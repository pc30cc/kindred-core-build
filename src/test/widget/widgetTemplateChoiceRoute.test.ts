// @vitest-environment node
/**
 * Widget → Appearance → Widget template, server side
 * (server/routes/widgetSettings.ts):
 *
 *   GET /api/widget-settings/:workspaceId/templates — the enabled templates of
 *   the running edition's catalog with their names in `?locale=`, the stored
 *   choice, what visitors wear now, and whether the picker is offered
 *   (two or more enabled, migration 275, a plan with widget_appearance);
 *
 *   PATCH /api/widget-settings/:workspaceId — `widget_template_id` only while
 *   enabled (400 template_not_available), stored under its current id, null
 *   follows the default; `widget_template_options` validated per key; plan
 *   denial 403; 409 migration_required before 275; `.strict()` still rejects
 *   unknown keys; the cache is invalidated as for any other appearance field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
const WS = '55555555-5555-4555-8555-555555555555';

const state = vi.hoisted(() => ({
  row: null as Row | null,
  edition: 'iran' as 'iran' | 'international',
  stored: null as unknown,
  ready: true,
  features: {} as Record<string, boolean>,
  updates: [] as Row[],
  published: [] as string[][],
  /** The update fails as PostgREST does when a column is missing (before 275). */
  columnMissing: false,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(name: string) {
      if (name !== 'widget_settings') throw new Error(`unexpected table ${name}`);
      let patch: Row | null = null;
      const b = {
        select: () => b,
        eq: () => b,
        update(p: Row) { patch = p; return b; },
        maybeSingle: async () => ({ data: state.row ? { ...state.row } : null, error: null }),
        single: async () => {
          if (patch) {
            if (state.columnMissing && Object.keys(patch).some((k) => k.startsWith('widget_template'))) {
              return { data: null, error: { code: 'PGRST204', message: "Could not find the 'widget_template_id' column of 'widget_settings' in the schema cache" } };
            }
            state.updates.push(structuredClone(patch));
            Object.assign(state.row as Row, patch);
          }
          return { data: { ...state.row }, error: null };
        },
      };
      return b;
    },
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'owner-1' }),
  requirePlatformAdmin: async () => null,
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({ assertPhoneVerificationSatisfied: async () => {} }));
vi.mock('../../../server/services/phoneVerification/types.js', () => ({ PhoneVerificationError: class extends Error {} }));
vi.mock('../../../server/services/widget/public.js', () => ({ invalidateWorkspaceOriginCache: () => {} }));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  createStorageUrlResolver: () => ({ workspace: async () => null }),
}));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/entitlements.js')>();
  return { ...real, resolveWidgetEntitlements: async () => ({ features: { ...state.features }, maxDomains: 10 }) };
});
vi.mock('../../../server/services/widget/configSnapshot.js', async () => {
  const { resolveChatTemplateCatalog } = await import('../../../shared/chatTemplateCatalog.js');
  return {
    getChatTemplateCatalog: async () => ({
      catalog: resolveChatTemplateCatalog(state.edition, state.stored),
      edition: state.edition,
      ready: state.ready,
    }),
  };
});
vi.mock('../../../server/lib/cacheBus.js', async (orig) => {
  const real = await orig<typeof import('../../../server/lib/cacheBus.js')>();
  return { ...real, publishCacheInvalidation: (scopes: string[]) => { state.published.push(scopes); } };
});

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');

const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { serverConfig: { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } });
  next();
});
app.use(express.json());
app.use('/api/widget-settings', widgetSettingsRouter);
const server = http.createServer(app).listen(0);

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || '{}') as Row }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const templates = (query = '') => call('GET', `/api/widget-settings/${WS}/templates${query}`);
const patch = (body: unknown) => call('PATCH', `/api/widget-settings/${WS}`, body);

const CATALOG = {
  default: 'default',
  items: {
    default: { enabled: true, order: 0, name: { fa: 'آشنا', en: 'Familiar' } },
    t1: { enabled: true, order: 1, name: { fa: 'فیروزه' }, options: { navStyle: 'vc' } },
    t2: { enabled: false, order: 2 },
  },
};

beforeEach(() => {
  state.row = { workspace_id: WS, primary_color: '#000000', widget_template_id: null, widget_template_options: {} };
  state.edition = 'iran';
  state.stored = CATALOG;
  state.ready = true;
  state.features = {};
  state.updates = [];
  state.published = [];
  state.columnMissing = false;
});

