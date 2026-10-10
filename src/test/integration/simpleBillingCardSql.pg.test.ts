// @vitest-environment node
/**
 * 262 — the saved card (a Paddle subscription) that renews a Multi Region
 * plan, in SQL, against real PostgreSQL built by the whole migration chain
 * (docs/billing/SIMPLE_BILLING.md, phase 3b).
 *
 *   - a checkout's card is registered once per subscription; it becomes the
 *     account's card and turns auto-renew on; a second live card of the same
 *     workspace is a duplicate, to be cancelled;
 *   - a card moves active ↔ past_due → canceling → canceled; leaving the
 *     live states takes it off the account and turns auto-renew off;
 *   - every Paddle transaction of a card is one payment row: a renewal with
 *     the net and tax we set, our own upgrade charge bound to the row it was
 *     asked for, anything else a top-up for review;
 *   - a card renewal is credited and spent on the next period in one
 *     transaction; each guard leaves the money in the balance and says why;
 *     a late renewal after the card was cancelled for not paying buys the
 *     plan again;
 *   - at the due moment a card account is never renewed from the balance: a
 *     prepaid period starts, or the workspace moves to Free and the card is
 *     returned to be cancelled; an account without a card is renewed as in
 *     261;
 *   - reminders, pruning, the reconciler's queue and its compare-and-set,
 *     the triggers that move sync_version, a deleted workspace's card, the
 *     partial unique indexes, the card emails (both editions), access,
 *     and running 262 again.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the saved card SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling262_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '262_simple_billing_card.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const fn = async (sql: string, params: unknown[] = []): Promise<Row> => (await one(sql, params)).r as Row;

const PRO = { monthly: 2900, yearly: 29000 };
const BIZ = { monthly: 9900, yearly: 99000 };
const VAT = 20;
let proId = '';
let bizId = '';
let freeId = '';

async function makePlan(slug: string, usd: { monthly: number; yearly: number }): Promise<string> {
  const row = await one(
    `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
     VALUES ($1, $2, $3, $4, true, false, false, 10) RETURNING id`,
    [slug, slug, JSON.stringify({ USD: usd }), JSON.stringify({ included_ai_allowance_irr: 0, max_agents: 5 })],
  );
  return String(row.id);
}

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  return id;
}

let keySeq = 0;
const credit = async (ws: string, amount: number) =>
  q(`SELECT public.billing_account_admin_adjust($1, $2, 'USD', 'test credit', NULL, $3)`, [ws, amount, `card-test-${++keySeq}`]);
const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);
const account = (ws: string) => one(`SELECT * FROM public.billing_accounts WHERE workspace_id = $1`, [ws]);
const sub = (ws: string) => one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
const card = (id: string) => one(`SELECT * FROM public.billing_account_cards WHERE id = $1`, [id]);
const payment = (id: string) => one(`SELECT * FROM public.billing_account_payments WHERE id = $1`, [id]);
const purchase = (ws: string, plan: string, interval = 'monthly') =>
  fn(`SELECT public.billing_account_purchase_plan($1, $2, $3, $4) AS r`, [ws, plan, interval, randomUUID()]);
const processDue = (ws: string) => fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]);
/** Moves only the running period into the past (a prepayment stays for the old one). */
const makeDueWithoutPrepaid = (ws: string) => q(
  `UPDATE public.workspace_subscriptions
      SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour'
    WHERE workspace_id = $1`, [ws]);
/** Moves the running period into the past (and a prepayment made for the next one with it). */
const makeDue = async (ws: string) => {
  await makeDueWithoutPrepaid(ws);
  await q(
    `UPDATE public.billing_accounts a SET next_period_start = s.current_period_end
       FROM public.workspace_subscriptions s
      WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id AND a.next_period_prepaid_minor IS NOT NULL`, [ws]);
};

let txnSeq = 0;
const txn = (prefix = 'txn') => `${prefix}_${++txnSeq}_${randomUUID().slice(0, 8)}`;
const subId = () => `sub_${randomUUID().slice(0, 13)}`;

/** A checkout payment that saves a card (pending: Paddle's events arrive in any order). */
async function setupPayment(ws: string, opts: { provider?: string; currency?: string; source?: string } = {}): Promise<string> {
  const row = await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref)
     VALUES ($1, $2, $3, $4, $4, 'plan', $5, $6, $7) RETURNING id`,
    [ws, opts.provider ?? 'paddle_sandbox', opts.currency ?? 'USD', PRO.monthly,
      JSON.stringify({ plan_id: proId, billing_interval: 'monthly' }), opts.source ?? 'card_setup', txn('txn_setup')],
  );
  return String(row.id);
}
const register = (provider: string, subscription: string, customer: string | null, currency: string, paymentId: string) =>
  fn(`SELECT public.billing_card_register($1, $2, $3, $4, $5) AS r`, [provider, subscription, customer, currency, paymentId]);

/** A workspace on a plan (Pro monthly by default), bought from the balance, with a live card saved by a checkout. */
async function cardWorkspace(opts: { balance?: number; plan?: string; price?: number } = {}): Promise<{ ws: string; card: string; subscription: string }> {
  const ws = await makeWorkspace();
  await credit(ws, (opts.price ?? PRO.monthly) + (opts.balance ?? 0));
  await purchase(ws, opts.plan ?? proId);
  const subscription = subId();
  const r = await register('paddle_sandbox', subscription, 'ctm_1', 'USD', await setupPayment(ws));
  return { ws, card: String(r.card_id), subscription };
}

const setStatus = (id: string, status: string, reason: string | null = null) =>
  fn(`SELECT public.billing_card_set_status($1, $2, $3) AS r`, [id, status, reason]);
const recordCharge = (
  cardId: string, txnId: string, origin: string, amount: number, items: unknown[] = [], paymentId: string | null = null, currency = 'USD',
) => one(
  `SELECT * FROM public.billing_card_record_charge($1, $2, $3, $4, $5, $6, $7)`,
  [cardId, txnId, origin, amount, currency, JSON.stringify(items), paymentId],
);
const settle = (paymentId: string, amount: number, txnId: string) =>
  fn(`SELECT public.billing_card_settle($1, $2, 'USD', $3) AS r`, [paymentId, amount, txnId]);
const renewalItem = (net: number, tax = 0, plan = proId, interval = 'monthly') => [{ plan_id: plan, interval, net_minor: net, tax_minor: tax }];
/** A renewal Paddle charged on the card: recorded, then settled. */
async function cardRenewal(cardId: string, net = PRO.monthly, tax = 0): Promise<{ payment: Row; settled: Row }> {
  const t = txn();
  const recorded = await recordCharge(cardId, t, 'subscription_recurring', net + tax, renewalItem(net, tax));
  const settled = await settle(String(recorded.id), net + tax, t);
  return { payment: recorded, settled };
}

/** A card row written directly (the reconciler tests need exact states). */
async function rawCard(fields: Row = {}): Promise<string> {
  const all: Row = {
    workspace_id: randomUUID(), provider: 'paddle_sandbox', subscription_id: `sub_raw_${randomUUID()}`, currency: 'USD', status: 'active',
    ...fields,
  };
  const cols = Object.keys(all);
  const row = await one(
    `INSERT INTO public.billing_account_cards (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(all),
  );
  return String(row.id);
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

