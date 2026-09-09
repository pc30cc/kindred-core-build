/**
 * Commerce Integration Platform — tenant isolation (spec §20/§72).
 *
 * Hard invariant under test: a connection id from Workspace B must never be
 * readable through Workspace A's URL, even by a legitimate, authenticated
 * member of Workspace A. server/routes/commerce/connections.ts scopes every
 * lookup on BOTH `id` AND `workspace_id` — this proves a mismatched pair
 * resolves to "not found", never "found, wrong tenant".
 *
 * Same fake-client + real-router harness pattern as
 * src/test/security/workspaceUsageIsolation.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let projection: string[] | null = null;
      const project = (r: Row) => (projection ? Object.fromEntries(projection.map((c) => [c, r[c]])) : r);
      const builder: any = {
        select(cols?: string) {
          if (cols && cols !== '*') projection = cols.split(',').map((c) => c.trim());
          return builder;
        },
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r: Row) => r[col] !== val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => (r[col] ?? null) === val); return builder; },
        order: () => builder,
        limit: () => builder,
        head: () => builder,
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ? project(matched[0]) : null, error: null };
        },
        then(resolve: any) {
          const matched = rows.filter((r) => filters.every((f) => f(r))).map(project);
          return resolve({ data: matched, error: null, count: matched.length });
        },
      };
      return builder;
    },
    rpc: async (fn: string, params: Record<string, any>) => {
      if (fn === 'is_workspace_member') {
        return {
          data: (db.workspace_members || []).some((m) => m.workspace_id === params._workspace_id && m.user_id === params._user_id),
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_c: unknown, token: string | undefined) => {
    if (!token) return null;
    const s = db.__sessions?.find((x) => x.token === token);
    return s ? { sessionId: 's1', userId: s.userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, plan: 'test' }),
  checkModuleAccess: async () => ({ allowed: true, plan: 'test' }),
}));

const { commerceConnectionsRouter } = await import('../../../server/routes/commerce/connections.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], selfHostBillingUnlimited: true };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspaces', commerceConnectionsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(p: string, token: string | null): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path: p, method: 'GET', headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const WS_A = crypto.randomUUID();
const WS_B = crypto.randomUUID();
const USER_A = crypto.randomUUID();
const CONN_A = crypto.randomUUID();
const CONN_B = crypto.randomUUID();

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.__sessions = [{ token: 'a-token', userId: USER_A }];
  db.workspace_members = [{ workspace_id: WS_A, user_id: USER_A, role: 'owner' }];
  db.commerce_connections = [
    { id: CONN_A, workspace_id: WS_A, provider_type: 'woocommerce', store_id: 'https://a.example.com', approved_origin: 'https://a.example.com', permissions: {}, capabilities: [], health: 'connected', catalog_ready: true, revoked_at: null },
    { id: CONN_B, workspace_id: WS_B, provider_type: 'woocommerce', store_id: 'https://b.example.com', approved_origin: 'https://b.example.com', permissions: {}, capabilities: [], health: 'connected', catalog_ready: true, revoked_at: null },
  ];
  db.commerce_products = [];
  db.commerce_sync_jobs = [];
});

describe('commerce connections — tenant isolation', () => {
  it('a member reads their own workspace connection list, containing only their own connection', async () => {
    const res = await call(`/api/workspaces/${WS_A}/commerce/connections`, 'a-token');
    expect(res.status).toBe(200);
    expect(res.json.connections.map((c: any) => c.id)).toEqual([CONN_A]);
  });

  it('a member of workspace A cannot list workspace B connections', async () => {
    const res = await call(`/api/workspaces/${WS_B}/commerce/connections`, 'a-token');
    expect(res.status).toBe(403);
  });

  it('CRITICAL: workspace A + workspace B connection id resolves to not_found, never the B row', async () => {
    const res = await call(`/api/workspaces/${WS_A}/commerce/connections/${CONN_B}`, 'a-token');
    expect(res.status).toBe(404);
    expect(res.json.connection).toBeUndefined();
  });

  it('a member correctly reads their OWN connection by id', async () => {
    const res = await call(`/api/workspaces/${WS_A}/commerce/connections/${CONN_A}`, 'a-token');
    expect(res.status).toBe(200);
    expect(res.json.connection.id).toBe(CONN_A);
  });

  it('an unauthenticated caller is rejected', async () => {
    expect((await call(`/api/workspaces/${WS_A}/commerce/connections`, null)).status).toBe(401);
  });
});
