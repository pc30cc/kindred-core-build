/**
 * The server's guard of the AI Advanced tools (server/routes/ai-agent/index.ts,
 * owner 2026-11-03; docs/operations/AI_ADVANCED_TOOLS.md), through the real
 * AI Agent router:
 *   - /platform/* (the Super Admin's AI Control Center) stays Super Admin
 *     only, whatever the workspace's plan;
 *   - an owner (or an admin) of a workspace whose plan has
 *     `ai_advanced_tools` reaches the Advanced tools' endpoints for THAT
 *     workspace, never another's (not even one they are an agent in, whose
 *     plan has the key too), whether the other workspace is named in the
 *     query or reached through a resource id;
 *   - an agent with the key, an owner without it, and an owner whose plan
 *     cannot be read are refused;
 *   - the old platform switches (advanced_tools_enabled and the
 *     *_visible_to_customers ones, all off here) no longer block a
 *     plan-enabled workspace.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { readFileSync } from 'node:fs';

const WS_A = '11111111-1111-4111-8111-111111111111'; // plan with the key
const WS_B = '22222222-2222-4222-8222-222222222222'; // plan with the key
const WS_C = '33333333-3333-4333-8333-333333333333'; // plan without it
const WS_D = '44444444-4444-4444-8444-444444444444'; // plan unreadable
const RUN_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const RUN_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BATCH_A = 'aaaaaaaa-1111-4000-8000-00000000000a';
const BATCH_B = 'bbbbbbbb-1111-4000-8000-00000000000b';
const SCHEDULE_B = 'bbbbbbbb-2222-4000-8000-00000000000b';
const MISSING = 'eeeeeeee-0000-4000-8000-00000000000e';

const ADMINS = new Set(['super-admin']);
const PLANS: Record<string, { allowed: boolean; reason?: string; plan?: string }> = {
  [WS_A]: { allowed: true, plan: 'pro' },
  [WS_B]: { allowed: true, plan: 'pro' },
  [WS_C]: { allowed: false, plan: 'starter', reason: 'registry_default' },
  [WS_D]: { allowed: false, plan: 'error', reason: 'rpc_error' },
};

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  workspace_members: [
    { workspace_id: WS_A, user_id: 'owner-a', role: 'owner', suspended_at: null },
    { workspace_id: WS_A, user_id: 'admin-a', role: 'admin', suspended_at: null },
    { workspace_id: WS_A, user_id: 'agent-a', role: 'agent', suspended_at: null },
    { workspace_id: WS_A, user_id: 'banned-a', role: 'admin', suspended_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS_B, user_id: 'owner-a', role: 'agent', suspended_at: null },
    { workspace_id: WS_B, user_id: 'owner-b', role: 'owner', suspended_at: null },
    { workspace_id: WS_C, user_id: 'owner-c', role: 'owner', suspended_at: null },
    { workspace_id: WS_D, user_id: 'owner-d', role: 'owner', suspended_at: null },
  ],
  ai_agent_settings: [],
  ai_agent_test_cases: [
    { id: 'tc-a', workspace_id: WS_A, name: 'A case', created_at: '2026-11-01' },
    { id: 'tc-b', workspace_id: WS_B, name: 'B case', created_at: '2026-11-01' },
    { id: 'tc-c', workspace_id: WS_C, name: 'C case', created_at: '2026-11-01' },
  ],
  ai_agent_test_runs: [
    { id: RUN_A, workspace_id: WS_A, test_case_id: null, status: 'passed' },
    { id: RUN_B, workspace_id: WS_B, test_case_id: null, status: 'failed' },
  ],
  ai_agent_regression_batches: [
    { id: BATCH_A, workspace_id: WS_A, status: 'completed' },
    { id: BATCH_B, workspace_id: WS_B, status: 'completed', total_cases: 1, metadata: {} },
  ],
  ai_agent_regression_schedules: [{ id: SCHEDULE_B, workspace_id: WS_B }],
};

/**
 * A value as Postgres compares it here: a uuid is one whatever its spelling
 * (any case, hyphens or not, in braces), as `id = '<text>'` casts the text.
 */
