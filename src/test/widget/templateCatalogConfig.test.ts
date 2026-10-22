// @vitest-environment node
/**
 * The chat widget template catalog on the visitor path: it rides in the
 * platform snapshot (server/services/widget/configSnapshot.ts, 30 s, cleared
 * by `platform`) and decides GET /config's `templateId` and `templateOptions`.
 *
 *   - no row: `default` with `templateOptions: {}`, exactly as before;
 *   - the workspace's choice while enabled (and while its plan allows
 *     widget_appearance), with the merged options; a disabled choice, or a
 *     plan without the Appearance editor, wears the catalog's default;
 *   - display names never reach the widget;
 *   - before migration 275 (no table) the snapshot is not degraded; a failed
 *     read is, and a rebuild that fails keeps the previous catalog, also
 *     right after a `platform` clear (the process's last good read);
 *   - the warm path reads nothing; `platform` makes the next read see a save;
 *   - workspaceChatTemplate (what the server reads before writing the closed
 *     line or serving a rating or a transcript) is exactly GET /config's
 *     template and options, so a `default` / `intl` workspace is never
 *     treated as wearing t2.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb, catalogMissing: false }));
const MISSING = { code: '42P01', message: 'relation "public.widget_edition_settings" does not exist' };
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => {
      if (holder.catalogMissing && t === 'widget_edition_settings') {
        holder.db.calls.from += 1;
        return { select: () => Promise.resolve({ data: null, error: MISSING }) };
      }
      return holder.db.client.from(t);
    },
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-catalog';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;

const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');

const req = {
  query: {},
  headers: {},
  protocol: 'https',
  get: () => 'api.test',
  socket: { remoteAddress: '127.0.0.1' },
} as unknown as Request;

const CATALOG = {
  default: 'default',
  items: {
    t1: { enabled: true, order: 1, name: { fa: 'فیروزه', en: 'Turquoise' }, options: { navStyle: 'vc' } },
    t2: { enabled: true, order: 2, name: { fa: 'نسیم' } },
  },
};

type Tables = ReturnType<typeof widgetScenarioTables>;

async function fresh(edit?: (t: Tables) => void, opts: { deny?: string[]; failing?: Set<string>; edition?: 'iran' | 'international' } = {}) {
  const tables = widgetScenarioTables({ edition: opts.edition ?? 'iran', ai: false, smart: false });
  edit?.(tables);
  const denied = new Set(opts.deny ?? []);
  holder.db = createFakeDb(tables, {
    failingTables: opts.failing,
    rpc: (fn, args) => (fn === 'check_workspace_entitlement' && denied.has(String(args?._feature))
      ? { data: { allowed: false, plan: 'pro', reason: 'feature_disabled' }, error: null }
      : allowAllRpc(fn, args)),
  });
  holder.catalogMissing = false;
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  return tables;
}

const withCatalog = (catalog: unknown = CATALOG, edition = 'iran') => (t: Tables) => {
  (t as Record<string, unknown[]>).widget_edition_settings = [{ edition, chat_templates: catalog }];
};
const choose = (id: string | null, options: Record<string, unknown> = {}) => (t: Tables) => {
  Object.assign(t.widget_settings[0], { widget_template_id: id, widget_template_options: options });
};

async function body(edition: 'iran' | 'international' = 'iran') {
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition, quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T10:00:00Z') });
  delete process.env.WIDGET_CONFIG_CACHE_TTL_MS;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GET /config body: templateId and templateOptions from the catalog', () => {
  it('no catalog row: default with no options, whatever the row holds', async () => {
    await fresh(choose('t1', { navMode: 'none' }));
    const b = await body();
    expect(b.templateId).toBe('default');
    expect(b.templateOptions).toEqual({});
    expect(String(b.presentationUrl)).toContain('presentation-default');
  });

  it('a pre-275 row (no template columns) wears default', async () => {
    await fresh(withCatalog());
    const b = await body();
    expect(b.templateId).toBe('default');
    expect(b.templateOptions).toEqual({});
  });

  it('an enabled choice is worn with the merged options and its own assets', async () => {
    await fresh((t) => {
      withCatalog()(t);
      choose('t1', { navMode: 'both', topics: [{ label: 'ارسال', icon: 'truck' }], askExamples: ['x'], junk: 1 })(t);
    });
    const b = await body();
    expect(b.templateId).toBe('t1');
    expect(b.templateOptions).toEqual({
      navStyle: 'vc', navMode: 'both', topics: [{ label: 'ارسال', icon: 'truck' }], prechatMode: 'card', transcriptEmail: false,
    });
    // No email to visitors while the switch is off (shared/visitorEmail.ts): the
    // away email step's flag is not sent.
    expect(b).not.toHaveProperty('visitorEmail');
    expect(String(b.presentationUrl)).toContain('presentation-t1');
    expect(String(b.presentationStyleUrl)).toContain('presentation-t1');
    expect(String(b.presentationFontsUrl ?? '')).not.toContain('t1');
  });

  it('names Core\'s renderer-feature module (modules.ext) for a template whose renderer declares features, once, and never for default', async () => {
    await fresh();
    const plain = await body();
    expect(plain.templateId).toBe('default');
    expect(Object.keys(plain.modules as Record<string, unknown>)).not.toContain('ext');
    await fresh((t) => { withCatalog()(t); choose('t2')(t); });
    const b = await body();
    expect(b.templateId).toBe('t2');
    const modules = b.modules as Record<string, unknown>;
    expect(Object.keys(modules).filter((k) => k === 'ext')).toHaveLength(1);
    // A hashed name carries no ?v= (the build's manifest); without one, as
    // here, the canonical name is versioned like every other module.
    expect(String(modules.ext)).toMatch(/\/widget\/runtime-ext(\.[0-9a-f]{8}\.js|\.js\?v=[^&]+)$/);
    expect(JSON.stringify(b).match(/runtime-ext/g)).toHaveLength(1);
  });

  it('names the late pack (modules.late, modules.extras) for a template whose renderer has extras, and never for default or intl', async () => {
    // default and intl: the modules exactly as before the late pack.
    const before = ['chat', 'kb', 'rt_resolver', 'rt_centrifugo', 'rt_supabase'];
    await fresh();
    expect(Object.keys((await body()).modules as Record<string, unknown>)).toEqual(before);
    await fresh((t) => { withCatalog(CATALOG, 'international')(t); }, { edition: 'international' });
    const intl = await body('international');
    expect(intl.templateId).toBe('intl');
    expect(Object.keys(intl.modules as Record<string, unknown>)).toEqual(before);
    expect(JSON.stringify(intl)).not.toMatch(/runtime-late|-x\.js|runtime-emoji/);
    for (const id of ['t1', 't2']) {
      await fresh((t) => { withCatalog()(t); choose(id)(t); });
      const b = await body();
      expect(b.templateId).toBe(id);
      const modules = b.modules as Record<string, unknown>;
      expect(Object.keys(modules)).toEqual(['chat', 'kb', 'ext', 'emoji', 'late', 'extras', 'rt_resolver', 'rt_centrifugo', 'rt_supabase']);
      expect(String(modules.late)).toMatch(/\/widget\/runtime-late(\.[0-9a-f]{8}\.js|\.js\?v=[^&]+)$/);
      // The emoji keyword data, requested only when the picker's search is used.
      expect(String(modules.emoji)).toMatch(/\/widget\/runtime-emoji(\.[0-9a-f]{8}\.js|\.js\?v=[^&]+)$/);
      expect(JSON.stringify(b).match(/runtime-emoji/g)).toHaveLength(1);
      expect(String(modules.extras)).toMatch(new RegExp(`/widget/presentation-${id}-x(\\.[0-9a-f]{8}\\.js|\\.js\\?v=[^&]+)$`));
      // The loader never asks for them: nowhere but in `modules`.
      expect(JSON.stringify(b).match(/runtime-late|-x\./g)).toHaveLength(2);
    }
  });

  it('display names never reach the widget', async () => {
    await fresh((t) => { withCatalog()(t); choose('t1')(t); });
    const text = JSON.stringify(await body());
    expect(text).not.toContain('فیروزه');
    expect(text).not.toContain('Turquoise');
    expect(text).not.toContain('نسیم');
  });

  it('a disabled choice wears the catalog default (and its choice is kept)', async () => {
    await fresh((t) => {
      withCatalog({ default: 't2', items: { t1: { enabled: false }, t2: { enabled: true } } })(t);
      choose('t1')(t);
    });
    const b = await body();
    expect(b.templateId).toBe('t2');
    expect(b.templateOptions).toEqual({ topics: [], askExamples: [], csat: true, transcriptEmail: false });
  });

  it('a plan without widget_appearance wears the default with the Super Admin options only', async () => {
    await fresh((t) => { withCatalog()(t); choose('t1', { navMode: 'none' })(t); }, { deny: ['widget_appearance'] });
    expect((await body()).templateId).toBe('default');
    await fresh((t) => {
      withCatalog({ default: 't1', items: { t1: { enabled: true, options: { navStyle: 'vd' } } } })(t);
      choose('t2', { navMode: 'none' })(t);
    }, { deny: ['widget_appearance'] });
    const b = await body();
    expect(b.templateId).toBe('t1');
    expect(b.templateOptions).toEqual({ navStyle: 'vd', navMode: 'active', topics: [], prechatMode: 'card', transcriptEmail: false });
  });

  it('the International edition ignores an Iranian catalog and wears intl', async () => {
    await fresh((t) => { withCatalog(CATALOG, 'international')(t); choose('t1')(t); }, { edition: 'international' });
    const b = await body('international');
    expect(b.templateId).toBe('intl');
    expect(b.templateOptions).toEqual({});
  });
});

describe('the catalog in the platform snapshot', () => {
  it('is read with the snapshot, cached, and re-read after `platform`', async () => {
    const tables = await fresh(withCatalog());
    const p = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(p.chatTemplatesReady).toBe(true);
    expect(p.degraded).toBe(false);
    expect(p.chatTemplates.iran).toEqual(CATALOG);
    holder.db.resetCalls();
    await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(holder.db.calls.from + holder.db.calls.rpc).toBe(0);
    (tables as Record<string, Array<Record<string, unknown>>>).widget_edition_settings[0].chat_templates = { default: 't2', items: { t2: { enabled: true } } };
    invalidateLocal(['platform']);
    const { catalog } = await snapshotMod.getChatTemplateCatalog(config);
    expect(catalog.defaultId).toBe('t2');
    expect(holder.db.calls.log).toContain('from:widget_edition_settings');
  });

  it('before migration 275 (no table) the snapshot is ready=false, not degraded', async () => {
    await fresh();
    holder.catalogMissing = true;
    const p = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(p.degraded).toBe(false);
    expect(p.chatTemplatesReady).toBe(false);
    expect(p.chatTemplates).toEqual({});
    const { catalog, ready } = await snapshotMod.getChatTemplateCatalog(config);
    expect(ready).toBe(false);
    expect(catalog.defaultId).toBe('default');
  });

  it('a failed read degrades the snapshot; a failing rebuild keeps the previous catalog', async () => {
    await fresh(withCatalog(), { failing: new Set(['widget_edition_settings']) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(bad.degraded).toBe(true);
    // Recovered: a good snapshot.
    holder.db.options.failingTables = new Set();
    vi.setSystemTime(new Date('2026-10-17T10:00:06Z'));
    const good = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(good.degraded).toBe(false);
    expect(good.chatTemplates.iran).toEqual(CATALOG);
    // Past its 30 s, a rebuild whose catalog read fails is not stored.
    holder.db.options.failingTables = new Set(['widget_edition_settings']);
    vi.setSystemTime(new Date('2026-10-17T10:00:40Z'));
    expect(await snapshotMod.getWidgetPlatformSnapshot(config)).toBe(good);
    await vi.waitFor(() => expect(holder.db.calls.log.filter((l) => l === 'from:widget_edition_settings').length).toBeGreaterThan(1));
    expect((await snapshotMod.getWidgetPlatformSnapshot(config)).chatTemplates.iran).toEqual(CATALOG);
    warn.mockRestore();
  });

  it('a catalog read that fails right after a `platform` clear keeps the last good catalog: t1 stays t1', async () => {
    await fresh((t) => {
      withCatalog()(t);
      choose('t1')(t);
    });
    expect((await body()).templateId).toBe('t1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Any `platform` publish (a Super Admin save) drops the snapshot; the next catalog read fails.
    holder.db.options.failingTables = new Set(['widget_edition_settings']);
    invalidateLocal(['platform']);
    const during = await body();
    expect(during.templateId).toBe('t1');
    const p = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(p.degraded).toBe(true);
    expect(p.chatTemplates.iran).toEqual(CATALOG);
    const { catalog, ready } = await snapshotMod.getChatTemplateCatalog(config);
    expect(ready).toBe(true);
    expect(catalog.entries.filter((e) => e.enabled).map((e) => e.id)).toEqual(['default', 't1', 't2']);
    // A process that never read the catalog has nothing to keep: the edition default, degraded (5 s).
    snapshotMod.__resetWidgetConfigCachesForTests();
    const cold = await snapshotMod.getWidgetPlatformSnapshot(config);
    expect(cold.degraded).toBe(true);
    expect(cold.chatTemplates).toEqual({});
    warn.mockRestore();
  });
});

describe('workspaceChatTemplate: the server\'s view of the template a workspace wears', () => {
  const effective = async () => snapshotMod.workspaceChatTemplate(config, WS);

  it('is GET /config\'s template and options, with the descriptor (closedNotice only on t2)', async () => {
    await fresh((t) => { withCatalog()(t); choose('t2', { csat: false })(t); });
    const tpl = await effective();
    const b = await body();
    expect(tpl.id).toBe(b.templateId);
    expect(tpl.options).toEqual(b.templateOptions);
    expect(tpl.options).toMatchObject({ csat: false, transcriptEmail: false });
    expect(tpl.descriptor?.closedNotice).toBe(true);
    await fresh((t) => { withCatalog()(t); choose('t1')(t); });
    expect((await effective()).descriptor?.closedNotice).toBe(false);
  });

  it('no catalog, a disabled choice, a plan without the Appearance editor, the International edition: never t2', async () => {
    await fresh(choose('t2'));
    expect((await effective()).id).toBe('default');
    await fresh((t) => { withCatalog({ default: 'default', items: { t2: { enabled: false } } })(t); choose('t2')(t); });
    expect((await effective()).id).toBe('default');
    await fresh((t) => { withCatalog()(t); choose('t2')(t); }, { deny: ['widget_appearance'] });
    const plan = await effective();
    expect(plan.id).toBe('default');
    expect(plan.descriptor?.closedNotice).toBe(false);
    await fresh((t) => { withCatalog(CATALOG, 'international')(t); choose('t2')(t); }, { edition: 'international' });
    expect((await effective()).id).toBe('intl');
  });

  it('a workspace whose choice follows the default wears t2 when the Super Admin makes t2 the default', async () => {
    await fresh((t) => { withCatalog({ default: 't2', items: { t2: { enabled: true } } })(t); choose(null)(t); });
    const tpl = await effective();
    expect(tpl.id).toBe('t2');
    expect(tpl.descriptor?.closedNotice).toBe(true);
  });

  it('widget settings missing or unreadable: the edition\'s own template, never the catalog\'s t2 default', async () => {
    const t2Default = { default: 't2', items: { t2: { enabled: true } } };
    // The workspace chose `default`; its row cannot be read (the degraded
    // snapshot's few seconds), or it has none: not taken for t2.
    await fresh((t) => { withCatalog(t2Default)(t); choose('default')(t); }, { failing: new Set(['widget_settings']) });
    const unreadable = await effective();
    expect(unreadable).toEqual({ id: 'default', descriptor: expect.objectContaining({ id: 'default', closedNotice: false }), options: {} });
    await fresh((t) => { withCatalog(t2Default)(t); t.widget_settings.length = 0; });
    expect((await effective()).descriptor?.closedNotice).toBe(false);
    await fresh((t) => {
      withCatalog(t2Default, 'international')(t);
      t.widget_settings.length = 0;
    }, { edition: 'international' });
    expect((await effective()).id).toBe('intl');
    // Readable again: the choice (and the catalog default for no choice) as before.
    await fresh((t) => { withCatalog(t2Default)(t); choose(null)(t); });
    expect((await effective()).id).toBe('t2');
  });

  it('reads nothing on a warm cache', async () => {
    await fresh((t) => { withCatalog()(t); choose('t2')(t); });
    await effective();
    holder.db.resetCalls();
    await effective();
    expect(holder.db.calls.from + holder.db.calls.rpc).toBe(0);
  });
});
