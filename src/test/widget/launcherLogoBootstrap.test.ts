/**
 * Round 5's two settings end to end (issue #340: g5-1 the launcher's styles,
 * g6b RESPOK's logo direction), every stage its real code, in each brand's
 * build:
 *
 *   the dashboard's choice (shared/launcherStyles.ts launcherChoiceOf and
 *   launcherChoiceFields, what WidgetPage saves; the Super Admin's catalog
 *   PUT) → the real routers (the settings PATCH: its schema, plan guard and
 *   template-option check; PUT /api/admin/widget-catalog) → the stored rows →
 *   GET /config (configSnapshot resolveWidgetConfigBody) → the brand's BUILT
 *   loader.js booted on that body, and the hashed files the body names.
 *
 * The asset names come from the real build: scripts/widget-hash.js on a
 * scratch copy of public/widget per brand, its widget-manifest.json served to
 * the backend as WIDGET_MANIFEST_URL (as in production), so the
 * runtime-fab.css and the skins the bootstrap names are the files the build
 * wrote. The plan is the workspace's entitlements as both the PATCH and
 * /config read them (the same RPC).
 *
 * It proves:
 *  - the pill / the agent's face / the kit: config.fab and config.fabStyleUrl
 *    from what the tile saved, the build's hashed runtime-fab.css (the same
 *    name in both builds), and the loader's classes, texts and its one
 *    request for that very URL; back on the kit, nothing of a style;
 *  - a plan without widget_launcher_icon: the PATCH refuses a style, and a
 *    row that holds one is a chat circle on /config;
 *  - logoDirection: the Super Admin's default (Open) → templateOptions →
 *    lg-open and the Open glyph in RESPOK's loader → the skin the body names
 *    carries the Open art → the Open lockup in poweredBy; the workspace's
 *    Thread tile overrides it all the way; `intl` reads no option; WebYar's
 *    Iranian edition never sees one; the Iran build's loader in the
 *    International edition draws no RESPOK kit (`@intl-kit`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';
import { launcherChoiceFields, launcherChoiceOf, type LauncherTile } from '../../../shared/launcherStyles';
import fa from '@/i18n/locales/fa';
import en from '@/i18n/locales/en';

type Row = Record<string, unknown>;
const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

/**
 * The fake database (widgetConfigFakeDb), whose writes are no-ops, with the
 * two writes this chain makes kept: the settings PATCH's update of the
 * workspace's row and the Super Admin's upsert of the edition's catalog.
 */
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(t: string) {
      const b = holder.db.client.from(t) as Row;
      if (t !== 'widget_settings' && t !== 'widget_edition_settings') return b;
      return new Proxy(b, {
        get(target, prop) {
          if (prop === 'update' && t === 'widget_settings') {
            return (patch: Row) => { Object.assign(holder.db.tables.widget_settings[0], patch); return (target.update as (p: Row) => unknown)(patch); };
          }
          if (prop === 'upsert' && t === 'widget_edition_settings') {
            return (row: Row) => {
              const rows = (holder.db.tables.widget_edition_settings ||= []);
              const at = rows.findIndex((r) => r.edition === row.edition);
              if (at >= 0) rows[at] = { ...row }; else rows.push({ ...row });
              return { select: () => ({ single: async () => ({ data: { ...row }, error: null }) }) };
            };
          }
          return target[prop as string];
        },
      });
    },
    rpc: (f: string, a?: Row) => holder.db.client.rpc(f, a),
  }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'owner-1' }),
  requirePlatformAdmin: async () => 'admin-1',
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({ assertPhoneVerificationSatisfied: async () => {} }));
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({ ...(await orig<object>()), publishCacheInvalidation: () => {} }));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-launcher-logo';
const ROOT = process.cwd();
const BRANDS = ['iran', 'respok'] as const;
type Brand = (typeof BRANDS)[number];
type Edition = 'iran' | 'international';

