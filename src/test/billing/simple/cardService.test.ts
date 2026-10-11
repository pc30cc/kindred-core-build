/**
 * The saved card's service (server/services/billing/account/card.ts, phase
 * 3b) over an in-memory database and a stubbed Paddle API (`fetch`): the
 * order of what it asks Paddle and writes here, not the SQL (that is
 * simpleBillingCardSql.pg.test.ts).
 *
 *   - the reconciler never bills: every PATCH is previewed with do_not_bill,
 *     a preview that bills stops it (P4); a cancel Paddle shows that we did
 *     not ask for is followed, never undone; a date is never moved earlier
 *     over a renewal Paddle charged that we have not recorded;
 *   - an upgrade charge is asked for once per payment row, after the row
 *     says so (charge_requested_at); an unknown outcome is never re-posted;
 *   - stop actions ask Paddle first (P7), with our intent recorded before;
 *   - card events: a declined renewal marks the card past_due and mails once
 *     per transaction; a paid one is recorded once and settled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type PaddleReply = { status?: number; body: unknown };

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  timeline: [] as string[],
  rpcCalls: [] as Array<{ name: string; args: Row }>,
  paddleCalls: [] as Array<{ method: string; path: string; body: unknown }>,
  notices: new Set<string>(),
  emails: [] as Array<{ slug: string; data: Record<string, string> }>,
  /** Overrides of the fake Paddle, per "METHOD path" (path without query). */
  paddleOverride: {} as Record<string, (body: unknown) => PaddleReply>,
  gatewayConfig: {} as Row | null,
  closeCheckout: vi.fn(),
  verifyPayment: vi.fn(),
  plans: { paidPeriodOf: vi.fn(), quotePlanChange: vi.fn(), renewPlan: vi.fn() },
  accountGateways: vi.fn(),
  afterSettlement: vi.fn(),
  edition: 'international' as 'international' | 'iran',
  regionMode: 'multi',
  purposeResult: null as Row | null,
}));

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../../server/services/billing/index.js', () => ({
  getProvider: (name: string) => ({ name, verifyPayment: h.verifyPayment }),
  resolveNamedBillingConfig: async (_url: string, _key: string, _ws: string, name: string) =>
    h.gatewayConfig === null
      ? null
      : { provider: { name, closeCheckout: h.closeCheckout }, config: { provider: name, ...h.gatewayConfig } },
}));
vi.mock('../../../../server/services/platformRegion.js', () => ({
  EditionUnavailableError: class extends Error {},
  getPlatformEdition: async () => h.edition,
  getPlatformEditionOrNull: async () => h.edition,
  getPlatformRegionMode: async () => h.regionMode,
}));
vi.mock('../../../../server/services/billing/account/notify.js', () => ({
  sendBillingEmail: async (_c: unknown, _ws: string, slug: string, build: (ctx: unknown) => Record<string, string>) => {
    const ctx = { locale: 'en', edition: 'international', money: (m: number, c: string) => `${m} ${c}`, date: (d: string | null) => String(d ?? ''), number: String };
    h.emails.push({ slug, data: build(ctx) });
    return { sent: true };
  },
  planNamesFor: async (_c: unknown, ids: Array<string | null | undefined>) =>
    new Map(ids.filter(Boolean).map((id) => [id as string, { name: id === PRO ? 'Pro' : 'Team', localized: {} }])),
  localizedPlanName: (plan: { name: string } | undefined) => plan?.name ?? '',
}));
vi.mock('../../../../server/services/billing/account/effects.js', () => ({ afterAccountSettlement: h.afterSettlement }));
vi.mock('../../../../server/services/billing/account/gateways.js', () => ({ accountGateways: h.accountGateways }));
vi.mock('../../../../server/services/billing/account/plans.js', () => ({
  paidPeriodOf: h.plans.paidPeriodOf,
  quotePlanChange: h.plans.quotePlanChange,
  renewPlan: h.plans.renewPlan,
  quoteNetMinor: (q: { amount_minor: number; returned_minor: number }) => q.amount_minor - q.returned_minor,
}));

const card = await import('../../../../server/services/billing/account/card.js');
const { CARD_RENEWAL_LEAD_MS } = await import('../../../../shared/simpleBilling.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CFG = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key' } as never;
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SETUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRO = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const SUB = 'sub_01test';
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
let E = 0;
let seq = 0;
const uuid = () => `eeeeeeee-eeee-4eee-8eee-${String(++seq).padStart(12, '0')}`;

const table = (name: string): Row[] => (h.db[name] ??= []);
const cardRow = () => table('billing_account_cards').find((r) => r.id === CARD) as Row;
const accountRow = () => table('billing_accounts')[0];
const payments = () => table('billing_account_payments');

/** What Paddle holds for SUB. */
const paddle = {
  sub: {} as Row,
  txns: [] as Row[],
  charges: 0,
};

function priceJson(amount: number, interval: 'month' | 'year', custom: Row) {
  return { id: 'pri_1', unit_price: { amount: String(amount), currency_code: 'USD' }, billing_cycle: { interval, frequency: 1 }, custom_data: custom };
}

function txnJson(over: Row): Row {
  const amount = String(over.amount ?? 2900);
  return {
    id: over.id,
    status: over.status ?? 'completed',
    origin: over.origin ?? 'subscription_recurring',
    subscription_id: SUB,
    customer_id: 'ctm_1',
    currency_code: 'USD',
    created_at: over.created_at ?? iso(Date.now()),
    billed_at: over.billed_at ?? over.created_at ?? iso(Date.now()),
    details: { totals: { total: amount, grand_total: amount, credit: '0' } },
    items: [{ price: { custom_data: over.custom ?? { plan_id: PRO, interval: 'monthly', net_minor: 2900, tax_minor: 0 } } }],
    custom_data: { workspace_id: W, card_id: CARD },
    payments: over.payments ?? [{ status: 'captured', created_at: iso(Date.now()), method_details: { card: { type: 'visa', last4: '4242', expiry_month: 12, expiry_year: 2030 } } }],
  };
}

function seed(over: { cardStatus?: string; autoRenew?: boolean; paddleNext?: number; cancelIntent?: string | null } = {}) {
  E = Date.now() + 10 * D;
  h.db = {
    workspaces: [{ id: W, name: 'Acme' }],
    billing_plans: [
      { id: PRO, name: 'Pro', localized: {}, is_free: false, prices: { USD: { monthly: 2900, yearly: 29000 } } },
      { id: TEAM, name: 'Team', localized: {}, is_free: false, prices: { USD: { monthly: 7900 } } },
    ],
    billing_settings: [{ edition: 'international', seller: {}, vat_percent: { USD: null }, receipt_prefix: 'RS', ai_packs: {} }],
    billing_accounts: [{
      workspace_id: W, currency: 'USD', balance_minor: 0, auto_renew: over.autoRenew ?? true,
      scheduled_plan_id: null, scheduled_interval: null, next_period_prepaid_minor: null, next_period_start: null,
      card_provider: 'paddle_sandbox', card_subscription_id: SUB, card_customer_id: 'ctm_1', billing_profile: {},
      created_at: iso(Date.now() - 40 * D), updated_at: iso(Date.now()),
    }],
    workspace_subscriptions: [{ workspace_id: W, plan_id: PRO, status: 'active', billing_interval: 'monthly', current_period_end: iso(E) }],
    billing_account_cards: [{
      id: CARD, workspace_id: W, provider: 'paddle_sandbox', subscription_id: SUB, customer_id: 'ctm_1', currency: 'USD',
      setup_payment_id: SETUP, status: over.cardStatus ?? 'active', cancel_reason: null, cancel_intent: over.cancelIntent ?? null,
      brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, paddle_status: 'active',
      paddle_next_billed_at: iso(over.paddleNext ?? E - D), paddle_scheduled_change: null, paddle_item: null,
      sync_version: 2, synced_version: 0, synced_at: null, sync_error: null, sync_failures: 0, next_sync_at: iso(Date.now()),
      last_failure: null, created_at: iso(Date.now() - 20 * D), updated_at: iso(Date.now()), canceled_at: null,
    }],
    billing_account_payments: [{
      id: SETUP, workspace_id: W, provider: 'paddle_sandbox', currency: 'USD', amount_minor: 2900, net_minor: 2900, tax_minor: 0,
      tax_percent: null, purpose: 'plan', purpose_detail: { plan_id: PRO, billing_interval: 'monthly' }, purpose_result: null,
      status: 'succeeded', provider_ref: 'txn_checkout', provider_payment_id: 'txn_checkout', failure_reason: null,
      ledger_id: 'l0', created_by: null, created_at: iso(Date.now() - 20 * D), updated_at: '', completed_at: iso(Date.now() - 20 * D),
      verified_amount_minor: 2900, verified_at: iso(Date.now() - 20 * D), refunded_minor: 0, closed_at: null,
      source: 'card_setup', card_id: CARD, charge_requested_at: null, review: null,
    }],
  };
  paddle.sub = {
    id: SUB, status: 'active', customer_id: 'ctm_1', currency_code: 'USD',
    next_billed_at: iso(over.paddleNext ?? E - D), current_billing_period: { ends_at: iso(over.paddleNext ?? E - D) },
    scheduled_change: null,
    items: [{ price: priceJson(2900, 'month', { plan_id: PRO, interval: 'monthly', net_minor: 2900, tax_minor: 0 }) }],
    custom_data: { workspace_id: W, card_id: CARD },
  };
  paddle.txns = [];
  paddle.charges = 0;
}

