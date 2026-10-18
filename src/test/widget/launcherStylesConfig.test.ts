// @vitest-environment node
/**
 * The launcher's styles and the logo direction on the visitor path (issue
 * #340, g5-1 and g6b): GET /config's `fab` and `fabStyleUrl` from the
 * workspace's row (shared/launcherStyles.ts), and the International credit's
 * lockup from the template option `logoDirection`.
 *
 *   - `fab.icon` / `fab.shape` are normalised (an unknown icon is `chat`, a
 *     pill needs its text); `fab.initial` only for the agent's face (the
 *     first operator, online first, else the workspace's name);
 *   - `fabStyleUrl` (the hashed runtime-fab.css) only for a launcher wearing
 *     a style: every other payload is as before, key for key;
 *   - a plan without widget_launcher_icon wears a chat circle and gets no
 *     stylesheet;
 *   - the International credit is the Open lockup when the worn template's
 *     logoDirection is `open`, the Thread one otherwise (`intl` reads no
 *     option, so it stays Thread); the Iranian credit is unchanged;
 *   - the build hashes runtime-fab.css in both brands and names it in the
 *     manifest.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { Request } from 'express';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-launcher-styles';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');

const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
type Tables = ReturnType<typeof widgetScenarioTables>;
type Body = Record<string, unknown> & { fab: Record<string, unknown>; poweredBy?: { logo?: string } | null };

/** The fab keys every payload carried before the styles (the starting commit's). */
const FAB_KEYS = ['icon', 'helpIcon', 'shape', 'label', 'chatLabel', 'helpLabel', 'scale', 'iconColor', 'textColor', 'animation', 'imageUrl'];

async function body(
  edit?: (t: Tables) => void,
  opts: { deny?: string[]; edition?: 'iran' | 'international' } = {},
): Promise<Body> {
  const edition = opts.edition ?? 'iran';
  const tables = widgetScenarioTables({ edition, ai: false, smart: false });
  edit?.(tables);
  const denied = new Set(opts.deny ?? []);
  holder.db = createFakeDb(tables, {
    rpc: (fn, args) => (fn === 'check_workspace_entitlement' && denied.has(String(args?._feature))
      ? { data: { allowed: false, plan: 'pro', reason: 'feature_disabled' }, error: null }
      : allowAllRpc(fn, args)),
  });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition, quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Body;
}
const fab = (row: Record<string, unknown>) => (t: Tables) => { Object.assign(t.widget_settings[0], row); };
const FAB_URL = /^https:\/\/app\.test\/widget\/runtime-fab(\.[0-9a-f]{8}\.css|\.css\?v=[^&]+)$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-18T10:00:00Z') });
  delete process.env.WIDGET_CONFIG_CACHE_TTL_MS;
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /config: the launcher', () => {
  it('today\'s launchers: the same fab keys, no fabStyleUrl', async () => {
    for (const row of [{}, { fab_shape: 'square' }, { fab_icon: 'headset' }, { fab_icon: 'smile', fab_shape: 'circle', fab_label: 'Hi' }]) {
      const b = await body(fab(row));
      expect(Object.keys(b.fab), JSON.stringify(row)).toEqual(FAB_KEYS);
      expect('fabStyleUrl' in b, JSON.stringify(row)).toBe(false);
      expect(JSON.stringify(b)).not.toContain('runtime-fab');
    }
    const b = await body(fab({ fab_shape: 'square', fab_icon: 'headset' }));
    expect(b.fab).toMatchObject({ shape: 'square', icon: 'headset' });
  });

  it('a value no client may store any more reads as the chat circle', async () => {
    const b = await body(fab({ fab_icon: 'constructor', fab_shape: 'oval' }));
    expect(b.fab).toMatchObject({ icon: 'chat', shape: 'circle' });
    expect('fabStyleUrl' in b).toBe(false);
  });

  it('the pill: its stylesheet, the text it carries; without a text it is a circle', async () => {
    const b = await body(fab({ fab_shape: 'pill', fab_label: 'سؤالی دارید؟ بپرسید' }));
    expect(b.fab).toMatchObject({ shape: 'pill', icon: 'chat', label: 'سؤالی دارید؟ بپرسید' });
    expect(String(b.fabStyleUrl)).toMatch(FAB_URL);
    const bare = await body(fab({ fab_shape: 'pill', fab_label: '' }));
    expect(bare.fab.shape).toBe('circle');
    expect('fabStyleUrl' in bare).toBe(false);
  });

  it.each(['bubble', 'duo'])('%s: its stylesheet, no initial', async (icon) => {
    const b = await body(fab({ fab_icon: icon }));
    expect(b.fab.icon).toBe(icon);
    expect('initial' in b.fab).toBe(false);
    expect(String(b.fabStyleUrl)).toMatch(FAB_URL);
  });

  it('the agent\'s face: the first operator\'s initial (online first), else the workspace\'s', async () => {
    const b = await body(fab({ fab_icon: 'avatar' }));
    expect((b.teamMembers as Array<{ name: string; online: boolean }>)[0]).toMatchObject({ name: 'Sara', online: true });
    expect(b.fab.initial).toBe('S');
    expect(Object.keys(b.fab)).toEqual([...FAB_KEYS.slice(0, 3), 'initial', ...FAB_KEYS.slice(3)]);
    expect(String(b.fabStyleUrl)).toMatch(FAB_URL);
    // A nameless operator is "Operator" in the team stack, and so here.
    const noTeam = await body((t) => {
      fab({ fab_icon: 'avatar', brand_name: 'نیلوفر' })(t);
      (t as Record<string, unknown[]>).workspace_members = [];
    });
    expect(noTeam.teamMembers).toEqual([]);
    expect(noTeam.fab.initial).toBe('ن');
  });

  it('a plan without widget_launcher_icon: the chat circle, no stylesheet', async () => {
    for (const row of [{ fab_icon: 'avatar' }, { fab_shape: 'pill', fab_label: 'Hi' }, { fab_shape: 'square', fab_icon: 'duo' }]) {
      const b = await body(fab(row), { deny: ['widget_launcher_icon'] });
      expect(b.fab, JSON.stringify(row)).toMatchObject({ icon: 'chat', shape: 'circle' });
      expect('fabStyleUrl' in b).toBe(false);
    }
  });

  it('a plan without widget_launcher_label: no text, so no pill', async () => {
    const b = await body(fab({ fab_shape: 'pill', fab_label: 'Hi' }), { deny: ['widget_launcher_label'] });
    expect(b.fab).toMatchObject({ shape: 'circle', label: '' });
    expect('fabStyleUrl' in b).toBe(false);
  });
});

