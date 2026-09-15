/**
 * AI-AGENT AND CALL-CENTRE SETTINGS CANNOT SET A MEDIA URL.
 *
 * Both surfaces had the same hole: an avatar/logo upload endpoint that did
 * the right thing (bytes -> WebYar storage -> canonical key, URL derived on
 * read) sitting next to a GENERIC settings save that still accepted a plain
 * `https://…` for the same image. That second door is the manual-URL model
 * this platform does not have, so it is closed: each schema is `.strict()`
 * and has no image field at all, which makes a stale client's request a
 * visible 400 rather than a silent drop.
 *
 * These drive the real routers, so they fail if either field is ever added
 * back — including indirectly, by loosening `.strict()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '55555555-5555-4555-8555-555555555555';
const AGENT_KEY = `workspace/${WS}/ai-agent/avatar/logo.png`;
const CALL_KEY = `workspace/${WS}/call-center/avatar.png`;

type Row = Record<string, unknown>;

/** The fluent PostgREST surface these routers touch. */
type FakeBuilder = {
  select: () => FakeBuilder;
  eq: (col: string, value: unknown) => FakeBuilder;
  order: () => FakeBuilder;
  limit: () => FakeBuilder;
  in: () => FakeBuilder;
  is: () => FakeBuilder;
  not?: () => FakeBuilder;
  insert: (values: Row | Row[]) => FakeBuilder;
  update: (values: Row) => FakeBuilder;
  single: () => Promise<{ data: unknown; error: unknown }>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (onOk: (v: unknown) => unknown) => Promise<unknown>;
};

/** The slice of a settings response these tests assert on. */
type JsonBody = { settings?: { agent_logo_url?: string | null } };

const db: {
  agentSettings: Row;
  callSettings: Row;
  updates: Array<{ table: string; values: Row }>;
} = { agentSettings: {}, callSettings: {}, updates: [] };

function reset() {
  db.agentSettings = {
    id: 'agent-1',
    workspace_id: WS,
    agent_name: 'Aria',
    agent_logo_url: null,
    metadata: { ai_avatar_storage_key: AGENT_KEY },
  };
  db.callSettings = {
    id: 'cc-1',
    workspace_id: WS,
    display_name: 'Support',
    avatar_url: null,
    avatar_storage_path: CALL_KEY,
  };
  db.updates = [];
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const builder: FakeBuilder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        is: () => builder,
        insert: () => builder,
        update: (values: Row) => { db.updates.push({ table, values }); return builder; },
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk),
      };
      return builder;
    },
    // `requireWorkspaceAdmin` in callCenter.ts resolves the caller's role
    // through this RPC before it parses the body.
    rpc: async (fn: string) => ({ data: fn === 'get_workspace_role' ? 'owner' : null, error: null }),
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>();
  return {
    ...actual,
    authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: true, role: 'owner' }),
    requirePlatformAdmin: async () => ({ userId: 'u1' }),
  };
});

// The AI-agent settings service is faked so the test is about the ROUTE's
// input schema, not about persistence mechanics covered elsewhere.
vi.mock('../../../server/services/ai-agent/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/ai-agent/settings.js')>();
  return {
    ...actual,
    getOrCreateSettings: async () => db.agentSettings,
    updateSettings: async (_c: unknown, _w: string, patch: Row) => {
      db.updates.push({ table: 'ai_agent_settings', values: patch });
      Object.assign(db.agentSettings, patch);
      return db.agentSettings;
    },
    resolveAgentLogoUrl: async () => 'https://derived.test/agent-logo.png',
  };
});
vi.mock('../../../server/services/callCenter/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/callCenter/settings.js')>();
  return {
    ...actual,
    getOrCreateWorkspaceSettings: async () => db.callSettings,
    updateWorkspaceSettings: async (_c: unknown, _w: string, patch: Row) => {
      db.updates.push({ table: 'call_center_settings', values: patch });
      Object.assign(db.callSettings, patch);
      return db.callSettings;
    },
    getPlatformCallCenterSettings: async () => ({ call_center_enabled: true }),
    updatePlatformCallCenterSettings: async () => ({}),
    computeEffectiveCallCenterCaps: () => ({}),
  };
});
vi.mock('../../../server/services/callCenter/recording.js', () => ({
  computeRecordingCapability: async () => ({ enabled: false }),
  disabledRecordingCapability: () => ({ enabled: false }),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkModuleAccess: async () => ({ allowed: true }),
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  checkEntitlementFromDB: async () => ({ allowed: true }),
  requireLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  clearEntitlementCache: () => {},
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => true,
}));