// ─── The in-memory database ─────────────────────────────────────────────────

function fakeClient() {
  return {
    from: (name: string) => query(name),
    rpc: async (name: string, args: Row) => {
      h.rpcCalls.push({ name, args });
      h.timeline.push(`rpc:${name}`);
      return rpcImpl(name, args);
    },
  };
}

function query(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'update' | 'insert' = 'select';
  let patch: Row = {};
  let rows: Row[] = [];
  let order: [string, boolean] | null = null;
  let limit = Infinity;
  const cmp = (a: unknown, b: unknown) => String(a) < String(b);
  const run = async (): Promise<{ data: unknown; error: unknown }> => {
    const all = table(name);
    if (op === 'insert') {
      for (const r of rows) {
        if (name === 'billing_account_payments' && r.source === 'card_charge' && r.purpose === 'upgrade' && r.status === 'pending'
            && all.some((p) => p.workspace_id === r.workspace_id && p.source === 'card_charge' && p.purpose === 'upgrade' && p.status === 'pending')) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_billing_account_payments_card_charge"' } };
        }
      }
      const added = rows.map((r) => ({ id: uuid(), created_at: iso(Date.now()), provider_ref: null, provider_payment_id: null, verified_at: null, purpose_result: null, ledger_id: null, refunded_minor: 0, charge_requested_at: null, ...r }));
      all.push(...added);
      h.timeline.push(`insert:${name}`);
      return { data: added.map((r) => ({ ...r })), error: null };
    }
    let hit = all.filter((r) => filters.every((f) => f(r)));
    if (op === 'update') {
      hit.forEach((r) => Object.assign(r, patch));
      h.timeline.push(`update:${name}:${Object.keys(patch).filter((k) => k !== 'updated_at').join(',')}`);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (order) {
      const [key, asc] = order;
      hit = [...hit].sort((a, b) => (cmp(a[key], b[key]) ? -1 : cmp(b[key], a[key]) ? 1 : 0) * (asc ? 1 : -1));
    }
    return { data: hit.slice(0, limit).map((r) => ({ ...r })), error: null };
  };
  const one = async () => {
    const { data, error } = await run();
    return { data: Array.isArray(data) ? data[0] ?? null : data, error };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
    lt: (k: string, v: unknown) => (filters.push((r) => r[k] != null && cmp(r[k], v)), b),
    lte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && !cmp(v, r[k])), b),
    gte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && !cmp(r[k], v)), b),
    order: (k: string, o?: { ascending?: boolean }) => ((order = [k, o?.ascending !== false]), b),
    limit: (n: number) => ((limit = n), b),
    update: (p: Row) => ((op = 'update'), (patch = p), b),
    insert: (r: Row | Row[]) => ((op = 'insert'), (rows = Array.isArray(r) ? r : [r]), b),
    maybeSingle: one,
    single: one,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
  };
  return b;
}

function rpcImpl(name: string, a: Row): { data: unknown; error: unknown } {
  const now = iso(Date.now());
  switch (name) {
    case 'billing_card_mark_synced': {
      const c = table('billing_account_cards').find((r) => r.id === a.p_card_id) as Row;
      Object.assign(c, a.p_mirror as Row);
      const covered = !a.p_error && c.sync_version === a.p_version;
      if (a.p_error) Object.assign(c, { sync_error: a.p_error, sync_failures: Number(c.sync_failures) + 1 });
      else Object.assign(c, { synced_at: now, sync_error: null, sync_failures: 0, ...(covered ? { synced_version: a.p_version } : {}) });
      return { data: covered, error: null };
    }
    case 'billing_card_set_status': {
      const c = table('billing_account_cards').find((r) => r.id === a.p_card_id) as Row;
      const previous = c.status;
      if (previous === a.p_status || previous === 'canceled') return { data: { changed: false, status: previous }, error: null };
      if (previous === 'canceling' && (a.p_status === 'active' || a.p_status === 'past_due')) {
        return { data: null, error: { message: 'billing_card_status_invalid' } };
      }
      c.status = a.p_status;
      if (a.p_status === 'canceling' || a.p_status === 'canceled') {
        c.cancel_reason = c.cancel_reason ?? a.p_reason ?? null;
        const acc = accountRow();
        if (acc.card_subscription_id === c.subscription_id) Object.assign(acc, { card_provider: null, card_subscription_id: null, auto_renew: false });
      }
      return { data: { changed: true, status: a.p_status, previous_status: previous }, error: null };
    }
    case 'billing_card_record_charge': {
      const existing = payments().find((p) => p.provider_ref === a.p_txn_id || p.provider_payment_id === a.p_txn_id);
      if (existing) return { data: { ...existing }, error: null };
      if (a.p_origin === 'subscription_charge' && a.p_payment_id) {
        const own = payments().find((p) => p.id === a.p_payment_id && p.status === 'pending' && p.amount_minor === a.p_amount_minor && !p.provider_ref);
        if (own) {
          own.provider_ref = a.p_txn_id;
          return { data: { ...own }, error: null };
        }
      }
      const item = (a.p_items as Row[])[0] ?? {};
      const renewal = a.p_origin === 'subscription_recurring' && Number(item.net_minor) + Number(item.tax_minor ?? 0) === a.p_amount_minor;
      const row: Row = {
        id: uuid(), workspace_id: W, provider: 'paddle_sandbox', currency: 'USD', amount_minor: a.p_amount_minor,
        net_minor: renewal ? item.net_minor : a.p_amount_minor, tax_minor: renewal ? item.tax_minor ?? 0 : 0, tax_percent: null,
        purpose: renewal ? 'renewal' : 'topup', purpose_detail: renewal ? { plan_id: item.plan_id, billing_interval: 'monthly', card_id: a.p_card_id } : { card_id: a.p_card_id },
        purpose_result: null, status: 'pending', provider_ref: a.p_txn_id, provider_payment_id: null, failure_reason: null,
        ledger_id: null, created_by: null, created_at: now, updated_at: now, verified_at: null, refunded_minor: 0,
        source: renewal ? 'card_renewal' : 'card_charge', card_id: a.p_card_id, charge_requested_at: null,
        review: renewal ? null : `unexpected_charge:${String(a.p_origin)}`,
      };
      payments().push(row);
      return { data: { ...row }, error: null };
    }
    case 'billing_card_settle': {
      const p = payments().find((r) => r.id === a.p_payment_id) as Row;
      if (p.status === 'succeeded') return { data: { replayed: true, payment_id: p.id, ledger_id: p.ledger_id }, error: null };
      const result = h.purposeResult ?? (p.purpose === 'upgrade' ? { action: 'upgraded' } : p.purpose === 'renewal' ? { action: 'prepaid', card: true } : null);
      Object.assign(p, { status: 'succeeded', provider_payment_id: a.p_txn_id, verified_at: now, ledger_id: `l-${p.id}`, purpose_result: result });
      return { data: { replayed: false, payment_id: p.id, ledger_id: p.ledger_id, receipt_number: 'RS-1', balance_minor: 0, purpose: p.purpose, purpose_result: result }, error: null };
    }
    case 'billing_card_register': {
      const found = table('billing_account_cards').find((r) => r.subscription_id === a.p_subscription_id);
      if (found) return { data: { card_id: found.id, workspace_id: W, live: true, duplicate: false, replayed: true }, error: null };
      const live = !table('billing_account_cards').some((r) => r.status === 'active' || r.status === 'past_due');
      const id = uuid();
      table('billing_account_cards').push({
        id, workspace_id: W, provider: a.p_provider, subscription_id: a.p_subscription_id, customer_id: a.p_customer_id, currency: 'USD',
        setup_payment_id: a.p_setup_payment_id, status: live ? 'active' : 'canceling', cancel_reason: live ? null : 'duplicate',
        cancel_intent: null, sync_version: 2, synced_version: 0, sync_failures: 0, next_sync_at: now, created_at: now,
      });
      const pay = payments().find((p) => p.id === a.p_setup_payment_id);
      if (pay && !pay.card_id) pay.card_id = id;
      return { data: { card_id: id, workspace_id: W, live, duplicate: !live, replayed: false }, error: null };
    }
    case 'billing_account_mark_notice': {
      const key = `${String(a.p_key)}`;
      if (h.notices.has(key)) return { data: false, error: null };
      h.notices.add(key);
      return { data: true, error: null };
    }
    case 'billing_account_unmark_notice':
      h.notices.delete(String(a.p_key));
      return { data: null, error: null };
    case 'billing_account_v2_next_period':
    case 'billing_card_touch_workspace':
    case 'billing_account_ensure':
      return { data: null, error: null };
    case 'billing_card_sync_candidates':
      return { data: table('billing_account_cards').filter((c) => c.status !== 'canceled'), error: null };
    default:
      throw new Error(`unexpected rpc ${name}`);
  }
}

