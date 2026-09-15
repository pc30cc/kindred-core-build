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

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

interface ThenableResult<T> {
  then: (resolve: (v: { data: T; error: { message: string } | null }) => void) => void;
}
interface UpdateBuilder extends ThenableResult<null> {
  eq: (col: string, val: unknown) => UpdateBuilder;
}
interface InsertBuilder extends ThenableResult<Row> {
  select: () => InsertBuilder;
  single: () => Promise<{ data: Row; error: null }>;
}
interface DeleteBuilder extends ThenableResult<null> {
  eq: (col: string, val: unknown) => DeleteBuilder;
}
interface QueryBuilder {
  select: () => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  is: (col: string, val: null) => QueryBuilder;
  in: (col: string, vals: unknown[]) => QueryBuilder;
  order: (col: string) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: { message: string } | null }>;
  upsert: (row: Row) => Promise<{ error: null }>;
  insert: (row: Row) => InsertBuilder;
  update: (patch: Row) => UpdateBuilder;
  delete: () => DeleteBuilder;
  then: (resolve: (v: { data: Row[]; error: null }) => void) => void;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string): QueryBuilder {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      const builder: QueryBuilder = {
        select: () => builder,
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        is(col, val) { filters.push((r) => r[col] === val); return builder; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return builder; },
        order(col) { orderCol = col; return builder; },
        limit() { return builder; },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        single: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: matched.length ? null : { message: 'no rows' } };
        },
        upsert(row) {
          const idx = rows.findIndex((r) => r.user_id === row.user_id && r.role === row.role);
          if (idx >= 0) Object.assign(rows[idx], row);
          else rows.push({ id: crypto.randomUUID(), ...row });
          return Promise.resolve({ error: null });
        },
        insert(row) {
          const inserted: Row = { id: crypto.randomUUID(), ...row };
          // Mirror the DB DEFAULT 'pending' on workspace_deletion_jobs.status
          // (database/migrations/180_workspace_deletion_lifecycle.sql) — the
          // production insert never sets this column explicitly.
          if (table === 'workspace_deletion_jobs' && inserted.status === undefined) {
            inserted.status = 'pending';
          }
          rows.push(inserted);
          const insertBuilder: InsertBuilder = {
            select: () => insertBuilder,
            single: async () => ({ data: inserted, error: null }),
            then: (resolve) => resolve({ data: inserted, error: null }),
          };
          return insertBuilder;
        },
        update(patch) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: UpdateBuilder = {
            eq(col, val) {
              scoped.push((r) => r[col] === val);
              return updateBuilder;
            },
            then: (resolve) => {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const deleteBuilder: DeleteBuilder = {
            eq(col, val) { scoped.push((r) => r[col] === val); return deleteBuilder; },
            then: (resolve) => {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        then(resolve) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const col = orderCol;
            matched = [...matched].sort((a, b) => ((a[col] as string) > (b[col] as string) ? 1 : -1));
          }
          resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
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

let currentInitialAdminEmail: string | undefined;

interface ReqWithConfig extends express.Request {
  serverConfig: Record<string, unknown>;
}

const app = express();
app.use((req, _res, next) => {
  (req as ReqWithConfig).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'],
    initialAdminEmail: currentInitialAdminEmail,
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/admin-status', adminBootstrapRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
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
        let json: Record<string, unknown> = {};
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
const CONFIGURED_ADMIN_EMAIL = 'owner@example.com';

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  currentInitialAdminEmail = undefined;
  db.__sessions = [
    { token: 'first-token', userId: FIRST_USER },
    { token: 'ordinary-token', userId: ORDINARY_USER },
    { token: 'admin-token', userId: ADMIN_USER },
    { token: 'configured-token', userId: FIRST_USER },
  ];
  db.profiles = [
    { id: FIRST_USER, email: CONFIGURED_ADMIN_EMAIL, full_name: 'First', phone: null, created_at: '2026-01-01' },
    { id: ORDINARY_USER, email: 'ordinary@example.com', full_name: 'Ordinary', phone: null, created_at: '2026-01-01' },
    { id: ADMIN_USER, email: 'admin@example.com', full_name: 'Admin', phone: null, created_at: '2026-01-01' },
  ];
  db.user_credentials = [
    { user_id: FIRST_USER, email_verified_at: '2026-01-02', password_hash: 'h', status: 'active' },
    { user_id: ORDINARY_USER, email_verified_at: '2026-01-02', password_hash: 'h', status: 'active' },
    { user_id: ADMIN_USER, email_verified_at: '2026-01-02', password_hash: 'h', status: 'active' },
  ];
});

describe('bootstrap_admin trust model — deployment-controlled boundary', () => {
  it('bootstrap is disabled (fails closed) when INITIAL_ADMIN_EMAIL is not configured', async () => {
    currentInitialAdminEmail = undefined;
    const res = await call('POST', '/api/admin-status/bootstrap', 'first-token');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('bootstrap_not_configured');
    expect((db.user_roles || []).length).toBe(0);
  });

  it('zero admins + the configured verified email → succeeds', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
    const res = await call('POST', '/api/admin-status/bootstrap', 'configured-token');
    expect(res.status).toBe(200);
    expect(res.json.promoted).toBe(true);
    expect((db.user_roles || []).some((r) => r.user_id === FIRST_USER && r.role === 'admin')).toBe(true);
  });

  it('zero admins + a random authenticated user (not the configured email) → denied', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
    const res = await call('POST', '/api/admin-status/bootstrap', 'ordinary-token');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('not_authorized');
    expect((db.user_roles || []).some((r) => r.user_id === ORDINARY_USER)).toBe(false);
  });

  it('zero admins + configured email but UNVERIFIED → denied', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
    db.user_credentials = db.user_credentials.map((c) =>
      c.user_id === FIRST_USER ? { ...c, email_verified_at: null } : c,
    );
    const res = await call('POST', '/api/admin-status/bootstrap', 'configured-token');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('email_verification_required');
    expect((db.user_roles || []).length).toBe(0);
  });

  it('email match is case-insensitive', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
    db.profiles = db.profiles.map((p) =>
      p.id === FIRST_USER ? { ...p, email: CONFIGURED_ADMIN_EMAIL.toUpperCase() } : p,
    );
    const res = await call('POST', '/api/admin-status/bootstrap', 'configured-token');
    expect(res.status).toBe(200);
    expect(res.json.promoted).toBe(true);
  });

  it('after the first admin exists, a SECOND user (even the configured email, on a different account) cannot bootstrap', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
    db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
    const res = await call('POST', '/api/admin-status/bootstrap', 'configured-token');
    expect(res.status).toBe(200); // the RPC's own guard returns false, not an error — idempotent shape preserved
    expect(res.json.promoted).toBe(false);
    expect((db.user_roles || []).filter((r) => r.role === 'admin')).toHaveLength(1);
  });

  it('existing admin state cannot be overwritten — the sole admin role row is untouched by a denied attempt', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
    const adminRoleRow = { id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' };
    db.user_roles = [adminRoleRow];
    await call('POST', '/api/admin-status/bootstrap', 'ordinary-token');
    expect(db.user_roles).toEqual([adminRoleRow]);
  });

  it('bootstrap requires authentication — an unauthenticated request cannot promote anyone', async () => {
    currentInitialAdminEmail = CONFIGURED_ADMIN_EMAIL;
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

describe('workspace deletion — async, storage-aware enqueue', () => {
  const WS_A = crypto.randomUUID();

  beforeEach(() => {
    db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
    db.workspaces = [{ id: WS_A, slug: 'acme', name: 'Acme', status: 'active' }];
  });

  it('flips the workspace to deleting and enqueues a pending job, returning 202', async () => {
    const res = await call('DELETE', `/api/admin/management/workspaces/${WS_A}`, 'admin-token');

    expect(res.status).toBe(202);
    expect(res.json.started).toBe(true);
    expect(res.json.job).toMatchObject({
      workspace_id: WS_A, workspace_slug: 'acme', workspace_name: 'Acme', requested_by: ADMIN_USER, status: 'pending',
    });
    expect(db.workspaces.find((w: Row) => w.id === WS_A)?.status).toBe('deleting');
    expect(db.workspace_deletion_jobs).toHaveLength(1);
  });

  it('does NOT synchronously delete the workspace row — it stays present with status=deleting', async () => {
    await call('DELETE', `/api/admin/management/workspaces/${WS_A}`, 'admin-token');

    expect(db.workspaces.some((w: Row) => w.id === WS_A)).toBe(true);
  });

  it('returns 404 for an unknown workspace and enqueues nothing', async () => {
    const res = await call('DELETE', `/api/admin/management/workspaces/${crypto.randomUUID()}`, 'admin-token');

    expect(res.status).toBe(404);
    expect(db.workspace_deletion_jobs ?? []).toHaveLength(0);
  });

  it('is idempotent: a second delete request while one is already in flight reports the existing job instead of enqueueing a duplicate', async () => {
    const first = await call('DELETE', `/api/admin/management/workspaces/${WS_A}`, 'admin-token');
    const second = await call('DELETE', `/api/admin/management/workspaces/${WS_A}`, 'admin-token');

    expect(second.status).toBe(202);
    expect(second.json.started).toBe(false);
    expect(second.json.job.id).toBe(first.json.job.id);
    expect(db.workspace_deletion_jobs).toHaveLength(1); // never a second row
  });

  it('a non-admin cannot trigger workspace deletion', async () => {
    const res = await call('DELETE', `/api/admin/management/workspaces/${WS_A}`, 'ordinary-token');

    expect(res.status).toBe(403);
    expect(db.workspaces.find((w: Row) => w.id === WS_A)?.status).toBe('active');
    expect(db.workspace_deletion_jobs ?? []).toHaveLength(0);
  });

  it('GET deletion-status reports the most recent job for the workspace', async () => {
    await call('DELETE', `/api/admin/management/workspaces/${WS_A}`, 'admin-token');

    const res = await call('GET', `/api/admin/management/workspaces/${WS_A}/deletion-status`, 'admin-token');

    expect(res.status).toBe(200);
    expect(res.json.job).toMatchObject({ workspace_id: WS_A, status: 'pending' });
  });

  it('GET deletion-status returns a null job for a workspace that was never queued for deletion', async () => {
    const res = await call('GET', `/api/admin/management/workspaces/${WS_A}/deletion-status`, 'admin-token');

    expect(res.status).toBe(200);
    expect(res.json.job).toBeNull();
  });
});
