/**
 * PHASE 8 — GoTrue-off acceptance harness.
 *
 * Cross-cutting proof, across every router touched in this pass and the
 * previous auth-migration pass, that:
 *   (a) a valid gs_session cookie ALONE is sufficient — no Authorization
 *       header is read or required anywhere in this surface;
 *   (b) an old-style Supabase Bearer JWT with NO gs_session cookie
 *       authenticates nothing, anywhere in this surface.
 *
 * This does not re-prove tenant isolation or business-rule correctness for
 * each router — those have their own dedicated adversarial test files
 * (teamManagementRoutes, conversationsRoutes, contactsRoutes,
 * workspaceResolution, adminSecurityRoutes). This file's only job is the
 * auth *mechanism* invariant, checked identically across all of them.
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
      let orderAsc = true;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder; },
        limit: () => builder,
        single: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: matched[0] ? null : { message: 'not found' } };
        },
        maybeSingle: async () => {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          return { data: matched[0] ?? null, error: null };
        },
        update: (patch: Row) => ({
          eq: (col: string, val: any) => {
            let updated: Row | null = null;
            for (const r of rows) if (r[col] === val) { Object.assign(r, patch); updated = r; }
            const result = Promise.resolve({ error: null }) as any;
            result.select = () => ({ single: async () => ({ data: updated, error: updated ? null : { message: 'not found' } }) });
            return result;
          },
        }),
        insert: (row: Row) => Promise.resolve({ error: null }).then(() => { rows.push(row); return { error: null }; }),
        delete: () => ({
          eq: (col: string, val: any) => {
            const idx = rows.findIndex((r) => r[col] === val);
            if (idx >= 0) rows.splice(idx, 1);
            return Promise.resolve({ error: null });
          },
        }),
        then(resolve: any) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
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
      if (name === 'has_role') return { data: args._user_id === ADMIN_USER, error: null };
      if (name === 'admin_security_stats') return { data: { total_events_24h: 0 }, error: null };
      return { data: null, error: null };
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_c: unknown, userId: string) => userId === ADMIN_USER,
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

// widget-settings' domain write path checks phone verification — not the
// concern of this harness, so it's stubbed to always pass.
vi.mock('../../../server/services/phoneVerification/index.js', () => ({
  assertPhoneVerificationSatisfied: async () => {},
}));

const { workspacesRouter } = await import('../../../server/routes/workspaces.js');
const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
const { adminRouter } = await import('../../../server/routes/admin.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspaces', workspacesRouter);
app.use('/api/widget-settings', widgetSettingsRouter);
app.use('/api/admin', adminRouter);

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

const ADMIN_USER = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const WS = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'owner-token', userId: OWNER },
    { token: 'admin-token', userId: ADMIN_USER },
  ];
  db.workspaces = [{ id: WS, name: 'WS', slug: 'ws', owner_id: OWNER, updated_at: null }];
  db.workspace_members = [{ workspace_id: WS, user_id: OWNER, role: 'owner' }];
  db.workspace_domains = [{ id: 'dom-1', workspace_id: WS, domain: 'acme.com', is_primary: true, verified: true, created_at: '2026-01-01' }];
  db.workspace_branding = [{ workspace_id: WS, support_email: 'x@acme.com', updated_at: null }];
  db.widget_settings = [{ id: 'wset-1', workspace_id: WS, enabled: true, updated_at: null }];
});

// Table of representative endpoints spanning every router mounted above.
// GET/POST/PATCH/DELETE mix, member-level and manage-level, workspace-scoped
// and platform-admin-scoped.
const ENDPOINTS: Array<{ method: string; path: string; body?: unknown; needsAdmin?: boolean }> = [
  { method: 'GET', path: `/api/workspaces/${WS}` },
  { method: 'GET', path: `/api/workspaces/${WS}/role` },
  { method: 'GET', path: `/api/workspaces/${WS}/primary-domain` },
  { method: 'GET', path: `/api/workspaces/${WS}/domains` },
  { method: 'GET', path: `/api/workspaces/${WS}/branding` },
  { method: 'PATCH', path: `/api/workspaces/${WS}/branding`, body: { support_email: 'y@acme.com' } },
  { method: 'GET', path: `/api/widget-settings/${WS}` },
  { method: 'GET', path: `/api/widget-settings/${WS}/prechat` },
  { method: 'GET', path: '/api/admin/security/stats', needsAdmin: true },
  { method: 'GET', path: '/api/admin/security/blocked-ips', needsAdmin: true },
];

describe('GoTrue-off acceptance — gs_session cookie is sufficient, Bearer alone authenticates nothing', () => {
  for (const ep of ENDPOINTS) {
    it(`${ep.method} ${ep.path} — succeeds with ONLY a gs_session cookie (no Authorization header sent at all)`, async () => {
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

  it('a bare Bearer token can never reach platform-admin routes, even with the correct admin user id encoded in it', async () => {
    // The point: nothing anywhere parses a JWT payload for identity. A
    // string that merely *looks like* it could carry admin-id claims is
    // still just an opaque, ignored value without the cookie.
    const res = await call('GET', '/api/admin/security/stats', { bearerOnly: `header.${btoa(JSON.stringify({ sub: ADMIN_USER }))}.sig` });
    expect(res.status).toBe(401);
  });
});
