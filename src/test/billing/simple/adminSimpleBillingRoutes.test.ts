/**
 * Super Admin billing screens, server side (phase 6, migration 266):
 * server/routes/adminSimpleBilling.ts behind the real /api/admin gate, over
 * an in-memory service client.
 *
 * - Every route is platform-admin only (403 / 401 otherwise).
 * - Credit and debit: the actor is the signed-in admin, never the body; the
 *   currency is the server's (409 CURRENCY_CHANGED); each SQL exception maps
 *   to its code; an audit row is written, but not on a replay, and a failed
 *   audit write still answers 200; 30 an hour per admin, then 429.
 * - Reading an account changes nothing: processDueNow, ensureAccount,
 *   syncCard and cardView are never called.
 * - /revenue validates `months`; /settings validates and keeps `ai_packs`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

type Row = Record<string, unknown>;
/** A JSON answer, read loosely by the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>,
  auditInsert: 'ok' as 'ok' | 'error' | 'throw',
  edition: 'international' as 'iran' | 'international',
  regionMode: 'multi' as string,
  admins: new Set<string>(),
  sessions: {} as Record<string, string>,
  gatewayConfig: {} as Record<string, Record<string, unknown>>,
  spies: {
    processDueNow: vi.fn(),
    ensureAccount: vi.fn(),
    syncCard: vi.fn(),
    cardView: vi.fn(),
  },
}));

function matches(row: Row, filters: Array<(r: Row) => boolean>) {
  return filters.every((f) => f(row));
}

vi.mock('../../../../server/supabase.js', () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('no') }) },
    from(table: string) {
      const rows = () => (h.db[table] ||= []);
      const filters: Array<(r: Row) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let range: [number, number] | null = null;
      let wantCount = false;
      const result = () => {
        let out = rows().filter((r) => matches(r, filters));
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        const count = out.length;
        if (range) out = out.slice(range[0], range[1] + 1);
        return { data: out, error: null, count: wantCount ? count : null };
      };
      const b: Record<string, unknown> = {
        select: (_cols?: string, opts?: { count?: string }) => {
          if (opts?.count) wantCount = true;
          return b;
        },
        eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
        in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
        order: (col: string, opts?: { ascending?: boolean }) => { order = { col, asc: opts?.ascending !== false }; return b; },
        range: (from: number, to: number) => { range = [from, to]; return b; },
        limit: () => b,
        maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
        single: async () => ({ data: result().data[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(result()).then(resolve, reject),
        insert: (row: Row) => {
          if (table === 'audit_logs') {
            if (h.auditInsert === 'throw') throw new Error('audit exploded');
            if (h.auditInsert === 'error') return Promise.resolve({ error: { message: 'audit down' } });
          }
          rows().push(row);
          return Promise.resolve({ error: null });
        },
        upsert: (row: Row) => {
          const list = rows();
          const i = list.findIndex((r) => r.edition === row.edition);
          if (i >= 0) list[i] = { ...list[i], ...row };
          else list.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      h.rpcCalls.push({ name, args });
      const handler = h.rpc[name];
      if (handler) return { data: null, error: null, ...handler(args) };
      if (name === 'has_role') return { data: false, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
  return { getServiceClient: () => client };
});

vi.mock('../../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_c: unknown, userId: string) => h.admins.has(userId),
  logGateBypass: async () => {},
}));

vi.mock('../../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    const userId = token ? h.sessions[token] : undefined;
    return userId ? { sessionId: 's', userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

vi.mock('../../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/platformRegion.js')>()),
  getPlatformEdition: async () => h.edition,
  getPlatformEditionOrNull: async () => h.edition,
  getPlatformRegionMode: async () => h.regionMode,
}));

vi.mock('../../../../server/services/billing/account/plans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/plans.js')>()),
  processDueNow: h.spies.processDueNow,
}));

vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  ensureAccount: h.spies.ensureAccount,
}));

vi.mock('../../../../server/services/billing/account/card.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/card.js')>()),
  syncCard: h.spies.syncCard,
  cardView: h.spies.cardView,
}));

vi.mock('../../../../server/services/billing/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../server/services/billing/index.js')>();
  return {
    ...actual,
    resolveNamedBillingConfig: async (_u: string, _k: string, _ws: string, name: string) => {
      const provider = actual.getProvider(name);
      return provider ? { provider, config: { provider: name, ...(h.gatewayConfig[name] ?? {}) } } : null;
    },
  };
});

const { adminRouter } = await import('../../../../server/routes/admin.js');
const { resetAdjustRateLimit } = await import('../../../../server/routes/adminSimpleBilling.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig: Record<string, unknown> }).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], complianceAuditLoggingEnabled: true,
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: Body }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = { connection: 'close' };
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/admin/simple-billing${path}`, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ADMIN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const NO_WS = '55555555-5555-4555-8555-555555555555';
const PLAN = '66666666-6666-4666-8666-666666666666';
const KEY = '77777777-7777-4777-8777-777777777777';
const LEDGER = '88888888-8888-4888-8888-888888888888';

function adjustBody(over: Record<string, unknown> = {}) {
  return {
    direction: 'credit', amountMinor: 500, currency: 'USD', reason: 'Goodwill for the outage',
    category: 'goodwill', expectedBalanceMinor: 1000, commandKey: KEY, ...over,
  };
}

beforeEach(() => {
  resetAdjustRateLimit();
  h.edition = 'international';
  h.regionMode = 'multi';
  h.auditInsert = 'ok';
  h.rpcCalls.length = 0;
  h.gatewayConfig = {};
  h.admins = new Set([ADMIN]);
  h.sessions = { 'admin-token': ADMIN, 'user-token': USER };
  for (const spy of Object.values(h.spies)) spy.mockReset();
  h.db = {
    workspaces: [{ id: WS, name: 'Acme', slug: 'acme', owner_id: OWNER }],
    profiles: [{ id: OWNER, email: 'owner@acme.test' }, { id: ADMIN, email: 'admin@platform.test' }],
    billing_accounts: [{
      workspace_id: WS, currency: 'USD', balance_minor: 1000, auto_renew: true, scheduled_plan_id: null, scheduled_interval: null,
      next_period_prepaid_minor: null, next_period_start: null, billing_profile: { company: 'Acme Ltd' },
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    }],
    workspace_subscriptions: [{
      workspace_id: WS, plan_id: PLAN, status: 'active', billing_interval: 'monthly',
      current_period_start: '2026-09-01T00:00:00Z', current_period_end: '2026-10-01T00:00:00Z', trial_end: null,
    }],
    billing_plans: [{ id: PLAN, slug: 'pro', name: 'Pro', localized: {}, is_free: false, is_active: true }],
    billing_account_cards: [],
    billing_settings: [{ edition: 'international', seller: {}, vat_percent: { USD: 10 }, receipt_prefix: 'R', ai_packs: { USD: [{ id: 'm', price_minor: 2000, credit_minor: 2200 }] } }],
    billing_account_ledger: [],
    audit_logs: [],
    billing_gateways: [],
  };
  h.rpc = {
    billing_account_admin_adjust: (args) => {
      const balance = 1000 + Number(args.p_amount_minor);
      return { data: { replayed: false, ledger_id: LEDGER, balance_minor: balance } };
    },
    billing_admin_liability: () => ({ data: [{ currency: 'USD', accounts: 1, positive_accounts: 1, balance_minor: 1000, prepaid_minor: 0 }] }),
    billing_admin_revenue_days: () => ({ data: [] }),
    billing_admin_ledger_days: () => ({ data: [] }),
  };
});

describe('the admin gate', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/settings'],
    ['PUT', '/settings', {}],
    ['GET', '/accounts'],
    ['GET', `/accounts/${WS}`],
    ['GET', `/accounts/${WS}/ledger`],
    ['GET', `/accounts/${WS}/payments`],
    ['GET', `/accounts/${WS}/receipts/${LEDGER}`],
    ['POST', `/accounts/${WS}/adjust`, adjustBody()],
    ['GET', '/revenue'],
    ['GET', '/gateways'],
  ];

  it('a signed-in user who is not a platform admin gets 403 on every route, and nothing runs', async () => {
    for (const [method, path, body] of routes) {
      const res = await call(method, path, 'user-token', body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(h.rpcCalls.filter((c) => c.name !== 'has_role')).toEqual([]);
  });

  it('no session: 401', async () => {
    expect((await call('GET', '/accounts', null)).status).toBe(401);
    expect((await call('POST', `/accounts/${WS}/adjust`, null, adjustBody())).status).toBe(401);
  });
});

describe('GET /accounts', () => {
  it('passes the filter, search, sort and paging to the SQL; answers the edition currencies', async () => {
    h.rpc.billing_admin_accounts = () => ({
      data: { total: 41, items: [{ workspace_id: WS, name: 'Acme', slug: 'acme', has_account: true, currency: 'USD', balance_minor: '1000', card_status: 'past_due', ledger_count: 3 }] },
    });
    const res = await call('GET', `/accounts?q=acme&filter=owner:${OWNER}&sort=name_asc&page=3&pageSize=20&currency=USD`, 'admin-token');
    expect(res.status).toBe(200);
    expect(h.rpcCalls.find((c) => c.name === 'billing_admin_accounts')!.args).toEqual({
      p_search: 'acme', p_filter: `owner:${OWNER}`, p_currency: 'USD', p_sort: 'name_asc', p_limit: 20, p_offset: 40,
    });
    expect(res.json).toMatchObject({ edition: 'international', currencies: ['USD', 'TRY'], total: 41, page: 3, pageSize: 20 });
    expect(res.json.items[0]).toMatchObject({ workspace_id: WS, balance_minor: 1000, card_status: 'past_due', ledger_count: 3, owner_email: null });
  });

  it('defaults (with_account, balance_desc, 25) and refuses a bad filter, sort, currency or page size', async () => {
    h.rpc.billing_admin_accounts = () => ({ data: { total: 0, items: [] } });
    expect((await call('GET', '/accounts', 'admin-token')).status).toBe(200);
    expect(h.rpcCalls.find((c) => c.name === 'billing_admin_accounts')!.args).toMatchObject({
      p_search: null, p_filter: 'with_account', p_currency: null, p_sort: 'balance_desc', p_limit: 25, p_offset: 0,
    });
    for (const q of ['filter=rich', 'filter=owner:nope', 'sort=random', 'currency=usd', 'pageSize=101', 'page=0', `q=${'x'.repeat(101)}`]) {
      expect((await call('GET', `/accounts?${q}`, 'admin-token')).status, q).toBe(400);
    }
  });
});

describe('GET /accounts/:workspaceId (read only)', () => {
  it('the account, its plan, card and VAT; nothing is processed, created or synced', async () => {
    h.db.billing_account_cards = [{ id: 'c1', workspace_id: WS, provider: 'paddle', status: 'past_due', brand: 'visa', last4: '4242', paddle_next_billed_at: '2026-10-20T00:00:00Z', cancel_intent: null }];
    const res = await call('GET', `/accounts/${WS}`, 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      workspace: { id: WS, name: 'Acme', slug: 'acme', owner: { id: OWNER, email: 'owner@acme.test' } },
      has_account: true,
      edition: 'international',
      currency: 'USD',
      balance_minor: 1000,
      auto_renew: true,
      plan: { plan_id: PLAN, name: 'Pro', status: 'active' },
      // The period ended on 2026-10-01 and the job has not moved it yet.
      due_unprocessed: true,
      card: { status: 'past_due', provider: 'paddle', brand: 'visa', last4: '4242' },
      billing_profile: { company: 'Acme Ltd' },
      vat_percent: 10,
    });
    for (const spy of Object.values(h.spies)) expect(spy).not.toHaveBeenCalled();
    expect(h.rpcCalls.map((c) => c.name)).not.toContain('billing_account_ensure');
  });

  it('a workspace with no account: the region currency, zero, has_account false, nothing created', async () => {
    h.db.billing_accounts = [];
    h.regionMode = 'turkey';
    const res = await call('GET', `/accounts/${WS}`, 'admin-token');
    expect(res.json).toMatchObject({ has_account: false, currency: 'TRY', balance_minor: 0, card: null });
    expect(h.spies.ensureAccount).not.toHaveBeenCalled();
    expect(h.db.billing_accounts).toEqual([]);
  });

  it('404 for a workspace that does not exist; 400 for a bad id', async () => {
    expect(await call('GET', `/accounts/${NO_WS}`, 'admin-token')).toMatchObject({ status: 404, json: { error: 'NOT_FOUND' } });
    expect((await call('GET', '/accounts/not-a-uuid', 'admin-token')).status).toBe(400);
  });
});

describe('ledger, payments, receipts', () => {
  it('the ledger names the admin behind a manual row, and hides the idempotency key', async () => {
    h.db.billing_account_ledger = [
      { id: LEDGER, workspace_id: WS, kind: 'admin_credit', amount_minor: 500, balance_after: 1500, currency: 'USD', actor_id: ADMIN, idempotency_key: `admin:${KEY}`, description: { reason: 'x', category: 'goodwill' }, created_at: '2026-10-02T00:00:00Z' },
      { id: 'l2', workspace_id: WS, kind: 'topup', amount_minor: 1000, balance_after: 1000, currency: 'USD', actor_id: null, idempotency_key: 'k2', receipt_number: 'R-1', description: {}, created_at: '2026-10-01T00:00:00Z' },
    ];
    const res = await call('GET', `/accounts/${WS}/ledger?page=1&pageSize=10`, 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ total: 2, page: 1, pageSize: 10 });
    expect(res.json.items[0]).toMatchObject({ id: LEDGER, actor_email: 'admin@platform.test' });
    expect(res.json.items[0]).not.toHaveProperty('idempotency_key');
    expect(res.json.items[1]).toMatchObject({ id: 'l2', actor_email: null });
  });

  it('payments: every status with refunds and the test marker', async () => {
    h.rpc.billing_admin_account_payments = (args) => {
      expect(args).toEqual({ p_workspace_id: WS, p_limit: 20, p_offset: 0 });
      return {
        data: {
          total: 1,
          items: [{
            id: 'p1', provider: 'paddle_sandbox', status: 'succeeded', currency: 'USD', amount_minor: '1100', net_minor: 1000, tax_minor: 100,
            purpose: 'topup', source: 'checkout', refunded_minor: 1100,
            refunds: [{ refund_id: 'r1', amount_minor: 1100, credit_minor: 1000, shortfall_minor: 0, released_prepaid_minor: 0, refunded_at: '2026-10-05T00:00:00Z' }],
            created_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:01:00Z',
          }],
        },
      };
    };
    const res = await call('GET', `/accounts/${WS}/payments`, 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.items[0]).toMatchObject({ id: 'p1', is_test: true, amount_minor: 1100, refunds: [{ refund_id: 'r1', refunded_at: '2026-10-05T00:00:00Z' }] });
  });

  it('a receipt of this workspace, else 404', async () => {
    h.db.billing_account_ledger = [{ id: LEDGER, workspace_id: WS, kind: 'topup', amount_minor: 1, balance_after: 1, currency: 'USD', receipt_number: 'R-9', description: {}, created_at: 'x' }];
    expect(await call('GET', `/accounts/${WS}/receipts/${LEDGER}`, 'admin-token')).toMatchObject({ status: 200, json: { receipt: { receipt_number: 'R-9' } } });
    expect((await call('GET', `/accounts/${NO_WS}/receipts/${LEDGER}`, 'admin-token')).status).toBe(404);
  });
});

describe('POST /accounts/:workspaceId/adjust', () => {
  const path = `/accounts/${WS}/adjust`;
  const adjustCalls = () => h.rpcCalls.filter((c) => c.name === 'billing_account_admin_adjust');

  it('credits with the signed-in admin as actor (a body actor is refused), and writes an audit row', async () => {
    expect((await call('POST', path, 'admin-token', adjustBody({ actorId: USER }))).status).toBe(400);
    expect(adjustCalls()).toHaveLength(0);
    const res = await call('POST', path, 'admin-token', adjustBody({ reason: '  Goodwill for the outage  ' }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ replayed: false, ledger_id: LEDGER, balance_minor: 1500, account: { workspace: { id: WS } } });
    expect(adjustCalls()[0].args).toEqual({
      p_workspace_id: WS, p_amount_minor: 500, p_currency: 'USD', p_reason: 'Goodwill for the outage', p_actor_id: ADMIN,
      p_command_key: KEY, p_category: 'goodwill', p_expected_balance_minor: 1000,
    });
    expect(h.db.audit_logs).toEqual([expect.objectContaining({
      workspace_id: WS, user_id: ADMIN, action: 'billing.admin_adjust', entity_type: 'billing_account', entity_id: LEDGER,
      new_value: { amount_minor: 500, currency: 'USD', category: 'goodwill', reason: 'Goodwill for the outage', balance_after: 1500 },
    })]);
  });

  it('a debit is signed negative', async () => {
    const res = await call('POST', path, 'admin-token', adjustBody({ direction: 'debit', amountMinor: 1000, category: 'correction' }));
    expect(res.status).toBe(200);
    expect(adjustCalls()[0].args).toMatchObject({ p_amount_minor: -1000, p_category: 'correction' });
  });

  it('the currency is the server\'s: 409 CURRENCY_CHANGED with the account, nothing booked', async () => {
    const res = await call('POST', path, 'admin-token', adjustBody({ currency: 'TRY' }));
    expect(res).toMatchObject({ status: 409, json: { error: 'CURRENCY_CHANGED', account: { currency: 'USD' } } });
    expect(adjustCalls()).toHaveLength(0);
  });

  it('a workspace with no account is credited in the region currency', async () => {
    h.db.billing_accounts = [];
    h.regionMode = 'turkey';
    expect((await call('POST', path, 'admin-token', adjustBody())).status).toBe(409);
    expect((await call('POST', path, 'admin-token', adjustBody({ currency: 'TRY' }))).status).toBe(200);
    expect(adjustCalls()[0].args).toMatchObject({ p_currency: 'TRY' });
  });

  it('refuses a bad body before the SQL', async () => {
    const bad = [
      adjustBody({ amountMinor: 0 }), adjustBody({ amountMinor: 1.5 }), adjustBody({ amountMinor: -5 }),
      adjustBody({ reason: ' ab ' }), adjustBody({ reason: 'x'.repeat(501) }), adjustBody({ category: 'bonus' }),
      adjustBody({ expectedBalanceMinor: -1 }), adjustBody({ commandKey: 'nope' }), adjustBody({ direction: 'up' }), adjustBody({ currency: 'usd' }),
    ];
    for (const body of bad) expect((await call('POST', path, 'admin-token', body)).json, JSON.stringify(body)).toEqual({ error: 'INVALID_REQUEST' });
    expect(await call('POST', path, 'admin-token', adjustBody({ amountMinor: 5_000_001 }))).toMatchObject({ status: 400, json: { error: 'ADJUST_TOO_LARGE' } });
    expect((await call('POST', `/accounts/${NO_WS}/adjust`, 'admin-token', adjustBody())).status).toBe(404);
    expect(adjustCalls()).toHaveLength(0);
  });

  it.each([
    ['billing_adjust_balance_changed', 409, 'BALANCE_CHANGED'],
    ['billing_account_currency_mismatch', 409, 'CURRENCY_CHANGED'],
    ['billing_insufficient_balance', 409, 'INSUFFICIENT_BALANCE'],
    ['billing_adjust_key_reused', 409, 'KEY_REUSED'],
    ['billing_adjust_too_large', 400, 'ADJUST_TOO_LARGE'],
    ['billing_adjust_reason_required', 400, 'INVALID_REQUEST'],
    ['billing_adjust_bad_category', 400, 'INVALID_REQUEST'],
    ['billing_adjust_missing_key', 400, 'INVALID_REQUEST'],
    ['billing_adjust_zero', 400, 'INVALID_REQUEST'],
  ])('SQL %s → %i %s, no audit row', async (sql, status, code) => {
    h.rpc.billing_account_admin_adjust = () => ({ error: { message: sql } });
    const res = await call('POST', path, 'admin-token', adjustBody());
    expect(res.status).toBe(status);
    expect(res.json.error).toBe(code);
    if (code === 'BALANCE_CHANGED' || code === 'CURRENCY_CHANGED') expect(res.json.account).toMatchObject({ balance_minor: 1000 });
    expect(h.db.audit_logs).toEqual([]);
  });

  it('an unknown SQL error is a 500', async () => {
    h.rpc.billing_account_admin_adjust = () => ({ error: { message: 'connection reset' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await call('POST', path, 'admin-token', adjustBody())).toMatchObject({ status: 500, json: { error: 'INTERNAL_ERROR' } });
    spy.mockRestore();
  });

  it('a replay answers the first booking and writes no second audit row', async () => {
    h.rpc.billing_account_admin_adjust = () => ({ data: { replayed: true, ledger_id: LEDGER, balance_minor: 1500 } });
    const res = await call('POST', path, 'admin-token', adjustBody());
    expect(res).toMatchObject({ status: 200, json: { replayed: true, ledger_id: LEDGER, balance_minor: 1500 } });
    expect(h.db.audit_logs).toEqual([]);
  });

  it.each(['error', 'throw'] as const)('a failed audit write (%s) still answers 200', async (mode) => {
    h.auditInsert = mode;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('POST', path, 'admin-token', adjustBody());
    spy.mockRestore();
    expect(res).toMatchObject({ status: 200, json: { replayed: false, balance_minor: 1500 } });
  });

  it('30 an hour per admin, then 429 TOO_MANY_ADJUSTMENTS (another admin is not limited)', async () => {
    for (let i = 0; i < 30; i++) expect((await call('POST', path, 'admin-token', adjustBody())).status).toBe(200);
    expect(await call('POST', path, 'admin-token', adjustBody())).toMatchObject({ status: 429, json: { error: 'TOO_MANY_ADJUSTMENTS' } });
    expect(adjustCalls()).toHaveLength(30);
    const OTHER = '99999999-9999-4999-8999-999999999999';
    h.admins.add(OTHER);
    h.sessions['other-token'] = OTHER;
    expect((await call('POST', path, 'other-token', adjustBody())).status).toBe(200);
  });
});

describe('GET /revenue', () => {
  it('validates months (1-36, default 12) and includeTest', async () => {
    for (const q of ['months=0', 'months=37', 'months=abc', 'months=1.5', 'includeTest=maybe']) {
      expect((await call('GET', `/revenue?${q}`, 'admin-token')).status, q).toBe(400);
    }
    const res = await call('GET', '/revenue', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.months).toHaveLength(12);
    expect(res.json).toMatchObject({ edition: 'international', calendar: 'gregorian', time_zone: 'UTC', include_test: false, currencies: ['USD', 'TRY'] });
    expect(res.json.liability).toEqual([{ currency: 'USD', accounts: 1, positive_accounts: 1, balance_minor: 1000, prepaid_minor: 0 }]);
  });

  it('reads (months + 1) × 31 days in the edition time zone and buckets them', async () => {
    h.edition = 'iran';
    h.rpc.billing_admin_revenue_days = () => ({
      data: [
        { day: new Date().toISOString().slice(0, 10), metric: 'payment', currency: 'IRR', provider: 'zarinpal', source: 'checkout', purpose: 'topup', count: '2', gross_minor: '2200000', tax_minor: '200000', net_minor: '2000000' },
      ],
    });
    const res = await call('GET', '/revenue?months=6&includeTest=1', 'admin-token');
    expect(res.status).toBe(200);
    const args = h.rpcCalls.find((c) => c.name === 'billing_admin_revenue_days')!.args as { p_from: string; p_to: string; p_time_zone: string };
    expect(args.p_time_zone).toBe('Asia/Tehran');
    const days = (Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000;
    expect(days).toBeCloseTo(7 * 31, 5);
    expect(h.rpcCalls.find((c) => c.name === 'billing_admin_ledger_days')!.args).toEqual(args);
    expect(res.json).toMatchObject({ calendar: 'jalali', include_test: true, currencies: ['IRR', 'USD'] });
    expect(res.json.months).toHaveLength(6);
    expect(res.json.totals.IRR).toMatchObject({ payments: 2, net_minor: 2_000_000 });
  });
});

describe('GET /gateways (readiness)', () => {
  it('per gateway and currency: listed, or why not', async () => {
    h.db.billing_gateways = [
      { id: 'g1', provider_name: 'paddle', display_name: { en: 'Paddle' }, is_active: true, is_test: false, currencies: ['USD'], countries: [], sort_order: 1, config: {} },
      { id: 'g2', provider_name: 'stripe', display_name: { en: 'Stripe' }, is_active: false, is_test: false, currencies: [], countries: [], sort_order: 2, config: {} },
      { id: 'g3', provider_name: 'zarinpal', display_name: { en: 'Zarinpal' }, is_active: true, is_test: false, currencies: ['IRR'], countries: [], sort_order: 3, config: {} },
    ];
    h.gatewayConfig.paddle = { card_auto_renew: true };
    const res = await call('GET', '/gateways', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.edition).toBe('international');
    expect(res.json.currencies).toEqual(['USD', 'TRY']);
    const byName = Object.fromEntries((res.json.gateways as Array<{ provider_name: string }>).map((g) => [g.provider_name, g])) as Record<string, Body>;
    // An Iranian gateway does not exist in the international edition.
    expect(byName.zarinpal).toBeUndefined();
    expect(byName.paddle.listing.TRY).toMatchObject({ listed: false });
    expect(byName.paddle.listing.TRY.reasons).toContain('currency');
    expect(byName.paddle.card_auto_renew).toBe(true);
    expect(byName.stripe.listing.USD.reasons).toContain('inactive');
    expect(byName.stripe).not.toHaveProperty('card_auto_renew');
  });

  it('Iran: an active Iranian gateway in IRR is listed', async () => {
    h.edition = 'iran';
    h.db.billing_gateways = [
      { id: 'g3', provider_name: 'zarinpal', display_name: { fa: 'زرین‌پال' }, is_active: true, is_test: false, currencies: ['IRR'], countries: [], sort_order: 1, config: {} },
    ];
    h.rpc.billing_admin_liability = () => ({ data: [] });
    const res = await call('GET', '/gateways', 'admin-token');
    const zarinpal = (res.json.gateways as Body[]).find((g) => g.provider_name === 'zarinpal')!;
    expect(res.json.currencies).toEqual(['IRR']);
    expect(zarinpal.listing.IRR).toEqual({ listed: true, reasons: [] });
  });
});

describe('/settings and the AI packs', () => {
  it('GET adds this edition\'s AI currencies and packs', async () => {
    const res = await call('GET', '/settings', 'admin-token');
    expect(res.json).toMatchObject({
      ai_currencies: ['USD', 'TRY'],
      ai_packs: { USD: [{ id: 'm', price_minor: 2000, credit_minor: 2200, active: true }], TRY: [] },
    });
  });

  it('PUT without ai_packs keeps the stored packs; an invalid ai_packs is 400 and writes nothing', async () => {
    const ok = await call('PUT', '/settings', 'admin-token', { seller: { legal_name: 'Acme' }, vat_percent: { USD: 10 }, receipt_prefix: 'R' });
    expect(ok.status).toBe(200);
    expect(h.db.billing_settings[0].ai_packs).toEqual({ USD: [{ id: 'm', price_minor: 2000, credit_minor: 2200 }] });
    expect(ok.json.ai_packs.USD[0].id).toBe('m');
    const before = JSON.stringify(h.db.billing_settings);
    const bad = await call('PUT', '/settings', 'admin-token', { seller: {}, vat_percent: {}, receipt_prefix: 'R', ai_packs: { USD: [{ id: 'Bad Id', price_minor: 1, credit_minor: 1 }] } });
    expect(bad).toMatchObject({ status: 400, json: { error: 'AI_PACKS_INVALID', field: 'USD.0.id' } });
    expect(JSON.stringify(h.db.billing_settings)).toBe(before);
  });

  it('PUT with valid ai_packs saves them normalised', async () => {
    const res = await call('PUT', '/settings', 'admin-token', {
      seller: {}, vat_percent: {}, receipt_prefix: 'R', ai_packs: { TRY: [{ id: 's', price_minor: 10_000, credit_minor: 12_000 }] },
    });
    expect(res.status).toBe(200);
    expect(h.db.billing_settings[0].ai_packs).toEqual({ USD: [], TRY: [{ id: 's', price_minor: 10_000, credit_minor: 12_000, active: true }] });
    expect(h.db.billing_settings[0].updated_by).toBe(ADMIN);
  });
});
