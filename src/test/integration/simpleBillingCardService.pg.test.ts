// @vitest-environment node
/**
 * The saved card's service (server/services/billing/account/card.ts, simple
 * billing phase 3b) against a database built by the whole chain (migration
 * 262 included), through the real data layer in postgres-only mode, with
 * Paddle's API answered by a local fake that holds every PATCH to its
 * preview first (P4). What the unit test (cardService.test.ts) fakes, the
 * SQL does here:
 *
 *   - subscription.created before the checkout settled: the card is
 *     registered and held, the setup checkout settled from Paddle's answer,
 *     then the card synced (date = period end − 24 h, our custom_data);
 *   - a renewal Paddle charged is recorded once and becomes the prepaid next
 *     period, and Paddle's date follows it;
 *   - an upgrade charged to the card: the exact difference, settled, the
 *     item swapped; its notification is a replay;
 *   - a declined renewal: past_due, one mail; paid later it is credited to
 *     the balance for review (the period was already paid);
 *   - auto-renew off and on, the job, removing the card (the Paddle customer
 *     kept for the next checkout);
 *   - the due moment: a renewal whose event was lost is pulled by the job;
 *     with none the workspace moves to Free and the card is cancelled;
 *   - the reconciler settles a renewal Paddle charged that never reached us
 *     instead of moving Paddle's date earlier.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the saved card service suite is mandatory.');
}
const suite = DSN ? describe : describe.skip;

const captured = vi.hoisted(() => ({ emails: [] as Array<{ to: string; templateSlug?: string; data: Record<string, string> }> }));
vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const send = async (_c: unknown, req: { to: string; templateSlug?: string; templateData?: Record<string, string> }) => {
    captured.emails.push({ to: req.to, templateSlug: req.templateSlug, data: req.templateData ?? {} });
    return { success: true, provider: 'capture', id: `m-${captured.emails.length}` };
  };
  return { ...actual, sendEmail: send, sendPlatformEmail: send };
});

type Row = Record<string, unknown>;
const API = 'https://sandbox-api.paddle.com';
const fake = {
  subs: new Map<string, Row>(),
  txns: new Map<string, Row>(),
  calls: [] as Array<{ method: string; path: string; body: unknown }>,
  seq: 0,
  /** Runs once, before Paddle answers the next transaction listing (what happens meanwhile elsewhere). */
  beforeList: null as null | (() => Promise<void>),
};
const originalFetch = globalThis.fetch;
const blocked: string[] = [];

function txn(id: string, over: Row): Row {
  const amount = String(over.amount ?? 2900);
  const row: Row = {
    id, status: over.status ?? 'completed', origin: over.origin ?? 'subscription_recurring',
    subscription_id: over.subscription_id ?? null, customer_id: 'ctm_1', currency_code: 'USD',
    created_at: new Date().toISOString(), billed_at: new Date().toISOString(),
    details: { totals: { total: amount, grand_total: amount, credit: '0' } },
    items: [{ price: { custom_data: over.custom ?? {} } }],
    custom_data: over.custom_data ?? {},
    payments: over.payments ?? [{ status: 'captured', created_at: new Date().toISOString(), method_details: { card: { type: 'visa', last4: '4242', expiry_month: 12, expiry_year: 2030 } } }],
  };
  fake.txns.set(id, row);
  return row;
}

