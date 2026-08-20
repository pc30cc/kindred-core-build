/**
 * BLOCKER 1 — GET /api/workspaces/account was shadowed by GET
 * /api/workspaces/:workspaceId.
 *
 * server/routes/workspaces.ts registered `GET /:workspaceId` before `GET
 * /account` — Express matches routes in registration order, so a request
 * for /api/workspaces/account was captured by the dynamic route with
 * workspaceId="account" and the real account handler was unreachable.
 * src/hooks/useWorkspace.ts's useAccount() calls exactly this endpoint,
 * and WorkspaceRedirect waits on it during workspace bootstrap — this was
 * release-critical.
 *
 * Fixed structurally: every static route is registered before any
 * `:workspaceId`-shaped route, AND the workspaceId param itself is now
 * constrained to a UUID shape via an inline path pattern, so "account"
 * (or any other non-UUID segment) can never match `:workspaceId` even if
 * a future static route were added in the wrong position.
 *
 * This proves, against the REAL Express router (only the DB client and
 * auth primitives are mocked): the request reaches the intended account
 * handler, never invokes authorizeWorkspaceAccess (the :workspaceId
 * route's own gate) at all, is user/tenant scoped, and an unauthenticated
 * caller is rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const isWorkspaceMemberCalls: unknown[] = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        limit: () => builder,
        async maybeSingle() {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      // authorizeWorkspaceAccess's own membership check — recorded so the
      // test can assert it was NEVER invoked with "account" as the id.
      if (name === 'is_workspace_member') {
        isWorkspaceMemberCalls.push(args);
        return { data: false, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const session = db.__sessions?.find((s) => s.token === token);
    return session ? { sessionId: 'test-session', userId: session.userId, email: 'test@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

// Partial mock: keep the REAL authorizeWorkspaceAccess implementation (so
// its actual behavior — including its own is_workspace_member call — is
// exercised if it's ever reached), but wrap it in a spy so the test can
// assert exactly how (and whether) it was called.
const authorizeWorkspaceAccessSpy = vi.fn();
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>();
  return {
    ...actual,
    authorizeWorkspaceAccess: (...args: Parameters<typeof actual.authorizeWorkspaceAccess>) => {
      authorizeWorkspaceAccessSpy(...args);
      return actual.authorizeWorkspaceAccess(...args);
    },
  };
});

const { workspacesRouter } = await import('../../../server/routes/workspaces.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspaces', workspacesRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method, headers: token ? { cookie: `gs_session=${token}` } : {} },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();
const ACCOUNT_A = crypto.randomUUID();
const ACCOUNT_B = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  isWorkspaceMemberCalls.length = 0;
  authorizeWorkspaceAccessSpy.mockClear();

  db.__sessions = [
    { token: 'token-a', userId: USER_A },
    { token: 'token-b', userId: USER_B },
  ];
  db.accounts = [
    { id: ACCOUNT_A, name: 'Account A', slug: 'account-a', owner_id: USER_A },
    { id: ACCOUNT_B, name: 'Account B', slug: 'account-b', owner_id: USER_B },
  ];
  db.account_members = [
    { id: crypto.randomUUID(), account_id: ACCOUNT_A, user_id: USER_A, role: 'owner' },
    { id: crypto.randomUUID(), account_id: ACCOUNT_B, user_id: USER_B, role: 'owner' },
  ];
});

describe('GET /api/workspaces/account — not shadowed by GET /api/workspaces/:workspaceId', () => {
  it('1. reaches the account handler (200, an account payload — not a 404/workspace shape)', async () => {
    const res = await call('GET', '/api/workspaces/account', 'token-a');
    expect(res.status).toBe(200);
    expect(res.json.account).toBeDefined();
    expect(res.json.account.id).toBe(ACCOUNT_A);
  });

  it('2. does NOT invoke the /:workspaceId handler — is_workspace_member is never called for this request', async () => {
    await call('GET', '/api/workspaces/account', 'token-a');
    expect(isWorkspaceMemberCalls).toEqual([]);
  });

  it('3. does NOT call authorizeWorkspaceAccess with "account"', async () => {
    await call('GET', '/api/workspaces/account', 'token-a');
    expect(authorizeWorkspaceAccessSpy).not.toHaveBeenCalled();
    const calledWithAccount = authorizeWorkspaceAccessSpy.mock.calls.some((args) => args[2] === 'account');
    expect(calledWithAccount).toBe(false);
  });

  it('4. returns the authenticated user\'s own account', async () => {
    const res = await call('GET', '/api/workspaces/account', 'token-a');
    expect(res.json.account.id).toBe(ACCOUNT_A);
    expect(res.json.account.name).toBe('Account A');
  });

  it('5. is tenant/user scoped — caller B never sees caller A\'s account', async () => {
    const res = await call('GET', '/api/workspaces/account', 'token-b');
    expect(res.json.account.id).toBe(ACCOUNT_B);
    expect(res.json.account.id).not.toBe(ACCOUNT_A);
  });

  it('6. an unauthenticated caller gets 401', async () => {
    const res = await call('GET', '/api/workspaces/account');
    expect(res.status).toBe(401);
    expect(authorizeWorkspaceAccessSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/workspaces/:workspaceId — the UUID-constrained param never matches a non-UUID static segment', () => {
  it('a real UUID workspaceId still reaches the dynamic route (authorizeWorkspaceAccess IS called, with that id)', async () => {
    const WS_ID = crypto.randomUUID();
    db.workspaces = [{ id: WS_ID, name: 'WS', slug: 'ws' }];
    db.workspace_members = [];
    await call('GET', `/api/workspaces/${WS_ID}`, 'token-a');
    expect(authorizeWorkspaceAccessSpy).toHaveBeenCalledTimes(1);
    expect(authorizeWorkspaceAccessSpy.mock.calls[0][2]).toBe(WS_ID);
  });

  it('a non-UUID, non-"account" segment (e.g. "provision-accountx") does not fall into the dynamic route as a workspaceId either', async () => {
    const res = await call('GET', '/api/workspaces/not-a-real-workspace-id', 'token-a');
    // Express's route-level regex simply does not match this segment to
    // :workspaceId at all — no route matches, so this is a plain 404, not
    // an authorizeWorkspaceAccess call with a garbage id.
    expect(res.status).toBe(404);
    expect(authorizeWorkspaceAccessSpy).not.toHaveBeenCalled();
  });
});