// ─── The stubbed Paddle API ─────────────────────────────────────────────────

function applyPatch(body: Row) {
  if ('scheduled_change' in body) paddle.sub.scheduled_change = null;
  if (body.next_billed_at) {
    paddle.sub.next_billed_at = body.next_billed_at;
    paddle.sub.current_billing_period = { ends_at: body.next_billed_at };
  }
  if (body.items) paddle.sub.items = body.items;
  if (body.custom_data) paddle.sub.custom_data = body.custom_data;
}

function paddleReply(method: string, path: string, body: Row): PaddleReply {
  const route = `${method} ${path.split('?')[0]}`;
  const override = h.paddleOverride[route];
  if (override) return override(body);
  const subData = () => ({ data: { ...paddle.sub } });
  switch (route) {
    case `GET /subscriptions/${SUB}`:
      return { body: subData() };
    case `PATCH /subscriptions/${SUB}/preview`: {
      const before = { ...paddle.sub };
      applyPatch(body);
      const preview = { ...paddle.sub, immediate_transaction: null, update_summary: null };
      paddle.sub = before;
      return { body: { data: preview } };
    }
    case `PATCH /subscriptions/${SUB}`:
      applyPatch(body);
      return { body: subData() };
    case `POST /subscriptions/${SUB}/cancel`:
      if (body.effective_from === 'immediately') Object.assign(paddle.sub, { status: 'canceled', next_billed_at: null, scheduled_change: null });
      else Object.assign(paddle.sub, { scheduled_change: { action: 'cancel', effective_at: paddle.sub.next_billed_at }, next_billed_at: null });
      return { body: subData() };
    case `POST /subscriptions/${SUB}/charge/preview`: {
      const amount = (body.items as Array<{ price: { unit_price: { amount: string } } }>)[0].price.unit_price.amount;
      return { body: { data: { immediate_transaction: { details: { totals: { grand_total: amount, credit: '0' } } } } } };
    }
    case `POST /subscriptions/${SUB}/charge`: {
      paddle.charges += 1;
      const item = (body.items as Array<{ price: { unit_price: { amount: string }; custom_data: Row } }>)[0].price;
      paddle.txns.unshift(txnJson({ id: `txn_charge_${paddle.charges}`, origin: 'subscription_charge', amount: Number(item.unit_price.amount), custom: item.custom_data }));
      return { body: subData() };
    }
    case 'GET /transactions':
      return { body: { data: paddle.txns } };
    case `GET /subscriptions/${SUB}/update-payment-method-transaction`:
      return { body: { data: { id: 'txn_update_1' } } };
    default: {
      const m = /^GET \/transactions\/(.+)$/.exec(route);
      if (m) {
        const txn = paddle.txns.find((t) => t.id === decodeURIComponent(m[1]));
        return txn ? { body: { data: txn } } : { status: 404, body: { error: { code: 'not_found', detail: 'no such transaction' } } };
      }
      return { status: 404, body: { error: { code: 'not_found', detail: route } } };
    }
  }
}

const BASE = 'https://sandbox-api.paddle.com';