function fakePaddle(url: string, init: RequestInit = {}): Response {
  const method = init.method ?? 'GET';
  const full = url.slice(API.length);
  const path = full.split('?')[0];
  const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : {};
  fake.calls.push({ method, path: full, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status, headers: { 'content-type': 'application/json' } });
  let m = /^\/subscriptions\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    const sub = fake.subs.get(m[1]);
    if (!sub) return json({ error: { code: 'not_found', detail: 'no sub' } }, 404);
    const rest = m[2] ?? '';
    const apply = (target: Row) => {
      if ('scheduled_change' in body) target.scheduled_change = null;
      if (body.next_billed_at) Object.assign(target, { next_billed_at: body.next_billed_at, current_billing_period: { ends_at: body.next_billed_at } });
      if (body.items) target.items = body.items;
      if (body.custom_data) target.custom_data = body.custom_data;
    };
    if (method === 'GET' && rest === '') return json(sub);
    if (method === 'PATCH' && rest === '/preview') {
      expect(body.items || body.next_billed_at ? body.proration_billing_mode : 'do_not_bill').toBe('do_not_bill');
      const copy = JSON.parse(JSON.stringify(sub)) as Row;
      apply(copy);
      return json({ ...copy, immediate_transaction: null });
    }
    if (method === 'PATCH' && rest === '') {
      const preview = fake.calls.at(-2);
      expect(preview?.path).toBe(`/subscriptions/${m[1]}/preview`);
      apply(sub);
      return json(sub);
    }
    if (method === 'POST' && rest === '/cancel') {
      if (body.effective_from === 'immediately') Object.assign(sub, { status: 'canceled', next_billed_at: null, scheduled_change: null });
      else Object.assign(sub, { scheduled_change: { action: 'cancel', effective_at: sub.next_billed_at }, next_billed_at: null });
      return json(sub);
    }
    if (method === 'POST' && rest === '/charge/preview') {
      const amount = (body.items as Array<{ price: { unit_price: { amount: string } } }>)[0].price.unit_price.amount;
      return json({ immediate_transaction: { details: { totals: { grand_total: amount, credit: '0' } } } });
    }
    if (method === 'POST' && rest === '/charge') {
      const price = (body.items as Array<{ price: { unit_price: { amount: string }; custom_data: Row } }>)[0].price;
      txn(`txn_charge_${++fake.seq}`, { origin: 'subscription_charge', subscription_id: m[1], amount: Number(price.unit_price.amount), custom: price.custom_data });
      return json(sub);
    }
    if (method === 'GET' && rest === '/update-payment-method-transaction') return json({ id: 'txn_upd_1' });
  }
  if (method === 'GET' && path === '/transactions') {
    const subId = new URLSearchParams(full.split('?')[1]).get('subscription_id');
    return json([...fake.txns.values()].filter((t) => t.subscription_id === subId).reverse());
  }
  m = /^\/transactions\/([^/]+)$/.exec(path);
  if (m) {
    const t = fake.txns.get(decodeURIComponent(m[1]));
    if (!t) return json({ error: { code: 'not_found', detail: 'no txn' } }, 404);
    if (method === 'PATCH') {
      if (t.status === 'completed' || t.status === 'paid') return json({ error: { code: 'transaction_immutable', detail: 'paid' } }, 400);
      Object.assign(t, body);
    }
    return json(t);
  }
  return json({ error: { code: 'unexpected', detail: `${method} ${full}` } }, 404);
}