/** scripts/widget-hash.js on a scratch copy (scripts/build, public/widget), as `npm run build` runs it. */
function buildWidget(brand: Brand): { dir: string; dist: string; manifest: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), `widget-hash-r5-${brand}-`));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(resolve(ROOT, 'scripts/widget-hash.js'), join(dir, 'scripts/widget-hash.js'));
  cpSync(resolve(ROOT, 'scripts/build'), join(dir, 'scripts/build'), { recursive: true });
  cpSync(resolve(ROOT, 'public/widget'), join(dir, 'public/widget'), { recursive: true });
  copyFileSync(resolve(ROOT, 'package.json'), join(dir, 'package.json'));
  symlinkSync(resolve(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(dir, 'scripts/widget-hash.js')], { cwd: dir, env: { ...process.env, VITE_BRAND: brand }, stdio: 'pipe' });
  const dist = join(dir, 'dist/widget');
  return { dir, dist, manifest: JSON.parse(readFileSync(join(dist, 'widget-manifest.json'), 'utf8')) };
}

const builds = {} as Record<Brand, ReturnType<typeof buildWidget>>;
let manifestServer: http.Server;
let apiServer: http.Server;
let snapshot: typeof import('../../../server/services/widget/configSnapshot.js');
let manifestMod: typeof import('../../../server/services/widget/manifest.js');
const serverConfig = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY', supabaseAnonKey: 'anon' };
const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;

beforeAll(async () => {
  for (const brand of BRANDS) builds[brand] = buildWidget(brand);
  manifestServer = http.createServer((rq, rs) => {
    const brand = (rq.url || '').split('/')[1] as Brand;
    if (!builds[brand]) { rs.statusCode = 404; rs.end(); return; }
    rs.setHeader('Content-Type', 'application/json');
    rs.end(readFileSync(join(builds[brand].dist, 'widget-manifest.json')));
  }).listen(0);
  snapshot = await import('../../../server/services/widget/configSnapshot.js');
  manifestMod = await import('../../../server/services/widget/manifest.js');
  const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
  const { adminWidgetCatalogRouter } = await import('../../../server/routes/adminWidgetCatalog.js');
  const app = express();
  app.use((rq, _rs, next) => { Object.assign(rq, { serverConfig }); next(); });
  app.use(express.json());
  app.use('/api/widget-settings', widgetSettingsRouter);
  app.use('/api/admin/widget-catalog', adminWidgetCatalogRouter);
  apiServer = http.createServer(app).listen(0);
}, 120_000);

afterAll(() => {
  manifestServer?.close();
  apiServer?.close();
  delete process.env.WIDGET_MANIFEST_URL;
  for (const brand of BRANDS) if (builds[brand]) rmSync(builds[brand].dir, { recursive: true, force: true });
});

let denied = new Set<string>();
/** A fresh workspace of the edition, its plan granting all but `denied`. */
function workspace(edition: Edition, edit?: (t: Record<string, Row[]>) => void) {
  const tables = widgetScenarioTables({ edition, ai: false, smart: false, locale: edition === 'iran' ? 'fa' : 'en' }) as Record<string, Row[]>;
  Object.assign(tables.widget_settings[0], { fab_shape: 'circle', fab_icon: 'chat', fab_label: null, widget_template_id: null, widget_template_options: {} });
  edit?.(tables);
  holder.db = createFakeDb(tables, {
    rpc: (fn, args) => (fn === 'check_workspace_entitlement' && denied.has(String(args?._feature))
      ? { data: { allowed: false, plan: 'pro', reason: 'feature_disabled' }, error: null }
      : allowAllRpc(fn, args)),
  });
  return tables.widget_settings[0];
}
beforeEach(() => { denied = new Set(); });

async function resetCaches() {
  snapshot.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
}

