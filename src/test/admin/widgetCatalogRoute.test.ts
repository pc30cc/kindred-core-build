// @vitest-environment node
/**
 * Super Admin → Widget settings → Widget templates:
 * GET / PUT /api/admin/widget-catalog (server/routes/adminWidgetCatalog.ts),
 * the chat widget template catalog of the running edition
 * (widget_edition_settings.chat_templates, migration 275).
 *
 *   - only a platform admin (401 anonymous, 403 a member), nothing written;
 *   - the edition comes from getPlatformEdition: 503 while unknown, and only
 *     that edition's row is read and written, with only its offered ids;
 *   - a save is validated (shape and rules), upserted with updated_by,
 *     audited with the old and new catalog, and publishes `platform` after
 *     the write; ids missing from the body keep their stored item;
 *   - usage counts per template and for workspaces that never chose;
 *   - before 275: GET reads the code's defaults (ready: false), PUT 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'node:fs';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international' | null,
  catalogRows: [] as Row[],
  settings: [] as Row[],
  audit: [] as Row[],
  upserts: [] as Row[],
  /** Each publish, with how many catalog writes had happened before it. */
  published: [] as Array<{ scopes: string[]; writes: number }>,
  admins: new Set<string>(),
  sessions: new Map<string, string>(),
  /** Simulates a database from before migration 275. */
  missing: false,
}));

const MISSING_TABLE = { code: '42P01', message: 'relation "public.widget_edition_settings" does not exist' };
const MISSING_COLUMN = { code: '42703', message: 'column widget_settings.widget_template_id does not exist' };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(name: string) {
      if (name === 'widget_edition_settings') {
        let edition: unknown;
        const b = {
          select: () => b,
          eq(_col: string, value: unknown) { edition = value; return b; },
          maybeSingle: async () => (state.missing
            ? { data: null, error: MISSING_TABLE }
            : { data: (() => { const r = state.catalogRows.find((x) => x.edition === edition); return r ? { ...r } : null; })(), error: null }),
          upsert(row: Row) {
            state.upserts.push(structuredClone(row));
            const done = state.missing
              ? { data: null, error: MISSING_TABLE }
              : (() => {
                  const at = state.catalogRows.findIndex((x) => x.edition === row.edition);
                  if (at >= 0) state.catalogRows[at] = { ...row };
                  else state.catalogRows.push({ ...row });
                  return { data: { ...row }, error: null };
                })();
            return { select: () => ({ single: async () => done }) };
          },
        };
        return b;
      }
      if (name === 'widget_settings') {
        let match: (r: Row) => boolean = () => true;
        const b = {
          select: () => b,
          is(col: string, value: unknown) { match = (r) => (value === null ? r[col] == null : r[col] === value); return b; },
          eq(col: string, value: unknown) { match = (r) => r[col] === value; return b; },
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve(state.missing
              ? { data: null, count: null, error: MISSING_COLUMN }
              : { data: null, count: state.settings.filter(match).length, error: null }).then(resolve);
          },
        };
        return b;
      }
      return {
        insert: async (row: Row) => { state.audit.push(structuredClone(row)); return { data: null, error: null }; },
      };
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_config: unknown, userId: string) => state.admins.has(userId),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    const userId = token ? state.sessions.get(token) : undefined;
    return userId ? { sessionId: 's1', userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

vi.mock('../../../server/services/platformRegion.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/platformRegion.js')>();
  return {
    ...real,
    getPlatformEdition: async () => {
      if (!state.edition) throw new real.EditionUnavailableError();
      return state.edition;
    },
  };
});

vi.mock('../../../server/lib/cacheBus.js', async (orig) => {
  const real = await orig<typeof import('../../../server/lib/cacheBus.js')>();
  return {
    ...real,
    publishCacheInvalidation: (scopes: string[]) => { state.published.push({ scopes, writes: state.upserts.length }); },
  };
});