suite('saved card service against the real chain (postgres-only, Paddle faked)', () => {
  let chain: FullChainDatabase;
  let config: never;
  let card: typeof import('../../../server/services/billing/account/card.js');
  let plans: typeof import('../../../server/services/billing/account/plans.js');
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  let ws = '';
  let pro = '';
  let biz = '';
  let setupId = '';
  let cardId = '';
  let E = '';

  async function workspace(): Promise<string> {
    const id = randomUUID();
    const owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
    return id;
  }
  const event = (eventType: string, over: Row) => ({
    type: 'card_event', providerEventId: `evt_${randomUUID()}`, raw: {},
    card: { eventType, occurredAt: new Date().toISOString(), customerId: 'ctm_1', customData: {}, transaction: null, subscription: null, ...over },
  }) as never;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `simplebilling_cardsvc_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    await q(`INSERT INTO public.billing_settings (edition, seller, vat_percent, receipt_prefix) VALUES ('international', '{"legal_name":"Respok"}', '{"USD": null}', 'RS') ON CONFLICT (edition) DO UPDATE SET vat_percent = EXCLUDED.vat_percent`);
    await q(`INSERT INTO public.billing_gateways (provider_name, display_name, is_active, is_test, currencies, sort_order)
             VALUES ('paddle_sandbox', '{"en":"Paddle sandbox"}', true, true, '{USD}', 1)
             ON CONFLICT (provider_name) DO UPDATE SET is_active = true, currencies = EXCLUDED.currencies`);
    await q(`INSERT INTO public.billing_provider_credentials (provider_name, config) VALUES ('paddle_sandbox', $1::jsonb)
             ON CONFLICT (provider_name) DO UPDATE SET config = EXCLUDED.config`,
      [JSON.stringify({ api_key: 'pdl_sdbx_apikey_test', client_token: 'test_client_token', webhook_secret: 'whsec', open_to_customers: true, card_auto_renew: true })]);
    pro = String((await one(`INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order) VALUES ('Pro', 'pro-x', $1, '{}', true, false, false, 10) RETURNING id`, [JSON.stringify({ USD: { monthly: 2900, yearly: 29000 } })])).id);
    biz = String((await one(`INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order) VALUES ('Biz', 'biz-x', $1, '{}', true, false, false, 11) RETURNING id`, [JSON.stringify({ USD: { monthly: 9900, yearly: 99000 } })])).id);
    ws = await workspace();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(API)) {
        const hook = fake.beforeList;
        if (hook && (init?.method ?? 'GET') === 'GET' && url.slice(API.length).startsWith('/transactions?')) {
          fake.beforeList = null;
          await hook();
        }
        return fakePaddle(url, init);
      }
      blocked.push(url);
      throw new Error(`outbound request refused by the test: ${url}`);
    }) as typeof fetch;
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    card = await import('../../../server/services/billing/account/card.js');
    plans = await import('../../../server/services/billing/account/plans.js');
  }, 600_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('availability and setup preparation', async () => {
    const avail = await card.cardAvailability(config, ws, 'USD', { isPlatformAdmin: false });
    expect(avail).toEqual({ available: true, providers: ['paddle_sandbox'] });
    const prep = await card.prepareCardSetup(config, ws, { providerName: 'paddle_sandbox', purpose: 'plan', planId: pro, interval: 'monthly', viewer: { isPlatformAdmin: false } });
    expect(prep).toEqual({ customerId: null, recurring: { interval: 'monthly' }, priceCustomData: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } });
  });

  it('subscription.created before the checkout settles: registers, holds, settles the setup, then syncs', async () => {
    await q(`SELECT public.billing_account_ensure($1, 'USD')`, [ws]);
    setupId = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, purpose_detail, source, provider_ref, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 0, 'plan', $2, 'card_setup', 'txn_checkout_1', 'pending') RETURNING id`,
      [ws, JSON.stringify({ plan_id: pro, billing_interval: 'monthly' })])).id);
    txn('txn_checkout_1', { origin: 'web', subscription_id: 'sub_1', custom: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } });
    fake.subs.set('sub_1', {
      id: 'sub_1', status: 'active', customer_id: 'ctm_1', currency_code: 'USD',
      next_billed_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      scheduled_change: null,
      items: [{ price: { id: 'pri_1', unit_price: { amount: '2900', currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 }, custom_data: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } } }],
      custom_data: { workspace_id: ws, intent_id: setupId, card_setup: '1' },
    });
    const ev = event('subscription.created', { entity: 'subscription', subscriptionId: 'sub_1', transactionId: 'txn_checkout_1' });
    const owner = await card.cardEventOwner(config, 'paddle_sandbox', ev);
    expect(owner).toEqual({ workspaceId: ws, cardId: null, setupPaymentId: setupId });
    expect(await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: ev, owner: owner! })).toBe('handled');
    const c = await one(`SELECT * FROM public.billing_account_cards WHERE subscription_id = 'sub_1'`);
    cardId = String(c.id);
    expect(c).toMatchObject({ status: 'active', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, customer_id: 'ctm_1' });
    expect(await one(`SELECT auto_renew, card_provider, card_subscription_id, card_customer_id FROM public.billing_accounts WHERE workspace_id = $1`, [ws]))
      .toEqual({ auto_renew: true, card_provider: 'paddle_sandbox', card_subscription_id: 'sub_1', card_customer_id: 'ctm_1' });
    // The hold settled the setup checkout (Paddle says paid): the plan was bought.
    expect((await one(`SELECT status, card_id FROM public.billing_account_payments WHERE id = $1`, [setupId]))).toEqual({ status: 'succeeded', card_id: cardId });
    const s = await one(`SELECT plan_id, status, current_period_end FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
    expect(s).toMatchObject({ plan_id: pro, status: 'active' });
    E = new Date(s.current_period_end as string).toISOString();
    // The next sync renews.
    const out = await card.syncCard(config, cardId);
    expect(out.status).toBe('synced');
    const sub = fake.subs.get('sub_1')!;
    expect(Math.abs(Date.parse(sub.next_billed_at as string) - (Date.parse(E) - 86_400_000))).toBeLessThanOrEqual(60_000);
    expect(sub.custom_data).toEqual({ workspace_id: ws, card_id: cardId });
    const after = await one(`SELECT sync_version, synced_version, paddle_next_billed_at, paddle_item FROM public.billing_account_cards WHERE id = $1`, [cardId]);
    expect(Number(after.synced_version)).toBe(Number(after.sync_version));
    expect(new Date(after.paddle_next_billed_at as string).toISOString()).toBe(sub.next_billed_at);
    expect((after.paddle_item as Row).amount_minor).toBe(2900);
    expect((await card.syncCard(config, cardId)).status).toBe('unchanged');
  });

  it('the view', async () => {
    const view = await card.cardView(config, ws);
    expect(view).toMatchObject({ id: cardId, status: 'active', brand: 'visa', last4: '4242', auto_renew: true, next_charge_minor: 2900, next_charge_interval: 'monthly', frozen_until: null });
    expect(view?.next_charge_plan?.plan_id).toBe(pro);
  });

  it('a renewal Paddle charged is recorded once, settled into the prepaid next period, and Paddle follows', async () => {
    const t = txn('txn_ren_1', { subscription_id: 'sub_1', custom: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 }, custom_data: { workspace_id: ws, intent_id: setupId } });
    const { readTransaction } = await import('../../../server/services/billing/providers/paddleSubscriptions.js');
    const ev = event('transaction.completed', { entity: 'transaction', subscriptionId: 'sub_1', transactionId: 'txn_ren_1', transaction: readTransaction(t) });
    const owner = await card.cardEventOwner(config, 'paddle_sandbox', ev);
    expect(owner).toMatchObject({ cardId });
    await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: ev, owner: owner! });
    await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: ev, owner: owner! });
    const rows = await q(`SELECT source, purpose, status, review, purpose_result FROM public.billing_account_payments WHERE provider_ref = 'txn_ren_1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'card_renewal', purpose: 'renewal', status: 'succeeded', review: null });
    expect((rows[0].purpose_result as Row).card).toBe(true);
    const acc = await one(`SELECT next_period_prepaid_minor, next_period_start, balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws]);
    expect(Number(acc.next_period_prepaid_minor)).toBe(2900);
    expect(Number(acc.balance_minor)).toBe(0);
    // Paddle moved its date by its own month; we move it to the end of the prepaid period − 24 h.
    const sub = fake.subs.get('sub_1')!;
    sub.next_billed_at = new Date(Date.parse(sub.next_billed_at as string) + 30 * 86_400_000).toISOString();
    sub.current_billing_period = { ends_at: sub.next_billed_at };
    expect((await card.syncCard(config, cardId)).status).toMatch(/synced|unchanged/);
    const { periodEndOf } = await import('../../../server/services/billing/account/cardState.js');
    expect(Math.abs(Date.parse(sub.next_billed_at as string) - (Date.parse(periodEndOf(E, 'monthly')!) - 86_400_000))).toBeLessThanOrEqual(60_000);
  });

  it('an upgrade charged to the card: exact difference, settled, item swapped', async () => {
    const quote = await plans.quotePlanChange(config, ws, biz, 'monthly');
    expect(quote.kind).toBe('upgrade');
    const net = plans.quoteNetMinor(quote);
    const out = await card.chargeCardForUpgrade(config, ws, { planId: biz, expectedNetMinor: net, actorId: null });
    expect(out.status).toBe('succeeded');
    const pay = await one(`SELECT * FROM public.billing_account_payments WHERE id = $1`, [out.paymentId]);
    expect(pay).toMatchObject({ source: 'card_charge', purpose: 'upgrade', status: 'succeeded', provider_ref: 'txn_charge_1' });
    expect(Number(pay.amount_minor)).toBe(net);
    expect(pay.charge_requested_at).toBeTruthy();
    expect((await one(`SELECT plan_id FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).plan_id).toBe(biz);
    const item = (fake.subs.get('sub_1')!.items as Array<{ price: { unit_price: { amount: string } } }>)[0];
    expect(item.price.unit_price.amount).toBe('9900');
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/subscriptions/sub_1/charge')).toHaveLength(1);
    // The webhook of that charge is a replay.
    const { readTransaction } = await import('../../../server/services/billing/providers/paddleSubscriptions.js');
    const ev = event('transaction.completed', { entity: 'transaction', subscriptionId: 'sub_1', transactionId: 'txn_charge_1', transaction: readTransaction(fake.txns.get('txn_charge_1')) });
    await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: ev, owner: { workspaceId: ws, cardId, setupPaymentId: setupId } });
    expect(await q(`SELECT id FROM public.billing_account_payments WHERE provider_ref = 'txn_charge_1'`)).toHaveLength(1);
    // A second upgrade quote/charge flow: resolveCardCharge on a settled row says succeeded.
    const resolved = await card.resolveCardCharge(config, (await (await import('../../../server/services/billing/account/index.js')).readAccountPayment(config, out.paymentId))!);
    expect(resolved.status).toBe('succeeded');
  });

  it('a declined renewal: past_due, one mail; paid later it is credited (the next period is already paid: review)', async () => {
    const { readTransaction } = await import('../../../server/services/billing/providers/paddleSubscriptions.js');
    const t = txn('txn_ren_2', { status: 'past_due', subscription_id: 'sub_1', amount: 9900, custom: { plan_id: biz, interval: 'monthly', net_minor: 9900, tax_minor: 0 }, payments: [{ status: 'error', error_code: 'declined', created_at: new Date().toISOString(), method_details: { card: { type: 'visa', last4: '4242' } } }] });
    const owner = { workspaceId: ws, cardId, setupPaymentId: setupId };
    captured.emails.length = 0;
    await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: event('transaction.payment_failed', { entity: 'transaction', subscriptionId: 'sub_1', transactionId: 'txn_ren_2', transaction: readTransaction(t) }), owner });
    await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: event('transaction.past_due', { entity: 'transaction', subscriptionId: 'sub_1', transactionId: 'txn_ren_2', transaction: readTransaction(t) }), owner });
    const c = await one(`SELECT status, last_failure FROM public.billing_account_cards WHERE id = $1`, [cardId]);
    expect(c.status).toBe('past_due');
    expect((c.last_failure as Row).code).toBe('declined');
    const failed = captured.emails.filter((e) => e.templateSlug === 'billing_card_payment_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({ card: 'Visa •••• 4242', plan_name: 'Biz' });
    expect((await card.cardView(config, ws))?.last_failure?.code).toBe('declined');
    await expect(card.assertCardAllowsPlanChange(config, ws)).rejects.toMatchObject({ code: 'CARD_PAST_DUE' });
    Object.assign(t, { status: 'completed' });
    await card.handleCardEvent(config, { providerName: 'paddle_sandbox', event: event('transaction.completed', { entity: 'transaction', subscriptionId: 'sub_1', transactionId: 'txn_ren_2', transaction: readTransaction(t) }), owner });
    const pay = await one(`SELECT status, review, purpose_result FROM public.billing_account_payments WHERE provider_ref = 'txn_ren_2'`);
    expect(pay).toMatchObject({ status: 'succeeded', review: 'already_renewed' });
    expect((await one(`SELECT status, last_failure FROM public.billing_account_cards WHERE id = $1`, [cardId]))).toEqual({ status: 'active', last_failure: null });
  });

  it('auto-renew off then on, the job, then remove', async () => {
    expect(await card.setCardAutoRenew(config, ws, false)).toBe(false);
    expect((fake.subs.get('sub_1')!.scheduled_change as Row).action).toBe('cancel');
    expect((await one(`SELECT auto_renew FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).auto_renew).toBe(false);
    const report1 = await card.runCardJob(config);
    expect(report1.errors).toEqual([]);
    expect((fake.subs.get('sub_1')!.scheduled_change as Row | null)?.action).toBe('cancel');
    expect(await card.setCardAutoRenew(config, ws, true)).toBe(true);
    expect(fake.subs.get('sub_1')!.scheduled_change).toBeNull();
    const report2 = await card.runCardJob(config);
    expect(report2.errors).toEqual([]);
    captured.emails.length = 0;
    expect(await card.removeCard(config, ws)).toEqual({ removed: true });
    expect(fake.subs.get('sub_1')!.status).toBe('canceled');
    expect(await one(`SELECT status, cancel_reason FROM public.billing_account_cards WHERE id = $1`, [cardId])).toEqual({ status: 'canceled', cancel_reason: 'removed' });
    expect(await one(`SELECT auto_renew, card_provider, card_customer_id FROM public.billing_accounts WHERE workspace_id = $1`, [ws]))
      .toEqual({ auto_renew: false, card_provider: null, card_customer_id: 'ctm_1' });
    expect(captured.emails.filter((e) => e.templateSlug === 'billing_card_removed')).toHaveLength(1);
    // The next checkout reuses the Paddle customer.
    const prep = await card.prepareCardSetup(config, ws, { providerName: 'paddle_sandbox', purpose: 'renewal', planId: biz, interval: 'monthly', viewer: { isPlatformAdmin: false } });
    expect(prep.customerId).toBe('ctm_1');
  });

  it('the due moment: a renewal never delivered is pulled; without one the card is cancelled', async () => {
    // A second workspace with a live card, its period due now.
    const ws2 = await workspace();
    await q(`SELECT public.billing_account_admin_adjust($1, 2900, 'USD', 'test', NULL, $2)`, [ws2, `k-${randomUUID()}`]);
    await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws2, pro, randomUUID()]);
    const pay2 = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'plan', '{}', 'card_setup', 'txn_checkout_2', 'failed') RETURNING id`, [ws2])).id);
    const reg = await one(`SELECT public.billing_card_register('paddle_sandbox', 'sub_2', 'ctm_2', 'USD', $1) AS r`, [pay2]);
    const card2 = String((reg.r as Row).card_id);
    // Paddle renewed two hours ago and moved on a month; its events never came. The card was synced before.
    const ahead = new Date(Date.now() - 2 * 3_600_000 + 30 * 86_400_000).toISOString();
    fake.subs.set('sub_2', { id: 'sub_2', status: 'active', customer_id: 'ctm_2', currency_code: 'USD', next_billed_at: ahead, current_billing_period: { ends_at: ahead }, scheduled_change: null, items: [], custom_data: {} });
    await q(`UPDATE public.billing_account_cards SET paddle_next_billed_at = now() - interval '2 hours', synced_at = now(), synced_version = sync_version, next_sync_at = now() + interval '1 hour' WHERE id = $1`, [card2]);
    // Paddle charged the renewal; its webhook was lost.
    txn('txn_ren_9', { subscription_id: 'sub_2', custom: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } });
    const report = await card.runCardJob(config);
    expect(report.pulled).toBe(1);
    expect(Number((await one(`SELECT next_period_prepaid_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws2])).next_period_prepaid_minor)).toBe(2900);
    expect(await card.pullCardRenewal(config, ws2)).toBe(false);

    // Now the period is due with nothing paid for the next one: Free, and the card is cancelled.
    await q(`UPDATE public.billing_accounts SET next_period_prepaid_minor = NULL, next_period_start = NULL WHERE workspace_id = $1`, [ws2]);
    await q(`UPDATE public.workspace_subscriptions SET current_period_end = now() - interval '1 minute' WHERE workspace_id = $1`, [ws2]);
    const due = await one(`SELECT public.billing_account_process_due($1) AS r`, [ws2]);
    const r = due.r as Row;
    expect(r).toMatchObject({ action: 'expired', reason: 'card_not_paid' });
    expect(await card.cancelCardNow(config, String((r.card_cancel as Row).card_id))).toBe(true);
    expect(fake.subs.get('sub_2')!.status).toBe('canceled');
    expect(await one(`SELECT status, cancel_reason FROM public.billing_account_cards WHERE id = $1`, [card2])).toEqual({ status: 'canceled', cancel_reason: 'not_renewed' });
  });

  it('the reconciler finds a renewal Paddle charged that never reached us, and does not move the date earlier', async () => {
    const ws3 = await workspace();
    await q(`SELECT public.billing_account_admin_adjust($1, 2900, 'USD', 'test', NULL, $2)`, [ws3, `k-${randomUUID()}`]);
    await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws3, pro, randomUUID()]);
    // The period ends in 23 hours: Paddle charged an hour ago (end − 24 h).
    await q(`UPDATE public.workspace_subscriptions SET current_period_end = now() + interval '23 hours' WHERE workspace_id = $1`, [ws3]);
    const pay3 = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'plan', '{}', 'card_setup', 'txn_checkout_3', 'failed') RETURNING id`, [ws3])).id);
    const card3 = String(((await one(`SELECT public.billing_card_register('paddle_sandbox', 'sub_3', 'ctm_3', 'USD', $1) AS r`, [pay3])).r as Row).card_id);
    const ahead = new Date(Date.now() - 3_600_000 + 30 * 86_400_000).toISOString();
    fake.subs.set('sub_3', {
      id: 'sub_3', status: 'active', customer_id: 'ctm_3', currency_code: 'USD', next_billed_at: ahead, current_billing_period: { ends_at: ahead },
      scheduled_change: null, custom_data: { workspace_id: ws3, card_id: card3 },
      items: [{ price: { id: 'pri_3', unit_price: { amount: '2900', currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 }, custom_data: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } } }],
    });
    txn('txn_ren_31', { subscription_id: 'sub_3', custom: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } });
    const patchesBefore = fake.calls.filter((c) => c.method === 'PATCH' && c.path === '/subscriptions/sub_3').length;
    const first = await card.syncCard(config, card3);
    expect(first).toEqual({ status: 'deferred', detail: 'renewal_settled' });
    expect(fake.calls.filter((c) => c.method === 'PATCH' && c.path === '/subscriptions/sub_3').length).toBe(patchesBefore);
    expect(Number((await one(`SELECT next_period_prepaid_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws3])).next_period_prepaid_minor)).toBe(2900);
    // Next pass: the prepaid period's end − 24 h is later than Paddle's date; moving it later is safe.
    const second = await card.syncCard(config, card3);
    expect(['synced', 'unchanged']).toContain(second.status);
    const n = Date.parse(fake.subs.get('sub_3')!.next_billed_at as string);
    expect(n).toBeGreaterThan(Date.now() + 25 * 86_400_000);
  });

  it("a renewal settled by its own notification while the reconciler lists Paddle's transactions: Paddle's date is not moved earlier", async () => {
    const ws4 = await workspace();
    await q(`SELECT public.billing_account_admin_adjust($1, 2900, 'USD', 'test', NULL, $2)`, [ws4, `k-${randomUUID()}`]);
    await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws4, pro, randomUUID()]);
    // Paddle charged its renewal a minute ago (our end − 24 h) and moved its date a month on.
    await q(`UPDATE public.workspace_subscriptions SET current_period_end = now() + interval '24 hours' - interval '1 minute' WHERE workspace_id = $1`, [ws4]);
    const end = new Date((await one(`SELECT current_period_end FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws4])).current_period_end as string).toISOString();
    const pay4 = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'plan', '{}', 'card_setup', 'txn_checkout_4', 'failed') RETURNING id`, [ws4])).id);
    const card4 = String(((await one(`SELECT public.billing_card_register('paddle_sandbox', 'sub_4', 'ctm_4', 'USD', $1) AS r`, [pay4])).r as Row).card_id);
    const { periodEndOf } = await import('../../../server/services/billing/account/cardState.js');
    const charged = new Date(Date.parse(end) - 86_400_000).toISOString();
    const ahead = periodEndOf(charged, 'monthly')!;
    fake.subs.set('sub_4', {
      id: 'sub_4', status: 'active', customer_id: 'ctm_4', currency_code: 'USD', next_billed_at: ahead,
      current_billing_period: { starts_at: charged, ends_at: ahead }, scheduled_change: null, custom_data: { workspace_id: ws4, card_id: card4 },
      items: [{ price: { id: 'pri_4', unit_price: { amount: '2900', currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 }, custom_data: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } } }],
    });
    const t = txn('txn_ren_41', { subscription_id: 'sub_4', custom: { plan_id: pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } });
    const { readTransaction } = await import('../../../server/services/billing/providers/paddleSubscriptions.js');
    // Its transaction.paid is handled at the same time (another replica): it
    // records and settles the renewal after the reconciler read what is paid,
    // before Paddle answers its listing.
    fake.beforeList = async () => {
      expect(await card.handleCardEvent(config, {
        providerName: 'paddle_sandbox',
        event: event('transaction.paid', { entity: 'transaction', subscriptionId: 'sub_4', transactionId: 'txn_ren_41', transaction: readTransaction(t) }),
        owner: { workspaceId: ws4, cardId: card4, setupPaymentId: pay4 },
      })).toBe('handled');
    };
    const mark = fake.calls.length;
    const out = await card.syncCard(config, card4);
    expect(fake.beforeList).toBeNull();
    expect(Number((await one(`SELECT next_period_prepaid_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws4])).next_period_prepaid_minor)).toBe(2900);
    expect(await q(`SELECT status, review FROM public.billing_account_payments WHERE provider_ref = 'txn_ren_41'`)).toEqual([{ status: 'succeeded', review: null }]);
    // Paddle keeps the date a month on: it is never asked to charge again in 45 minutes.
    expect(out).toEqual({ status: 'deferred', detail: 'renewal_settled' });
    expect(fake.calls.slice(mark).filter((c) => c.method === 'PATCH' && c.path === '/subscriptions/sub_4')).toEqual([]);
    expect(fake.subs.get('sub_4')!.next_billed_at).toBe(ahead);
    // The next pass puts Paddle's date at the prepaid period's end − 24 h (later, never earlier).
    expect(['synced', 'unchanged']).toContain((await card.syncCard(config, card4)).status);
    const wanted = Date.parse(periodEndOf(end, 'monthly')!) - 86_400_000;
    expect(Math.abs(Date.parse(fake.subs.get('sub_4')!.next_billed_at as string) - wanted)).toBeLessThanOrEqual(60_000);
  });

  it("a wrong early date at Paddle inside the freeze is moved later (the date only), before Paddle charges at it", async () => {
    // The state the race above could leave before the fix: the next period is
    // prepaid, yet Paddle's date was moved to 45 minutes from now.
    const ws5 = await workspace();
    await q(`SELECT public.billing_account_admin_adjust($1, 5800, 'USD', 'test', NULL, $2)`, [ws5, `k-${randomUUID()}`]);
    await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws5, pro, randomUUID()]);
    await q(`UPDATE public.workspace_subscriptions SET current_period_end = now() + interval '23 hours' WHERE workspace_id = $1`, [ws5]);
    const end = new Date((await one(`SELECT current_period_end FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws5])).current_period_end as string).toISOString();
    await q(`SELECT public.billing_account_renew($1, NULL, $2::timestamptz, 2900)`, [ws5, end]);
    const pay5 = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'plan', '{}', 'card_setup', 'txn_checkout_5', 'failed') RETURNING id`, [ws5])).id);
    const card5 = String(((await one(`SELECT public.billing_card_register('paddle_sandbox', 'sub_5', 'ctm_5', 'USD', $1) AS r`, [pay5])).r as Row).card_id);
    const early = new Date(Date.now() + 45 * 60_000).toISOString();
    fake.subs.set('sub_5', {
      id: 'sub_5', status: 'active', customer_id: 'ctm_5', currency_code: 'USD', next_billed_at: early,
      current_billing_period: { ends_at: early }, scheduled_change: null, custom_data: { workspace_id: ws5, card_id: card5 },
      // An item that is not the next period's either: it waits for the freeze to end.
      items: [{ price: { id: 'pri_5', unit_price: { amount: '1000', currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 }, custom_data: {} } }],
    });
    const mark = fake.calls.length;
    expect(await card.syncCard(config, card5)).toEqual({ status: 'deferred', detail: 'moved_later' });
    const patches = fake.calls.slice(mark).filter((c) => c.method === 'PATCH' && c.path.startsWith('/subscriptions/sub_5'));
    const { periodEndOf } = await import('../../../server/services/billing/account/cardState.js');
    const wanted = new Date(Date.parse(periodEndOf(end, 'monthly')!) - 86_400_000).toISOString();
    expect(patches.map((c) => [c.path, c.body])).toEqual([
      ['/subscriptions/sub_5/preview', { next_billed_at: wanted, proration_billing_mode: 'do_not_bill' }],
      ['/subscriptions/sub_5', { next_billed_at: wanted, proration_billing_mode: 'do_not_bill' }],
    ]);
    expect(fake.subs.get('sub_5')!.next_billed_at).toBe(wanted);
    // Out of the freeze now: the next pass swaps the item.
    expect((await card.syncCard(config, card5)).status).toBe('synced');
    expect(((fake.subs.get('sub_5')!.items as Array<{ price: { unit_price: { amount: string } } }>)[0]).price.unit_price.amount).toBe('2900');
  });

  it('nothing left this machine except to the local Paddle fake', () => {
    expect(blocked).toEqual([]);
  });
});