describe('GET /:workspaceId/templates', () => {
  it('lists the enabled templates with names in the asked language, the choice and the effective template', async () => {
    state.row!.widget_template_id = 't1';
    state.row!.widget_template_options = { navMode: 'none', junk: true };
    const res = await templates('?locale=fa');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      edition: 'iran',
      ready: true,
      defaultId: 'default',
      templates: [
        { id: 'default', name: 'آشنا', isDefault: true, options: {} },
        { id: 't1', name: 'فیروزه', isDefault: false, options: { navStyle: 'vc', navMode: 'active', topics: [] } },
      ],
      selectedId: 't1',
      selectedOptions: { navMode: 'none' },
      selectedUnavailable: false,
      effectiveId: 't1',
      effectiveOptions: { navStyle: 'vc', navMode: 'none', topics: [] },
      planAllowsChoice: true,
      canChoose: true,
    });
    const en = await templates('?locale=en');
    expect((en.json.templates as Row[]).map((t) => t.name)).toEqual(['Familiar', null]);
    // Without a locale: the edition's dashboard language (Iran: Persian).
    expect(((await templates()).json.templates as Row[])[0].name).toBe('آشنا');
  });

  it('a disabled choice is reported and visitors get the default', async () => {
    state.row!.widget_template_id = 't2';
    const res = await templates();
    expect(res.json).toMatchObject({ selectedId: 't2', selectedUnavailable: true, effectiveId: 'default', canChoose: true });
  });

  it('one template enabled (or no catalog): no picker', async () => {
    state.stored = null;
    const res = await templates();
    expect(res.json).toMatchObject({ canChoose: false, defaultId: 'default', effectiveId: 'default' });
    expect((res.json.templates as Row[]).map((t) => t.id)).toEqual(['default']);
  });

  it('a plan without widget_appearance: no choice, the default worn', async () => {
    state.features = { widget_appearance: false };
    state.row!.widget_template_id = 't1';
    const res = await templates();
    expect(res.json).toMatchObject({ planAllowsChoice: false, canChoose: false, effectiveId: 'default', effectiveOptions: {} });
  });

  it('before migration 275 (no column, or no table): ready false, no picker', async () => {
    state.row = { workspace_id: WS, primary_color: '#000000' };
    expect((await templates()).json).toMatchObject({ ready: false, canChoose: false, selectedId: null });
    state.row = { workspace_id: WS, widget_template_id: null };
    state.ready = false;
    expect((await templates()).json).toMatchObject({ ready: false, canChoose: false });
  });
});

describe('PATCH /:workspaceId — widget_template_id / widget_template_options', () => {
  it('an enabled id is stored (normalised) and the widget cache is invalidated', async () => {
    const res = await patch({ widget_template_id: ' T1 ' });
    expect(res.status).toBe(200);
    expect(state.updates).toEqual([expect.objectContaining({ widget_template_id: 't1' })]);
    expect(state.published).toEqual([[`widget:${WS}`, `origin:${WS}`]]);
  });

  it('null follows the default', async () => {
    state.row!.widget_template_id = 't1';
    expect((await patch({ widget_template_id: null })).status).toBe(200);
    expect(state.updates[0].widget_template_id).toBeNull();
  });

  it.each(['t2', 'intl', 'nope', 'web-yar-x'])('%s (disabled, other edition, unknown) is 400 template_not_available', async (id) => {
    const res = await patch({ widget_template_id: id });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'template_not_available', issues: [{ path: 'widget_template_id' }] });
    expect(state.updates).toEqual([]);
    expect(state.published).toEqual([]);
  });

  it('a legacy id is stored under its current name', async () => {
    expect((await patch({ widget_template_id: 'web-yar' })).status).toBe(200);
    expect(state.updates[0].widget_template_id).toBe('default');
  });

  it('a malformed id is refused by the schema', async () => {
    for (const id of ['Simple Home', '-x', 'x'.repeat(33), 12]) {
      expect((await patch({ widget_template_id: id })).status).toBe(400);
    }
    expect(state.updates).toEqual([]);
  });

  it('options: cleaned (unknown keys dropped) or refused naming the key', async () => {
    const ok = await patch({ widget_template_options: { navMode: 'none', topics: [{ label: ' ارسال ', icon: 'truck' }, { label: '', icon: 'box' }], junk: 1 } });
    expect(ok.status).toBe(200);
    expect(state.updates[0].widget_template_options).toEqual({ navMode: 'none', topics: [{ label: 'ارسال', icon: 'truck' }] });
    const bad = await patch({ widget_template_options: { topics: [{ label: 'x', icon: 'rocket' }] } });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'invalid_template_options', issues: [{ path: 'widget_template_options.topics' }] });
    expect((await patch({ widget_template_options: ['x'] })).status).toBe(400);
    expect(state.updates).toHaveLength(1);
  });

  it('a plan without widget_appearance may not choose (403), but may clear', async () => {
    state.features = { widget_appearance: false };
    const res = await patch({ widget_template_id: 't1' });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: 'plan_upgrade_required', denied: ['widget_appearance'] });
    expect((await patch({ widget_template_options: { navMode: 'none' } })).status).toBe(403);
    expect((await patch({ widget_template_id: null, widget_template_options: {} })).status).toBe(200);
  });

  it('before migration 275 the write answers 409 migration_required', async () => {
    state.columnMissing = true;
    const res = await patch({ widget_template_id: 't1' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('migration_required');
    expect(state.published).toEqual([]);
  });

  it('with no catalog table at all (275 not applied) every template write is 409, never template_not_available', async () => {
    state.ready = false;
    state.stored = null;
    state.columnMissing = true;
    for (const body of [{ widget_template_id: 't1' }, { widget_template_id: 'default' }, { widget_template_id: null }, { widget_template_options: { navStyle: 'va' } }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.json.code).toBe('migration_required');
    }
    expect(state.updates).toEqual([]);
    expect(state.published).toEqual([]);
    // Every other field still saves.
    expect((await patch({ primary_color: '#123456' })).status).toBe(200);
  });

  it('.strict() still rejects an unknown key next to the template fields', async () => {
    const res = await patch({ widget_template_id: 't1', widget_template_name: 'x' });
    expect(res.status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it('other fields are untouched by the template checks', async () => {
    state.stored = null;
    expect((await patch({ primary_color: '#123456' })).status).toBe(200);
    expect(state.updates).toEqual([expect.objectContaining({ primary_color: '#123456' })]);
  });
});
