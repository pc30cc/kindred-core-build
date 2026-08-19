/**
 * BLOCKER 2 — workspace resolution acceptance test.
 *
 * `useWorkspaces()` (src/hooks/useWorkspace.ts) used to query `workspaces`
 * directly from the browser via Supabase, relying on RLS keyed to
 * `auth.uid()`. Since the dashboard's browser session no longer carries a
 * Supabase Auth JWT, that query silently returned zero rows for every
 * user — nobody could resolve a workspace to enter the app at all, a total
 * outage hidden behind "fails closed" security-looking behavior.
 *
 * This proves the replacement (GET /api/workspaces, backed by the
 * gs_session cookie + service_role) actually resolves a logged-in user's
 * workspaces, and that it stays tenant-isolated (never returns a workspace
 * the caller isn't a member of).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let inFilter: { col: string; vals: any[] } | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { inFilter = { col, vals }; return builder; },
        limit: () => builder,
        async maybeSingle() {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (inFilter) matched = matched.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 'test-session', userId: user.userId, email: 'test@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

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
const WS_A = crypto.randomUUID();
const WS_B = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'token-a', userId: USER_A },
    { token: 'token-b', userId: USER_B },
  ];
  db.workspaces = [
    { id: WS_A, name: 'Workspace A', slug: 'workspace-a', owner_id: USER_A },
    { id: WS_B, name: 'Workspace B', slug: 'workspace-b', owner_id: USER_B },
  ];
  db.workspace_members = [
    { id: crypto.randomUUID(), workspace_id: WS_A, user_id: USER_A, role: 'owner' },
    { id: crypto.randomUUID(), workspace_id: WS_B, user_id: USER_B, role: 'owner' },
  ];
});

describe('GET /api/workspaces — workspace resolution, no Supabase Auth session needed', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await call('GET', '/api/workspaces');
    expect(res.status).toBe(401);
  });

  it('a logged-in user resolves exactly their own workspace via the gs_session cookie alone', async () => {
    const res = await call('GET', '/api/workspaces', 'token-a');
    expect(res.status).toBe(200);
    expect(res.json.workspaces).toHaveLength(1);
    expect(res.json.workspaces[0].id).toBe(WS_A);
  });

  it('never leaks a workspace the caller is not a member of (tenant isolation)', async () => {
    const res = await call('GET', '/api/workspaces', 'token-a');
    const ids = res.json.workspaces.map((w: any) => w.id);
    expect(ids).not.toContain(WS_B);
  });

  it('a user in zero workspaces gets an empty (not error, not other-tenant) list', async () => {
    db.workspace_members = db.workspace_members.filter((m) => m.user_id !== USER_A);
    const res = await call('GET', '/api/workspaces', 'token-a');
    expect(res.status).toBe(200);
    expect(res.json.workspaces).toEqual([]);
  });

  it('a member of multiple workspaces resolves all of them', async () => {
    db.workspace_members.push({ id: crypto.randomUUID(), workspace_id: WS_B, user_id: USER_A, role: 'agent' });
    const res = await call('GET', '/api/workspaces', 'token-a');
    const ids = res.json.workspaces.map((w: any) => w.id).sort();
    expect(ids).toEqual([WS_A, WS_B].sort());
  });
});