function pgText(v: unknown): string {
  const s = String(v).toLowerCase();
  const hex = s.replace(/[{}-]/g, '');
  return /^[0-9a-f{}-]+$/.test(s) && /^[0-9a-f]{32}$/.test(hex) ? hex : s;
}

/** A small PostgREST-shaped fake over TABLES: select/eq/in/order/limit/ilike/gte, maybeSingle/single, await. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (TABLES[table] || []).filter((r) => filters.every((f) => f(r)));
      const q = {
        select: () => q,
        order: () => q,
        limit: () => q,
        gte: () => q,
        ilike: () => q,
        eq: (col: string, val: unknown) => {
          filters.push((r) => pgText(r[col]) === pgText(val));
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null; count: number }) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  // The bearer token is the user id.
  validateSessionToken: async (_config: unknown, token: string | undefined) =>
    token ? { sessionId: 's', userId: token, email: `${token}@example.com` } : null,
  verifyOriginForMutation: () => true,
  renewMobileSessionIfDue: async () => {},
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_config: unknown, userId: string) => ADMINS.has(userId),
  logGateBypass: async () => {},
}));

vi.mock('../../../server/services/ai-agent/platformSettings.js', () => ({
  getPlatformAiAgentSettings: async () => ({
    ai_agent_enabled: true,
    customer_ai_agent_visible: true,
    // The old switches, all off: they must not block a plan with the key.
    advanced_tools_enabled: false,
    regression_runner_enabled: false,
    source_health_visible_to_customers: false,
    test_harness_visible_to_customers: false,
    files_enabled: true,
    secret_marker: 'PLATFORM_SETTINGS',
    metadata: {},
  }),
  updatePlatformAiAgentSettings: async () => {
    throw new Error('forbidden');
  },
  isPlatformSettingsLookupFailed: () => false,
}));

const entitlementCalls: string[] = [];
vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
  checkEntitlementFromDB: async (_u: string, _k: string, workspaceId: string, feature: string) => {
    entitlementCalls.push(`${workspaceId}:${feature}`);
    if (feature !== 'ai_advanced_tools') return { allowed: false, reason: 'registry_default' };
    return PLANS[workspaceId] ?? { allowed: false, reason: 'registry_default' };
  },
  checkModuleAccess: async () => ({ allowed: true, plan: 'pro' }),
}));

vi.mock('../../../server/services/billing/locks/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({}),
}));
vi.mock('../../../server/services/billing/locks/predicates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/predicates.js')>()),
  isMemberLocked: () => false,
}));

vi.mock('../../../server/services/observability/collector/index.js', () => ({
  getMonitoringCollector: () => ({ queryRealtimeCount: () => 0 }),
}));

const { aiAgentRouter } = await import('../../../server/routes/ai-agent/index.js');
const { assertFeatureEnabled, lookupAiAgentResourceWorkspace, resolveAiAgentRequestWorkspace } =
  await import('../../../server/services/ai-agent/platformGuards.js');
const { canAccessAiAgentAdvancedToolsServer, regressionScheduleMayRunServer } =
  await import('../../../server/services/ai-agent/customerSafe.js');

const CONFIG = { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' };

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig?: unknown }).serverConfig = CONFIG;
  next();
});
app.use(express.json());
app.use('/api/ai-agent', aiAgentRouter);
const server = http.createServer(app).listen(0);

afterAll(() => {
  server.close();
});

beforeEach(() => {
  entitlementCalls.length = 0;
  delete process.env.ENABLE_AI_ADVANCED_TOOLS;
});

function call(userId: string | null, method: string, path: string, body?: unknown) {
  const port = (server.address() as AddressInfo).port;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (userId) headers.authorization = `Bearer ${userId}`;
  if (payload) headers['content-type'] = 'application/json';
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = d ? JSON.parse(d) : {}; } catch { parsed = { raw: d }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const DENIED = 'advanced_ai_tools_not_available';

describe('platform pages stay Super Admin only', () => {
  it.each(['/api/ai-agent/platform/settings', '/api/ai-agent/platform/ai-proactive-stats'])(
    '%s → 403 for the owner of a workspace whose plan has the key',
    async (path) => {
      const r = await call('owner-a', 'GET', `${path}?workspaceId=${WS_A}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(DENIED);
      expect(JSON.stringify(r.body)).not.toContain('PLATFORM_SETTINGS');
    },
  );

  it('GET /platform/settings → 200 for the Super Admin', async () => {
    const r = await call('super-admin', 'GET', '/api/ai-agent/platform/settings');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('PLATFORM_SETTINGS');
  });
});

describe('a plan with ai_advanced_tools opens the Advanced tools for its owner and admins', () => {
  it('the owner reads their own workspace\'s test cases, despite the old switches being off', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_A}`);
    expect(r.status).toBe(200);
    expect((r.body.items as Row[]).map((i) => i.id)).toEqual(['tc-a']);
    expect(entitlementCalls).toContain(`${WS_A}:ai_advanced_tools`);
  });

  it('an admin of that workspace too', async () => {
    const r = await call('admin-a', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_A}`);
    expect(r.status).toBe(200);
  });

  it('a test run of their workspace, by its id', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-runs/${RUN_A}`);
    expect(r.status).toBe(200);
    expect((r.body.item as Row).workspace_id).toBe(WS_A);
  });

  it('a suspended admin: no', async () => {
    const r = await call('banned-a', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_A}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });
});

describe('never another workspace\'s QA data', () => {
  it('another workspace named in the query (an agent there, its plan has the key): 403', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_B}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  it('another workspace\'s test run by id: 403', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-runs/${RUN_B}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  it('another workspace\'s test run by id, with their own workspace named: 403', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-runs/${RUN_B}?workspaceId=${WS_A}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  // Express hands the handler a percent-decoded `:id`, and Postgres reads a
  // uuid in any case, without hyphens or in braces: the guard must find the
  // workspace of the row the handler will read, whatever the spelling.
  it.each([
    ['percent-encoded', `%${RUN_B.charCodeAt(0).toString(16)}${RUN_B.slice(1)}`],
    ['percent-encoded hyphen', RUN_B.replace('-', '%2D')],
    ['without hyphens', RUN_B.replace(/-/g, '')],
    ['in braces', `{${RUN_B}}`],
    ['in encoded braces', `%7B${RUN_B}%7D`],
    ['upper case, no hyphens', RUN_B.replace(/-/g, '').toUpperCase()],
  ])('another workspace\'s test run by id spelled %s, with their own workspace named: 403', async (_how, id) => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-runs/${id}?workspaceId=${WS_A}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  it('another workspace\'s regression batch by a percent-encoded id: 403', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/regression/batches/%${BATCH_B.charCodeAt(0).toString(16)}${BATCH_B.slice(1)}?workspaceId=${WS_A}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  it('their own test run by id spelled without hyphens: 200', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-runs/${RUN_A.replace(/-/g, '')}?workspaceId=${WS_A}`);
    expect(r.status).toBe(200);
  });

  it('a regression run linked to another workspace\'s schedule: refused', async () => {
    const r = await call('owner-a', 'POST', '/api/ai-agent/regression/run-now', { workspaceId: WS_A, scheduleId: SCHEDULE_B });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('schedule_not_found');
  });

  it('two different workspaces named in one request: 400, before any handler', async () => {
    const r = await call('owner-a', 'POST', `/api/ai-agent/debug/retrieval?workspaceId=${WS_A}`, {
      workspaceId: WS_B,
      message: 'hi',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('workspace_id_mismatch');
  });

  it('no workspace at all: 403', async () => {
    const r = await call('owner-a', 'GET', '/api/ai-agent/test-cases');
    expect(r.status).toBe(403);
  });

  it('a resource that does not exist: 403', async () => {
    const r = await call('owner-a', 'GET', `/api/ai-agent/test-runs/${MISSING}`);
    expect(r.status).toBe(403);
  });
});

describe('everyone else is refused', () => {
  it('an agent of a workspace whose plan has the key', async () => {
    const r = await call('agent-a', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_A}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
    // The role is checked first: an agent never costs a plan read.
    expect(entitlementCalls).toEqual([]);
  });

  it('the owner of a workspace whose plan does not have it (every plan by default)', async () => {
    const r = await call('owner-c', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_C}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  it('the owner of a workspace whose plan cannot be read (fail closed)', async () => {
    const r = await call('owner-d', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_D}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DENIED);
  });

  it('a stranger', async () => {
    const r = await call('stranger', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_A}`);
    expect(r.status).toBe(403);
  });

  it('nobody signed in: 401', async () => {
    const r = await call(null, 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_A}`);
    expect(r.status).toBe(401);
  });
});

describe('the Super Admin keeps every workspace', () => {
  it('reads a workspace whose plan does not have the key', async () => {
    const r = await call('super-admin', 'GET', `/api/ai-agent/test-cases?workspaceId=${WS_C}`);
    expect(r.status).toBe(200);
    expect((r.body.items as Row[]).map((i) => i.id)).toEqual(['tc-c']);
  });
});

describe('the pieces', () => {
  it('canAccessAiAgentAdvancedToolsServer applies the rule per workspace', async () => {
    const can = (u: string, ws: string) => canAccessAiAgentAdvancedToolsServer(CONFIG as never, u, ws);
    expect(await can('super-admin', '')).toBe(true);
    expect(await can('owner-a', WS_A)).toBe(true);
    expect(await can('admin-a', WS_A)).toBe(true);
    expect(await can('agent-a', WS_A)).toBe(false);
    expect(await can('owner-a', WS_B)).toBe(false);
    expect(await can('owner-c', WS_C)).toBe(false);
    expect(await can('owner-d', WS_D)).toBe(false);
    expect(await can('owner-a', '')).toBe(false);
  });

  it('the dev override works outside production only', async () => {
    process.env.ENABLE_AI_ADVANCED_TOOLS = 'true';
    expect(await canAccessAiAgentAdvancedToolsServer(CONFIG as never, 'owner-c', WS_C)).toBe(true);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(await canAccessAiAgentAdvancedToolsServer(CONFIG as never, 'owner-c', WS_C)).toBe(false);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('a due regression schedule runs only while the plan has the key, or when the Super Admin set it up', async () => {
    const may = (schedule: { workspace_id: string; created_by?: string | null; updated_by?: string | null }) =>
      regressionScheduleMayRunServer(CONFIG as never, schedule);
    expect(await may({ workspace_id: WS_A, created_by: 'owner-a', updated_by: 'owner-a' })).toBe(true);
    // The plan lost the key (or never had it): the customer's schedule stops.
    expect(await may({ workspace_id: WS_C, created_by: 'owner-c', updated_by: 'owner-c' })).toBe(false);
    expect(await may({ workspace_id: WS_C, created_by: null, updated_by: null })).toBe(false);
    // Unreadable plan: this run is skipped.
    expect(await may({ workspace_id: WS_D, created_by: 'owner-d', updated_by: 'owner-d' })).toBe(false);
    // The Super Admin's own QA schedules keep running, as before.
    expect(await may({ workspace_id: WS_C, created_by: 'super-admin', updated_by: 'owner-c' })).toBe(true);
    expect(await may({ workspace_id: WS_C, created_by: 'owner-c', updated_by: 'super-admin' })).toBe(true);
  });

  it('the regression worker asks before running a due schedule', () => {
    const worker = readFileSync('worker/regression-runner/index.ts', 'utf8');
    const due = worker.slice(worker.indexOf('findDueScheduleIds(sb'), worker.indexOf('findQueuedBatchIds(sb'));
    expect(due.indexOf('regressionScheduleMayRunServer(config, claimed)')).toBeGreaterThan(-1);
    expect(due.indexOf('regressionScheduleMayRunServer(config, claimed)')).toBeLessThan(due.indexOf('enqueueRegressionBatch('));
  });

  it('the old platform switches no longer gate the Advanced tools\' features', async () => {
    for (const feature of ['regression', 'test_harness', 'source_health'] as const) {
      expect(await assertFeatureEnabled(CONFIG as never, feature, { userId: 'owner-a' })).toEqual({ ok: true });
    }
  });

  it('finds the workspace of nested resources (regression batches, suggestions from a test run)', async () => {
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/regression/batches/${BATCH_A}/export.csv`))
      .toEqual({ kind: 'found', workspaceId: WS_A });
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/suggested-test-cases/from-test-run/${RUN_B}`))
      .toEqual({ kind: 'found', workspaceId: WS_B });
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/Test-Runs/${RUN_A}/`))
      .toEqual({ kind: 'found', workspaceId: WS_A });
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/test-runs/${MISSING}`)).toEqual({ kind: 'missing' });
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, '/test-cases/run-bulk')).toEqual({ kind: 'none' });
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, '/regression/schedules/default')).toEqual({ kind: 'none' });
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, '/suggested-test-cases/from-feedback/not-an-id')).toEqual({ kind: 'none' });
  });

  it('reads the id as the handler will: percent-decoded, in any uuid spelling Postgres takes', async () => {
    for (const id of [
      `%${RUN_B.charCodeAt(0).toString(16)}${RUN_B.slice(1)}`,
      RUN_B.replace(/-/g, ''),
      `{${RUN_B}}`,
      `%7B${RUN_B}%7D`,
      RUN_B.toUpperCase(),
    ]) {
      expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/test-runs/${id}`), id).toEqual({ kind: 'found', workspaceId: WS_B });
      expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/runs/${id}/inspect`), id).toEqual({ kind: 'missing' });
    }
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/regression/batches/${BATCH_B.replace(/-/g, '')}/export.csv`))
      .toEqual({ kind: 'found', workspaceId: WS_B });
    // A segment Express itself cannot decode is no resource of anyone's.
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, '/test-runs/%E0%A4%A')).toEqual({ kind: 'missing' });
    // An encoded slash is part of the id, as Express reads it: no uuid.
    expect(await lookupAiAgentResourceWorkspace(CONFIG as never, `/test-runs/${RUN_B}%2Fx`)).toEqual({ kind: 'none' });
  });

  it('resolves the one workspace a request acts on', async () => {
    const req = (path: string, query: Row = {}, body: Row = {}) => ({ path, query, body }) as never;
    expect(await resolveAiAgentRequestWorkspace(CONFIG as never, req('/test-cases', { workspaceId: WS_A })))
      .toEqual({ ok: true, workspaceId: WS_A });
    expect(await resolveAiAgentRequestWorkspace(CONFIG as never, req(`/regression/batches/${BATCH_A}`)))
      .toEqual({ ok: true, workspaceId: WS_A });
    expect(await resolveAiAgentRequestWorkspace(CONFIG as never, req(`/regression/batches/${BATCH_A}`, { workspaceId: WS_B })))
      .toMatchObject({ ok: false, status: 403 });
    expect(await resolveAiAgentRequestWorkspace(CONFIG as never, req('/test-cases', { workspaceId: WS_A }, { workspaceId: WS_B })))
      .toMatchObject({ ok: false, status: 400, error: 'workspace_id_mismatch' });
    expect(await resolveAiAgentRequestWorkspace(CONFIG as never, req('/test-cases', { workspaceId: [WS_A, WS_B] })))
      .toMatchObject({ ok: false, status: 400 });
  });
});