beforeEach(() => {
  seq = 0;
  h.timeline = [];
  h.rpcCalls = [];
  h.paddleCalls = [];
  h.notices = new Set();
  h.emails = [];
  h.paddleOverride = {};
  h.gatewayConfig = { api_key: 'pdl_sdbx_apikey_mock', client_token: 'test_client_mock', card_auto_renew: true };
  h.edition = 'international';
  h.regionMode = 'multi';
  h.purposeResult = null;
  h.closeCheckout.mockReset();
  h.verifyPayment.mockReset();
  h.afterSettlement.mockReset();
  h.accountGateways.mockReset();
  h.plans.paidPeriodOf.mockReset();
  h.plans.quotePlanChange.mockReset();
  h.plans.renewPlan.mockReset();
  seed();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.slice(BASE.length);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    h.paddleCalls.push({ method, path, body });
    h.timeline.push(`paddle:${method} ${path.split('?')[0]}`);
    const reply = paddleReply(method, path, (body ?? {}) as Row);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (route: string) => h.paddleCalls.filter((c) => `${c.method} ${c.path.split('?')[0]}` === route);
const rpcs = (name: string) => h.rpcCalls.filter((c) => c.name === name);
/** Where an exact entry first happened in the timeline (-1: never). */
const at = (entry: string) => h.timeline.findIndex((e) => e === entry);

// ─── The reconciler ──────────────────────────────────────────────────────────

describe('syncCard', () => {
  it('first sync after setup: drops the checkout custom_data and moves the date to the period end − 24 h, previewed with do_not_bill', async () => {
    paddle.sub.custom_data = { workspace_id: W, intent_id: SETUP, card_setup: '1' };
    paddle.sub.next_billed_at = iso(E + 5 * MIN);
    paddle.sub.current_billing_period = { ends_at: iso(E + 5 * MIN) };
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('synced');
    const preview = calls(`PATCH /subscriptions/${SUB}/preview`);
    const patch = calls(`PATCH /subscriptions/${SUB}`);
    expect(preview).toHaveLength(1);
    expect(patch).toHaveLength(1);
    expect(patch[0].body).toEqual({
      custom_data: { workspace_id: W, card_id: CARD },
      next_billed_at: iso(E - CARD_RENEWAL_LEAD_MS),
      proration_billing_mode: 'do_not_bill',
    });
    expect(preview[0].body).toEqual(patch[0].body);
    expect(at(`paddle:PATCH /subscriptions/${SUB}/preview`)).toBeLessThan(at(`paddle:PATCH /subscriptions/${SUB}`));
    expect(rpcs('billing_card_mark_synced').at(-1)?.args).toMatchObject({ p_version: 2, p_error: null });
    expect(cardRow()).toMatchObject({ synced_version: 2, paddle_next_billed_at: iso(E - CARD_RENEWAL_LEAD_MS) });
  });

  it('swaps the item to a scheduled change (plan, interval, VAT) without touching the date', async () => {
    Object.assign(accountRow(), { scheduled_plan_id: TEAM });
    table('billing_settings')[0].vat_percent = { USD: 10 };
    await card.syncCard(CFG, CARD);
    const patch = calls(`PATCH /subscriptions/${SUB}`)[0].body as { items: Array<{ price: Row }>; next_billed_at?: string };
    expect(patch.next_billed_at).toBeUndefined();
    expect(patch.items[0].price).toMatchObject({
      unit_price: { amount: '8690', currency_code: 'USD' },
      billing_cycle: { interval: 'month', frequency: 1 },
      custom_data: { plan_id: TEAM, interval: 'monthly', net_minor: 7900, tax_minor: 790 },
    });
  });

  it('nothing to change: no preview, no update', async () => {
    expect((await card.syncCard(CFG, CARD)).status).toBe('unchanged');
    expect(calls(`PATCH /subscriptions/${SUB}/preview`)).toHaveLength(0);
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
  });

  it('extra custom_data keys Paddle kept (its merge of the checkout\'s) are left: no PATCH that could never change them', async () => {
    paddle.sub.custom_data = { workspace_id: W, card_id: CARD, intent_id: SETUP, card_setup: '1' };
    expect((await card.syncCard(CFG, CARD)).status).toBe('unchanged');
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
  });

  it('a preview that would bill stops the sync (P4)', async () => {
    paddle.sub.next_billed_at = iso(E + 5 * D);
    h.paddleOverride[`PATCH /subscriptions/${SUB}/preview`] = () => ({ body: { data: { ...paddle.sub, immediate_transaction: { id: 'txn_x' } } } });
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'error', detail: 'preview_bills' });
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
    expect(cardRow().sync_error).toBe('preview_bills');
  });

  it('auto-renew off: cancels at the period end, with our intent recorded before asking Paddle', async () => {
    accountRow().auto_renew = false;
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('synced');
    expect(calls(`POST /subscriptions/${SUB}/cancel`)[0].body).toEqual({ effective_from: 'next_billing_period' });
    expect(at('update:billing_account_cards:cancel_intent')).toBeLessThan(at(`paddle:POST /subscriptions/${SUB}/cancel`));
    expect(cardRow()).toMatchObject({ cancel_intent: 'period_end', paddle_scheduled_change: { action: 'cancel' } });
  });

  it("a cancel scheduled in Paddle's portal is followed (auto-renew off, mail once), never undone", async () => {
    paddle.sub.scheduled_change = { action: 'cancel', effective_at: iso(E - D) };
    paddle.sub.next_billed_at = null;
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('unchanged');
    expect(accountRow().auto_renew).toBe(false);
    expect(cardRow().cancel_intent).toBe('period_end');
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
    expect(h.emails).toEqual([expect.objectContaining({ slug: 'billing_card_removed', data: expect.objectContaining({ card: 'Visa •••• 4242' }) })]);
    await card.syncCard(CFG, CARD);
    expect(h.emails).toHaveLength(1);
  });

  it('our own scheduled cancel is undone when auto-renew is on again', async () => {
    paddle.sub.scheduled_change = { action: 'cancel', effective_at: iso(E - D) };
    cardRow().cancel_intent = 'period_end';
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('synced');
    expect(calls(`PATCH /subscriptions/${SUB}`)[0].body).toEqual({ scheduled_change: null });
    expect(cardRow().cancel_intent).toBeNull();
    expect(h.emails).toHaveLength(0);
  });

  /** Paddle renewed an hour ago (at our end − 24 h) and moved on a month; the webhook never came. */
  function paddleRenewedUnseen() {
    E = Date.now() + 23 * H;
    table('workspace_subscriptions')[0].current_period_end = iso(E);
    cardRow().paddle_next_billed_at = iso(Date.now() - H);
    paddle.sub.next_billed_at = iso(Date.now() - H + 30 * D);
    paddle.sub.current_billing_period = { ends_at: iso(Date.now() - H + 30 * D) };
    paddle.txns = [txnJson({ id: 'txn_renewal_1', created_at: iso(Date.now() - H), billed_at: iso(Date.now() - H) })];
  }

  it('never moves the date earlier over a renewal Paddle charged that we have not recorded: it is settled instead', async () => {
    paddleRenewedUnseen();
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'deferred', detail: 'renewal_settled' });
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
    expect(rpcs('billing_card_record_charge')[0].args).toMatchObject({ p_txn_id: 'txn_renewal_1', p_origin: 'subscription_recurring', p_amount_minor: 2900 });
    expect(rpcs('billing_card_settle')).toHaveLength(1);
  });

  it('a period Paddle began within the last hours whose renewal is not listed yet: the date waits (renewal_expected)', async () => {
    paddleRenewedUnseen();
    paddle.sub.current_billing_period = { starts_at: iso(Date.now() - H), ends_at: iso(Date.now() - H + 30 * D) };
    paddle.txns = [];
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'deferred', detail: 'renewal_expected' });
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
    expect(calls(`PATCH /subscriptions/${SUB}/preview`)).toHaveLength(0);
    // Hours later with still nothing listed, Paddle's lead is ours to correct.
    paddle.sub.current_billing_period = { starts_at: iso(Date.now() - 7 * H), ends_at: iso(Date.now() - H + 30 * D) };
    expect((await card.syncCard(CFG, CARD)).status).toBe('synced');
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(1);
  });

  it('a renewal of Paddle\'s period that was recorded but not applied blocks moving the date earlier', async () => {
    paddleRenewedUnseen();
    payments().push({ id: uuid(), workspace_id: W, provider: 'paddle_sandbox', provider_ref: 'txn_renewal_1', status: 'succeeded', amount_minor: 2900, purpose: 'renewal', purpose_detail: {}, purpose_result: { error: 'amount_below_price' }, source: 'card_renewal', created_at: iso(Date.now()) });
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'deferred', detail: 'renewal_not_applied' });
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
  });

  it('a renewal of Paddle\'s period credited at another amount (a top-up, for review) also blocks moving the date earlier', async () => {
    paddleRenewedUnseen();
    payments().push({ id: uuid(), workspace_id: W, provider: 'paddle_sandbox', provider_ref: 'txn_renewal_1', status: 'succeeded', amount_minor: 2500, purpose: 'topup', purpose_detail: {}, purpose_result: null, review: 'amount_mismatch', source: 'card_renewal', created_at: iso(Date.now()) });
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'deferred', detail: 'renewal_not_applied' });
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
  });

  it('within 2 hours of Paddle\'s charge nothing is changed (freeze)', async () => {
    paddle.sub.next_billed_at = iso(Date.now() + H);
    paddle.sub.items = [{ price: priceJson(1000, 'month', {}) }];
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'deferred', detail: 'frozen' });
    expect(h.paddleCalls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a canceling card is cancelled at Paddle now, then marked canceled', async () => {
    Object.assign(cardRow(), { status: 'canceling', cancel_reason: 'not_renewed' });
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('canceled');
    expect(calls(`POST /subscriptions/${SUB}/cancel`)[0].body).toEqual({ effective_from: 'immediately' });
    expect(cardRow()).toMatchObject({ status: 'canceled', cancel_reason: 'not_renewed', cancel_intent: 'now' });
    expect(h.emails).toHaveLength(0);
  });

  it('our scheduled cancel taking effect at the period end mails "auto-renew off" once', async () => {
    Object.assign(cardRow(), { cancel_intent: 'period_end' });
    accountRow().auto_renew = false;
    Object.assign(paddle.sub, { status: 'canceled', next_billed_at: null });
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('canceled');
    expect(cardRow().status).toBe('canceled');
    expect(h.emails.map((m) => [m.slug, m.data.reason])).toEqual([['billing_card_removed', 'automatic renewal was turned off']]);
  });

  it('past_due at Paddle: the card follows, and nothing is changed', async () => {
    paddle.sub.status = 'past_due';
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome).toEqual({ status: 'deferred', detail: 'paddle_past_due' });
    expect(cardRow().status).toBe('past_due');
    expect(h.paddleCalls).toHaveLength(1);
  });

  it('a date Paddle does not take is a sync error (with its back-off), not an immediate retry', async () => {
    paddle.sub.next_billed_at = iso(E + 5 * D);
    paddle.sub.current_billing_period = { ends_at: iso(E + 5 * D) };
    h.paddleOverride[`PATCH /subscriptions/${SUB}`] = () => ({ body: { data: { ...paddle.sub } } });
    const outcome = await card.syncCard(CFG, CARD);
    expect(outcome.status).toBe('error');
    expect(outcome.detail).toMatch(/^paddle_date_not_applied/);
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(1);
    expect(cardRow()).toMatchObject({ sync_failures: 1, synced_version: 0 });
  });

  it('a Paddle error is recorded with its back-off, never thrown', async () => {
    h.paddleOverride[`GET /subscriptions/${SUB}`] = () => ({ status: 500, body: { error: { code: 'internal_error', detail: 'boom' } } });
    expect(await card.syncCard(CFG, CARD)).toMatchObject({ status: 'error' });
    expect(cardRow()).toMatchObject({ sync_failures: 1, synced_version: 0 });
  });
});

// ─── Upgrade charged to the card ─────────────────────────────────────────────