const { adminWidgetCatalogRouter } = await import('../../../server/routes/adminWidgetCatalog.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'http://x',
    supabaseServiceRoleKey: 'k',
    corsOrigins: ['*'],
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin/widget-catalog', adminWidgetCatalogRouter);
const server = http.createServer(app).listen(0);

function call(method: 'GET' | 'PUT', token: string | null, body?: unknown): Promise<{ status: number; json: Row }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token) headers.cookie = `gs_session=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/admin/widget-catalog', method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || '{}') as Row }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
const get = (token: string | null = 'admin-token') => call('GET', token);
const put = (body: unknown, token: string | null = 'admin-token') => call('PUT', token, body);

const SAVE = {
  defaultId: 'default',
  templates: [
    { id: 'default', enabled: true, order: 0, name: { fa: 'آشنا' } },
    { id: 't1', enabled: true, order: 1, name: { fa: 'فیروزه', en: 'Turquoise' }, options: { navStyle: 'va', navMode: 'icon' } },
  ],
};

beforeEach(() => {
  state.edition = 'iran';
  state.catalogRows = [];
  state.settings = [
    { workspace_id: 'w1', widget_template_id: null },
    { workspace_id: 'w2', widget_template_id: null },
    { workspace_id: 'w3', widget_template_id: 't1' },
    { workspace_id: 'w4', widget_template_id: 't2' },
  ];
  state.audit = [];
  state.upserts = [];
  state.published = [];
  state.admins = new Set(['admin-1']);
  state.sessions = new Map([['admin-token', 'admin-1'], ['member-token', 'member-1']]);
  state.missing = false;
});

describe('auth', () => {
  it('refuses an anonymous caller and a member, reads and writes nothing', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get('member-token')).status).toBe(403);
    expect((await put(SAVE, null)).status).toBe(401);
    expect((await put(SAVE, 'member-token')).status).toBe(403);
    expect(state.upserts).toEqual([]);
    expect(state.published).toEqual([]);
    expect(state.audit).toEqual([]);
  });

  it('is mounted under /api/admin (behind requireAdmin), not under /api/widget-settings/platform', () => {
    const admin = readFileSync('server/routes/admin.ts', 'utf8');
    const mount = admin.indexOf("adminRouter.use('/widget-catalog', adminWidgetCatalogRouter);");
    expect(mount).toBeGreaterThan(admin.indexOf('adminRouter.use(requireAdmin);'));
    expect(readFileSync('server/routes/widgetSettings.ts', 'utf8')).not.toContain("'/platform/templates'");
  });
});

describe('GET', () => {
  it('an edition without a row reads the code defaults: only `default` enabled', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ edition: 'iran', ready: true, defaultId: 'default', followingDefault: 2 });
    const templates = res.json.templates as Row[];
    expect(templates.map((t) => [t.id, t.enabled, t.chosenBy])).toEqual([['default', true, 0], ['t1', false, 1], ['t2', false, 1]]);
    expect(templates[1]).toMatchObject({
      options: { navStyle: 'vb', navMode: 'active', topics: [] },
      optionSpec: { navStyle: ['vb', 'va', 'vc', 'vd'], navMode: ['active', 'both', 'icon', 'text', 'none'] },
    });
    expect(templates[2].optionSpec).toMatchObject({ topics: { max: 4 }, askExamples: { max: 2 } });
    // Every option a template reads has its spec (the first value the code's default).
    expect(templates[1].optionSpec).toMatchObject({ prechatMode: ['card', 'steps'], transcriptEmail: [true, false] });
    expect(templates[2].optionSpec).toMatchObject({ csat: [true, false], transcriptEmail: [true, false] });
    expect(templates[2].optionSpec).not.toHaveProperty('prechatMode');
    for (const t of templates) {
      expect(Object.keys(t.optionSpec as Row).sort(), String(t.id)).toEqual(Object.keys(t.options as Row).sort());
    }
  });

  it('reads only the running edition\'s row', async () => {
    state.catalogRows = [
      { edition: 'international', chat_templates: { default: 'intl', items: { intl: { enabled: true, name: { en: 'Global' } } } } },
      { edition: 'iran', chat_templates: { default: 't1', items: { t1: { enabled: true } } }, updated_by: 'admin-0' },
    ];
    const res = await get();
    expect(res.json).toMatchObject({ edition: 'iran', defaultId: 't1', updatedBy: 'admin-0' });
    state.edition = 'international';
    const intl = await get();
    expect(intl.json).toMatchObject({ edition: 'international', defaultId: 'intl' });
    expect((intl.json.templates as Row[]).map((t) => t.id)).toEqual(['intl', 't1-intl', 't2-intl']);
    // RESPOK's skins over Templates 1 and 2 are off until the Super Admin
    // enables them, and carry the logo direction (Thread by default).
    const [own, t1i, t2i] = intl.json.templates as Row[];
    expect([own.enabled, t1i.enabled, t2i.enabled]).toEqual([true, false, false]);
    expect(t1i.options).toMatchObject({ logoDirection: 'thread', navStyle: 'vb', navMode: 'active' });
    expect(t2i.options).toMatchObject({ logoDirection: 'thread', csat: true });
    expect(own.options).toEqual({ csat: true });
    // Every option they read has its spec here too, the logo direction's
    // values with the code's default (Thread) first.
    expect(t1i.optionSpec).toMatchObject({ logoDirection: ['thread', 'open'] });
    expect(t2i.optionSpec).toMatchObject({ logoDirection: ['thread', 'open'] });
    for (const t of intl.json.templates as Row[]) {
      expect(Object.keys(t.optionSpec as Row).sort(), String(t.id)).toEqual(Object.keys(t.options as Row).sort());
    }
  });

  it('503 while the edition cannot be told', async () => {
    state.edition = null;
    expect(await get()).toEqual({ status: 503, json: { error: 'EDITION_UNAVAILABLE' } });
    expect(await put(SAVE)).toEqual({ status: 503, json: { error: 'EDITION_UNAVAILABLE' } });
    expect(state.upserts).toEqual([]);
  });

  it('before migration 275: the code defaults, ready false, no counts', async () => {
    state.missing = true;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ready: false, defaultId: 'default', followingDefault: null });
    expect((res.json.templates as Row[]).every((t) => t.chosenBy === null)).toBe(true);
  });
});

describe('PUT', () => {
  it('saves the running edition\'s row, audits it and publishes `platform` after the write', async () => {
    const res = await put(SAVE);
    expect(res.status).toBe(200);
    expect(state.upserts).toEqual([expect.objectContaining({
      edition: 'iran',
      updated_by: 'admin-1',
      chat_templates: {
        default: 'default',
        items: {
          default: { enabled: true, order: 0, name: { fa: 'آشنا' } },
          t1: { enabled: true, order: 1, name: { fa: 'فیروزه', en: 'Turquoise' }, options: { navStyle: 'va', navMode: 'icon' } },
        },
      },
    })]);
    expect(state.published).toEqual([{ scopes: ['platform'], writes: 1 }]);
    expect(state.audit).toEqual([expect.objectContaining({
      user_id: 'admin-1',
      workspace_id: null,
      action: 'admin.widget_catalog.changed',
      entity_type: 'widget_edition_settings',
      entity_id: null,
      old_value: { edition: 'iran', chat_templates: null },
      new_value: { edition: 'iran', chat_templates: state.upserts[0].chat_templates },
    })]);
    // Answers what the page reads.
    expect(res.json).toMatchObject({ edition: 'iran', defaultId: 'default', followingDefault: 2 });
    expect((res.json.templates as Row[]).filter((t) => t.enabled).map((t) => t.id)).toEqual(['default', 't1']);
  });

  it('keeps the stored item of a template the body leaves out', async () => {
    state.catalogRows = [{ edition: 'iran', chat_templates: { default: 'default', items: { t2: { enabled: true, name: { fa: 'نسیم' } } } } }];
    const res = await put(SAVE);
    expect(res.status).toBe(200);
    expect((state.upserts[0].chat_templates as { items: Row }).items.t2).toEqual({ enabled: true, name: { fa: 'نسیم' } });
    expect(state.audit[0].old_value).toEqual({ edition: 'iran', chat_templates: { default: 'default', items: { t2: { enabled: true, name: { fa: 'نسیم' } } } } });
  });

  it.each([
    [{ ...SAVE, extra: 1 }, 'Invalid input'],
    [{ defaultId: 'default', templates: [] }, 'Invalid input'],
    [{ defaultId: 'default', templates: [{ id: 't1', enabled: 'yes' }] }, 'Invalid input'],
    [{ defaultId: 'default', templates: [{ id: 't1', enabled: true, name: { de: 'x' } }] }, 'Invalid input'],
    [{ defaultId: 'default', templates: [{ id: 'intl', enabled: true }] }, 'template_not_offered'],
    [{ defaultId: 't2', templates: SAVE.templates }, 'default_not_enabled'],
    [{ defaultId: 'default', templates: [{ id: 'default', enabled: false }] }, 'no_template_enabled'],
    [{ defaultId: 'default', templates: [{ id: 't1', enabled: true, options: { navMode: 'sideways' } }] }, 'invalid_template_options'],
    [{ defaultId: 'default', templates: [{ id: 't1', enabled: true, name: { fa: 'ق'.repeat(41) } }] }, 'name_too_long'],
  ])('refuses %j (%s): nothing written, nothing published', async (body, error) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(error);
    expect(state.upserts).toEqual([]);
    expect(state.published).toEqual([]);
    expect(state.audit).toEqual([]);
  });

  it('the International edition writes its own row and refuses the Iranian ids', async () => {
    state.edition = 'international';
    expect((await put(SAVE)).json.error).toBe('template_not_offered');
    const res = await put({ defaultId: 'intl', templates: [{ id: 'intl', enabled: true, name: { en: 'Global' } }] });
    expect(res.status).toBe(200);
    expect(state.upserts).toEqual([expect.objectContaining({ edition: 'international', chat_templates: { default: 'intl', items: { intl: { enabled: true, name: { en: 'Global' } } } } })]);
  });

  it('before migration 275: 409 migration_required, nothing written', async () => {
    state.missing = true;
    const res = await put(SAVE);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('migration_required');
    expect(state.upserts).toEqual([]);
    expect(state.published).toEqual([]);
  });
});