describe('GET /config: the International credit follows the logo direction', () => {
  const catalog = (options: Record<string, unknown> = {}) => (t: Tables) => {
    (t as Record<string, unknown[]>).widget_edition_settings = [{
      edition: 'international',
      chat_templates: { default: 'intl', items: { 't1-intl': { enabled: true, options }, 't2-intl': { enabled: true } } },
    }];
  };
  const wear = (id: string, options: Record<string, unknown> = {}) => (t: Tables) => {
    Object.assign(t.widget_settings[0], { widget_template_id: id, widget_template_options: options });
  };
  const logo = (b: Body) => String(b.poweredBy?.logo);

  it('Thread by default; Open when the template wears it (the workspace\'s or the Super Admin\'s choice)', async () => {
    const thread = await body((t) => { catalog()(t); wear('t1-intl')(t); }, { edition: 'international' });
    expect(thread.templateId).toBe('t1-intl');
    expect(logo(thread)).toBe('https://app.test/brand/intl/respok-thread-horizontal-color.svg');
    const open = await body((t) => { catalog()(t); wear('t1-intl', { logoDirection: 'open' })(t); }, { edition: 'international' });
    expect(open.templateOptions).toMatchObject({ logoDirection: 'open' });
    expect(logo(open)).toBe('https://app.test/brand/intl/respok-open-horizontal-color.svg');
    const brandDefault = await body((t) => { catalog({ logoDirection: 'open' })(t); wear('t1-intl')(t); }, { edition: 'international' });
    expect(logo(brandDefault)).toBe('https://app.test/brand/intl/respok-open-horizontal-color.svg');
    const t2 = await body((t) => { catalog()(t); wear('t2-intl', { logoDirection: 'open' })(t); }, { edition: 'international' });
    expect(logo(t2)).toBe('https://app.test/brand/intl/respok-open-horizontal-color.svg');
  });

  it('intl reads no option: Thread, whatever its row holds', async () => {
    const b = await body((t) => { catalog()(t); wear('intl', { logoDirection: 'open' })(t); }, { edition: 'international' });
    expect(b.templateId).toBe('intl');
    expect(b.templateOptions).toEqual({});
    expect(logo(b)).toBe('https://app.test/brand/intl/respok-thread-horizontal-color.svg');
  });

  it('the Iranian credit is unchanged', async () => {
    const b = await body();
    expect(logo(b)).not.toMatch(/respok/);
  });

  it('the Open lockup is the brand kit\'s, in Ink and Signal, with no font or script', () => {
    const svg = readFileSync(resolve(process.cwd(), 'public/brand/intl/respok-open-horizontal-color.svg'), 'utf8');
    expect(svg).toContain('M41 0A41 41 0 0 1 82 41L82 78Q82 82 78 82L41 82A41 41 0 0 1 0 41A41 41 0 0 1 41 0Z');
    expect(svg).toContain('fill="#FF5A3C"');
    expect(svg).toContain('#16142B');
    expect(svg).not.toMatch(/currentColor|<script|<text|font-family|href=/);
  });
});

// ─── The build ──────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the build hashes runtime-fab.css', () => {
  it.each(['iran', 'respok'])('%s: runtime-fab.<hash>.css is written and named in the manifest', (brand) => {
    const dir = mkdtempSync(join(tmpdir(), `widget-hash-fab-${brand}-`));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(resolve(ROOT, 'scripts/widget-hash.js'), join(dir, 'scripts/widget-hash.js'));
    cpSync(resolve(ROOT, 'scripts/build'), join(dir, 'scripts/build'), { recursive: true });
    cpSync(resolve(ROOT, 'public/widget'), join(dir, 'public/widget'), { recursive: true });
    copyFileSync(resolve(ROOT, 'package.json'), join(dir, 'package.json'));
    symlinkSync(resolve(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    execFileSync(process.execPath, [join(dir, 'scripts/widget-hash.js')], { cwd: dir, env: { ...process.env, VITE_BRAND: brand }, stdio: 'pipe' });
    const dist = join(dir, 'dist/widget');
    const manifest = JSON.parse(readFileSync(join(dist, 'widget-manifest.json'), 'utf8')) as Record<string, string>;
    expect(manifest['runtime-fab.css']).toMatch(/^runtime-fab\.[a-f0-9]{8}\.css$/);
    const shipped = readFileSync(join(dist, manifest['runtime-fab.css']), 'utf8');
    expect(shipped).toContain('.launcher.fx-pill');
    expect(shipped).not.toMatch(/\/\*/);
  }, 120_000);
});
