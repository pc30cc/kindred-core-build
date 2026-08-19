/**
 * GoTrue-off closure — platform-admin user/workspace/role management.
 *
 * Covers the critical bootstrap_admin trust model explicitly called out in
 * the closure review: an ordinary user must NEVER be able to self-promote
 * once a platform admin already exists, and the admin_* RPCs (which have
 * an internal has_role(_actor_user_id, ...) check, not just the Express
 * gate) must actually receive the real, session-verified actor id — not a
 * client-supplied one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        order(col: string) { orderCol = col; return builder; },
        upsert(row: Row) {
          const idx = rows.findIndex((r) => r.user_id === row.user_id && r.role === row.role);
          if (idx >= 0) Object.assign(rows[idx], row);
          else rows.push({ id: crypto.randomUUID(), ...row });
          return Promise.resolve({ error: null });
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          return {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return this; },
            then: (resolve: any) => {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) matched = [...matched].sort((a, b) => (a[orderCol!] > b[orderCol!] ? 1 : -1));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      if (name === 'has_role') {
        const match = (db.user_roles || []).some((r) => r.user_id === args._user_id && r.role === args._role);
        return { data: match, error: null };
      }
      if (name === 'bootstrap_admin') {
        const anyAdmin = (db.user_roles || []).some((r) => r.role === 'admin');
        if (anyAdmin) return { data: false, error: null };
        (db.user_roles ||= []).push({ id: crypto.randomUUID(), user_id: args._user_id, role: 'admin' });
        return { data: true, error: null };
      }
      if (name === 'admin_list_profiles' || name === 'admin_list_workspaces') {
        // The RPC's OWN internal check — proves the route passes the real
        // actor id, not something client-controlled or absent.
        const isAdmin = (db.user_roles || []).some((r) => r.user_id === args._actor_user_id && r.role === 'admin');
        if (!isAdmin) return { data: null, error: { message: 'Not authorized' } };
        return { data: [], error: null };
      }
      if (name === 'admin_delete_workspace') {
        const isAdmin = (db.user_roles || []).some((r) => r.user_id === args._actor_user_id && r.role === 'admin');
        if (!isAdmin) return { data: null, error: { message: 'Not authorized' } };
        db.workspaces = (db.workspaces || []).filter((w) => w.id !== args._workspace_id);
        return { data: true, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_c: unknown, userId: string) =>
    (db.user_roles || []).some((r) => r.user_id === userId && r.role === 'admin'),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 's1', userId: user.userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { adminRouter } = await import('../../../server/routes/admin.js');
const { adminBootstrapRouter } = await import('../../../server/routes/adminBootstrap.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/admin-status', adminBootstrapRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const FIRST_USER = crypto.randomUUID();
const ORDINARY_USER = crypto.randomUUID();
const ADMIN_USER = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'first-token', userId: FIRST_USER },
    { token: 'ordinary-token', userId: ORDINARY_USER },
    { token: 'admin-token', userId: ADMIN_USER },
  ];
});

describe('bootstrap_admin trust model', () => {
  it('the first user on a fresh install (zero admins) can bootstrap themselves', async () => {
    const res = await call('POST', '/api/admin-status/bootstrap', 'first-token');
    expect(res.status).toBe(200);
    expect(res.json.promoted).toBe(true);
    expect((db.user_roles || []).some((r) => r.user_id === FIRST_USER && r.role === 'admin')).toBe(true);
  });

  it('an ordinary user CANNOT self-promote once a platform admin already exists', async () => {
    db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
    const res = await call('POST', '/api/admin-status/bootstrap', 'ordinary-token');
    expect(res.status).toBe(200); // the RPC returns false, not an error — matches its designed idempotent shape
    expect(res.json.promoted).toBe(false);
    expect((db.user_roles || []).some((r) => r.user_id === ORDINARY_USER)).toBe(false);
  });

  it('bootstrap requires authentication — an unauthenticated request cannot promote anyone', async () => {
    const res = await call('POST', '/api/admin-status/bootstrap', null);
    expect(res.status).toBe(401);
  });

  it('/is-admin correctly reports false for an ordinary user and true for a real admin', async () => {
    db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
    const ordinary = await call('GET', '/api/admin-status/is-admin', 'ordinary-token');
    expect(ordinary.json.isAdmin).toBe(false);
    const admin = await call('GET', '/api/admin-status/is-admin', 'admin-token');
    expect(admin.json.isAdmin).toBe(true);
  });
});

describe('platform admin management routes — authorization', () => {
  beforeEach(() => {
    db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
  });

  it('an ordinary user is denied at every management route', async () => {
    expect((await call('GET', '/api/admin/management/users', 'ordinary-token')).status).toBe(403);
    expect((await call('GET', '/api/admin/management/workspaces', 'ordinary-token')).status).toBe(403);
    expect((await call('GET', '/api/admin/management/feature-flags', 'ordinary-token')).status).toBe(403);
    expect((await call('GET', '/api/admin/management/audit-logs', 'ordinary-token')).status).toBe(403);
    expect(
      (await call('POST', `/api/admin/management/users/${ORDINARY_USER}/roles`, 'ordinary-token', { role: 'admin' })).status,
    ).toBe(403);
  });

  it('an ordinary user cannot grant themselves the admin role via the role-assignment route', async () => {
    const res = await call('POST', `/api/admin/management/users/${ORDINARY_USER}/roles`, 'ordinary-token', { role: 'admin' });
    expect(res.status).toBe(403);
    expect((db.user_roles || []).some((r) => r.user_id === ORDINARY_USER)).toBe(false);
  });

  it('a real platform admin can list users and workspaces', async () => {
    const users = await call('GET', '/api/admin/management/users', 'admin-token');
    expect(users.status).toBe(200);
    const workspaces = await call('GET', '/api/admin/management/workspaces', 'admin-token');
    expect(workspaces.status).toBe(200);
  });

  it('a real platform admin can grant and revoke a role on another user', async () => {
    const grant = await call('POST', `/api/admin/management/users/${ORDINARY_USER}/roles`, 'admin-token', { role: 'moderator' });
    expect(grant.status).toBe(200);
    expect((db.user_roles || []).some((r) => r.user_id === ORDINARY_USER && r.role === 'moderator')).toBe(true);

    const revoke = await call('DELETE', `/api/admin/management/users/${ORDINARY_USER}/roles/moderator`, 'admin-token');
    expect(revoke.status).toBe(200);
    expect((db.user_roles || []).some((r) => r.user_id === ORDINARY_USER && r.role === 'moderator')).toBe(false);
  });

  it('the RPC layer receives the real session-verified actor id, not a client-suppliable one', async () => {
    // No route parameter or body field lets the caller name a different
    // _actor_user_id — it always comes from requirePlatformAdmin(req, res).
    const res = await call('GET', '/api/admin/management/workspaces', 'admin-token');
    expect(res.status).toBe(200); // only succeeds because the fake RPC checked _actor_user_id === ADMIN_USER
  });

  it('an unauthenticated request is rejected at every management route', async () => {
    expect((await call('GET', '/api/admin/management/users', null)).status).toBe(401);
    expect((await call('DELETE', '/api/admin/management/workspaces/x', null)).status).toBe(401);
  });
});
