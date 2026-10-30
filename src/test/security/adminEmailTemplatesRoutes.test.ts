/**
 * GoTrue-off closure (item 6) — platform-wide default email templates
 * (email_templates rows with workspace_id IS NULL). RLS never actually
 * covered this case (get_workspace_role(NULL, uid) never resolves to
 * owner/admin for anyone), so EmailTemplatesTab.tsx's direct
 * supabase.from() calls were unsafe/unreachable by design even before the
 * auth migration. Now gated by requirePlatformAdmin only.
 *
 * Since the email redesign (owner, 2026-10-30: no email without a
 * template): a template of a mail the platform sends is edited, never
 * deleted or switched off; and the catalog, the preview and the test
 * (Branding → Email templates) are the platform admin's only, in the running
 * edition only, the test to the admin's own verified address only and
 * counted per admin.
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
/** Single-row reads of a table that fail next (a statement timeout, the pool exhausted). */
const faults: Record<string, number> = {};

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
        maybeSingle: async () => {
          if (faults[table]) {
            faults[table] -= 1;
            return { data: null, error: { message: 'canceling statement due to statement timeout' } };
          }
          return { data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
        },
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
  getPlatformAllowedLocales: async () => (edition.current === 'iran' ? ['fa'] : ['en', 'fa', 'tr']),
}));

