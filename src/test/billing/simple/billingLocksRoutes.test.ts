/**
 * The routes of simple billing phase 4's server part (design §9, §10):
 *
 *   - GET  /api/billing/account/:ws/quote asks for the downgrade report and
 *     hides other members' names and e-mails from a member who cannot manage;
 *   - GET  /api/billing/account/:ws/lock-report: managers only, the plan in
 *     force by default;
 *   - POST /api/billing/account/:ws/change passes acknowledgeLocks, and
 *     LOCKS_NOT_ACKNOWLEDGED comes back as 409 with the report;
 *   - Super Admin billing locks: platform admin only, the switch per edition
 *     (only that column written, every cached lock state dropped), and the
 *     preview over active workspaces;
 *   - Super Admin plans: locked_data_retention_days, is_hidden and
 *     ai_allowance are saved on create, validated on create and edit with a
 *     readable 400;
 *   - GET /api/plans/workspace/:id/effective carries the lock summary.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const WS2 = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';

class FakeBillingError extends Error {
  constructor(public code: string, public status = 400, public details: Record<string, unknown> | null = null) {
    super(code);
  }
}

const REPORT = {
  locks_enabled: true, plan_id: PLAN, has_locks: true,
  kb_article: { limit: 2, total: 3, locked: 1, items: [] },
  contact: { limit: 2, total: 2, locked: 0 },
  member: { limit: 2, total: 3, locked: 1, items: [{ user_id: 'u9', name: 'Nine', email: 'nine@acme.test' }] },
  conversation: { retention_days: 30, total: 0, locked: 0, cutoff: null, oldest_kept: null },
  conversation_quota: { limit: null, used_this_month: 0, full: false },
  storage: { limit_gb: null, used_gb: 0, uploads_blocked: false },
  locked_data_retention_days: null, first_deletion_not_before: null,
  modules_lost: [], channels_lost: [], channels_stop_messages: false, ai_credits: { current: null, target: null },
};

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  admin: true,
  locksSwitch: false,
  quote: vi.fn(),
  scheduleChange: vi.fn(),
  buildLockReport: vi.fn(),
  clearLockStateCache: vi.fn(),
  lockSummary: vi.fn(),
  writes: [] as Array<{ table: string; op: string; row: unknown; opts?: unknown }>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  workspaces: [] as Array<{ id: string; name: string }>,
  reports: {} as Record<string, unknown>,
  xRows: [] as Array<{ workspace_id: string }>,
  xAllowed: false,
  kbLocked: {} as Record<string, number>,
}));

vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async (_req: unknown, res: { status(c: number): { json(b: unknown): void } }, _ws: string, opts: { manage?: boolean } = {}) => {
    if (opts.manage && !['owner', 'admin'].includes(h.role)) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return null;
    }
    return { userId: 'u1', isAdmin: false, role: h.role };
  },
  requirePlatformAdmin: async (_req: unknown, res: { status(c: number): { json(b: unknown): void } }) => {
    if (!h.admin) {
      res.status(403).json({ error: 'Platform admin required' });
      return null;
    }
    return 'admin-1';
  },
}));

/** A query builder over the few tables these routes touch. */
function fakeClient() {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      h.rpcs.push({ name, args });
      if (name === 'billing_lock_compute') {
        const locked = h.kbLocked[String(args.p_workspace_id)] ?? 0;
        return Promise.resolve({ data: [{ lim: 1, total: 1 + locked, locked, cut_ts: null, cut_id: null }], error: null });
      }
      if (name === 'enqueue_kb_catchup') return Promise.resolve({ data: 1, error: null });
      if (name === 'billing_lock_report') {
        const data = h.reports[String(args.p_workspace_id)];
        return Promise.resolve(data === 'error' ? { data: null, error: { message: 'boom' } } : { data, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      let range: [number, number] | null = null;
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'is', 'in', 'gte']) b[m] = () => b;
      b.range = (from: number, to: number) => {
        range = [from, to];
        return b;
      };
      const result = () => {
        if (table === 'billing_settings') return { data: { locks_enabled: h.locksSwitch }, error: null };
        if (table === 'workspaces') return { data: range ? h.workspaces.slice(range[0], range[1] + 1) : h.workspaces, error: null };
        if (table === 'workspace_plugin_installations') return { data: h.xRows, error: null };
        return { data: [], error: null };
      };
      b.maybeSingle = async () => result();
      b.single = async () => ({ data: { id: 'new-plan', ...(h.writes.at(-1)?.row as object) }, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve(result());
      b.upsert = (row: unknown, opts: unknown) => {
        h.writes.push({ table, op: 'upsert', row, opts });
        return Promise.resolve({ data: null, error: null });
      };
      b.insert = (row: unknown) => {
        h.writes.push({ table, op: 'insert', row });
        return b;
      };
      b.update = (row: unknown) => {
        h.writes.push({ table, op: 'update', row });
        return b;
      };
      return b;
    },
  };
}

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../../server/services/platformRegion.js', () => ({
  getPlatformEdition: async () => 'international',
  getPlatformEditionOrNull: async () => 'international',
  EditionUnavailableError: class extends Error {},
}));
vi.mock('../../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true }),
  checkModuleAccess: async () => ({ allowed: true }),
  checkChannelAccess: async () => ({ allowed: h.xAllowed }),
  getWorkspacePlanInfoDetailed: async () => ({
    ok: true,
    value: { plan: { name: 'Pro', slug: 'pro' }, subscription: null, entitlements: {}, limits: {}, planLimits: {}, limitOverrides: {} },
  }),
  clearEntitlementCache: () => {},
  SELF_HOST_UNLIMITED: 'self_host_unlimited',
}));
vi.mock('../../../../server/services/billing/locks/state.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearLockStateCache: h.clearLockStateCache,
  lockSummary: h.lockSummary,
}));
vi.mock('../../../../server/services/billing/locks/report.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildLockReport: h.buildLockReport,
}));
vi.mock('../../../../server/services/billing/entitlementChange.js', () => ({
  handleWorkspaceEntitlementChanged: async () => ({ ok: true }),
  handlePlanDefinitionChanged: async () => ({ ok: true, backgrounded: true, skipped: true }),
}));
vi.mock('../../../../server/services/billing/account/renewalNotice.js', () => ({ renewalDueNotice: async () => null }));
vi.mock('../../../../server/services/billing/account/index.js', () => ({
  AccountBillingError: FakeBillingError,
  accountCurrency: async () => 'USD',
}));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  editionErrorResponse: () => null,
  getBillingRegion: async () => ({ edition: 'international', regionMode: 'multi', currency: 'USD' }),
}));
vi.mock('../../../../server/services/billing/account/plans.js', () => ({
  accountPlanState: async () => ({}),
  amountNeededFor: async () => ({}),
  buyPlan: async () => ({}),
  listPlanOptions: async () => [],
  processDueNow: async () => null,
  quotePlanChange: h.quote,
  scheduleChange: h.scheduleChange,
  setAutoRenew: async () => true,
  upgradePlan: async () => ({}),
  afterAdminAssignment: async () => undefined,
}));
vi.mock('../../../../server/services/billing/account/card.js', () => ({
  assertCardAllowsPlanChange: async () => undefined,
  syncWorkspaceCard: async () => undefined,
  cardAvailability: async () => ({ available: false, providers: [] }),
  cardView: async () => null,
}));