const { assistantRouter } = await import('../../../server/routes/ai-agent/assistant.js');
const { callCenterRouter } = await import('../../../server/routes/callCenter.js');

const app = express();
app.use((req, _res, next) => {
  const r = req as express.Request & { serverConfig: unknown; authUser: unknown };
  r.serverConfig = { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' };
  r.authUser = { id: 'u1' };
  next();
});
app.use(express.json());
app.use('/api/ai-agent', assistantRouter);
app.use('/api/call-center', callCenterRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: JsonBody }> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { done({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
        catch (e) { fail(e); }
      });
    });
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeEach(reset);

describe('PUT /api/ai-agent/settings — no agent_logo_url', () => {
  it('rejects a manually supplied logo URL', async () => {
    const res = await call('PUT', '/api/ai-agent/settings', {
      workspaceId: WS,
      agent_name: 'Aria',
      agent_logo_url: 'https://external.example/logo.png',
    });

    expect(res.status).toBe(400);
    expect(db.agentSettings.agent_logo_url).toBeNull();
  });

  it('leaves the stored avatar key untouched when such a save is refused', async () => {
    await call('PUT', '/api/ai-agent/settings', {
      workspaceId: WS,
      agent_logo_url: 'https://external.example/logo.png',
    });

    expect((db.agentSettings.metadata as Record<string, unknown>).ai_avatar_storage_key).toBe(AGENT_KEY);
    // Rejected before any write — not "saved minus the field".
    expect(db.updates.filter((u) => u.table === 'ai_agent_settings')).toEqual([]);
  });

  it('still accepts an ordinary settings save', async () => {
    const res = await call('PUT', '/api/ai-agent/settings', { workspaceId: WS, agent_name: 'Nova' });

    expect(res.status).toBe(200);
    expect(db.agentSettings.agent_name).toBe('Nova');
    // The response carries a DERIVED logo link, never a stored one.
    expect(res.body.settings.agent_logo_url).toBe('https://derived.test/agent-logo.png');
  });
});

describe('PUT /api/call-center/settings — no avatar_url', () => {
  it('rejects a manually supplied avatar URL', async () => {
    const res = await call('PUT', `/api/call-center/settings?workspaceId=${WS}`, {
      display_name: 'Support',
      avatar_url: 'https://external.example/avatar.png',
    });

    expect(res.status).toBe(400);
    expect(db.callSettings.avatar_url).toBeNull();
  });

  it('leaves the stored avatar key untouched when such a save is refused', async () => {
    await call('PUT', `/api/call-center/settings?workspaceId=${WS}`, {
      avatar_url: 'https://external.example/avatar.png',
    });

    expect(db.callSettings.avatar_storage_path).toBe(CALL_KEY);
    expect(db.updates.filter((u) => u.table === 'call_center_settings')).toEqual([]);
  });

  it('also refuses a client-supplied storage path (path injection)', async () => {
    const res = await call('PUT', `/api/call-center/settings?workspaceId=${WS}`, {
      avatar_storage_path: 'workspace/11111111-1111-4111-8111-111111111111/secret.png',
    });

    expect(res.status).toBe(400);
    expect(db.callSettings.avatar_storage_path).toBe(CALL_KEY);
  });

  it('still accepts an ordinary settings save', async () => {
    const res = await call('PUT', `/api/call-center/settings?workspaceId=${WS}`, { display_name: 'Sales' });

    expect(res.status).toBe(200);
    expect(db.callSettings.display_name).toBe('Sales');
  });
});