function call(method: 'PATCH' | 'PUT', path: string, body: unknown): Promise<{ status: number; json: Row }> {
  return new Promise((done, fail) => {
    const payload = JSON.stringify(body);
    const rq = http.request({
      host: '127.0.0.1', port: (apiServer.address() as AddressInfo).port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (rs) => {
      let d = '';
      rs.on('data', (c) => (d += c));
      rs.on('end', () => { try { done({ status: rs.statusCode || 0, json: d ? JSON.parse(d) : {} }); } catch (e) { fail(e); } });
    });
    rq.on('error', fail);
    rq.end(payload);
  });
}
const patch = async (body: Row) => { await resetCaches(); return call('PATCH', `/api/widget-settings/${WS}`, body); };

/** A tile chosen on Widget → Appearance: each column it writes, saved through the PATCH as the page does. */
async function chooseTile(tile: LauncherTile, row: Row, locale: 'fa' | 'en') {
  const pillDefault = (locale === 'fa' ? fa : en).widgetPage.appearance.launcherPillDefault;
  const statuses: number[] = [];
  for (const [field, value] of launcherChoiceFields(launcherChoiceOf(tile, row.fab_label as string | null, pillDefault), row.widget_template_options)) {
    statuses.push((await patch({ [field]: value })).status);
  }
  return statuses;
}

/**
 * GET /config with the brand's build as the backend's manifest (fetched
 * fresh, then the clock held still so its own re-read cannot swap it while
 * the body is built).
 */
async function configBody(brand: Brand, edition: Edition): Promise<Row> {
  await resetCaches();
  process.env.WIDGET_MANIFEST_URL = `http://127.0.0.1:${(manifestServer.address() as AddressInfo).port}/${brand}/widget-manifest.json`;
  const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    manifestMod.invalidateManifestCache();
    manifestMod.getWidgetAssetName('runtime-fab.css');
    await vi.waitFor(() => expect(manifestMod.getManifestDiagnostics().source).toBe(`remote:${process.env.WIDGET_MANIFEST_URL}`), { timeout: 5000 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const out = await snapshot.resolveWidgetConfigBody(serverConfig as never, req, WS, { edition, quotaFull: null });
      expect(out.status).toBe(200);
      expect(manifestMod.getManifestDiagnostics().source).toBe(`remote:${process.env.WIDGET_MANIFEST_URL}`);
      return JSON.parse(JSON.stringify(out.body)) as Row;
    } finally {
      clock.mockRestore();
    }
  } finally {
    quiet.mockRestore();
  }
}

// ─── The brand's built loader on the body /config gave ──────────────────────

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}
/** The backend's own requests (its manifest, on 127.0.0.1) keep the real fetch. */
const realFetch = globalThis.fetch;
async function bootLoader(brand: Brand, body: Row) {
  document.body.innerHTML = '';
  document.querySelectorAll('gs-widget').forEach((n) => n.remove());
  for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete (window as unknown as Row)[key];
  const w = window as unknown as Row;
  w.__gs_id = WS;
  w.__gs_api_base = 'https://api.test';
  w.fetch = vi.fn((url: string, init?: RequestInit) => (String(url).startsWith('http://127.0.0.1:')
    ? realFetch(url, init)
    : Promise.resolve(jsonResponse(
      String(url).includes('/api/widget/bootstrap') ? { session_token: 't', workspace_id: WS, availability: { state: 'online' } }
        : String(url).includes('/api/widget/config') ? body : {},
    ))));
  new Function(readFileSync(join(builds[brand].dist, 'loader.js'), 'utf8')).call(window);
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  const root = document.querySelector('gs-widget')!.shadowRoot!;
  return { root, shell: root.querySelector('.shell') as HTMLElement, launcher: root.querySelector('.launcher') as HTMLButtonElement };
}

const fab = (body: Row) => body.fab as Row;
const url = (brand: Brand, key: string) => `https://app.test/widget/${builds[brand].manifest[key]}`;

// ─── The launcher's style ───────────────────────────────────────────────────