const { billingAccountRouter } = await import('../../../../server/routes/billingAccount.js');
const { adminBillingLocksRouter } = await import('../../../../server/routes/adminBillingLocks.js');
const { plansRouter } = await import('../../../../server/routes/plans.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k', selfHostBillingUnlimited: false };
  next();
});
app.use(express.json());
app.use('/api/billing', billingAccountRouter);
app.use('/api/admin/billing/locks', adminBillingLocksRouter);
app.use('/api/plans', plansRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

beforeEach(() => {
  h.role = 'owner';
  h.admin = true;
  h.locksSwitch = false;
  h.writes.length = 0;
  h.rpcs.length = 0;
  h.workspaces = [];
  h.reports = {};
  h.xRows = [];
  h.xAllowed = false;
  h.kbLocked = {};
  for (const fn of [h.quote, h.scheduleChange, h.buildLockReport, h.clearLockStateCache, h.lockSummary]) fn.mockReset();
  h.quote.mockImplementation(async () => ({ kind: 'schedule', plan_id: PLAN, lock_report: structuredClone(REPORT) }));
  h.buildLockReport.mockResolvedValue(REPORT);
});

describe('workspace billing: quote, lock report, change', () => {
  it('the quote asks for the downgrade report; a manager sees the members it names', async () => {
    const res = await call('GET', `/api/billing/account/${WS}/quote?planId=${PLAN}&interval=monthly`);
    expect(res.status).toBe(200);
    expect(h.quote.mock.calls[0].slice(2)).toEqual([PLAN, 'monthly', { withLockReport: true }]);
    expect((res.json.lock_report as typeof REPORT).member.items).toHaveLength(1);
  });

  it('a member who cannot manage gets the counts without names or e-mails', async () => {
    h.role = 'agent';
    const res = await call('GET', `/api/billing/account/${WS}/quote?planId=${PLAN}`);
    expect(res.status).toBe(200);
    expect(res.json.lock_report).toMatchObject({ member: { locked: 1, items: [] } });
  });

  it('lock-report: managers only; the plan in force unless one is named', async () => {
    let res = await call('GET', `/api/billing/account/${WS}/lock-report`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ plan_id: PLAN, has_locks: true });
    expect(h.buildLockReport.mock.calls[0].slice(1)).toEqual([WS, null]);
    res = await call('GET', `/api/billing/account/${WS}/lock-report?planId=${PLAN}`);
    expect(h.buildLockReport.mock.calls[1].slice(1)).toEqual([WS, PLAN]);
    expect((await call('GET', `/api/billing/account/${WS}/lock-report?planId=nope`)).status).toBe(400);
    h.role = 'agent';
    expect((await call('GET', `/api/billing/account/${WS}/lock-report`)).status).toBe(403);
    expect(h.buildLockReport).toHaveBeenCalledTimes(2);
  });

  it('change passes the acknowledgement; without it the 409 carries the report', async () => {
    h.scheduleChange.mockResolvedValueOnce({ action: 'change_scheduled' });
    let res = await call('POST', `/api/billing/account/${WS}/change`, { planId: PLAN, acknowledgeLocks: true });
    expect(res.status).toBe(200);
    expect(h.scheduleChange.mock.calls[0][2]).toMatchObject({ planId: PLAN, acknowledgeLocks: true });
    h.scheduleChange.mockRejectedValueOnce(new FakeBillingError('LOCKS_NOT_ACKNOWLEDGED', 409, { lock_report: REPORT }));
    res = await call('POST', `/api/billing/account/${WS}/change`, { planId: PLAN });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'LOCKS_NOT_ACKNOWLEDGED', details: { lock_report: { plan_id: PLAN } } });
    expect((await call('POST', `/api/billing/account/${WS}/change`, { planId: PLAN, acknowledgeLocks: 'yes' })).status).toBe(400);
  });
});

