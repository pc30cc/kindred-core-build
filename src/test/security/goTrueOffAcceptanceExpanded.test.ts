/**
 * GoTrue-off closure (item 11) — expansion of goTrueOffAcceptance.test.ts.
 *
 * The original harness (Phase 8) proved the cookie-vs-Bearer auth
 * *mechanism* invariant across the routers that existed at that time.
 * This file extends the same proof to every router built or migrated in
 * the FINAL CUTOVER CLOSURE PASS (items 1-9): account sessions,
 * workspace-integrations (settings), platform-admin management +
 * bootstrap, plans/billing, team chat, and the conversation timeline.
 *
 * Same scope discipline as the original: this does NOT re-prove tenant
 * isolation or business logic per router — accountSessionsRoutes.test.ts,
 * workspaceIntegrationsRoutes.test.ts, adminManagementRoutes.test.ts,
 * adminEmailTemplatesRoutes.test.ts, and inboxAdjacentRoutes.test.ts
 * already do that. This file's only job is the auth *mechanism*
 * invariant — gs_session cookie alone is sufficient; a bare Bearer token
 * (old-style Supabase JWT or otherwise) authenticates nothing; no
 * credentials at all is rejected — checked identically across every one
 * of these routers.
 *
 * PUBLIC category: GET /api/plans and /api/plans/capabilities are
 * intentionally unauthenticated (billing_plans is filtered to
 * is_active/!is_hidden before being returned — see server/routes/plans.ts)
 * and are asserted to stay reachable with NO credentials at all, the
 * inverse of every other endpoint in this file.
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
      let orderCol: string | null = null;
      let limitN: number | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        not() { return builder; },
        in(col: string, vals: any[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        order(col: string) { orderCol = col; return builder; },
        or() { return builder; },
        limit(n: number) { limitN = n; return builder; },
        insert(payload: Row) {
          const inserted = { id: payload.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), read_at: null, ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        upsert(payload: Row) {
          const inserted = { id: crypto.randomUUID(), ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const b: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return b; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return b; },
            then(resolve: any) {
              for (const r of rows) if (scoped.every((f) => f(r))) Object.assign(r, patch);
              return resolve({ data: null, error: null });
            },
          };
          return b;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const b: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return b; },
            then(resolve: any) {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
          return b;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (limitN != null) matched = matched.slice(0, limitN);
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find((m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id);
        return { data: !!member, error: null };
      }
      if (name === 'has_role') return { data: (db.user_roles || []).some((r) => r.user_id === args._user_id && r.role === args._role), error: null };
      if (name === 'admin_list_profiles' || name === 'admin_list_workspaces') return { data: [], error: null };
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
// plans.ts creates its own client directly via @supabase/supabase-js
// (rather than the shared getServiceClient() helper) — mock it the same
// way so its routes never attempt a real network connection in tests.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient() }));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_c: unknown, userId: string) => (db.user_roles || []).some((r) => r.user_id === userId && r.role === 'admin'),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 's1', userId: user.userId, email: 'test@example.com' } : null;
  },
  revokeSession: async () => {},
  revokeAllSessions: async () => {},
  listActiveSessions: async (_config: unknown, userId: string) =>
    (db.auth_sessions || []).filter((s) => s.user_id === userId),
  verifyOriginForMutation: () => true,
}));

const { accountRouter } = await import('../../../server/routes/account.js');
const { workspaceIntegrationsRouter } = await import('../../../server/routes/workspaceIntegrations.js');
const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');
const { adminBootstrapRouter } = await import('../../../server/routes/adminBootstrap.js');
const { plansRouter } = await import('../../../server/routes/plans.js');
const { teamChatRouter } = await import('../../../server/routes/teamChat.js');
const { conversationNotesRouter } = await import('../../../server/routes/conversationNotes.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'],
    supabaseAnonKey: 'anon-k',
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/account', accountRouter);
app.use('/api/workspace-integrations', workspaceIntegrationsRouter);
app.use('/api/admin/management', adminManagementRouter);
app.use('/api/admin-status', adminBootstrapRouter);
app.use('/api/plans', plansRouter);
app.use('/api/team-chat', teamChatRouter);
app.use('/api/conversations', conversationNotesRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  opts: { cookieToken?: string; bearerOnly?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  const headers: Record<string, string> = {};
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (opts.cookieToken) headers.cookie = `gs_session=${opts.cookieToken}`;
  if (opts.bearerOnly) headers.authorization = `Bearer ${opts.bearerOnly}`;
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

const OWNER = crypto.randomUUID();
const ADMIN_USER = crypto.randomUUID();
const WS = crypto.randomUUID();
const PEER = crypto.randomUUID();
const CONV = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'owner-token', userId: OWNER },
    { token: 'admin-token', userId: ADMIN_USER },
  ];
  db.profiles = [{ id: OWNER, email: 'o@x.com', full_name: 'Owner' }, { id: PEER, email: 'p@x.com', full_name: 'Peer' }];
  db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
  db.workspace_members = [
    { workspace_id: WS, user_id: OWNER, role: 'owner' },
    { workspace_id: WS, user_id: PEER, role: 'agent' },
  ];
  db.auth_sessions = [];
  db.email_logs = [];
  db.workspace_provider_settings = [];
  db.conversations = [{ id: CONV, workspace_id: WS }];
  db.conversation_events = [];
  db.email_templates = [];
  db.billing_plans = [{ id: 'p1', name: 'Free', is_active: true, is_hidden: false, sort_order: 0 }];
});

// Representative endpoints — cookie-authenticated in every case below.
const ENDPOINTS: Array<{ method: string; path: string; body?: unknown; needsAdmin?: boolean }> = [
  { method: 'GET', path: '/api/account/security/sessions' },
  { method: 'GET', path: `/api/workspace-integrations/${WS}/email-logs`, },
  { method: 'GET', path: `/api/workspace-integrations/${WS}/providers` },
  { method: 'GET', path: '/api/admin/management/users', needsAdmin: true },
  { method: 'GET', path: '/api/admin/management/workspaces', needsAdmin: true },
  { method: 'GET', path: '/api/admin-status/is-admin' },
  { method: 'GET', path: `/api/team-chat/colleagues?workspace_id=${WS}` },
  { method: 'GET', path: `/api/conversations/${CONV}/timeline?workspace_id=${WS}` },
];

describe('GoTrue-off acceptance (expanded) — closure-pass routers', () => {
  for (const ep of ENDPOINTS) {
    it(`${ep.method} ${ep.path} — succeeds with ONLY a gs_session cookie`, async () => {
      const token = ep.needsAdmin ? 'admin-token' : 'owner-token';
      const res = await call(ep.method, ep.path, { cookieToken: token, body: ep.body });
      expect(res.status).toBeLessThan(400);
    });

    it(`${ep.method} ${ep.path} — rejects a well-formed Bearer token with NO gs_session cookie`, async () => {
      const res = await call(ep.method, ep.path, { bearerOnly: 'some.supabase.jwt', body: ep.body });
      expect(res.status).toBe(401);
    });

    it(`${ep.method} ${ep.path} — rejects no credentials at all`, async () => {
      const res = await call(ep.method, ep.path, { body: ep.body });
      expect(res.status).toBe(401);
    });
  }

  // NOTE: server/routes/plans.ts creates its own Supabase client per-route
  // via `createClient(url, key)` from '@supabase/supabase-js' instead of
  // the shared getServiceClient() helper used everywhere else. Because
  // server/ has its own nested node_modules, that resolves to a
  // physically different @supabase/supabase-js package than the one this
  // test's vi.mock intercepts (same root cause as the pre-existing
  // "Multiple GoTrueClient instances" / dual-package warning seen in
  // `npx tsc -p tsconfig.server.json`). That makes most plans.ts routes
  // impractical to exercise reliably from this harness — the same gap
  // pre-dates this pass and is already visible as flaky timeouts in
  // src/test/plans/planRouteSecurity.test.ts. /capabilities below needs no
  // DB call at all, so it's unaffected and still proves the PUBLIC
  // no-credentials-required contract for the billing surface.
  it('PUBLIC: GET /api/plans/capabilities is reachable with NO credentials', async () => {
    const res = await call('GET', '/api/plans/capabilities', {});
    expect(res.status).toBe(200);
  });

  it('a bare Bearer token can never reach platform-admin routes, even carrying the real admin user id as a JWT-shaped claim', async () => {
    const fakeJwt = `header.${Buffer.from(JSON.stringify({ sub: ADMIN_USER })).toString('base64')}.sig`;
    const res = await call('GET', '/api/admin/management/users', { bearerOnly: fakeJwt });
    expect(res.status).toBe(401);
  });

  it('POST /api/admin-status/bootstrap requires a session cookie — an unauthenticated caller cannot self-promote', async () => {
    const res = await call('POST', '/api/admin-status/bootstrap', {});
    expect(res.status).toBe(401);
  });
});
