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
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
type Builder = Record<string, unknown>;
type Settle = (value: { data: unknown; error: null }) => unknown;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      const builder: Builder = {
        select: () => builder,
        eq(col: string, val: unknown) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        order(col: string) { orderCol = col; return builder; },
        maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        insert(payload: Row) {
          const inserted = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: Builder = {
            eq(col: string, val: unknown) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
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
          const deleteBuilder: Builder = {
            eq(col: string, val: unknown) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            then(resolve: Settle) {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        then(resolve: Settle) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) matched = [...matched].sort((a, b) => (String(a[orderCol!]) > String(b[orderCol!]) ? 1 : -1));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

// The running edition (migration 260): templates are listed, created, updated
// and deleted only within it.
const edition = vi.hoisted(() => ({ current: 'international' as 'iran' | 'international' }));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPlatformEdition: async () => edition.current,
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

const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig?: unknown }).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin/management', adminManagementRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as AddressInfo).port;

interface ApiJson {
  templates: Array<{ id: string }>;
  edition?: string;
  template: { id: string; workspace_id: string | null; edition: string; subject: string };
}

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: ApiJson }> {
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
        let json: unknown = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json: json as ApiJson });
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
  edition.current = 'international';
  db.email_templates = [
    { id: 't-global', workspace_id: null, edition: 'international', slug: 'welcome', locale: 'en', subject: 'Hi', html_body: '<p>hi</p>', text_body: null, is_active: true },
    { id: 't-iran', workspace_id: null, edition: 'iran', slug: 'welcome', locale: 'en', subject: 'Iran hi', html_body: '<p>salam</p>', text_body: null, is_active: true },
    { id: 't-ws', workspace_id: crypto.randomUUID(), edition: 'international', slug: 'welcome', locale: 'en', subject: 'Workspace one', html_body: '<p>x</p>', text_body: null, is_active: true },
  ];
});

describe('platform admin — global default email templates', () => {
  it('a platform admin sees only global (workspace_id IS NULL) templates of the running edition', async () => {
    const res = await call('GET', '/api/admin/management/email-templates', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.templates.map((t) => t.id)).toEqual(['t-global']);
    expect(res.json.edition).toBe('international');

    edition.current = 'iran';
    const iran = await call('GET', '/api/admin/management/email-templates', 'admin-token');
    expect(iran.json.templates.map((t) => t.id)).toEqual(['t-iran']);
    expect(iran.json.edition).toBe('iran');
  });

  it('the other edition\'s template can be neither updated nor deleted', async () => {
    const put = await call('PUT', '/api/admin/management/email-templates/t-iran', 'admin-token', {
      subject: 'hijacked', html_body: '<p/>', is_active: true,
    });
    expect(put.status).toBe(500);
    await call('DELETE', '/api/admin/management/email-templates/t-iran', 'admin-token');
    expect(db.email_templates.find((t) => t.id === 't-iran')?.subject).toBe('Iran hi');
  });

  it('creating a template that exists in this edition updates it instead of adding a twin', async () => {
    const res = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'welcome', locale: 'en', subject: 'New hi', html_body: '<p>new</p>', is_active: true,
    });
    expect(res.status).toBe(200);
    const intl = db.email_templates.filter((t) => t.workspace_id === null && t.edition === 'international' && t.slug === 'welcome');
    expect(intl).toHaveLength(1);
    expect(intl[0].subject).toBe('New hi');
    expect(db.email_templates.find((t) => t.id === 't-iran')?.subject).toBe('Iran hi');
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
    expect(created.json.template.edition).toBe('international');

    const updated = await call('PUT', `/api/admin/management/email-templates/${created.json.template.id}`, 'admin-token', {
      subject: 'updated', html_body: '<p>new</p>', is_active: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.template.subject).toBe('updated');

    const del = await call('DELETE', `/api/admin/management/email-templates/${created.json.template.id}`, 'admin-token');
    expect(del.status).toBe(200);
    const list = await call('GET', '/api/admin/management/email-templates', 'admin-token');
    expect(list.json.templates.find((t) => t.id === created.json.template.id)).toBeUndefined();
  });

  it('creating a template always forces workspace_id to null, ignoring any client-supplied value', async () => {
    const created = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'x', locale: 'en', subject: 's', html_body: '<p/>', is_active: true,
      workspace_id: 'attacker-supplied-workspace-id',
    });
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