suite('262 — the saved card (real PostgreSQL, whole chain)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query('SET client_min_messages = warning');

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f <= FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    await db.query(
      `INSERT INTO public.billing_settings (edition, vat_percent, receipt_prefix) VALUES ('international', $1, 'RS')
       ON CONFLICT (edition) DO UPDATE SET vat_percent = EXCLUDED.vat_percent`,
      [JSON.stringify({ USD: VAT })],
    );
    proId = await makePlan('c-pro', PRO);
    bizId = await makePlan('c-biz', BIZ);
    freeId = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'free'`)).id);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  // ─── Registering ──────────────────────────────────────────────────────────

  it('a checkout\'s card becomes the account\'s card and turns auto-renew on; a replay changes nothing', async () => {
    const ws = await makeWorkspace();
    await credit(ws, PRO.monthly);
    await purchase(ws, proId);
    expect((await account(ws)).auto_renew).toBe(false);
    const pay = await setupPayment(ws);
    const subscription = subId();
    const r = await register('paddle_sandbox', subscription, 'ctm_42', 'usd', pay);
    expect(r).toMatchObject({ workspace_id: ws, live: true, duplicate: false, replayed: false });
    expect(await card(String(r.card_id))).toMatchObject({
      workspace_id: ws, provider: 'paddle_sandbox', subscription_id: subscription, customer_id: 'ctm_42', currency: 'USD',
      setup_payment_id: pay, status: 'active', cancel_reason: null,
    });
    expect(await account(ws)).toMatchObject({
      card_provider: 'paddle_sandbox', card_subscription_id: subscription, card_customer_id: 'ctm_42', auto_renew: true,
    });
    // The payment is linked, and it did not have to be settled first.
    expect(await payment(pay)).toMatchObject({ card_id: r.card_id, status: 'pending' });

    expect(await register('paddle_sandbox', subscription, 'ctm_42', 'USD', pay))
      .toEqual({ card_id: r.card_id, workspace_id: ws, live: true, duplicate: false, replayed: true });
    expect((await q(`SELECT id FROM public.billing_account_cards WHERE workspace_id = $1`, [ws]))).toHaveLength(1);

    // The same subscription named by another workspace's checkout is refused.
    const other = await makeWorkspace();
    await expect(register('paddle_sandbox', subscription, 'ctm_42', 'USD', await setupPayment(other)))
      .rejects.toThrow(/billing_card_conflict/);
  });

  it('a second card of the same workspace (two tabs) is a duplicate, to be cancelled; the first stays the account\'s card', async () => {
    const { ws, card: first, subscription } = await cardWorkspace();
    const second = subId();
    const r = await register('paddle_sandbox', second, 'ctm_1', 'USD', await setupPayment(ws));
    expect(r).toMatchObject({ live: false, duplicate: true, replayed: false });
    expect(await card(String(r.card_id))).toMatchObject({ status: 'canceling', cancel_reason: 'duplicate' });
    expect(await account(ws)).toMatchObject({ card_subscription_id: subscription, auto_renew: true });
    expect((await card(first)).status).toBe('active');
    // Its replay says so too.
    expect(await register('paddle_sandbox', second, 'ctm_1', 'USD', String((await card(String(r.card_id))).setup_payment_id)))
      .toMatchObject({ live: false, duplicate: true, replayed: true });
  });

  it('only a card checkout of the same provider and currency registers a card, in an account of that currency', async () => {
    const ws = await makeWorkspace();
    await expect(register('paddle_sandbox', subId(), null, 'USD', await setupPayment(ws, { source: 'checkout' })))
      .rejects.toThrow(/billing_card_setup_invalid/);
    await expect(register('paddle', subId(), null, 'USD', await setupPayment(ws)))
      .rejects.toThrow(/billing_card_setup_invalid/);
    await expect(register('paddle_sandbox', subId(), null, 'EUR', await setupPayment(ws)))
      .rejects.toThrow(/billing_card_setup_invalid/);
    await expect(register('stripe', subId(), null, 'USD', await setupPayment(ws, { provider: 'stripe' })))
      .rejects.toThrow(/billing_card_setup_invalid/);
    await expect(register('paddle_sandbox', subId(), null, 'USD', randomUUID())).rejects.toThrow(/billing_card_setup_invalid/);
    await expect(register('paddle_sandbox', '', null, 'USD', await setupPayment(ws))).rejects.toThrow(/billing_card_setup_invalid/);

    // An account that already counts in another currency.
    const turkish = await makeWorkspace();
    await q(`SELECT public.billing_account_ensure($1, 'TRY')`, [turkish]);
    await expect(register('paddle_sandbox', subId(), null, 'USD', await setupPayment(turkish)))
      .rejects.toThrow(/billing_account_currency_mismatch/);
    expect(await q(`SELECT 1 FROM public.billing_account_cards WHERE workspace_id IN ($1, $2)`, [ws, turkish])).toHaveLength(0);
  });

  // ─── Status ───────────────────────────────────────────────────────────────

  it('a card moves active ↔ past_due → canceling → canceled; leaving the live states takes it off the account', async () => {
    const { ws, card: id, subscription } = await cardWorkspace();
    expect(await setStatus(id, 'past_due')).toEqual({
      card_id: id, workspace_id: ws, status: 'past_due', previous_status: 'active', changed: true, was_live: true,
    });
    expect(await account(ws)).toMatchObject({ card_subscription_id: subscription, auto_renew: true });
    expect(await setStatus(id, 'active')).toMatchObject({ status: 'active', previous_status: 'past_due', changed: true });
    expect(await setStatus(id, 'active')).toMatchObject({ status: 'active', previous_status: 'active', changed: false, was_live: true });

    await q(`UPDATE public.billing_account_cards SET next_sync_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    expect(await setStatus(id, 'canceling', 'removed')).toMatchObject({ status: 'canceling', previous_status: 'active', changed: true, was_live: true });
    const canceling = await card(id);
    expect(canceling).toMatchObject({ status: 'canceling', cancel_reason: 'removed', canceled_at: null });
    // A card to cancel is picked up at once, whatever its back-off.
    expect(new Date(canceling.next_sync_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // The pointer is cleared, the Paddle customer kept, auto-renew off.
    expect(await account(ws)).toMatchObject({ card_provider: null, card_subscription_id: null, card_customer_id: 'ctm_1', auto_renew: false });

    await expect(setStatus(id, 'active')).rejects.toThrow(/billing_card_status_invalid/);
    await expect(setStatus(id, 'past_due')).rejects.toThrow(/billing_card_status_invalid/);
    expect(await setStatus(id, 'canceled', 'canceled_at_paddle')).toMatchObject({ status: 'canceled', previous_status: 'canceling', changed: true, was_live: false });
    const canceled = await card(id);
    expect(canceled.cancel_reason).toBe('removed');
    expect(canceled.canceled_at).not.toBeNull();
    // Canceled is final.
    expect(await setStatus(id, 'active')).toMatchObject({ status: 'canceled', changed: false });
    expect(await setStatus(id, 'canceling')).toMatchObject({ status: 'canceled', changed: false });

    await expect(setStatus(id, 'paused')).rejects.toThrow(/billing_card_status_invalid/);
    await expect(setStatus(randomUUID(), 'active')).rejects.toThrow(/billing_card_not_found/);
  });

  it('a past_due card can be cancelled directly; a duplicate\'s cancel leaves the account\'s card alone', async () => {
    const { ws, card: id, subscription } = await cardWorkspace();
    const dup = String((await register('paddle_sandbox', subId(), null, 'USD', await setupPayment(ws))).card_id);
    expect(await setStatus(dup, 'canceled', 'duplicate_canceled')).toMatchObject({ changed: true, was_live: false });
    expect(await account(ws)).toMatchObject({ card_subscription_id: subscription, auto_renew: true });

    await setStatus(id, 'past_due');
    expect(await setStatus(id, 'canceled', 'canceled_at_paddle')).toMatchObject({ previous_status: 'past_due', was_live: true });
    expect(await card(id)).toMatchObject({ status: 'canceled', cancel_reason: 'canceled_at_paddle' });
    expect(await account(ws)).toMatchObject({ card_provider: null, card_subscription_id: null, auto_renew: false });
  });

  // ─── Recording a charge ───────────────────────────────────────────────────

  it('a renewal Paddle charged is a card_renewal row with our net and tax, recorded once', async () => {
    const { ws, card: id } = await cardWorkspace();
    const t = txn();
    const row = await recordCharge(id, t, 'subscription_recurring', 3480, renewalItem(2900, 580));
    expect(row).toMatchObject({
      workspace_id: ws, provider: 'paddle_sandbox', currency: 'USD', amount_minor: '3480', net_minor: '2900', tax_minor: '580',
      tax_percent: '20.000', purpose: 'renewal', status: 'pending', provider_ref: t, created_by: null,
      source: 'card_renewal', card_id: id, review: null,
    });
    expect(row.purpose_detail).toEqual({ plan_id: proId, billing_interval: 'monthly', card_id: id });

    // Reported again (another event of the same transaction): the same row.
    expect((await recordCharge(id, t, 'subscription_recurring', 3480, renewalItem(2900, 580))).id).toBe(row.id);
    expect(await q(`SELECT 1 FROM public.billing_account_payments WHERE provider_ref = $1`, [t])).toHaveLength(1);
    // Never for another workspace.
    const { card: other } = await cardWorkspace();
    await expect(recordCharge(other, t, 'subscription_recurring', 3480, renewalItem(2900, 580))).rejects.toThrow(/billing_card_conflict/);
  });

  it('the same transaction reported twice at once is recorded once', async () => {
    const { card: id } = await cardWorkspace();
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    const a = new pg.Client({ connectionString: url.toString() });
    const b = new pg.Client({ connectionString: url.toString() });
    await a.connect();
    await b.connect();
    try {
      const t = txn();
      const sql = `SELECT id FROM public.billing_card_record_charge($1, $2, 'subscription_recurring', 2900, 'USD', $3)`;
      const params = [id, t, JSON.stringify(renewalItem(2900))];
      await a.query('BEGIN');
      const first = (await a.query(sql, params)).rows[0].id;
      // The second waits for the first one's account lock, then finds its row.
      const second = b.query(sql, params);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect((await second).rows[0].id).toBe(first);
      expect(await q(`SELECT 1 FROM public.billing_account_payments WHERE provider_ref = $1`, [t])).toHaveLength(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('a renewal whose amounts do not add up is a top-up for review; nothing is ever dropped', async () => {
    const { card: id } = await cardWorkspace();
    const mismatch = await recordCharge(id, txn(), 'subscription_recurring', 3100, renewalItem(2900, 0));
    expect(mismatch).toMatchObject({
      source: 'card_renewal', purpose: 'topup', amount_minor: '3100', net_minor: '3100', tax_minor: '0', tax_percent: null,
      review: 'amount_mismatch',
    });
    // Settled, it stays a top-up with its own reason.
    expect(await settle(String(mismatch.id), 3100, String(mismatch.provider_ref))).toMatchObject({ purpose: 'topup', purpose_result: null });
    expect(await payment(String(mismatch.id))).toMatchObject({ status: 'succeeded', review: 'amount_mismatch' });
    expect(await recordCharge(id, txn(), 'subscription_recurring', 2900, []))
      .toMatchObject({ purpose: 'topup', review: 'amount_mismatch', net_minor: '2900' });
    expect(await recordCharge(id, txn(), 'subscription_recurring', 2900, [{ plan_id: proId, interval: 'monthly', net_minor: 2899.5, tax_minor: 0.5 }]))
      .toMatchObject({ purpose: 'topup', review: 'amount_mismatch' });
    // A plan id that is not one is left out; Paddle's interval names are understood.
    const odd = await recordCharge(id, txn(), 'subscription_recurring', 2900, [{ plan_id: 'nope', interval: 'year', net_minor: '2900', tax_minor: '0' }]);
    expect(odd).toMatchObject({ purpose: 'renewal', review: null });
    expect(odd.purpose_detail).toEqual({ billing_interval: 'yearly', card_id: id });

    await expect(recordCharge(id, txn(), 'subscription_recurring', 0)).rejects.toThrow(/billing_card_charge_amount_invalid/);
    await expect(recordCharge(id, txn(), 'subscription_recurring', -5)).rejects.toThrow(/billing_card_charge_amount_invalid/);
    await expect(recordCharge(id, '', 'subscription_recurring', 2900)).rejects.toThrow(/billing_payment_reference_missing/);
    await expect(recordCharge(id, txn(), 'subscription_recurring', 2900, renewalItem(2900), null, 'EUR'))
      .rejects.toThrow(/billing_account_currency_mismatch/);
    await expect(recordCharge(randomUUID(), txn(), 'subscription_recurring', 2900)).rejects.toThrow(/billing_card_not_found/);
  });

  it('our own /charge binds the pending card_charge row it was made for; a row that does not match is a top-up for review', async () => {
    const { ws, card: id } = await cardWorkspace();
    const pending = await one(
      `INSERT INTO public.billing_account_payments
         (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, card_id, charge_requested_at)
       VALUES ($1, 'paddle_sandbox', 'USD', 7000, 7000, 'upgrade', $2, 'card_charge', $3, now()) RETURNING id`,
      [ws, JSON.stringify({ plan_id: bizId, billing_interval: 'monthly', card_id: id }), id],
    );
    const t = txn();
    const bound = await recordCharge(id, t, 'subscription_charge', 7000, [{ payment_id: pending.id, workspace_id: ws }], String(pending.id));
    expect(bound).toMatchObject({ id: pending.id, provider_ref: t, source: 'card_charge', purpose: 'upgrade', status: 'pending', review: null });
    expect((await recordCharge(id, t, 'subscription_charge', 7000, [], String(pending.id))).id).toBe(pending.id);

    // Another amount than the row's: credited as a top-up, for review, naming the row it claimed.
    const other = await one(
      `INSERT INTO public.billing_account_payments
         (workspace_id, provider, currency, amount_minor, net_minor, purpose, source, card_id, charge_requested_at, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 5000, 5000, 'upgrade', 'card_charge', $2, now(), 'failed') RETURNING id`, [ws, id]);
    for (const [claimed, amount] of [[pending.id, 7000], [other.id, 5000], [randomUUID(), 5000]] as const) {
      const t2 = txn();
      const r = await recordCharge(id, t2, 'subscription_charge', amount, [], String(claimed));
      expect(r).toMatchObject({ source: 'card_charge', purpose: 'topup', status: 'pending', provider_ref: t2, review: 'charge_mismatch' });
      expect((r.purpose_detail as Row).claimed_payment_id).toBe(claimed);
      expect(r.id).not.toBe(claimed);
    }
    // Without our row, or from any other origin: unexpected, for review.
    expect(await recordCharge(id, txn(), 'subscription_charge', 1200)).toMatchObject({ purpose: 'topup', review: 'unexpected_charge:subscription_charge' });
    expect(await recordCharge(id, txn(), 'subscription_update', 1200)).toMatchObject({
      source: 'card_charge', purpose: 'topup', net_minor: '1200', tax_minor: '0', review: 'unexpected_charge:subscription_update',
    });
    expect(await recordCharge(id, txn(), '', 1200)).toMatchObject({ review: 'unexpected_charge:unknown' });
  });

  // ─── Settling a renewal ───────────────────────────────────────────────────

  it('a card renewal is credited and spent on the next period in one transaction: the prepaid next period', async () => {
    const { ws, card: id } = await cardWorkspace({ balance: 500 });
    const end = (await sub(ws)).current_period_end as Date;
    const { payment: p, settled } = await cardRenewal(id, 2900, 580);
    expect(settled).toMatchObject({ replayed: false, purpose: 'renewal', balance_minor: 500 });
    expect(settled.purpose_result).toMatchObject({ action: 'prepaid', card: true, amount_minor: 2900, plan_id: proId });
    expect(await payment(String(p.id))).toMatchObject({
      status: 'succeeded', verified_amount_minor: '3480', provider_payment_id: p.provider_ref, review: null,
    });
    const acc = await account(ws);
    expect(Number(acc.next_period_prepaid_minor)).toBe(2900);
    expect(new Date(acc.next_period_start as string).getTime()).toBe(end.getTime());
    expect(await balanceOf(ws)).toBe(500);
    const rows = await q(
      `SELECT kind, amount_minor::int AS amount, net_minor::int AS net, tax_minor::int AS tax FROM public.billing_account_ledger
        WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);
    expect(rows.slice(-2)).toEqual([
      { kind: 'topup', amount: 2900, net: 2900, tax: 580 },
      { kind: 'renewal', amount: -2900, net: null, tax: null },
    ]);

    // Paid and completed both arrive: the second settles nothing.
    expect(await settle(String(p.id), 3480, String(p.provider_ref))).toMatchObject({ replayed: true });
    expect((await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws]))).toHaveLength(rows.length);
    // Another transaction, or another amount, never settles this row.
    const fresh = await recordCharge(id, txn(), 'subscription_recurring', 2900, renewalItem(2900));
    await expect(settle(String(fresh.id), 2900, 'txn_other')).rejects.toThrow(/billing_payment_reference_mismatch/);
    await expect(settle(String(fresh.id), 2800, String(fresh.provider_ref))).rejects.toThrow(/billing_payment_amount_mismatch/);
  });

  it('a card renewal that arrives after the period end, before the due step, starts the next period at once', async () => {
    const { ws, card: id } = await cardWorkspace();
    await makeDueWithoutPrepaid(ws);
    const end = (await sub(ws)).current_period_end as Date;
    const { settled } = await cardRenewal(id);
    expect(settled.purpose_result).toMatchObject({ action: 'renewed', card: true });
    const s = await sub(ws);
    expect(s.status).toBe('active');
    expect(new Date(s.current_period_start as string).getTime()).toBe(end.getTime());
  });

  it('each renewal guard leaves the money in the balance and says why', async () => {
    const kept = async (ws: string, settled: Row, error: string, net = PRO.monthly, before = 0) => {
      expect(settled.purpose_result).toEqual({ error });
      expect(await balanceOf(ws)).toBe(before + net);
      const p = await one(`SELECT status, purpose_result, review FROM public.billing_account_payments WHERE ledger_id = $1`, [settled.ledger_id]);
      // The reason is kept for a person to look at.
      expect(p).toMatchObject({ status: 'succeeded', purpose_result: { error }, review: error });
    };

    // The card was removed (not live) …
    const removed = await cardWorkspace();
    await setStatus(removed.card, 'canceled', 'removed');
    await kept(removed.ws, (await cardRenewal(removed.card)).settled, 'card_not_live');
    // … or is live but not the account's card.
    const moved = await cardWorkspace();
    await q(`UPDATE public.billing_accounts SET card_subscription_id = 'sub_elsewhere' WHERE workspace_id = $1`, [moved.ws]);
    await kept(moved.ws, (await cardRenewal(moved.card)).settled, 'card_not_live');
    // A duplicate card's charge.
    const dupWs = await cardWorkspace();
    const dup = String((await register('paddle_sandbox', subId(), null, 'USD', await setupPayment(dupWs.ws))).card_id);
    await kept(dupWs.ws, (await cardRenewal(dup)).settled, 'card_not_live');

    const off = await cardWorkspace();
    await q(`UPDATE public.billing_accounts SET auto_renew = false WHERE workspace_id = $1`, [off.ws]);
    await kept(off.ws, (await cardRenewal(off.card)).settled, 'auto_renew_off');

    // Renewed from the balance already.
    const early = await cardWorkspace({ balance: PRO.monthly });
    await fn(`SELECT public.billing_account_renew($1) AS r`, [early.ws]);
    await kept(early.ws, (await cardRenewal(early.card)).settled, 'already_renewed');
    // Or through billing v2.
    const v2 = await cardWorkspace();
    await q(
      `INSERT INTO public.billing_subscription_periods (workspace_id, plan_id, status, period_start, period_end, billing_interval, source)
       SELECT $1, plan_id, 'scheduled', current_period_end, current_period_end + interval '1 month', 'monthly', 'admin'
         FROM public.workspace_subscriptions WHERE workspace_id = $1`, [v2.ws]);
    await kept(v2.ws, (await cardRenewal(v2.card)).settled, 'already_renewed');

    const toFree = await cardWorkspace();
    await fn(`SELECT public.billing_account_schedule_change($1, $2, NULL) AS r`, [toFree.ws, freeId]);
    await kept(toFree.ws, (await cardRenewal(toFree.card)).settled, 'renewal_to_free');

    const soloId = await makePlan('c-solo', PRO);
    const unsold = await cardWorkspace({ plan: soloId });
    await q(`UPDATE public.billing_plans SET prices = '{}' WHERE id = $1`, [soloId]);
    await kept(unsold.ws, (await cardRenewal(unsold.card)).settled, 'price_unavailable');

    const short = await cardWorkspace();
    await kept(short.ws, (await cardRenewal(short.card, 2000)).settled, 'amount_below_price', 2000);

    // No paid plan, and the card was not cancelled for missing this payment.
    const lapsed = await cardWorkspace();
    await setStatus(lapsed.card, 'canceled', 'removed');
    await makeDue(lapsed.ws);
    expect(await processDue(lapsed.ws)).toMatchObject({ action: 'expired', reason: 'not_renewed' });
    await kept(lapsed.ws, (await cardRenewal(lapsed.card)).settled, 'no_paid_plan');
    expect((await sub(lapsed.ws)).status).toBe('expired');

    // A renewal row without a card.
    const orphan = await cardWorkspace();
    const t = txn();
    const p = await one(
      `INSERT INTO public.billing_account_payments
         (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'renewal', '{}', 'card_renewal', $2) RETURNING id`, [orphan.ws, t]);
    await kept(orphan.ws, await settle(String(p.id), 2900, t), 'card_not_found');
  });

  it('a renewal paid late, after the plan ended because the card had not paid, buys the plan again', async () => {
    const { ws, card: id } = await cardWorkspace({ balance: 10_000 });
    await makeDue(ws);
    expect(await processDue(ws)).toMatchObject({ action: 'expired', reason: 'card_not_paid' });
    expect(await card(id)).toMatchObject({ status: 'canceling', cancel_reason: 'not_renewed' });
    const { payment: p, settled } = await cardRenewal(id);
    expect(settled.purpose_result).toMatchObject({ action: 'purchase', plan_id: proId, card: true, late: true });
    expect(await sub(ws)).toMatchObject({ status: 'active', plan_id: proId });
    expect(await balanceOf(ws)).toBe(10_000);
    expect((await payment(String(p.id))).review).toBeNull();

    // Not when the card stopped because auto-renew was off: the money stays.
    const off = await cardWorkspace();
    await q(`UPDATE public.billing_accounts SET auto_renew = false WHERE workspace_id = $1`, [off.ws]);
    await makeDue(off.ws);
    expect(await processDue(off.ws)).toMatchObject({ action: 'expired', reason: 'not_renewed' });
    expect((await card(off.card)).cancel_reason).toBe('plan_ended');
    expect((await cardRenewal(off.card)).settled.purpose_result).toEqual({ error: 'no_paid_plan' });
    expect(await balanceOf(off.ws)).toBe(PRO.monthly);
  });

  // ─── The due moment ───────────────────────────────────────────────────────

  it('at the due moment a card renewal starts as the prepaid period (prepaid_card), and the card stays', async () => {
    const { ws, card: id, subscription } = await cardWorkspace();
    await cardRenewal(id);
    await makeDue(ws);
    expect(await processDue(ws)).toMatchObject({ action: 'renewed', prepaid: true, prepaid_card: true, plan_id: proId });
    expect((await sub(ws)).status).toBe('active');
    expect((await card(id)).status).toBe('active');
    expect(await account(ws)).toMatchObject({ card_subscription_id: subscription, auto_renew: true });
  });

  it('a live card that did not pay: Free at once, the balance untouched, the card returned to be cancelled', async () => {
    const { ws, card: id, subscription } = await cardWorkspace({ balance: 10_000 });
    await makeDue(ws);
    const r = await processDue(ws);
    expect(r).toMatchObject({
      action: 'expired', reason: 'card_not_paid', plan_id: proId, balance_minor: 10_000,
      card_cancel: { card_id: id, provider: 'paddle_sandbox', subscription_id: subscription },
    });
    expect(await balanceOf(ws)).toBe(10_000);
    expect(await sub(ws)).toMatchObject({ status: 'expired', plan_id: proId });
    expect(await card(id)).toMatchObject({ status: 'canceling', cancel_reason: 'not_renewed' });
    expect(await account(ws)).toMatchObject({ card_provider: null, card_subscription_id: null, card_customer_id: 'ctm_1', auto_renew: false });
    expect((await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1 AND kind = 'renewal'`, [ws]))).toHaveLength(0);

    // A past_due card the same.
    const late = await cardWorkspace({ balance: 10_000 });
    await setStatus(late.card, 'past_due');
    await makeDue(late.ws);
    expect(await processDue(late.ws)).toMatchObject({ action: 'expired', reason: 'card_not_paid', card_cancel: { card_id: late.card } });
  });

  it('a card with auto-renew off, or a change to Free, ends the plan and the card (plan_ended)', async () => {
    const off = await cardWorkspace({ balance: 10_000 });
    await q(`UPDATE public.billing_accounts SET auto_renew = false WHERE workspace_id = $1`, [off.ws]);
    await makeDue(off.ws);
    expect(await processDue(off.ws)).toMatchObject({ action: 'expired', reason: 'not_renewed', card_cancel: { card_id: off.card } });
    expect(await card(off.card)).toMatchObject({ status: 'canceling', cancel_reason: 'plan_ended' });

    const free = await cardWorkspace({ balance: PRO.monthly });
    await fn(`SELECT public.billing_account_renew($1) AS r`, [free.ws]);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, NULL) AS r`, [free.ws, freeId]);
    await makeDue(free.ws);
    expect(await processDue(free.ws)).toMatchObject({ action: 'expired', reason: 'changed_to_free', card_cancel: { card_id: free.card } });
    expect(await card(free.card)).toMatchObject({ status: 'canceling', cancel_reason: 'plan_ended' });
    // The prepayment came back when Free was chosen; nothing was spent.
    expect(await balanceOf(free.ws)).toBe(PRO.monthly);
  });

  it('without a live card the due moment is 261\'s: auto-renew from the balance, else Free; no card fields', async () => {
    const renewing = await makeWorkspace();
    await credit(renewing, PRO.monthly * 2);
    await purchase(renewing, proId);
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [renewing]);
    await makeDue(renewing);
    const renewed = await processDue(renewing);
    expect(renewed).toMatchObject({ action: 'renewed', auto_renew: true, amount_minor: PRO.monthly, balance_minor: 0 });
    expect(renewed).not.toHaveProperty('card_cancel');

    const broke = await makeWorkspace();
    await credit(broke, PRO.monthly);
    await purchase(broke, proId);
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [broke]);
    await makeDue(broke);
    const expired = await processDue(broke);
    expect(expired).toMatchObject({ action: 'expired', reason: 'insufficient_balance' });
    expect(expired).not.toHaveProperty('card_cancel');

    const manual = await makeWorkspace();
    await credit(manual, PRO.monthly * 3);
    await purchase(manual, proId);
    await makeDue(manual);
    expect(await processDue(manual)).toEqual({
      action: 'expired', reason: 'not_renewed', plan_id: proId, balance_minor: PRO.monthly * 2,
      expired_at: expect.anything(),
    });

    const prepaid = await makeWorkspace();
    await credit(prepaid, PRO.monthly * 2);
    await purchase(prepaid, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [prepaid]);
    await makeDue(prepaid);
    expect(await processDue(prepaid)).toMatchObject({ action: 'renewed', prepaid: true, prepaid_card: false });

    // A card that is no longer live does not stop the balance auto-renew.
    const removed = await cardWorkspace({ balance: PRO.monthly });
    await setStatus(removed.card, 'canceled', 'removed');
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [removed.ws]);
    await makeDue(removed.ws);
    expect(await processDue(removed.ws)).toMatchObject({ action: 'renewed', auto_renew: true });
  });

  it('an online renewal (not a card) paid after the plan ran out still buys the plan again', async () => {
    const ws = await makeWorkspace();
    await credit(ws, PRO.monthly);
    await purchase(ws, proId);
    const end = (await sub(ws)).current_period_end as Date;
    await makeDue(ws);
    await processDue(ws);
    const p = await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'renewal', $2) RETURNING id, source`,
      [ws, JSON.stringify({ plan_id: proId, billing_interval: 'monthly', period_end: end })]);
    expect(p.source).toBe('checkout');
    await q(`SELECT public.billing_account_record_verification($1, 2900, 'USD', $2)`, [p.id, txn()]);
    const settled = await fn(`SELECT public.billing_account_settle_payment($1) AS r`, [p.id]);
    expect(settled.purpose_result).toMatchObject({ action: 'purchase', plan_id: proId });
  });

  // ─── Reminders and pruning ────────────────────────────────────────────────

  it('no renewal reminder while an active card with auto-renew will pay a sold next period', async () => {
    const reminded = async (ws: string) =>
      (await q(`SELECT workspace_id FROM public.billing_account_reminder_candidates(7)`)).some((r) => r.workspace_id === ws);
    const endSoon = (ws: string) =>
      q(`UPDATE public.workspace_subscriptions SET current_period_end = now() + interval '3 days' WHERE workspace_id = $1`, [ws]);

    const { ws, card: id } = await cardWorkspace();
    await endSoon(ws);
    expect(await reminded(ws)).toBe(false);
    await setStatus(id, 'past_due');
    expect(await reminded(ws)).toBe(true);
    await setStatus(id, 'active');
    await q(`UPDATE public.billing_accounts SET auto_renew = false WHERE workspace_id = $1`, [ws]);
    expect(await reminded(ws)).toBe(true);

    // Without a card, as before: auto-renew without the balance for it is reminded.
    const plain = await makeWorkspace();
    await credit(plain, PRO.monthly);
    await purchase(plain, proId);
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [plain]);
    await endSoon(plain);
    expect(await reminded(plain)).toBe(true);
  });

  it('pruning keeps a card charge that may have been made and every renewal Paddle charged', async () => {
    const { ws, card: id } = await cardWorkspace();
    const insert = async (fields: Row) => {
      const all: Row = { workspace_id: ws, provider: 'paddle_sandbox', currency: 'USD', amount_minor: 1000, net_minor: 1000, ...fields };
      const cols = Object.keys(all);
      const row = await one(
        `INSERT INTO public.billing_account_payments (${cols.join(', ')}, created_at)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, now() - interval '40 days') RETURNING id`,
        Object.values(all));
      return String(row.id);
    };
    const asked = await insert({ source: 'card_charge', purpose: 'upgrade', card_id: id, charge_requested_at: ago(40 * 24 * HOUR) });
    const neverAsked = await insert({ source: 'card_charge', purpose: 'topup', card_id: id });
    const failedCharge = await insert({ source: 'card_charge', purpose: 'upgrade', card_id: id, charge_requested_at: ago(40 * 24 * HOUR), status: 'failed' });
    const renewal = await insert({ source: 'card_renewal', purpose: 'renewal', card_id: id, provider_ref: txn() });
    const checkout = await insert({ source: 'checkout', purpose: 'topup' });

    const pruned = Number((await one(`SELECT public.billing_account_prune_payments(30, ARRAY['paddle_sandbox']) AS n`)).n);
    expect(pruned).toBeGreaterThanOrEqual(3);
    const left = (await q(`SELECT id FROM public.billing_account_payments WHERE id = ANY($1)`, [[asked, neverAsked, failedCharge, renewal, checkout]]))
      .map((r) => r.id);
    expect(left.sort()).toEqual([asked, renewal].sort());
  });

  // ─── The reconciler ───────────────────────────────────────────────────────

  it('every change that decides what a card charges moves its sync_version; other changes do not', async () => {
    const { ws, card: id } = await cardWorkspace({ balance: PRO.monthly + BIZ.monthly });
    const version = async (cardId = id) => Number((await card(cardId)).sync_version);
    const bumps = async (action: () => Promise<unknown>, cardId = id) => {
      const before = await version(cardId);
      await action();
      return (await version(cardId)) - before;
    };
    const accountSet = (set: string) => () => q(`UPDATE public.billing_accounts SET ${set} WHERE workspace_id = $1`, [ws]);
    const subSet = (set: string, params: unknown[] = []) => () =>
      q(`UPDATE public.workspace_subscriptions SET ${set} WHERE workspace_id = $1`, [ws, ...params]);

    // billing_accounts: auto-renew, the scheduled change, the prepaid next period; not the balance.
    expect(await bumps(accountSet('auto_renew = false'))).toBe(1);
    expect(await bumps(accountSet('auto_renew = true'))).toBe(1);
    expect(await bumps(accountSet('auto_renew = true'))).toBe(0);
    expect(await bumps(() => credit(ws, 100))).toBe(0);
    expect(await bumps(accountSet(`billing_profile = '{"company":"X"}'`))).toBe(0);
    expect(await bumps(() => fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, bizId]))).toBe(1);
    expect(await bumps(() => fn(`SELECT public.billing_account_schedule_change($1, $2, 'yearly') AS r`, [ws, proId]))).toBe(1);
    expect(await bumps(() => fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, proId]))).toBe(1);
    expect(await bumps(() => fn(`SELECT public.billing_account_renew($1) AS r`, [ws]))).toBeGreaterThanOrEqual(1);
    expect(await bumps(accountSet(`next_period_start = next_period_start + interval '1 second'`))).toBe(1);
    expect(await bumps(accountSet(`next_period_start = next_period_start - interval '1 second'`))).toBe(1);

    // workspace_subscriptions: plan, status, interval, period end; nothing else.
    expect(await bumps(subSet(`current_period_end = current_period_end + interval '1 day'`))).toBe(1);
    expect(await bumps(subSet(`plan_id = $2`, [bizId]))).toBe(1);
    expect(await bumps(subSet(`plan_id = $2`, [proId]))).toBe(1);
    expect(await bumps(subSet(`billing_interval = 'yearly'`))).toBe(1);
    expect(await bumps(subSet(`billing_interval = 'monthly', status = 'past_due'`))).toBe(1);
    expect(await bumps(subSet(`status = 'active'`))).toBe(1);
    expect(await bumps(subSet(`metadata = coalesce(metadata, '{}'::jsonb) || '{"x":1}'`))).toBe(0);
    expect(await bumps(subSet(`billing_interval = 'monthly'`))).toBe(0);

    // billing_plans: the prices or availability of the plan it is on, or the one scheduled next.
    const planSet = (planId: string, set: string) => () => q(`UPDATE public.billing_plans SET ${set} WHERE id = $1`, [planId]);
    expect(await bumps(planSet(proId, 'is_hidden = true'))).toBe(1);
    expect(await bumps(planSet(proId, 'is_hidden = false'))).toBe(1);
    expect(await bumps(planSet(proId, 'is_active = is_active, prices = prices, sort_order = sort_order + 1'))).toBe(0);
    const bizPrice = (cents: number) => () =>
      q(`UPDATE public.billing_plans SET prices = $2 WHERE id = $1`, [bizId, JSON.stringify({ USD: { ...BIZ, monthly: cents } })]);
    // Biz is nobody's plan here yet; once it is scheduled next, its prices count.
    expect(await bumps(bizPrice(9902))).toBe(0);
    expect(await bumps(bizPrice(BIZ.monthly))).toBe(0);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, bizId]);
    expect((await account(ws)).scheduled_plan_id).toBe(bizId);
    expect(await bumps(bizPrice(9902))).toBe(1);
    expect(await bumps(bizPrice(BIZ.monthly))).toBe(1);
    const unused = await makePlan('c-unused', PRO);
    expect(await bumps(planSet(unused, 'is_active = false'))).toBe(0);

    // billing_settings: the VAT percent, for every card that is not cancelled.
    const settingsSet = (set: string, params: unknown[] = []) => () =>
      q(`UPDATE public.billing_settings SET ${set} WHERE edition = 'international'`, params);
    expect(await bumps(settingsSet(`vat_percent = '{"USD": 21}'`))).toBe(1);
    expect(await bumps(settingsSet(`vat_percent = vat_percent`))).toBe(0);
    expect(await bumps(settingsSet(`receipt_prefix = 'RS'`))).toBe(0);
    expect(await bumps(settingsSet(`vat_percent = $1`, [JSON.stringify({ USD: VAT })]))).toBe(1);

    // A canceled card is never touched; a canceling one is.
    const canceling = String((await register('paddle_sandbox', subId(), null, 'USD', await setupPayment(ws))).card_id);
    const canceled = String((await register('paddle_sandbox', subId(), null, 'USD', await setupPayment(ws))).card_id);
    await setStatus(canceled, 'canceled', 'duplicate_canceled');
    const versions = async () => [await version(id), await version(canceling), await version(canceled)];
    const before = await versions();
    await accountSet('auto_renew = false')();
    expect(await versions()).toEqual([before[0] + 1, before[1] + 1, before[2]]);

    // A touch cuts a back-off short.
    await q(`UPDATE public.billing_account_cards SET next_sync_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    await accountSet('auto_renew = true')();
    expect(new Date((await card(id)).next_sync_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // A subscription row written for the first time.
    const fresh = await makeWorkspace();
    const freshCard = String((await register('paddle_sandbox', subId(), null, 'USD', await setupPayment(fresh))).card_id);
    expect(await bumps(() => q(
      `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', 'monthly', now(), now() + interval '1 month')`, [fresh, proId]), freshCard)).toBe(1);
  });

  it('the reconciler\'s queue: changed, canceling, never synced, stale or overdue cards, oldest first; back-off waits', async () => {
    const synced = { sync_version: 4, synced_version: 4, synced_at: ago(HOUR), next_sync_at: ago(HOUR), paddle_next_billed_at: ago(-20 * 24 * HOUR) };
    const changed = await rawCard({ ...synced, sync_version: 5, next_sync_at: ago(3 * HOUR) });
    const quiet = await rawCard(synced);
    const stale = await rawCard({ ...synced, synced_at: ago(7 * HOUR), next_sync_at: ago(2 * HOUR) });
    const overdue = await rawCard({ ...synced, paddle_next_billed_at: ago(2 * HOUR) });
    const canceling = await rawCard({ ...synced, status: 'canceling', next_sync_at: ago(30 * 60_000) });
    const canceled = await rawCard({ ...synced, status: 'canceled', sync_version: 9 });
    const backingOff = await rawCard({ ...synced, sync_version: 5, next_sync_at: ago(-30 * 60_000) });
    const never = await rawCard({ synced_at: null, next_sync_at: ago(4 * HOUR) });
    const ours = new Set([changed, quiet, stale, overdue, canceling, canceled, backingOff, never]);

    const ids = (await q(`SELECT id FROM public.billing_card_sync_candidates(1000)`)).map((r) => String(r.id)).filter((x) => ours.has(x));
    expect(ids).toEqual([never, changed, stale, overdue, canceling]);
    const full = await one(`SELECT * FROM public.billing_card_sync_candidates(1000) WHERE id = $1`, [changed]);
    expect(full).toMatchObject({ id: changed, provider: 'paddle_sandbox', currency: 'USD', sync_version: '5' });
    expect(await q(`SELECT id FROM public.billing_card_sync_candidates(1)`)).toHaveLength(1);
  });

  it('a sync result is written by compare-and-set; errors back off 2^n minutes, at most an hour', async () => {
    const id = await rawCard({ sync_version: 3, brand: 'mastercard' });
    const secondsUntilNext = async () =>
      Number((await one(`SELECT extract(epoch FROM next_sync_at - now())::float AS s FROM public.billing_account_cards WHERE id = $1`, [id])).s);
    const mark = (version: number, mirror: Row = {}, error: string | null = null) =>
      one(`SELECT public.billing_card_mark_synced($1, $2, $3, $4) AS ok`, [id, version, JSON.stringify(mirror), error]).then((r) => r.ok);

    // The version moved during the sync: not marked, synced again at once.
    expect(await mark(2, { paddle_status: 'active' })).toBe(false);
    expect(await card(id)).toMatchObject({ synced_version: '0', paddle_status: 'active', sync_error: null });
    expect(await secondsUntilNext()).toBeLessThanOrEqual(1);

    const next = new Date(Date.now() + 20 * 24 * HOUR).toISOString();
    expect(await mark(3, {
      paddle_status: 'active', paddle_next_billed_at: next, paddle_scheduled_change: { action: 'cancel', effective_at: next },
      paddle_item: { price: 2900 }, customer_id: 'ctm_9', last4: '4242', exp_month: 12, exp_year: '2031', cancel_intent: 'period_end',
    })).toBe(true);
    const c = await card(id);
    expect(c).toMatchObject({
      synced_version: '3', sync_error: null, sync_failures: 0, paddle_status: 'active', customer_id: 'ctm_9',
      brand: 'mastercard', last4: '4242', exp_month: 12, exp_year: 2031, cancel_intent: 'period_end',
      paddle_scheduled_change: { action: 'cancel', effective_at: next }, paddle_item: { price: 2900 },
    });
    expect(new Date(c.paddle_next_billed_at as string).toISOString()).toBe(next);
    expect(c.synced_at).not.toBeNull();
    expect(await secondsUntilNext()).toBeGreaterThan(6 * 3600 - 60);
    // A key given as null clears it; keys left out stay.
    expect(await mark(3, { paddle_scheduled_change: null })).toBe(true);
    expect(await card(id)).toMatchObject({ paddle_scheduled_change: null, cancel_intent: 'period_end', last4: '4242' });

    // Errors: 1, 2, 4 … minutes, capped at an hour; the message is kept short.
    expect(await mark(3, {}, 'x'.repeat(600))).toBe(false);
    expect(await card(id)).toMatchObject({ sync_failures: 1, synced_version: '3' });
    expect(String((await card(id)).sync_error)).toHaveLength(500);
    expect(await secondsUntilNext()).toBeGreaterThan(50);
    expect(await secondsUntilNext()).toBeLessThanOrEqual(60);
    expect(await mark(3, {}, 'again')).toBe(false);
    expect(await secondsUntilNext()).toBeGreaterThan(110);
    expect(await secondsUntilNext()).toBeLessThanOrEqual(120);
    await q(`UPDATE public.billing_account_cards SET sync_failures = 12 WHERE id = $1`, [id]);
    await mark(3, {}, 'still');
    expect(await secondsUntilNext()).toBeGreaterThan(3540);
    expect(await secondsUntilNext()).toBeLessThanOrEqual(3600);
    // A success clears the failures.
    expect(await mark(3)).toBe(true);
    expect(await card(id)).toMatchObject({ sync_failures: 0, sync_error: null });

    await expect(one(`SELECT public.billing_card_mark_synced($1, 1) AS ok`, [randomUUID()])).rejects.toThrow(/billing_card_not_found/);
  });

  // ─── Workspace deleted; indexes ───────────────────────────────────────────

  it('a deleted workspace\'s live card is marked canceling for the job; nothing fails', async () => {
    const { ws, card: id } = await cardWorkspace();
    const dup = String((await register('paddle_sandbox', subId(), null, 'USD', await setupPayment(ws))).card_id);
    const old = await rawCard({ workspace_id: ws, status: 'canceled', cancel_reason: 'removed' });
    const before = Number((await card(id)).sync_version);
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [ws]);
    const live = await card(id);
    expect(live).toMatchObject({ status: 'canceling', cancel_reason: 'workspace_deleted', setup_payment_id: null });
    expect(Number(live.sync_version)).toBe(before + 1);
    expect(await card(dup)).toMatchObject({ status: 'canceling', cancel_reason: 'duplicate' });
    expect(await card(old)).toMatchObject({ status: 'canceled', cancel_reason: 'removed' });
    expect(await q(`SELECT 1 FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    // Its card can still be cancelled, and a late charge on it is refused, not lost silently.
    expect(await setStatus(id, 'canceled')).toMatchObject({ status: 'canceled', changed: true });
    await expect(recordCharge(id, txn(), 'subscription_recurring', 2900, renewalItem(2900))).rejects.toThrow(/billing_card_workspace_missing/);

    // A workspace without a card is deleted as before.
    const plain = await makeWorkspace();
    await credit(plain, 100);
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [plain]);
    expect(await q(`SELECT 1 FROM public.workspaces WHERE id = $1`, [plain])).toHaveLength(0);
  });

  it('one live card per workspace, and one upgrade charge in flight per workspace', async () => {
    const ws = randomUUID();
    await rawCard({ workspace_id: ws, status: 'active' });
    await expect(rawCard({ workspace_id: ws, status: 'past_due' })).rejects.toThrow(/uq_billing_account_cards_live/);
    await rawCard({ workspace_id: ws, status: 'canceling' });
    await rawCard({ workspace_id: ws, status: 'canceled' });
    const sameSub = `sub_same_${randomUUID()}`;
    await rawCard({ subscription_id: sameSub });
    await expect(rawCard({ subscription_id: sameSub })).rejects.toThrow(/uq_billing_account_cards_subscription/);
    await rawCard({ subscription_id: sameSub, provider: 'paddle' });

    const { ws: w, card: id } = await cardWorkspace();
    const charge = (status = 'pending', purpose = 'upgrade') => q(
      `INSERT INTO public.billing_account_payments
         (workspace_id, provider, currency, amount_minor, net_minor, purpose, source, card_id, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 7000, 7000, $2, 'card_charge', $3, $4) RETURNING id`, [w, purpose, id, status]);
    const [first] = await charge();
    await expect(charge()).rejects.toThrow(/uq_billing_account_payments_card_charge/);
    await charge('pending', 'topup');
    await charge('failed');
    await q(`UPDATE public.billing_account_payments SET status = 'failed' WHERE id = $1`, [first.id]);
    await charge();
    await expect(q(`UPDATE public.billing_account_payments SET source = 'card' WHERE id = $1`, [first.id]))
      .rejects.toThrow(/billing_account_payments_source_check/);
    await expect(rawCard({ status: 'paused' })).rejects.toThrow(/billing_account_cards_status_check/);
    await expect(rawCard({ provider: 'stripe' })).rejects.toThrow(/billing_account_cards_provider_check/);
    await expect(rawCard({ cancel_intent: 'later' })).rejects.toThrow(/billing_account_cards_cancel_intent_check/);
    expect((await one(`SELECT source FROM public.billing_account_payments WHERE id = $1`, [first.id])).source).toBe('card_charge');
  });

  // ─── Emails, access, running again ────────────────────────────────────────

  it('the card emails exist in both editions (only Multi Region sends them), in fa/en/tr, with their variables', async () => {
    const rows = await q(
      `SELECT edition, slug, locale, subject, html_body, text_body FROM public.email_templates
        WHERE workspace_id IS NULL AND slug IN ('billing_card_payment_failed', 'billing_card_removed') ORDER BY 1, 2, 3`);
    expect(rows.map((r) => [r.edition, r.slug, r.locale])).toEqual(
      ['international', 'iran'].flatMap((edition) =>
        ['billing_card_payment_failed', 'billing_card_removed'].flatMap((slug) =>
          ['en', 'fa', 'tr'].map((locale) => [edition, slug, locale]))),
    );
    const vars: Record<string, string[]> = {
      billing_card_payment_failed: ['{plan_name}', '{amount}', '{card}', '{failure_reason}', '{due_at}', '{billing_url}'],
      billing_card_removed: ['{card}', '{reason}', '{plan_name}', '{period_end}', '{billing_url}'],
    };
    for (const r of rows) {
      for (const v of vars[String(r.slug)]) expect(String(r.html_body), `${r.slug}/${r.locale} ${v}`).toContain(v);
      expect(String(r.subject)).toContain('{brand}');
      expect(String(r.html_body)).toContain(r.locale === 'fa' ? 'dir="rtl"' : 'dir="ltr"');
      expect(String(r.text_body)).toContain('{card}');
    }
  });

  it('only service_role reaches the card table and functions', async () => {
    for (const f of [
      'public.billing_card_register(text, text, text, text, uuid)',
      'public.billing_card_set_status(uuid, text, text)',
      'public.billing_card_record_charge(uuid, text, text, bigint, text, jsonb, uuid)',
      'public.billing_card_settle(uuid, bigint, text, text)',
      'public.billing_card_apply_renewal(public.billing_account_payments)',
      'public.billing_card_sync_candidates(integer)',
      'public.billing_card_mark_synced(uuid, bigint, jsonb, text)',
      'public.billing_card_touch_workspace(uuid)',
      'public.billing_account_settle_payment(uuid)',
      'public.billing_account_process_due(uuid)',
      'public.billing_account_reminder_candidates(integer)',
      'public.billing_account_prune_payments(integer, text[])',
    ]) {
      const r = await one(
        `SELECT has_function_privilege('anon', $1, 'execute') AS anon,
                has_function_privilege('authenticated', $1, 'execute') AS auth,
                has_function_privilege('service_role', $1, 'execute') AS svc`, [f]);
      expect(r, f).toEqual({ anon: false, auth: false, svc: true });
    }
    expect(await one(
      `SELECT has_table_privilege('anon', 'public.billing_account_cards', 'select') AS anon,
              has_table_privilege('authenticated', 'public.billing_account_cards', 'select') AS auth,
              has_table_privilege('service_role', 'public.billing_account_cards', 'select') AS svc,
              (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing_account_cards'::regclass) AS rls`,
    )).toEqual({ anon: false, auth: false, svc: true, rls: true });
  });

  it('running 262 again adds or changes nothing, and keeps an edited template', async () => {
    await q(`UPDATE public.email_templates SET subject = 'EDITED'
              WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'billing_card_removed' AND locale = 'en'`);
    const snapshot = async () => ({
      templates: await q(`SELECT edition, slug, locale, subject, md5(html_body) AS h FROM public.email_templates WHERE workspace_id IS NULL ORDER BY 1, 2, 3`),
      cards: await q(`SELECT id, status, sync_version, next_sync_at, updated_at FROM public.billing_account_cards ORDER BY id`),
      payments: await q(`SELECT id, source, status, updated_at FROM public.billing_account_payments ORDER BY id`),
      accounts: await q(`SELECT workspace_id, auto_renew, card_subscription_id, updated_at FROM public.billing_accounts ORDER BY 1`),
      functions: await q(
        `SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS h, p.proacl::text AS acl FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'billing_card%' OR p.proname LIKE 'billing_account%')
          ORDER BY 1`),
      triggers: await q(`SELECT tgrelid::regclass::text AS t, tgname, md5(pg_get_triggerdef(oid)) AS h FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
      indexes: await q(`SELECT indexname, md5(indexdef) AS h FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
      constraints: await q(`SELECT conname FROM pg_constraint WHERE conrelid IN ('public.billing_account_cards'::regclass, 'public.billing_account_payments'::regclass) ORDER BY 1`),
      columns: await q(`SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name IN ('billing_account_cards', 'billing_account_payments') ORDER BY 1, 2`),
      policies: await q(`SELECT tablename, policyname FROM pg_policies WHERE tablename = 'billing_account_cards'`),
    });
    const before = await snapshot();
    expect(before.cards.length).toBeGreaterThan(0);
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(await snapshot()).toEqual(before);
    expect((await one(
      `SELECT subject FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = 'international' AND slug = 'billing_card_removed' AND locale = 'en'`,
    )).subject).toBe('EDITED');
  });
});