const CASES: Array<{ brand: Brand; edition: Edition; locale: 'fa' | 'en'; kit: string }> = [
  { brand: 'iran', edition: 'iran', locale: 'fa', kit: 'lk-kit' },
  { brand: 'respok', edition: 'international', locale: 'en', kit: 'rpk-kit' },
];

describe('the launcher\'s style: the tile → the PATCH → /config → the built loader and its stylesheet', () => {
  it('the build hashes runtime-fab.css under the same name in both brands (it carries no brand)', () => {
    for (const brand of BRANDS) {
      const name = builds[brand].manifest['runtime-fab.css'];
      expect(name, brand).toMatch(/^runtime-fab\.[a-f0-9]{8}\.css$/);
      expect(existsSync(join(builds[brand].dist, name)), brand).toBe(true);
      expect(readFileSync(join(builds[brand].dist, name), 'utf8')).toContain('.launcher.fx-pill');
    }
    expect(builds.iran.manifest['runtime-fab.css']).toBe(builds.respok.manifest['runtime-fab.css']);
  });

  it.each(CASES)('$brand build, $edition edition: the pill with its default text', async ({ brand, edition, locale, kit }) => {
    const row = workspace(edition);
    expect(await chooseTile('pill', row, locale)).toEqual([200, 200]);
    const text = (locale === 'fa' ? fa : en).widgetPage.appearance.launcherPillDefault;
    expect(row).toMatchObject({ fab_shape: 'pill', fab_icon: 'chat', fab_label: text });

    const body = await configBody(brand, edition);
    expect(fab(body)).toMatchObject({ shape: 'pill', icon: 'chat', label: text });
    expect(body.fabStyleUrl).toBe(url(brand, 'runtime-fab.css'));

    const { root, launcher } = await bootLoader(brand, body);
    const links = root.querySelectorAll('link[data-gs-fab]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(body.fabStyleUrl);
    expect(launcher.className.split(' ')).toEqual(expect.arrayContaining([kit, 'fx', 'fx-chat', 'fx-pill']));
    expect(launcher.getAttribute('data-fx')).toBe(text);
    expect(launcher.getAttribute('aria-label')).toBe(text);
    expect(launcher.dir).toBe(locale === 'fa' ? 'rtl' : 'ltr');
    // Unseen until its stylesheet is in; its text is inside it, no card beside it.
    expect(launcher.style.visibility).toBe('hidden');
    expect(root.querySelector('.gs-fab-label')).toBeNull();
  });

  it.each(CASES)('$brand build, $edition edition: the agent\'s face, then back to the kit', async ({ brand, edition, locale, kit }) => {
    const row = workspace(edition, (t) => { Object.assign(t.widget_settings[0], { fab_label: locale === 'fa' ? 'گفتگو با ما' : 'Chat with us' }); });
    expect(await chooseTile('avatar', row, locale)).toEqual([200, 200]);
    const face = await configBody(brand, edition);
    // Sara is the online operator (widgetConfigFakeDb).
    expect(fab(face)).toMatchObject({ shape: 'circle', icon: 'avatar', initial: 'S' });
    expect(face.fabStyleUrl).toBe(url(brand, 'runtime-fab.css'));
    const styled = await bootLoader(brand, face);
    expect(styled.launcher.className).toContain('fx fx-avatar fx-circle');
    expect(styled.launcher.getAttribute('data-fi')).toBe('S');
    // The card beside it waits with it.
    expect((styled.root.querySelector('.gs-fab-label') as HTMLElement).style.visibility).toBe('hidden');

    expect(await chooseTile('kit', row, locale)).toEqual([200, 200]);
    const plain = await configBody(brand, edition);
    expect(fab(plain)).toMatchObject({ shape: 'circle', icon: 'chat' });
    expect(fab(plain)).not.toHaveProperty('initial');
    expect(plain).not.toHaveProperty('fabStyleUrl');
    const back = await bootLoader(brand, plain);
    expect(back.root.querySelector('link[data-gs-fab]')).toBeNull();
    expect(back.launcher.className).not.toMatch(/\bfx/);
    expect(back.launcher.className).toContain(kit);
    expect(back.launcher.hasAttribute('data-fx')).toBe(false);
    expect(back.launcher.style.visibility).toBe('');
  });

  it('a plan without widget_launcher_icon: no style through the PATCH, and a row that holds one is a chat circle', async () => {
    denied = new Set(['widget_launcher_icon']);
    const row = workspace('iran');
    const refused = await patch({ fab_shape: 'pill' });
    expect(refused.status).toBe(403);
    expect(refused.json.denied).toEqual(['widget_launcher_icon']);
    expect((await patch({ fab_icon: 'duo' })).status).toBe(403);
    expect(row).toMatchObject({ fab_shape: 'circle', fab_icon: 'chat' });
    Object.assign(row, { fab_shape: 'pill', fab_icon: 'bubble', fab_label: 'Hi' });
    const body = await configBody('iran', 'iran');
    expect(fab(body)).toMatchObject({ shape: 'circle', icon: 'chat' });
    expect(body).not.toHaveProperty('fabStyleUrl');
  });
});

// ─── RESPOK's logo direction ────────────────────────────────────────────────

/** The Super Admin enables RESPOK's skins, with the Open logo as the brand's default for t1-intl. */
async function superAdminCatalog() {
  await resetCaches();
  const res = await call('PUT', '/api/admin/widget-catalog', {
    defaultId: 'intl',
    templates: [
      { id: 'intl', enabled: true },
      { id: 't1-intl', enabled: true, options: { logoDirection: 'open' } },
      { id: 't2-intl', enabled: true },
    ],
  });
  expect(res.status).toBe(200);
  const t1i = (res.json.templates as Row[]).find((t) => t.id === 't1-intl')!;
  expect(t1i).toMatchObject({ enabled: true, options: { logoDirection: 'open' }, optionSpec: { logoDirection: ['thread', 'open'] } });
}

const OPEN_LOCKUP = 'https://app.test/brand/intl/respok-open-horizontal-color.svg';
const THREAD_LOCKUP = 'https://app.test/brand/intl/respok-thread-horizontal-color.svg';

describe('the logo direction: the catalog → templateOptions → the loader, the skin\'s art and the credit', () => {
  it('the Super Admin\'s Open, then the workspace\'s Thread tile, then intl', async () => {
    const row = workspace('international');
    await superAdminCatalog();
    expect((await patch({ widget_template_id: 't1-intl' })).status).toBe(200);

    // The brand's default reaches the visitor.
    const open = await configBody('respok', 'international');
    expect(open).toMatchObject({ templateId: 't1-intl', templateOptions: { logoDirection: 'open' } });
    expect((open.poweredBy as Row).logo).toBe(OPEN_LOCKUP);
    expect(existsSync(resolve(ROOT, 'public/brand/intl/respok-open-horizontal-color.svg'))).toBe(true);
    // The skin the body names is the build's, and draws the Open art under .lg-open.
    expect(open.presentationSkinUrl).toBe(url('respok', 'presentation-t1-intl.css'));
    const skin = readFileSync(join(builds.respok.dist, builds.respok.manifest['presentation-t1-intl.css']), 'utf8');
    expect(skin).toMatch(/\.lg-open [^{]*\{[^}]*--mk:/);
    const openLoader = await bootLoader('respok', open);
    expect(openLoader.shell.classList.contains('lg-open')).toBe(true);
    expect(openLoader.shell.classList.contains('lg-thread')).toBe(false);
    expect(openLoader.launcher.querySelector('svg.chat-icon.rpk-kit-glyph.rpk-kit-o')!.getAttribute('viewBox')).toBe('0 0 108 108');

    // The workspace picks RESPOK's Thread tile: its own option wins everywhere.
    expect(await chooseTile('thread', row, 'en')).toEqual([200, 200, 200]);
    expect(row.widget_template_options).toEqual({ logoDirection: 'thread' });
    const thread = await configBody('respok', 'international');
    expect(thread.templateOptions).toMatchObject({ logoDirection: 'thread' });
    expect((thread.poweredBy as Row).logo).toBe(THREAD_LOCKUP);
    const threadLoader = await bootLoader('respok', thread);
    expect(threadLoader.shell.classList.contains('lg-thread')).toBe(true);
    expect(threadLoader.shell.classList.contains('lg-open')).toBe(false);
    expect(threadLoader.launcher.querySelector('svg.chat-icon.rpk-kit-glyph')!.getAttribute('viewBox')).toBe('0 0 104 92');

    // t2-intl reads it too (the workspace's Open this time).
    expect((await patch({ widget_template_id: 't2-intl', widget_template_options: { logoDirection: 'open' } })).status).toBe(200);
    const t2 = await configBody('respok', 'international');
    expect(t2).toMatchObject({ templateId: 't2-intl', templateOptions: { logoDirection: 'open' } });
    expect((t2.poweredBy as Row).logo).toBe(OPEN_LOCKUP);
    expect(t2.presentationSkinUrl).toBe(url('respok', 'presentation-t2-intl.css'));
    expect((await bootLoader('respok', t2)).shell.classList.contains('lg-open')).toBe(true);

    // Back to the edition's default, intl: it reads no option, whatever the row holds.
    expect((await patch({ widget_template_id: null })).status).toBe(200);
    const intl = await configBody('respok', 'international');
    expect(intl).toMatchObject({ templateId: 'intl', templateOptions: {} });
    expect((intl.poweredBy as Row).logo).toBe(THREAD_LOCKUP);
    expect((await bootLoader('respok', intl)).shell.classList.contains('lg-thread')).toBe(true);
  });

  it('an invalid direction is refused by name, and the row keeps what it had', async () => {
    const row = workspace('international');
    await superAdminCatalog();
    const res = await patch({ widget_template_options: { logoDirection: 'sideways' } });
    expect(res.status).toBe(400);
    expect((res.json.issues as Row[])[0].path).toBe('widget_template_options.logoDirection');
    expect(row.widget_template_options).toEqual({});
  });

  it('the Iran build\'s loader in the International edition: no RESPOK kit, no lg-* (the credit is the server\'s)', async () => {
    workspace('international');
    await superAdminCatalog();
    expect((await patch({ widget_template_id: 't1-intl' })).status).toBe(200);
    const body = await configBody('iran', 'international');
    expect(body.templateOptions).toMatchObject({ logoDirection: 'open' });
    const { root, shell, launcher } = await bootLoader('iran', body);
    expect(shell.className).not.toMatch(/lg-/);
    expect(launcher.className).not.toMatch(/rpk-kit|lk-kit/);
    expect(root.querySelector('style[data-rpk-kit]')).toBeNull();
    expect(launcher.querySelector('svg.chat-icon')!.getAttribute('viewBox')).toBe('0 0 24 24');
    expect((body.poweredBy as Row).logo).toBe(OPEN_LOCKUP);
  });

  it('WebYar\'s Iranian edition: t1 reads no logo direction, and its shell has no lg-* class', async () => {
    workspace('iran', (t) => {
      t.widget_edition_settings = [{ edition: 'iran', chat_templates: { default: 'default', items: { t1: { enabled: true } } } }];
      Object.assign(t.widget_settings[0], { widget_template_id: 't1', widget_template_options: { logoDirection: 'open' } });
    });
    const body = await configBody('iran', 'iran');
    expect(body.templateId).toBe('t1');
    expect(body.templateOptions).not.toHaveProperty('logoDirection');
    expect(JSON.stringify(body.poweredBy)).not.toMatch(/respok/);
    const { shell, launcher } = await bootLoader('iran', body);
    expect(shell.className).not.toMatch(/lg-/);
    expect(launcher.className).toContain('lk-kit');
  });
});