// The render and the send themselves are the email core's (their own tests,
// src/test/email/emailTemplateAdmin.test.ts); here only who may call them,
// and with what.
const tries = vi.hoisted(() => ({
  previews: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
  sendResult: { success: true, provider: 'resend' } as Record<string, unknown>,
  /** The content checks a save asked for, and what the next ones answer. */
  checks: [] as Array<Record<string, unknown>>,
  refused: [] as string[],
}));
vi.mock('../../../server/services/email/templateAdmin.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  previewPlatformTemplate: async (_config: unknown, input: Record<string, unknown>) => {
    tries.previews.push(input);
    return { subject: 'S', html: '<html><body>H</body></html>', text: 'T', problems: ['foreign_link'] };
  },
  sendPlatformTemplateTest: async (_config: unknown, input: Record<string, unknown>) => {
    tries.sends.push(input);
    return tries.sendResult;
  },
  refusedTemplateContent: async (_config: unknown, input: Record<string, unknown>) => {
    tries.checks.push(input);
    return tries.refused;
  },
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
const { __resetEmailQuotaMemoryForTests } = await import('../../../server/services/email/sendQuota.js');

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
  templates: Array<{ id: string; slug?: string; status?: string; sentInEdition?: boolean; variables?: string[] }>;
  edition?: string;
  template: { id: string; workspace_id: string | null; edition: string; subject: string };
  error?: string;
  locales?: { offered: string[]; fallback: string };
  problems?: string[];
  sent_to?: string;
  success?: boolean;
  error_code?: string;
}

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: ApiJson; headers: http.IncomingHttpHeaders }> {
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
        resolve({ status: res.statusCode || 0, json: json as ApiJson, headers: res.headers });
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
  for (const key of Object.keys(faults)) delete faults[key];
  db.__sessions = [
    { token: 'admin-token', userId: ADMIN_USER },
    { token: 'ordinary-token', userId: ORDINARY_USER },
  ];
  db.user_roles = [{ id: crypto.randomUUID(), user_id: ADMIN_USER, role: 'admin' }];
  db.profiles = [{ id: ADMIN_USER, email: 'admin@example.com', full_name: 'Admin', phone: null, created_at: null }];
  db.user_credentials = [{ user_id: ADMIN_USER, email_verified_at: '2026-01-01T00:00:00Z', status: 'active' }];
  edition.current = 'international';
  tries.previews = [];
  tries.sends = [];
  tries.sendResult = { success: true, provider: 'resend' };
  tries.checks = [];
  tries.refused = [];
  __resetEmailQuotaMemoryForTests();
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

  it('a platform admin can create, update, and delete a global template of a mail nothing sends', async () => {
    const created = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'welcome', locale: 'fa', subject: 'خوش آمدید', html_body: '<p/>', is_active: true,
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

describe('a mail the platform sends keeps its template', () => {
  beforeEach(() => {
    db.email_templates.push(
      { id: 't-reset', workspace_id: null, edition: 'international', slug: 'password_reset', locale: 'en', subject: 'Reset', html_body: '<p>r</p>', text_body: null, is_active: true },
      { id: 't-reset-iran', workspace_id: null, edition: 'iran', slug: 'password_reset', locale: 'fa', subject: 'بازیابی', html_body: '<p>r</p>', text_body: null, is_active: true },
    );
  });

  it('its row cannot be deleted', async () => {
    const res = await call('DELETE', '/api/admin/management/email-templates/t-reset', 'admin-token');
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('template_in_use');
    expect(db.email_templates.find((t) => t.id === 't-reset')).toBeDefined();
  });

  it('its row cannot be switched off, by an update or a save', async () => {
    const put = await call('PUT', '/api/admin/management/email-templates/t-reset', 'admin-token', {
      subject: 'Reset', html_body: '<p>r</p>', is_active: false,
    });
    expect(put.status).toBe(409);
    expect(db.email_templates.find((t) => t.id === 't-reset')?.is_active).toBe(true);
    const post = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'password_reset', locale: 'en', subject: 'Reset', html_body: '<p>r</p>', is_active: false,
    });
    expect(post.status).toBe(409);
    expect(db.email_templates.find((t) => t.id === 't-reset')?.is_active).toBe(true);
  });

  it('its text can be changed, and a switched-off row switched back on', async () => {
    db.email_templates.find((t) => t.id === 't-reset')!.is_active = false;
    const put = await call('PUT', '/api/admin/management/email-templates/t-reset', 'admin-token', {
      subject: 'Choose a new password', html_body: '<p>new</p>', is_active: true,
    });
    expect(put.status).toBe(200);
    expect(db.email_templates.find((t) => t.id === 't-reset')).toMatchObject({ subject: 'Choose a new password', is_active: true });
  });

  it('its row is kept when it cannot be told what the row is: a failed read refuses the delete or the switch-off', async () => {
    faults.email_templates = 1;
    const del = await call('DELETE', '/api/admin/management/email-templates/t-reset', 'admin-token');
    expect(del.status).toBe(500);
    expect(db.email_templates.find((t) => t.id === 't-reset')).toBeDefined();
    faults.email_templates = 1;
    const put = await call('PUT', '/api/admin/management/email-templates/t-reset', 'admin-token', {
      subject: 'Reset', html_body: '<p>r</p>', is_active: false,
    });
    expect(put.status).toBe(500);
    expect(db.email_templates.find((t) => t.id === 't-reset')?.is_active).toBe(true);
    expect(faults.email_templates).toBe(0);
  });

  it('a mail nothing sends can still be switched off', async () => {
    const put = await call('PUT', '/api/admin/management/email-templates/t-global', 'admin-token', {
      subject: 'Hi', html_body: '<p>hi</p>', is_active: false,
    });
    expect(put.status).toBe(200);
    expect(db.email_templates.find((t) => t.id === 't-global')?.is_active).toBe(false);
  });
});

describe('a template is saved only as the platform may send it', () => {
  it('a save whose content would run or load anything once opened is refused, with the codes, and nothing is written', async () => {
    tries.refused = ['foreign_image', 'forbidden_element:form'];
    const html = '<p>Hi</p><img src="https://tracker.example.org/p.gif" width="1" height="1" alt="">';
    const post = await call('POST', '/api/admin/management/email-templates', 'admin-token', {
      slug: 'welcome', locale: 'en', subject: 'Hi', html_body: html, is_active: true,
    });
    expect(post.status).toBe(422);
    expect(post.json).toEqual({ error: 'template_content_refused', problems: ['foreign_image', 'forbidden_element:form'] });
    const put = await call('PUT', '/api/admin/management/email-templates/t-global', 'admin-token', {
      subject: 'Hi', html_body: html, is_active: true,
    });
    expect(put.status).toBe(422);
    expect(db.email_templates.find((t) => t.id === 't-global')?.html_body).toBe('<p>hi</p>');
    // Read in the running edition, in the row's own language.
    expect(tries.checks).toEqual([
      { edition: 'international', locale: 'en', html_body: html },
      { edition: 'international', locale: 'en', html_body: html },
    ]);
  });

  it('a content with nothing refused is saved', async () => {
    const put = await call('PUT', '/api/admin/management/email-templates/t-global', 'admin-token', {
      subject: 'Hi', html_body: '<h1>Hello</h1>', is_active: true,
    });
    expect(put.status).toBe(200);
    expect(db.email_templates.find((t) => t.id === 't-global')?.html_body).toBe('<h1>Hello</h1>');
    expect(tries.checks).toHaveLength(1);
  });
});

describe('the catalog of email templates', () => {
  it('lists every template the platform keeps, sent and no longer sent, for the running edition', async () => {
    const res = await call('GET', '/api/admin/management/email-templates/catalog', 'admin-token');
    expect(res.status).toBe(200);
    expect(res.json.edition).toBe('international');
    expect(res.json.locales).toEqual({ offered: ['en', 'fa', 'tr'], fallback: 'en' });
    const bySlug = new Map(res.json.templates.map((t) => [t.slug, t]));
    expect(bySlug.get('password_reset')).toMatchObject({ status: 'sent', sentInEdition: true });
    expect(bySlug.get('invoice_issued')).toMatchObject({ status: 'legacy', sentInEdition: false });
    expect(bySlug.get('billing_card_removed')).toMatchObject({ status: 'sent', sentInEdition: true });
    expect(bySlug.get('operator_unread_digest')?.variables).toContain('{{count}}');

    edition.current = 'iran';
    const iran = await call('GET', '/api/admin/management/email-templates/catalog', 'admin-token');
    expect(iran.json.locales).toEqual({ offered: ['fa'], fallback: 'en' });
    expect(new Map(iran.json.templates.map((t) => [t.slug, t])).get('billing_card_removed')).toMatchObject({ status: 'sent', sentInEdition: false });
  });

  it('is the platform admin\'s only', async () => {
    expect((await call('GET', '/api/admin/management/email-templates/catalog', 'ordinary-token')).status).toBe(403);
    expect((await call('GET', '/api/admin/management/email-templates/catalog', null)).status).toBe(401);
  });
});

describe('the preview of a template', () => {
  const PREVIEW = '/api/admin/management/email-templates/preview';

  it('renders the posted text in the running edition, as JSON with its problems', async () => {
    const res = await call('POST', PREVIEW, 'admin-token', {
      slug: 'password_reset', locale: 'en', subject: 'Unsaved', html_body: '<h1>Unsaved</h1>', text_body: null, scheme: 'dark',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json).toMatchObject({ subject: 'S', problems: ['foreign_link'] });
    expect(tries.previews).toEqual([{
      edition: 'international', slug: 'password_reset', locale: 'en', scheme: 'dark',
      content: { subject: 'Unsaved', html_body: '<h1>Unsaved</h1>', text_body: null },
    }]);
  });

  it('renders the saved row when nothing is posted, and never the other edition\'s', async () => {
    const res = await call('POST', PREVIEW, 'admin-token', { slug: 'welcome', locale: 'en' });
    expect(res.status).toBe(200);
    expect(tries.previews[0]).toMatchObject({ edition: 'international', content: { subject: 'Hi', html_body: '<p>hi</p>' }, scheme: 'light' });

    // Only the Iranian edition has a Persian 'welcome' here.
    db.email_templates.push({ id: 't-iran-fa', workspace_id: null, edition: 'iran', slug: 'welcome', locale: 'fa', subject: 'سلام', html_body: '<p>س</p>', text_body: null, is_active: true });
    const other = await call('POST', PREVIEW, 'admin-token', { slug: 'welcome', locale: 'fa' });
    expect(other.status).toBe(404);
    expect(tries.previews).toHaveLength(1);
  });

  it('refuses an edition, a recipient or a language the platform does not write', async () => {
    for (const body of [
      { slug: 'welcome', locale: 'en', edition: 'iran' },
      { slug: 'welcome', locale: 'en', to: 'someone@example.com' },
      { slug: 'welcome', locale: 'de' },
    ]) {
      expect((await call('POST', PREVIEW, 'admin-token', body)).status).toBe(400);
    }
    expect(tries.previews).toEqual([]);
  });

  it('is the platform admin\'s only', async () => {
    expect((await call('POST', PREVIEW, 'ordinary-token', { slug: 'welcome', locale: 'en' })).status).toBe(403);
    expect((await call('POST', PREVIEW, null, { slug: 'welcome', locale: 'en' })).status).toBe(401);
    expect(tries.previews).toEqual([]);
  });
});

describe('the test of a template', () => {
  const TEST = '/api/admin/management/email-templates/test-send';
  const posted = { slug: 'password_reset', locale: 'en', subject: 'Reset — {brand}', html_body: '<h1>Reset</h1>', text_body: null };

  it('goes to the signed-in admin\'s own verified address, with the posted text, in the running edition', async () => {
    const res = await call('POST', TEST, 'admin-token', posted);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, sent_to: 'admin@example.com' });
    expect(tries.sends).toEqual([{
      edition: 'international', slug: 'password_reset', locale: 'en', to: 'admin@example.com',
      content: { subject: 'Reset — {brand}', html_body: '<h1>Reset</h1>', text_body: null },
    }]);
  });

  it('sends the saved row when nothing is posted', async () => {
    const res = await call('POST', TEST, 'admin-token', { slug: 'welcome', locale: 'en' });
    expect(res.status).toBe(200);
    expect(tries.sends[0]).toMatchObject({ content: { subject: 'Hi', html_body: '<p>hi</p>' } });
    expect((await call('POST', TEST, 'admin-token', { slug: 'welcome', locale: 'tr' })).status).toBe(404);
  });

  it('never goes to another address, nor to an unverified one', async () => {
    expect((await call('POST', TEST, 'admin-token', { ...posted, to: 'victim@example.com' })).status).toBe(400);
    db.user_credentials[0].email_verified_at = null;
    const unverified = await call('POST', TEST, 'admin-token', posted);
    expect(unverified.status).toBe(400);
    expect(unverified.json.error).toBe('verified_email_required');
    expect(tries.sends).toEqual([]);
  });

  it('refuses half a template: a subject without its HTML, or an empty one', async () => {
    expect((await call('POST', TEST, 'admin-token', { slug: 'password_reset', locale: 'en', subject: 'Only a subject' })).status).toBe(400);
    expect((await call('POST', TEST, 'admin-token', { ...posted, html_body: '  ' })).json.error).toBe('template_empty');
    expect(tries.sends).toEqual([]);
  });

  it('is counted per admin: past ten in ten minutes it waits', async () => {
    for (let i = 0; i < 10; i += 1) expect((await call('POST', TEST, 'admin-token', posted)).status).toBe(200);
    const limited = await call('POST', TEST, 'admin-token', posted);
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('test_limit_reached');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(tries.sends).toHaveLength(10);
  });

  it('says when the provider did not take it', async () => {
    tries.sendResult = { success: false, provider: 'resend', errorCode: 'provider_rejected', error: 'provider_rejected: refused' };
    const res = await call('POST', TEST, 'admin-token', posted);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ success: false, sent_to: 'admin@example.com', error_code: 'provider_rejected' });
  });

  it('is the platform admin\'s only', async () => {
    expect((await call('POST', TEST, 'ordinary-token', posted)).status).toBe(403);
    expect((await call('POST', TEST, null, posted)).status).toBe(401);
    expect(tries.sends).toEqual([]);
  });
});