describe('chargeCardForUpgrade', () => {
  const quote = (over: Row = {}) => ({ kind: 'upgrade', currency: 'USD', amount_minor: 5000, returned_minor: 0, ...over });
  beforeEach(() => {
    h.plans.paidPeriodOf.mockResolvedValue({ plan_id: PRO, billing_interval: 'monthly', current_period_start: iso(Date.now() - 20 * D), current_period_end: iso(E) });
    h.plans.quotePlanChange.mockResolvedValue(quote());
  });

  it('charges exactly the quoted difference once, after the row says so, and settles it', async () => {
    const out = await card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: 'u1' });
    expect(out).toMatchObject({ status: 'succeeded', purposeResult: { action: 'upgraded' } });
    const row = payments().find((p) => p.id === out.paymentId) as Row;
    expect(row).toMatchObject({ source: 'card_charge', purpose: 'upgrade', amount_minor: 5000, status: 'succeeded', provider_ref: 'txn_charge_1', card_id: CARD });
    expect(row.charge_requested_at).toBeTruthy();
    expect(calls(`POST /subscriptions/${SUB}/charge`)).toHaveLength(1);
    expect(calls(`POST /subscriptions/${SUB}/charge`)[0].body).toMatchObject({
      effective_from: 'immediately', on_payment_failure: 'prevent_change',
      items: [{ quantity: 1, price: { unit_price: { amount: '5000', currency_code: 'USD' }, custom_data: { payment_id: out.paymentId, workspace_id: W } } }],
    });
    expect(at(`paddle:POST /subscriptions/${SUB}/charge/preview`)).toBeLessThan(at('update:billing_account_payments:charge_requested_at'));
    expect(at('update:billing_account_payments:charge_requested_at')).toBeLessThan(at(`paddle:POST /subscriptions/${SUB}/charge`));
    expect(rpcs('billing_card_record_charge')[0].args).toMatchObject({ p_origin: 'subscription_charge', p_payment_id: out.paymentId, p_amount_minor: 5000 });
  });

  it('an unknown outcome answers processing and is never posted again', async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/charge`] = () => ({ status: 502, body: { error: { code: 'bad_gateway', detail: 'upstream' } } });
    const out = await card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null });
    expect(out.status).toBe('processing');
    expect(calls(`POST /subscriptions/${SUB}/charge`)).toHaveLength(1);
    const row = payments().find((p) => p.id === out.paymentId) as Row;
    expect(row.status).toBe('pending');
    expect(row.charge_requested_at).toBeTruthy();
    // The verify route / job looks it up: still nothing at Paddle, still pending, never re-posted.
    const look = await card.resolveCardCharge(CFG, row as never);
    expect(look.status).toBe('pending');
    expect(calls(`POST /subscriptions/${SUB}/charge`)).toHaveLength(1);
  });

  it('a decline fails the row and answers CARD_DECLINED', async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/charge`] = () => ({ status: 400, body: { error: { code: 'subscription_payment_declined', detail: 'declined' } } });
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_DECLINED', status: 402 });
    expect(payments().find((p) => p.source === 'card_charge')).toMatchObject({ status: 'failed', failure_reason: 'card_declined' });
  });

  it("a decline names the card's own reason when Paddle shows the declined charge; its later event adds no row", async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/charge`] = (body) => {
      const item = (body as { items: Array<{ price: { unit_price: { amount: string }; custom_data: Row } }> }).items[0].price;
      paddle.txns.unshift(txnJson({
        id: 'txn_charge_declined', origin: 'subscription_charge', status: 'canceled', amount: Number(item.unit_price.amount), custom: item.custom_data,
        payments: [{ status: 'error', error_code: 'expired_card', created_at: iso(Date.now()), method_details: { card: { type: 'visa', last4: '4242' } } }],
      }));
      return { status: 400, body: { error: { code: 'subscription_payment_declined', detail: 'declined' } } };
    };
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_DECLINED', status: 402, details: { code: 'expired_card' } });
    const before = payments().length;
    const { readTransaction } = await import('../../../../server/services/billing/providers/paddleSubscriptions.js');
    readTxn = readTransaction as never;
    const owner = { workspaceId: W, cardId: CARD, setupPaymentId: SETUP };
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.payment_failed', paddle.txns[0]) as never, owner });
    expect(payments()).toHaveLength(before);
    expect(rpcs('billing_card_record_charge')).toHaveLength(0);
    expect(payments().find((p) => p.source === 'card_charge')).toMatchObject({ status: 'failed', failure_reason: 'card_declined', provider_ref: null });
  });

  it("Paddle's renewal lock answers CARD_RENEWAL_IN_PROGRESS and fails the row", async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/charge`] = () => ({ status: 409, body: { error: { code: 'subscription_locked_renewal', detail: 'locked' } } });
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_RENEWAL_IN_PROGRESS', status: 409 });
    expect(payments().find((p) => p.source === 'card_charge')?.status).toBe('failed');
  });

  it('a second click while one is pending is refused before Paddle is asked', async () => {
    payments().push({ id: uuid(), workspace_id: W, source: 'card_charge', purpose: 'upgrade', status: 'pending', provider: 'paddle_sandbox', created_at: iso(Date.now()) });
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_CHARGE_IN_PROGRESS', status: 409 });
    expect(h.paddleCalls).toHaveLength(0);
  });

  it('a quote that moved answers QUOTE_CHANGED and creates nothing', async () => {
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 4900, actorId: null }))
      .rejects.toMatchObject({ code: 'QUOTE_CHANGED' });
    h.plans.quotePlanChange.mockResolvedValue(quote({ kind: 'schedule' }));
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'QUOTE_CHANGED' });
    expect(payments().filter((p) => p.source === 'card_charge')).toHaveLength(0);
  });

  it("below Paddle's minimum the card is not charged", async () => {
    h.plans.quotePlanChange.mockResolvedValue(quote({ amount_minor: 50 }));
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 50, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_CHARGE_BELOW_MINIMUM', status: 400 });
    expect(payments().filter((p) => p.source === 'card_charge')).toHaveLength(0);
  });

  it('a past_due card or a frozen one is refused', async () => {
    cardRow().status = 'past_due';
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_PAST_DUE' });
    Object.assign(cardRow(), { status: 'active', paddle_next_billed_at: iso(Date.now() - H) });
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_RENEWAL_IN_PROGRESS', details: { frozen_until: iso(Date.parse(cardRow().paddle_next_billed_at as string) + 6 * H) } });
  });

  it('a preview with Paddle credit stops before the charge', async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/charge/preview`] = () => ({ body: { data: { immediate_transaction: { details: { totals: { grand_total: '4000', credit: '1000' } } } } } });
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_PROVIDER_ERROR' });
    expect(calls(`POST /subscriptions/${SUB}/charge`)).toHaveLength(0);
    expect(payments().find((p) => p.source === 'card_charge')?.status).toBe('failed');
  });

  it('the gateway switch off makes card charges unavailable', async () => {
    h.gatewayConfig = { api_key: 'pdl_sdbx_apikey_mock', client_token: 'test_client_mock', card_auto_renew: false };
    await expect(card.chargeCardForUpgrade(CFG, W, { planId: TEAM, expectedNetMinor: 5000, actorId: null }))
      .rejects.toMatchObject({ code: 'CARD_NOT_AVAILABLE' });
  });
});

describe('resolveCardCharge', () => {
  const pending = (over: Row) => {
    const row = { id: uuid(), workspace_id: W, provider: 'paddle_sandbox', currency: 'USD', amount_minor: 5000, net_minor: 5000, tax_minor: 0, purpose: 'upgrade', purpose_detail: {}, purpose_result: null, status: 'pending', provider_ref: null, failure_reason: null, ledger_id: null, source: 'card_charge', card_id: CARD, created_at: iso(Date.now() - 3 * H), charge_requested_at: null, ...over };
    payments().push(row);
    return row;
  };

  it('a charge Paddle shows no trace of after an hour fails (charge_not_found)', async () => {
    const row = pending({ charge_requested_at: iso(Date.now() - 2 * H) });
    expect(await card.resolveCardCharge(CFG, row as never)).toEqual({ status: 'failed', reason: 'charge_not_found' });
    expect(row).toMatchObject({ status: 'failed', failure_reason: 'charge_not_found' });
    expect(calls(`POST /subscriptions/${SUB}/charge`)).toHaveLength(0);
  });

  it('a charge found by its payment id is bound and settled', async () => {
    const row = pending({ charge_requested_at: iso(Date.now() - 5 * MIN) });
    paddle.txns = [txnJson({ id: 'txn_charge_9', origin: 'subscription_charge', amount: 5000, custom: { payment_id: row.id, workspace_id: W } })];
    const out = await card.resolveCardCharge(CFG, row as never);
    expect(out).toMatchObject({ status: 'succeeded', purpose: 'upgrade' });
    expect(row).toMatchObject({ status: 'succeeded', provider_ref: 'txn_charge_9' });
  });

  it('a charge never asked for ends once its request is surely over', async () => {
    const row = pending({ created_at: iso(Date.now() - 10 * MIN) });
    expect(await card.resolveCardCharge(CFG, row as never)).toEqual({ status: 'failed', reason: 'charge_not_requested' });
    expect(h.paddleCalls).toHaveLength(0);
  });
});

// ─── Card events ─────────────────────────────────────────────────────────────

function txnEvent(eventType: string, txn: Row) {
  return {
    type: 'card_event' as const,
    providerEventId: `evt_${eventType}_${String(txn.id)}`,
    raw: {},
    card: {
      eventType,
      entity: 'transaction' as const,
      occurredAt: iso(Date.now()),
      subscriptionId: SUB,
      customerId: 'ctm_1',
      transactionId: String(txn.id),
      transaction: readTxn(txn),
      subscription: null,
      customData: { workspace_id: W, card_id: CARD },
    },
  };
}

let readTxn: (t: Row) => never;

describe('handleCardEvent', () => {
  beforeEach(async () => {
    readTxn = (await import('../../../../server/services/billing/providers/paddleSubscriptions.js')).readTransaction as never;
  });
  const owner = { workspaceId: W, cardId: CARD, setupPaymentId: SETUP };

  it('a declined renewal: the card goes past_due, the row stays pending, one mail per transaction', async () => {
    const txn = txnJson({ id: 'txn_renewal_2', status: 'past_due', payments: [{ status: 'error', error_code: 'expired_card', created_at: iso(Date.now()), method_details: { card: { type: 'visa', last4: '4242' } } }] });
    const event = txnEvent('transaction.payment_failed', txn);
    expect(await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: event as never, owner })).toBe('handled');
    expect(cardRow()).toMatchObject({ status: 'past_due', last_failure: { code: 'expired_card', txn: 'txn_renewal_2' } });
    expect(payments().find((p) => p.provider_ref === 'txn_renewal_2')).toMatchObject({ status: 'pending', failure_reason: 'expired_card', source: 'card_renewal' });
    expect(h.emails).toEqual([expect.objectContaining({
      slug: 'billing_card_payment_failed',
      data: expect.objectContaining({ card: 'Visa •••• 4242', amount: '2900 USD', failure_reason: 'the card has expired', plan_name: 'Pro' }),
    })]);
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.past_due', txn) as never, owner });
    expect(h.emails).toHaveLength(1);
    expect(rpcs('billing_card_settle')).toHaveLength(0);
  });

  it('a paid renewal is recorded once and settled; a past_due card is active again', async () => {
    Object.assign(cardRow(), { status: 'past_due', last_failure: { at: iso(Date.now()), code: 'declined' } });
    const txn = txnJson({ id: 'txn_renewal_3', status: 'paid' });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.paid', txn) as never, owner });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.completed', { ...txn, status: 'completed' }) as never, owner });
    expect(payments().filter((p) => p.provider_ref === 'txn_renewal_3')).toHaveLength(1);
    expect(payments().find((p) => p.provider_ref === 'txn_renewal_3')).toMatchObject({ status: 'succeeded', purpose: 'renewal' });
    expect(rpcs('billing_card_settle')).toHaveLength(2);
    expect(h.afterSettlement).toHaveBeenCalledTimes(1);
    expect(cardRow()).toMatchObject({ status: 'active', last_failure: null });
  });

  it('a renewal paid with another card: the card is written before the settlement, whose mail names the card that paid', async () => {
    const txn = txnJson({ id: 'txn_renewal_5', status: 'paid', payments: [{ status: 'captured', created_at: iso(Date.now()), method_details: { card: { type: 'mastercard', last4: '5555', expiry_month: 6, expiry_year: 2031 } } }] });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.paid', txn) as never, owner });
    const written = at('update:billing_account_cards:brand,last4,exp_month,exp_year');
    expect(written).toBeGreaterThanOrEqual(0);
    expect(written).toBeLessThan(at('rpc:billing_card_settle'));
    expect(cardRow()).toMatchObject({ brand: 'mastercard', last4: '5555' });
  });

  it('a failed attempt reported after the transaction was paid changes nothing and mails nothing', async () => {
    const paid = txnJson({ id: 'txn_renewal_6', status: 'paid' });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.paid', paid) as never, owner });
    const failed = txnJson({ id: 'txn_renewal_6', status: 'past_due', payments: [{ status: 'error', error_code: 'expired_card', created_at: iso(Date.now() - MIN), method_details: { card: { type: 'visa', last4: '4242' } } }] });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.payment_failed', failed) as never, owner });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.past_due', failed) as never, owner });
    expect(cardRow()).toMatchObject({ status: 'active', last_failure: null });
    expect(payments().find((p) => p.provider_ref === 'txn_renewal_6')).toMatchObject({ status: 'succeeded', failure_reason: null });
    expect(h.emails.filter((e) => e.slug === 'billing_card_payment_failed')).toEqual([]);
  });

  it('a charge of a subscription our checkout did not make is not registered as our card (P6); one it made is', async () => {
    table('billing_account_cards').length = 0;
    Object.assign(accountRow(), { card_provider: null, card_subscription_id: null });
    Object.assign(payments()[0], { card_id: null });
    // Our checkout made SUB (txnJson's subscription_id).
    paddle.txns = [txnJson({ id: 'txn_checkout', origin: 'web', status: 'completed' })];
    h.paddleOverride['GET /subscriptions/sub_other'] = () => ({ body: { data: { ...paddle.sub, id: 'sub_other', custom_data: { workspace_id: W, intent_id: SETUP } } } });
    const foreign = txnEvent('transaction.paid', { ...txnJson({ id: 'txn_other_1', status: 'paid' }), subscription_id: 'sub_other' });
    foreign.card.subscriptionId = 'sub_other';
    const pending = { workspaceId: W, cardId: null, setupPaymentId: SETUP };
    expect(await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: foreign as never, owner: pending })).toBe('ignored');
    expect(rpcs('billing_card_register')).toHaveLength(0);
    expect(rpcs('billing_card_record_charge')).toHaveLength(0);
    expect(h.paddleCalls.filter((c) => c.method !== 'GET')).toEqual([]);

    const ours = txnEvent('transaction.paid', txnJson({ id: 'txn_renewal_7', status: 'paid' }));
    expect(await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: ours as never, owner: pending })).toBe('handled');
    expect(rpcs('billing_card_register').map((c) => c.args.p_subscription_id)).toEqual([SUB]);
  });

  it('a zero-amount card change only refreshes the card', async () => {
    const txn = txnJson({ id: 'txn_update_1', amount: 0, origin: 'subscription_payment_method_change', payments: [{ status: 'captured', created_at: iso(Date.now()), method_details: { card: { type: 'mastercard', last4: '5555', expiry_month: 3, expiry_year: 2031 } } }] });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.completed', txn) as never, owner });
    expect(cardRow()).toMatchObject({ brand: 'mastercard', last4: '5555', exp_month: 3, exp_year: 2031 });
    expect(rpcs('billing_card_record_charge')).toHaveLength(0);
  });

  it('a cancelled transaction fails its pending row', async () => {
    const txn = txnJson({ id: 'txn_renewal_4', status: 'billed' });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.billed', txn) as never, owner });
    await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: txnEvent('transaction.canceled', { ...txn, status: 'canceled' }) as never, owner });
    expect(payments().find((p) => p.provider_ref === 'txn_renewal_4')).toMatchObject({ status: 'canceled', failure_reason: 'paddle_canceled' });
  });

  it('a subscription Paddle does not know is not registered, and not retried', async () => {
    table('billing_account_cards').length = 0;
    Object.assign(payments()[0], { card_id: null });
    h.paddleOverride[`GET /subscriptions/sub_unknown`] = () => ({ status: 404, body: { error: { code: 'not_found', detail: 'no such subscription' } } });
    const event = txnEvent('transaction.paid', txnJson({ id: 'txn_x', status: 'paid' }));
    event.card.subscriptionId = 'sub_unknown';
    expect(await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: event as never, owner: { workspaceId: W, cardId: null, setupPaymentId: SETUP } })).toBe('ignored');
    expect(rpcs('billing_card_register')).toHaveLength(0);
    expect(rpcs('billing_card_record_charge')).toHaveLength(0);
  });

  it("subscription.created of our checkout registers the card, then syncs it", async () => {
    table('billing_account_cards').length = 0;
    Object.assign(accountRow(), { card_provider: null, card_subscription_id: null });
    Object.assign(payments()[0], { card_id: null });
    paddle.sub.custom_data = { workspace_id: W, intent_id: SETUP, card_setup: '1' };
    paddle.txns = [txnJson({ id: 'txn_checkout', origin: 'web', status: 'completed' })];
    const event = {
      type: 'card_event', providerEventId: 'evt_created', raw: {},
      card: { eventType: 'subscription.created', entity: 'subscription', occurredAt: iso(Date.now()), subscriptionId: SUB, customerId: 'ctm_1', transactionId: 'txn_checkout', transaction: null, subscription: null, customData: { workspace_id: W, intent_id: SETUP } },
    };
    const found = await card.cardEventOwner(CFG, 'paddle_sandbox', event as never);
    expect(found).toEqual({ workspaceId: W, cardId: null, setupPaymentId: SETUP });
    expect(await card.handleCardEvent(CFG, { providerName: 'paddle_sandbox', event: event as never, owner: found! })).toBe('handled');
    expect(rpcs('billing_card_register')[0].args).toMatchObject({ p_provider: 'paddle_sandbox', p_subscription_id: SUB, p_customer_id: 'ctm_1', p_currency: 'USD', p_setup_payment_id: SETUP });
    const registered = table('billing_account_cards')[0];
    expect(registered).toMatchObject({ brand: 'visa', last4: '4242', exp_year: 2030 });
    expect(calls(`PATCH /subscriptions/${SUB}`)[0].body).toMatchObject({ custom_data: { workspace_id: W, card_id: registered.id } });
  });
});

describe('cardEventOwner (read-only, P6)', () => {
  const event = (over: Row) => ({
    type: 'card_event', providerEventId: 'e', raw: {},
    card: { eventType: 'subscription.updated', entity: 'subscription', occurredAt: null, subscriptionId: 'sub_foreign', customerId: null, transactionId: null, transaction: null, subscription: null, customData: {}, ...over },
  }) as never;

  it('our card, by its subscription', async () => {
    expect(await card.cardEventOwner(CFG, 'paddle_sandbox', event({ subscriptionId: SUB }))).toEqual({ workspaceId: W, cardId: CARD, setupPaymentId: SETUP });
  });
  it('the same subscription id on the other gateway is not ours', async () => {
    expect(await card.cardEventOwner(CFG, 'paddle', event({ subscriptionId: SUB }))).toBeNull();
  });
  it('a foreign subscription naming one of our workspaces is not ours', async () => {
    expect(await card.cardEventOwner(CFG, 'paddle_sandbox', event({ customData: { workspace_id: W } }))).toBeNull();
    expect(h.rpcCalls).toHaveLength(0);
  });
  it("a copied intent id that is not our card checkout's is not ours", async () => {
    payments()[0].source = 'checkout';
    expect(await card.cardEventOwner(CFG, 'paddle_sandbox', event({ customData: { intent_id: SETUP } }))).toBeNull();
  });
  it('an intent id naming our checkout whose card is registered already: another subscription, not ours', async () => {
    expect(await card.cardEventOwner(CFG, 'paddle_sandbox', event({ customData: { intent_id: SETUP } }))).toBeNull();
    Object.assign(payments()[0], { card_id: null });
    expect(await card.cardEventOwner(CFG, 'paddle_sandbox', event({ customData: { intent_id: SETUP } })))
      .toEqual({ workspaceId: W, cardId: null, setupPaymentId: SETUP });
  });
  it('an intent id whose checkout is another transaction is not ours', async () => {
    expect(await card.cardEventOwner(CFG, 'paddle_sandbox', event({ customData: { intent_id: SETUP }, transactionId: 'txn_other' }))).toBeNull();
  });
});

// ─── Customer actions ────────────────────────────────────────────────────────

describe('removeCard / setCardAutoRenew (Paddle first, P7)', () => {
  it('a refusal changes nothing here', async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/cancel`] = () => ({ status: 409, body: { error: { code: 'subscription_locked_renewal', detail: 'locked' } } });
    h.paddleOverride[`GET /subscriptions/${SUB}`] = () => ({ body: { data: paddle.sub } });
    await expect(card.removeCard(CFG, W)).rejects.toMatchObject({ code: 'CARD_RENEWAL_IN_PROGRESS' });
    expect(cardRow()).toMatchObject({ status: 'active', cancel_intent: null });
    expect(accountRow().auto_renew).toBe(true);
    expect(h.emails).toHaveLength(0);
  });

  it("no answer to the cancel keeps our intent (Paddle's later cancel event reads as ours); a sync finding no cancel clears it", async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/cancel`] = () => ({ status: 503, body: { error: { code: 'service_unavailable', detail: 'busy' } } });
    await expect(card.removeCard(CFG, W)).rejects.toMatchObject({ code: 'CARD_PROVIDER_ERROR', status: 502 });
    expect(cardRow()).toMatchObject({ status: 'active', cancel_intent: 'now' });
    delete h.paddleOverride[`POST /subscriptions/${SUB}/cancel`];
    expect((await card.syncCard(CFG, CARD)).status).toBe('unchanged');
    expect(cardRow().cancel_intent).toBeNull();
    expect(h.emails).toHaveLength(0);
  });

  it('removing: cancelled at Paddle, then the card, its pointer and auto-renew; one mail', async () => {
    expect(await card.removeCard(CFG, W)).toEqual({ removed: true });
    expect(calls(`POST /subscriptions/${SUB}/cancel`)[0].body).toEqual({ effective_from: 'immediately' });
    expect(at(`paddle:POST /subscriptions/${SUB}/cancel`)).toBeLessThan(at('rpc:billing_card_set_status'));
    expect(cardRow()).toMatchObject({ status: 'canceled', cancel_reason: 'removed', cancel_intent: 'now' });
    expect(accountRow()).toMatchObject({ auto_renew: false, card_subscription_id: null });
    expect(h.emails.map((m) => [m.slug, m.data.reason])).toEqual([['billing_card_removed', 'you removed the card']]);
    await expect(card.removeCard(CFG, W)).rejects.toMatchObject({ code: 'CARD_NOT_FOUND', status: 404 });
  });

  it('auto-renew off: Paddle schedules the cancel first, then the flag', async () => {
    expect(await card.setCardAutoRenew(CFG, W, false)).toBe(false);
    expect(at(`paddle:POST /subscriptions/${SUB}/cancel`)).toBeLessThan(at('update:billing_accounts:auto_renew'));
    expect(accountRow().auto_renew).toBe(false);
    expect(cardRow()).toMatchObject({ status: 'active', cancel_intent: 'period_end' });
  });

  it('auto-renew off refused by Paddle: the flag stays on', async () => {
    h.paddleOverride[`POST /subscriptions/${SUB}/cancel`] = () => ({ status: 400, body: { error: { code: 'bad_request', detail: 'no' } } });
    await expect(card.setCardAutoRenew(CFG, W, false)).rejects.toMatchObject({ code: 'CARD_PROVIDER_ERROR', status: 502 });
    expect(accountRow().auto_renew).toBe(true);
    expect(cardRow().cancel_intent).toBeNull();
  });

  it('auto-renew on again: the scheduled cancel is undone; a permanent refusal turns it back off', async () => {
    await card.setCardAutoRenew(CFG, W, false);
    expect(await card.setCardAutoRenew(CFG, W, true)).toBe(true);
    expect(calls(`PATCH /subscriptions/${SUB}`)[0].body).toEqual({ scheduled_change: null });
    expect(cardRow().cancel_intent).toBeNull();

    await card.setCardAutoRenew(CFG, W, false);
    h.paddleOverride[`PATCH /subscriptions/${SUB}`] = () => ({ status: 400, body: { error: { code: 'invalid_field', detail: 'no' } } });
    await expect(card.setCardAutoRenew(CFG, W, true)).rejects.toMatchObject({ code: 'CARD_PROVIDER_ERROR' });
    expect(accountRow().auto_renew).toBe(false);
  });
});

describe('renewWithCard (design §2.5)', () => {
  beforeEach(() => {
    accountRow().balance_minor = 5000;
    h.plans.renewPlan.mockImplementation(async () => {
      Object.assign(accountRow(), { next_period_prepaid_minor: 2900, next_period_start: iso(E) });
      return { action: 'prepaid' };
    });
  });

  it("moves Paddle's charge one period on (previewed, do_not_bill) before the balance pays", async () => {
    const result = await card.renewWithCard(CFG, W, { actorId: 'u1', expectedPeriodEnd: iso(E), expectedPriceMinor: 2900 });
    expect(result).toEqual({ action: 'prepaid' });
    const moved = calls(`PATCH /subscriptions/${SUB}`)[0].body as Row;
    expect(moved.proration_billing_mode).toBe('do_not_bill');
    const prepaidEnd = new Date(E);
    prepaidEnd.setUTCMonth(prepaidEnd.getUTCMonth() + 1);
    expect(moved.next_billed_at).toBe(iso(prepaidEnd.getTime() - CARD_RENEWAL_LEAD_MS));
    expect(at(`paddle:PATCH /subscriptions/${SUB}/preview`)).toBeLessThan(at(`paddle:PATCH /subscriptions/${SUB}`));
    expect(h.plans.renewPlan).toHaveBeenCalledWith(CFG, W, 'u1', iso(E), 2900);
  });

  it('a renewal the balance cannot pay moves nothing at Paddle', async () => {
    accountRow().balance_minor = 100;
    h.plans.renewPlan.mockRejectedValue(Object.assign(new Error('INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE' }));
    await expect(card.renewWithCard(CFG, W, { actorId: null, expectedPeriodEnd: null, expectedPriceMinor: null })).rejects.toThrow('INSUFFICIENT_BALANCE');
    expect(calls(`PATCH /subscriptions/${SUB}`)).toHaveLength(0);
  });

  it('a past_due card is cancelled at Paddle first', async () => {
    cardRow().status = 'past_due';
    await card.renewWithCard(CFG, W, { actorId: null, expectedPeriodEnd: null, expectedPriceMinor: null });
    expect(at(`paddle:POST /subscriptions/${SUB}/cancel`)).toBeGreaterThanOrEqual(0);
    expect(cardRow()).toMatchObject({ status: 'canceled', cancel_reason: 'renewed_from_balance' });
    expect(h.plans.renewPlan).toHaveBeenCalled();
  });

  it('frozen around the charge: refused', async () => {
    cardRow().paddle_next_billed_at = iso(Date.now() + H);
    await expect(card.renewWithCard(CFG, W, { actorId: null, expectedPeriodEnd: null, expectedPriceMinor: null }))
      .rejects.toMatchObject({ code: 'CARD_RENEWAL_IN_PROGRESS' });
    expect(h.plans.renewPlan).not.toHaveBeenCalled();
  });
});

describe('assertCardAllowsPlanChange / cardView / cardAvailability', () => {
  it('past_due and frozen cards refuse plan changes; no card is no-op', async () => {
    await expect(card.assertCardAllowsPlanChange(CFG, W)).resolves.toBeUndefined();
    cardRow().status = 'past_due';
    await expect(card.assertCardAllowsPlanChange(CFG, W)).rejects.toMatchObject({ code: 'CARD_PAST_DUE' });
    table('billing_account_cards').length = 0;
    await expect(card.assertCardAllowsPlanChange(CFG, W)).resolves.toBeUndefined();
  });

  it('the view: next charge, its plan and amount, the card', async () => {
    const view = await card.cardView(CFG, W);
    expect(view).toMatchObject({
      id: CARD, provider: 'paddle_sandbox', status: 'active', brand: 'visa', last4: '4242', auto_renew: true,
      next_charge_at: iso(E - D), next_charge_minor: 2900, next_charge_plan: { plan_id: PRO, name: 'Pro' },
      next_charge_interval: 'monthly', scheduled_cancel_at: null, frozen_until: null, expires_before_next_charge: false,
    });
    Object.assign(cardRow(), { exp_month: 1, exp_year: 2020, cancel_intent: 'period_end', paddle_scheduled_change: { action: 'cancel', effective_at: iso(E - D) }, paddle_next_billed_at: null });
    expect(await card.cardView(CFG, W)).toMatchObject({ next_charge_at: null, scheduled_cancel_at: iso(E - D), expires_before_next_charge: false });
  });

  it('availability: International, Multi Region/Global, USD, a Paddle gateway with the switch on', async () => {
    h.accountGateways.mockResolvedValue([{ provider_name: 'stripe' }, { provider_name: 'paddle_sandbox' }]);
    expect(await card.cardAvailability(CFG, W, 'USD', { isPlatformAdmin: false })).toEqual({ available: true, providers: ['paddle_sandbox'] });
    expect(await card.cardAvailability(CFG, W, 'EUR', { isPlatformAdmin: false })).toMatchObject({ available: false, reason: 'currency' });
    h.regionMode = 'turkey';
    expect(await card.cardAvailability(CFG, W, 'USD', { isPlatformAdmin: false })).toMatchObject({ available: false, reason: 'region' });
    h.regionMode = 'global';
    h.gatewayConfig = { api_key: 'pdl_sdbx_apikey_mock', client_token: 'test_client_mock', card_auto_renew: 'false' };
    expect(await card.cardAvailability(CFG, W, 'USD', { isPlatformAdmin: false })).toMatchObject({ available: false, reason: 'no_gateway' });
    h.edition = 'iran';
    expect(await card.cardAvailability(CFG, W, 'USD', { isPlatformAdmin: false })).toMatchObject({ available: false, reason: 'edition' });
  });
});

describe('prepareCardSetup', () => {
  beforeEach(() => {
    h.accountGateways.mockResolvedValue([{ provider_name: 'paddle_sandbox' }]);
    table('billing_account_cards').length = 0;
    Object.assign(accountRow(), { card_provider: null, card_subscription_id: null, card_customer_id: 'ctm_old' });
  });
  const input = { providerName: 'paddle_sandbox', purpose: 'plan' as const, planId: PRO, interval: 'monthly' as const, viewer: { isPlatformAdmin: false } };

  it('closes older card checkouts and returns the recurring price with VAT', async () => {
    payments()[0].status = 'failed';
    table('billing_settings')[0].vat_percent = { USD: 20 };
    payments().push({ id: 'p-old', workspace_id: W, provider: 'paddle_sandbox', source: 'card_setup', status: 'pending', provider_ref: 'txn_old', card_id: null, created_at: iso(Date.now() - 5 * MIN) });
    h.closeCheckout.mockResolvedValue(true);
    const out = await card.prepareCardSetup(CFG, W, input);
    expect(out).toEqual({ customerId: null, recurring: { interval: 'monthly' }, priceCustomData: { plan_id: PRO, interval: 'monthly', net_minor: 2900, tax_minor: 580 } });
    expect(h.closeCheckout).toHaveBeenCalledWith(expect.anything(), 'txn_old');
    expect(payments().find((p) => p.id === 'p-old')).toMatchObject({ status: 'canceled', failure_reason: 'superseded' });
  });

  it("reuses the Paddle customer only when a card of the same gateway used it", async () => {
    payments()[0].status = 'failed';
    table('billing_account_cards').push({ id: uuid(), workspace_id: W, provider: 'paddle_sandbox', customer_id: 'ctm_old', status: 'canceled', created_at: iso(Date.now() - D) });
    expect((await card.prepareCardSetup(CFG, W, input)).customerId).toBe('ctm_old');
  });

  it('an older checkout already paid refuses a second setup', async () => {
    payments()[0].status = 'failed';
    payments().push({ id: 'p-paid', workspace_id: W, provider: 'paddle_sandbox', source: 'card_setup', status: 'pending', provider_ref: 'txn_paid', card_id: null, created_at: iso(Date.now() - 5 * MIN) });
    h.closeCheckout.mockResolvedValue(false);
    paddle.txns = [txnJson({ id: 'txn_paid', origin: 'web', status: 'paid' })];
    await expect(card.prepareCardSetup(CFG, W, input)).rejects.toMatchObject({ code: 'CARD_SETUP_IN_PROGRESS', status: 409 });
  });

  it('a live card refuses a second one; a non-card gateway is not available', async () => {
    seed();
    h.accountGateways.mockResolvedValue([{ provider_name: 'paddle_sandbox' }]);
    await expect(card.prepareCardSetup(CFG, W, input)).rejects.toMatchObject({ code: 'CARD_ALREADY_SAVED' });
    await expect(card.prepareCardSetup(CFG, W, { ...input, providerName: 'stripe' })).rejects.toMatchObject({ code: 'CARD_NOT_AVAILABLE' });
  });
});

describe('runCardJob', () => {
  it('recovers a paid card checkout with no card, cancels canceling cards, and one failure stops nothing', async () => {
    table('billing_account_cards').length = 0;
    Object.assign(accountRow(), { card_provider: null, card_subscription_id: null });
    Object.assign(payments()[0], { card_id: null, completed_at: iso(Date.now() - 20 * MIN) });
    paddle.txns = [txnJson({ id: 'txn_checkout', origin: 'web', status: 'completed' })];
    // A second, broken card: its gateway answers 500 to everything.
    table('billing_account_cards').push({ id: uuid(), workspace_id: W, provider: 'paddle_sandbox', subscription_id: 'sub_broken', currency: 'USD', status: 'canceling', cancel_reason: 'duplicate', sync_version: 1, synced_version: 0, sync_failures: 0, next_sync_at: iso(Date.now() - MIN), created_at: iso(Date.now()) });
    const report = await card.runCardJob(CFG);
    expect(report.activated).toBe(1);
    expect(table('billing_account_cards').find((c) => c.subscription_id === SUB)).toMatchObject({ status: 'active' });
    expect(report.errors.some((e) => e.includes('sub_broken') || e.startsWith('sync'))).toBe(true);
  });
});

describe('cardLabel', () => {
  it.each([
    ['visa', '4242', 'Visa •••• 4242'],
    ['american_express', '0005', 'American Express •••• 0005'],
    ['union_pay', '1234', 'UnionPay •••• 1234'],
    ['some_new_brand', '9999', 'Some New Brand •••• 9999'],
    [null, '1111', 'Card •••• 1111'],
    ['mastercard', null, 'Mastercard'],
  ])('%s %s → %s', (brand, last4, label) => {
    expect(card.cardLabel(brand, last4)).toBe(label);
  });
});
