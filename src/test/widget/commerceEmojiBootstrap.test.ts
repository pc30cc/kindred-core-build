/**
 * Round 4's two bootstrap keys end to end (issue #340 g3 track order, g5-2c
 * emoji search): `config.commerce.trackOrder` and `config.modules.emoji`
 * as the REAL widget config (server/services/widget/configSnapshot.ts
 * resolveWidgetConfigBody, what /config and /bootstrap answer) emits them,
 * handed whole to the SHIPPED widget (runtime.js, runtime-ext.js,
 * runtime-late.js, the real t1 / t2 / default renderers and extras,
 * coreFeaturesHarness.ts), the way the loader hands its config over.
 *
 * The asset names come from the REAL build: scripts/widget-hash.js run on a
 * scratch copy of public/widget for each brand (iran, respok), its
 * widget-manifest.json served to the backend as WIDGET_MANIFEST_URL (the
 * frontend-built manifest the backend reads in production), so the
 * runtime-emoji.js the bootstrap names is the very file the build wrote.
 *
 * It proves:
 *  - t2 with a store that answers order questions: `commerce: {trackOrder:
 *    true}` and the home's track-order row that sends «پیگیری سفارشم»; t1
 *    carries the key and draws no row; `default` neither;
 *  - `modules.emoji` only for Core-features templates, the build's hashed
 *    file (no `?v=`), the URL t1's picker search loads on its first use;
 *    `default` names none and never loads it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';
import { boot, click, flush, resetWindow, typeInto } from './coreFeaturesHarness';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-commerce-emoji';
const ROOT = process.cwd();
const BRANDS = ['iran', 'respok'] as const;
type Brand = (typeof BRANDS)[number];
type Row = Record<string, unknown>;

/** scripts/widget-hash.js on a scratch copy (scripts/build, public/widget), as `npm run build` runs it. */
function buildWidget(brand: Brand): { dir: string; dist: string; manifest: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), `widget-hash-${brand}-`));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(resolve(ROOT, 'scripts/widget-hash.js'), join(dir, 'scripts/widget-hash.js'));
  cpSync(resolve(ROOT, 'scripts/build'), join(dir, 'scripts/build'), { recursive: true });
  cpSync(resolve(ROOT, 'public/widget'), join(dir, 'public/widget'), { recursive: true });
  copyFileSync(resolve(ROOT, 'package.json'), join(dir, 'package.json'));
  symlinkSync(resolve(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_BRAND: brand };
  execFileSync(process.execPath, [join(dir, 'scripts/widget-hash.js')], { cwd: dir, env, stdio: 'pipe' });
  const dist = join(dir, 'dist/widget');
  return { dir, dist, manifest: JSON.parse(readFileSync(join(dist, 'widget-manifest.json'), 'utf8')) };
}

const CATALOG = { default: 'default', items: { t1: { enabled: true }, t2: { enabled: true } } };
const WOO: Row = {
  id: 'conn-woo', workspace_id: WS, installation_id: 'inst-woo', provider_type: 'woocommerce', store_id: 'https://shop.example',
  approved_origin: 'https://shop.example', capabilities: ['store.read', 'products.read', 'orders.read', 'tracking.read'],
  permissions: { orders: true, customer_history: true, order_status: true, tracking: true, products: true },
  health: 'connected', catalog_ready: true, revoked_at: null, protocol_version: 'webyar-commerce/1', created_at: '2026-01-01',
};
const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;

const builds = {} as Record<Brand, ReturnType<typeof buildWidget>>;
/** The config body per brand's manifest and template, built before any widget runs (it replaces `fetch`). */
const bodies = {} as Record<Brand, Record<'default' | 't1' | 't2', Row>>;
let manifestServer: http.Server | null = null;