describe('Super Admin: billing locks', () => {
  it('platform admin only', async () => {
    h.admin = false;
    expect((await call('GET', '/api/admin/billing/locks')).status).toBe(403);
    expect((await call('PUT', '/api/admin/billing/locks', { enabled: true })).status).toBe(403);
    expect((await call('GET', '/api/admin/billing/locks/preview')).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it('reads and sets the edition switch, writing only that column, and drops every cached lock state', async () => {
    h.locksSwitch = true;
    expect((await call('GET', '/api/admin/billing/locks')).json).toEqual({ edition: 'international', locks_enabled: true });
    const res = await call('PUT', '/api/admin/billing/locks', { enabled: false });
    expect(res.json).toEqual({ edition: 'international', locks_enabled: false });
    expect(h.writes).toHaveLength(1);
    const { row, opts } = h.writes[0] as { row: Record<string, unknown>; opts: unknown };
    expect(Object.keys(row).sort()).toEqual(['edition', 'locks_enabled', 'updated_at', 'updated_by']);
    expect(row).toMatchObject({ edition: 'international', locks_enabled: false });
    expect(opts).toEqual({ onConflict: 'edition' });
    expect(h.clearLockStateCache).toHaveBeenCalledWith();
    expect((await call('PUT', '/api/admin/billing/locks', { enabled: 'on' })).status).toBe(400);
  });

  it('switching off re-indexes the AI knowledge of the workspaces whose articles the plan locks; switching on does not', async () => {
    h.workspaces = [{ id: WS, name: 'Acme' }, { id: WS2, name: 'Quiet' }];
    h.kbLocked = { [WS]: 3 };
    h.locksSwitch = false;
    await call('PUT', '/api/admin/billing/locks', { enabled: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.rpcs.filter((c) => c.name === 'enqueue_kb_catchup')).toEqual([]);
    h.locksSwitch = true;
    const res = await call('PUT', '/api/admin/billing/locks', { enabled: false });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(h.rpcs.filter((c) => c.name === 'enqueue_kb_catchup')).toEqual([
      { name: 'enqueue_kb_catchup', args: { _workspace_id: WS } },
    ]));
    expect(h.rpcs.filter((c) => c.name === 'billing_lock_compute').map((c) => c.args)).toEqual([
      { p_workspace_id: WS, p_kind: 'kb_article', p_plan_id: null },
      { p_workspace_id: WS2, p_kind: 'kb_article', p_plan_id: null },
    ]);
  });

  it('the preview lists the active workspaces that would lock, and X channels that stop', async () => {
    h.workspaces = [{ id: WS, name: 'Acme' }, { id: WS2, name: 'Quiet' }, { id: 'w3', name: 'Broken' }];
    h.reports = {
      [WS]: { plan_id: 'free', kb_article: { locked: 2 }, contact: { locked: 5 }, member: { locked: 1 }, conversation: { locked: 0 } },
      [WS2]: { plan_id: 'pro', kb_article: { locked: 0 }, contact: { locked: 0 }, member: { locked: 0 }, conversation: { locked: 0 } },
      w3: 'error',
    };
    h.xRows = [{ workspace_id: WS2 }, { workspace_id: WS2 }];
    const res = await call('GET', '/api/admin/billing/locks/preview');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      edition: 'international',
      locks_enabled: false,
      scanned: 3,
      truncated: false,
      failed: 1,
      workspaces_locking: 1,
      totals: { kb_article: 2, contact: 5, member: 1, conversation: 0 },
      workspaces: [{ workspace_id: WS, name: 'Acme', plan_id: 'free', kb_article: 2, contact: 5, member: 1, conversation: 0 }],
      x_channel_stops: [{ workspace_id: WS2, name: 'Quiet' }],
    });
    // Computed for the plan in force (p_plan_id null), as if the switch were on.
    expect(h.rpcs.filter((r) => r.name === 'billing_lock_report').map((r) => r.args.p_plan_id)).toEqual([null, null, null]);
    h.xAllowed = true;
    expect((await call('GET', '/api/admin/billing/locks/preview')).json.x_channel_stops).toEqual([]);
  });
});

describe('Super Admin: plan fields', () => {
  it('a new plan keeps its locked-data retention, visibility and AI allowance', async () => {
    const res = await call('POST', '/api/plans/admin', {
      name: 'Lite', slug: 'lite', locked_data_retention_days: '90', is_hidden: true, ai_allowance: { USD: 500 },
    });
    expect(res.status).toBe(200);
    const insert = h.writes.find((w) => w.table === 'billing_plans' && w.op === 'insert')!.row as Record<string, unknown>;
    expect(insert).toMatchObject({ locked_data_retention_days: 90, is_hidden: true, ai_allowance: { USD: 500 } });
  });

  it('defaults: never deleted, shown, no allowance', async () => {
    await call('POST', '/api/plans/admin', { name: 'Lite', slug: 'lite' });
    const insert = h.writes.find((w) => w.table === 'billing_plans' && w.op === 'insert')!.row as Record<string, unknown>;
    expect(insert).toMatchObject({ locked_data_retention_days: null, is_hidden: false, ai_allowance: {} });
  });

  it('a bad value answers a readable 400 on create and on edit, and writes nothing', async () => {
    let res = await call('POST', '/api/plans/admin', { name: 'Lite', slug: 'lite', locked_data_retention_days: 0 });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ field: 'locked_data_retention_days' });
    expect(String(res.json.error)).toMatch(/greater than 0/);
    res = await call('PUT', `/api/plans/admin/${PLAN}`, { locked_data_retention_days: -5 });
    expect(res.status).toBe(400);
    res = await call('PUT', `/api/plans/admin/${PLAN}`, { is_hidden: 'no' });
    expect(res.json).toMatchObject({ field: 'is_hidden' });
    expect(h.writes).toEqual([]);
  });

  it('an edit stores the cleaned value; empty means never deleted', async () => {
    let res = await call('PUT', `/api/plans/admin/${PLAN}`, { locked_data_retention_days: ' 45 ' });
    expect(res.status).toBe(200);
    expect(h.writes.find((w) => w.op === 'update')!.row).toMatchObject({ locked_data_retention_days: 45 });
    h.writes.length = 0;
    res = await call('PUT', `/api/plans/admin/${PLAN}`, { locked_data_retention_days: '' });
    expect(h.writes.find((w) => w.op === 'update')!.row).toMatchObject({ locked_data_retention_days: null });
  });
});

describe('the entitlements snapshot', () => {
  it('carries the lock summary', async () => {
    const summary = { enabled: true, any_locked: true, kb_article: { limit: 2, total: 3, locked: 1, cut: null }, contact: null, member: null, conversation: null, next_deletion_at: null };
    h.lockSummary.mockResolvedValue(summary);
    const res = await call('GET', `/api/plans/workspace/${WS}/effective`);
    expect(res.status).toBe(200);
    expect(res.json.locks).toEqual(summary);
    expect(h.lockSummary.mock.calls[0][1]).toBe(WS);
  });
});
