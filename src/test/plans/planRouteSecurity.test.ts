import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from() {
      const b: any = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: undefined,
      };
      return b;
    },
    rpc: async () => ({ data: { allowed: true }, error: null }),
  }),
}));

let authUser: { id: string } | null = null;
let memberOf: Record<string, string> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error('bad') }),
    },
    rpc: async (_fn: string, args: any) => ({ data: Boolean(memberOf[args._workspace_id]), error: null }),
    from: () => {
      const b: any = {
        select: () => b,
        eq: (_c: string, v: string) => {
          if (!b._ws) b._ws = v;
          return b;
        },
        maybeSingle: async () => ({
          data: b._ws && memberOf[b._ws] ? { role: memberOf[b._ws] } : null,
          error: null,
        }),
      };
      return b;
    },
  }),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token || token === 'ANON_KEY') return null;
    if (!authUser) return null;
    return { sessionId: 'test-session', userId: authUser.id, email: 'test@example.com' };
  },
  verifyOriginForMutation: () => true,
}));

let globalAdmin = false;
vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => globalAdmin,
  logGateBypass: async () => {},
}));

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true }),
  checkModuleAccess: async () => ({ allowed: true }),
  checkChannelAccess: async () => ({ allowed: true }),
  getWorkspacePlanInfo: async () => ({ plan: null, subscription: null, entitlements: {}, limits: {} }),
  clearEntitlementCache: () => {},
}));

const { plansRouter } = await import('../../../server/routes/plans.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/plans', plansRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, headers: Record<string, string> = {}) {
  const finalHeaders = { ...headers };
  const authMatch = /^Bearer (.+)$/.exec(finalHeaders.authorization || '');
  if (authMatch) finalHeaders.cookie = `gs_session=${authMatch[1]}`;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers: finalHeaders }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = { headers: { authorization: 'Bearer user-jwt' } };

beforeEach(() => {
  authUser = null;
  memberOf = {};
  globalAdmin = false;
});

const workspaceRoutes = [
  `/api/plans/check?workspaceId=${WS}&feature=ai_assistant`,
  `/api/plans/workspace/${WS}`,
  `/api/plans/workspace/${WS}/effective`,
  `/api/plans/workspace/${WS}/modules`,
  `/api/plans/workspace/${WS}/channels`,
  `/api/plans/workspace/${WS}/usage`,
];

const adminRoutes = ['/api/plans/admin/all', '/api/plans/admin/subscriptions', '/api/plans/admin/diagnostics'];

describe('plans route authorization', () => {
  it.each(workspaceRoutes)('%s rejects unauthenticated callers', async (path) => {
    expect((await call('GET', path)).status).toBe(401);
  });

  it.each(workspaceRoutes)('%s rejects the anon key used as a token', async (path) => {
    expect((await call('GET', path, { authorization: 'Bearer ANON_KEY' })).status).toBe(401);
  });

  it.each(workspaceRoutes)('%s rejects non-members (cross-tenant)', async (path) => {
    authUser = { id: 'u1' };
    memberOf = { [OTHER]: 'owner' };
    expect((await call('GET', path, USER.headers)).status).toBe(403);
  });

  it.each(workspaceRoutes)('%s allows workspace members', async (path) => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'agent' };
    const res = await call('GET', path, USER.headers);
    expect([200, 500]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it.each(adminRoutes)('%s rejects unauthenticated callers', async (path) => {
    expect((await call('GET', path)).status).toBe(401);
  });

  it.each(adminRoutes)('%s rejects authenticated non-admins', async (path) => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'owner' };
    expect((await call('GET', path, USER.headers)).status).toBe(403);
  });

  it.each(adminRoutes)('%s allows platform super admins', async (path) => {
    authUser = { id: 'admin' };
    globalAdmin = true;
    const res = await call('GET', path, USER.headers);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('public plan list stays public and does not leak provider price ids', async () => {
    const res = await call('GET', '/api/plans');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('provider_price_ids');
  });

  it('capability catalog stays public', async () => {
    expect((await call('GET', '/api/plans/capabilities')).status).toBe(200);
  });
});