beforeAll(async () => {
  for (const brand of BRANDS) builds[brand] = buildWidget(brand);
  // The frontend's manifest, as the backend fetches it (WIDGET_MANIFEST_URL).
  manifestServer = http.createServer((rq, rs) => {
    const brand = (rq.url || '').split('/')[1] as Brand;
    if (!builds[brand]) { rs.statusCode = 404; rs.end(); return; }
    rs.setHeader('Content-Type', 'application/json');
    rs.end(readFileSync(join(builds[brand].dist, 'widget-manifest.json')));
  }).listen(0);
  const port = (manifestServer.address() as AddressInfo).port;

  const snapshot = await import('../../../server/services/widget/configSnapshot.js');
  const manifest = await import('../../../server/services/widget/manifest.js');
  const now = Date.now();
  // The manifest's own 2 s re-read is held still while the bodies are built
  // (and its "loaded from" lines kept out of the test output).
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const brand of BRANDS) {
    process.env.WIDGET_MANIFEST_URL = `http://127.0.0.1:${port}/${brand}/widget-manifest.json`;
    manifest.invalidateManifestCache();
    manifest.getWidgetAssetName('runtime-emoji.js');
    await vi.waitFor(() => expect(manifest.getManifestDiagnostics().source).toBe(`remote:${process.env.WIDGET_MANIFEST_URL}`), { timeout: 5000 });
    bodies[brand] = {} as Record<'default' | 't1' | 't2', Row>;
    for (const template of ['default', 't1', 't2'] as const) {
      const tables = widgetScenarioTables({ edition: 'iran', ai: false, smart: false }) as Record<string, Row[]>;
      tables.widget_edition_settings = [{ edition: 'iran', chat_templates: CATALOG }];
      Object.assign(tables.widget_settings[0], { widget_template_id: template, widget_template_options: {} });
      tables.commerce_connections = [{ ...WOO }];
      holder.db = createFakeDb(tables, { rpc: allowAllRpc });
      snapshot.__resetWidgetConfigCachesForTests();
      (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
      (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
      const out = await snapshot.resolveWidgetConfigBody(config, req, WS, { edition: 'iran', quotaFull: null });
      expect(out.status).toBe(200);
      bodies[brand][template] = JSON.parse(JSON.stringify(out.body));
    }
    expect(manifest.getManifestDiagnostics().source).toBe(`remote:${process.env.WIDGET_MANIFEST_URL}`);
  }
  clock.mockRestore();
  quiet.mockRestore();
  delete process.env.WIDGET_MANIFEST_URL;
  manifest.invalidateManifestCache();
}, 120_000);

afterAll(() => {
  manifestServer?.close();
  for (const brand of BRANDS) if (builds[brand]) rmSync(builds[brand].dir, { recursive: true, force: true });
});

const modulesOf = (body: Row) => (body.modules || {}) as Record<string, string>;

describe('the build names runtime-emoji.js; the bootstrap names the build\'s file', () => {
  it.each(BRANDS)('%s: the manifest\'s hashed runtime-emoji.js is written, and is modules.emoji of t1 and t2', async (brand) => {
    const { dist, manifest } = builds[brand];
    const hashed = manifest['runtime-emoji.js'];
    expect(hashed).toMatch(/^runtime-emoji\.[a-f0-9]{8}\.js$/);
    expect(existsSync(join(dist, hashed))).toBe(true);
    // The shipped bytes: the source through the brand's transform (esbuild runs in node, not here).
    const shipped = execFileSync(process.execPath, [resolve(ROOT, 'scripts/build/widgetBrand.mjs'), brand, resolve(ROOT, 'public/widget/runtime-emoji.js')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(readFileSync(join(dist, hashed), 'utf8')).toBe(shipped);
    for (const template of ['t1', 't2'] as const) {
      // A content hash is its own version: no `?v=`.
      expect(modulesOf(bodies[brand][template]).emoji).toBe(`https://app.test/widget/${hashed}`);
    }
    expect(modulesOf(bodies[brand].default)).not.toHaveProperty('emoji');
  });

  it('the file carries no brand: both builds give it the same name', () => {
    expect(builds.iran.manifest['runtime-emoji.js']).toBe(builds.respok.manifest['runtime-emoji.js']);
  });

  it('the other round-4 modules come from the same manifest (ext, late, extras of t1 / t2; none for default)', () => {
    for (const brand of BRANDS) {
      const m = builds[brand].manifest;
      expect(modulesOf(bodies[brand].t2)).toMatchObject({
        ext: `https://app.test/widget/${m['runtime-ext.js']}`, late: `https://app.test/widget/${m['runtime-late.js']}`,
        extras: `https://app.test/widget/${m['presentation-t2-x.js']}`, emoji: `https://app.test/widget/${m['runtime-emoji.js']}`,
      });
      expect(modulesOf(bodies[brand].t1).extras).toBe(`https://app.test/widget/${m['presentation-t1-x.js']}`);
      expect(Object.keys(modulesOf(bodies[brand].default)).filter((k) => ['ext', 'late', 'extras', 'emoji'].includes(k))).toEqual([]);
    }
  });
});

/**
 * The shipped widget on a config body, as the loader hands it over (plus its
 * own private fields). What round 4 does not touch is set to a plain open
 * chat: no pre-chat form, the team online (the scenario's hours say away).
 */
const OPEN_CHAT = {
  preChat: { name: { enabled: false }, email: { enabled: false }, phone: { enabled: false } },
  availability: { state: 'online', reason: 'within_hours', next_open_at: null, offline_mode: 'capture_message' },
};
function widget(renderer: 'default' | 't1' | 't2', body: Row) {
  resetWindow();
  return boot({ renderer, config: { ...body, ...OPEN_CHAT } });
}
async function online(h: ReturnType<typeof boot>) {
  await flush(40);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
}

describe('config.commerce: emitted where the widget reads it', () => {
  it('t2: {trackOrder: true} right after templateOptions, and the home row it draws sends «پیگیری سفارشم»', async () => {
    const body = bodies.iran.t2;
    expect(body.commerce).toEqual({ trackOrder: true });
    const keys = Object.keys(body);
    expect(keys[keys.indexOf('templateOptions') + 1]).toBe('commerce');
    const h = widget('t2', body);
    await online(h);
    const row = h.q('[data-home-action="track-order"]')!;
    expect(row.getAttribute('data-topic')).toBe('پیگیری سفارشم');
    click(row);
    await flush(30);
    expect(h.posts.filter((p) => p.url === 'chat:sendMessage').map((p) => p.body.text)).toEqual(['پیگیری سفارشم']);
  });

  it('t2 without the key (no store): no row', async () => {
    const { commerce: _c, ...body } = bodies.iran.t2;
    const h = widget('t2', body);
    await online(h);
    expect(h.q('[data-home-action="track-order"]')).toBeNull();
  });

  it('t1 carries the key and draws no row; default has neither', async () => {
    expect(bodies.iran.t1.commerce).toEqual({ trackOrder: true });
    const t1 = widget('t1', bodies.iran.t1);
    await online(t1);
    expect(t1.q('[data-home-action="track-order"]')).toBeNull();
    expect(bodies.iran.default).not.toHaveProperty('commerce');
    const d = widget('default', bodies.iran.default);
    await online(d);
    expect(d.q('[data-home-action="track-order"]')).toBeNull();
  });
});

describe('config.modules.emoji: the URL the picker\'s search loads', () => {
  it('t1: nothing until the search is used, then exactly modules.emoji', async () => {
    const body = bodies.iran.t1;
    const h = widget('t1', body);
    await online(h);
    h.runtime.setTab('chat');
    await flush(30);
    click(h.q('[data-emoji-btn]'));
    await flush(10);
    const field = h.q<HTMLInputElement>('[data-emoji-picker] [data-emoji-search]')!;
    expect(h.scripts.filter((s) => /runtime-emoji/.test(s))).toEqual([]);
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    typeInto(field, 'heart');
    await flush(20);
    expect(h.scripts.filter((s) => /runtime-emoji/.test(s))).toEqual([modulesOf(body).emoji]);
    // The module the URL loaded answers the search.
    const shown = Array.from(h.q('[data-emoji-picker]')!.querySelectorAll('[data-emoji]:not([hidden])')).map((b) => b.getAttribute('data-emoji'));
    expect(shown).toContain('❤️');
  });

  it('default: no field, no request, whatever is typed', async () => {
    const h = widget('default', bodies.iran.default);
    await online(h);
    h.runtime.setTab('chat');
    await flush(30);
    expect(h.q('[data-emoji-search]')).toBeNull();
    typeInto(h.q<HTMLTextAreaElement>('[data-msg-input]')!, 'heart');
    await flush(10);
    expect(h.scripts.filter((s) => /runtime-emoji/.test(s))).toEqual([]);
  });
});
