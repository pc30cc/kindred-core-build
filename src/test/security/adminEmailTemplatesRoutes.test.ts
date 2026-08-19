/**
 * GoTrue-off closure (item 6) — platform-wide default email templates
 * (email_templates rows with workspace_id IS NULL). RLS never actually
 * covered this case (get_workspace_role(NULL, uid) never resolves to
 * owner/admin for anyone), so EmailTemplatesTab.tsx's direct
 * supabase.from() calls were unsafe/unreachable by design even before the
 * auth migration. Now gated by requirePlatformAdmin only.
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
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        order(col: string) { orderCol = col; return builder; },
        insert(payload: Row) {
          const inserted = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            select: () => ({
              single: async () => {
                const matched = rows.filter((r) => scoped.every((f) => f(r)));
                for (const r of matched) Object.assign(r, patch);
                return { data: matched[0] ?? null, error: matched[0] ? null : { message: 'not found' } };
              },
            }),
          };
          return updateBuilder;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const deleteBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            then(resolve: any) {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) matched = [...matched].sort((a, b) => (a[orderCol!] > b[orderCol!] ? 1 : -1));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

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

const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin/management', adminManagementRouter);

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

const ADMIN_USER = crypto.randomUUID();
const ORDINARY_USER = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'admin-token', userId: ADMIN_USER },
    { token: 'ordinary-token', userId: ORDINARY_USER },
  ];
  db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
  db.email_templates = [
    { id: 't-global', workspace_id: null, slug: 'welcome', locale: 'en', subject: 'Hi', html_body: '<p>hi</p>', text_body: null, is_active: true },
    { id: 't-ws', workspace_id: crypto.randomUUID(), slug: 'welcome', locale: 'en', subject: 'Workspace one', html_body: '<p>x</p>', text_body: null, is_active: true },
  ];
});

describe('platform admin — global default email templates', () => {
  it('a platform admin sees only global (workspace_id IS NULL) templates', async () => {
    const res = await call('GET', '/api/admin/management/email-templates', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.templates.map((t: any) => t.id)).toEqual(['t-global']);
  });

  it('an ordinary user is denied read/write/delete', async () => {
    expect((await call('GET', '/api/admin/management/email-templates', 'ordinary-token')).status).toBe(403);
    expect((await call('POST', '/api/admin/management/email-templates', 'ordinary-token', {
      slug: 'x', locale: 'en', subject: 's', html_body: '<p/>',
    })).status).toBe(403);
    expect((await call('PUT', '/api/admin/management/email-templates/t-global', 'ordinary-token', {
      subject: 's', html_body: '<p/>', is_active: true,
    })).status).toBe(403);
    expect((await call('DELETE', '/api/admin/management/email-templates/t-global', 'ordinary-token')).status).toBe(403);
  });

  it('an unauthenticated request is rejected', async () => {
    expect((await call('GET', '/api/admin/management/email-templates', null)).status).toBe(401);
  });

  it('a platform admin can create, update, and delete a global template', async () => {
    const created = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'password_reset', locale: 'fa', subject: 'بازیابی', html_body: '<p/>', is_active: true,
    });
    expect(created.status).toBe(200);
    expect(created.json.template.workspace_id).toBeNull();

    const updated = await call('PUT', `/api/admin/management/email-templates/${created.json.template.id}`, 'admin-token', {
      subject: 'updated', html_body: '<p>new</p>', is_active: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.template.subject).toBe('updated');

    const del = await call('DELETE', `/api/admin/management/email-templates/${created.json.template.id}`, 'admin-token');
    expect(del.status).toBe(200);
    const list = await call('GET', '/api/admin/management/email-templates', 'admin-token');
    expect(list.json.templates.find((t: any) => t.id === created.json.template.id)).toBeUndefined();
  });

  it('creating a template always forces workspace_id to null, ignoring any client-supplied value', async () => {
    const created = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'x', locale: 'en', subject: 's', html_body: '<p/>', is_active: true,
      workspace_id: 'attacker-supplied-workspace-id',
    } as any);
    expect(created.json.template.workspace_id).toBeNull();
  });

  it('updating a workspace-scoped template id via this endpoint fails (scoped to workspace_id IS NULL)', async () => {
    const res = await call('PUT', '/api/admin/management/email-templates/t-ws', 'admin-token', {
      subject: 'hijacked', html_body: '<p/>', is_active: true,
    });
    expect(res.status).toBe(500);
    const wsTemplate = db.email_templates.find((t) => t.id === 't-ws');
    expect(wsTemplate?.subject).toBe('Workspace one');
  });
});
