/**
 * The call widget's load chain in a page (jsdom): l.js as the build ships it
 * (scripts/call-widget-hash.js), the raw l.js the API image serves, and the
 * presentation's createHost.
 *
 *  - A built l.js starts the registry, the presentation and the runtime at
 *    once, by this build's hashed names, as ordered (`async = false`) head
 *    scripts, in parallel with the bootstrap; it mounts when both are done.
 *  - No stylesheet goes into the page's head: the two stylesheets are linked
 *    in the shadow root only (hashed names), the host hidden until they load.
 *  - A hashed file that is not there (a stale l.js, a rolling deploy) sends
 *    the loader back to the fixed names with a per-load token.
 *  - The raw l.js has no build names: it waits for the bootstrap and loads
 *    the fixed names with `?v=<assets_version>`, without a per-load token.
 *  - A bootstrap that says "off" is remembered (`ccw_off:`): the next page
 *    view downloads nothing until the bootstrap says the widget is on.
 *  - A rate limit, a server error or no answer is asked again once, after
 *    Retry-After (at most 10 s) plus jitter; then the loader gives up quietly.
 *  - The media SDK by the chat widget's hashed name, the fixed name if that
 *    fails; concurrent requests share one load.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildCallWidget, FONTS_NAME, ROOT, type CallWidgetBuild } from './callWidgetBuildFixture';

const WS = '22222222-2222-4222-8222-222222222222';
const ASSETS = 'https://app.example';
const API = 'https://api.example';
const RAW_LOADER = readFileSync(resolve(ROOT, 'public/call-widget/l.js'), 'utf8');

type Win = Window & typeof globalThis & {
  eval(code: string): unknown;
  CallCenterWidget?: { mount: ReturnType<typeof vi.fn> };
  fetch: unknown;
};
type ScriptEl = HTMLScriptElement & { onload: (() => void) | null; onerror: (() => void) | null };

function page() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://shop.example/page', runScripts: 'outside-only' });
  const win = dom.window as unknown as Win;
  let answer: ((r: unknown) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  win.fetch = (url: string, init: RequestInit) => {
    fetches.push({ url, init });
    return new Promise((res, rej) => { answer = res; fail = rej; });
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const respond = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    answer!({
      ok: status >= 200 && status < 300,
      status,
      json: () => (body === undefined ? Promise.reject(new SyntaxError('not JSON')) : Promise.resolve(body)),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    });
    await flush();
  };
  const networkError = async () => { fail!(new TypeError('Failed to fetch')); await flush(); };
  /** The page's timers (the loader's retry), run by hand. */
  const timers: Array<{ fn: () => void; ms: number }> = [];
  (win as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  /** Runs a loader as the customer's snippet would, from ASSETS. */
  const run = (code: string) => {
    (win as unknown as Record<string, unknown>).__CC_WIDGET_LOADED__ = undefined;
    const tag = win.document.createElement('script');
    tag.setAttribute('src', `${ASSETS}/call-widget/l.js`);
    tag.setAttribute('workspace-id', WS);
    tag.setAttribute('api-base', API);
    win.document.head.appendChild(tag);
    win.eval(code);
  };
  const scripts = () => [...win.document.head.querySelectorAll('script:not([workspace-id])')] as ScriptEl[];
  const stylesheets = () => [...win.document.head.querySelectorAll('link[rel="stylesheet"]')] as HTMLLinkElement[];
  /** The runtime's global, as runtime.js would define it once it ran. */
  const runtime = () => {
    const mount = vi.fn();
    win.CallCenterWidget = { mount };
    return mount;
  };
  return { dom, win, fetches, respond, networkError, timers, run, scripts, stylesheets, runtime };
}

const bootstrap = (extra: Record<string, unknown> = {}) => ({
  status: 'ok',
  session: 'sess',
  assets_version: 'abc123def456',
  assets: {
    font_style_url: '/widget/presentation-default-fonts.fromapi.css',
    presentation_registry_url: '/call-widget/presentation-registry.js',
    presentation_script_url: '/call-widget/presentation-default.js',
    presentation_style_url: '/call-widget/presentation-default.css',
  },
  ...extra,
});

describe('the built l.js', () => {
  let build: CallWidgetBuild;
  beforeAll(() => { build = buildCallWidget(null); }, 60_000);
  afterAll(() => build?.cleanup());
  const hashed = (name: string) => `${ASSETS}/call-widget/${build.manifest.files[name]}`;

  it('starts the three scripts by hashed name, ordered, before the bootstrap answers; no head stylesheet', async () => {
    const p = page();
    p.run(build.loader);
    expect(p.fetches.map((f) => f.url)).toEqual([`${API}/api/call-widget/bootstrap?workspaceId=${WS}`]);
    expect(p.fetches[0].init.credentials).toBe('include');
    const s = p.scripts();
    expect(s.map((el) => el.src)).toEqual([
      hashed('presentation-registry.js'),
      hashed('presentation-default.js'),
      hashed('runtime.js'),
    ]);
    for (const el of s) expect(el.async).toBe(false);
    expect(p.stylesheets()).toEqual([]);
    expect(s.every((el) => !/[?&]t=/.test(el.src))).toBe(true);
  });

  it('mounts once both the scripts and the bootstrap are in, with the build\'s asset and font URLs', async () => {
    const p = page();
    p.run(build.loader);
    const mount = p.runtime();
    const s = p.scripts();
    s[0].onload!(); s[1].onload!();
    await p.respond(200, bootstrap());
    expect(mount).not.toHaveBeenCalled(); // runtime.js has not run yet
    s[2].onload!();
    expect(mount).toHaveBeenCalledTimes(1);
    const opts = mount.mock.calls[0][0];
    expect(opts.apiBase).toBe(API);
    expect(opts.origin).toBe(ASSETS);
    expect(opts.bootstrap.session).toBe('sess');
    expect(opts.runtimeAssetSuffix).toBe('?v=abc123def456');
    expect(opts.assetUrl('/call-widget/runtime.css')).toBe(hashed('runtime.css'));
    expect(opts.assetUrl('/call-widget/presentation-intl.css')).toBe(hashed('presentation-intl.css'));
    expect(opts.fontsUrl).toBe(`${ASSETS}/widget/${FONTS_NAME}`);
    expect(typeof opts.loadLiveKitSdk).toBe('function');
    expect(p.scripts()).toHaveLength(3); // nothing requested twice
    expect(p.stylesheets()).toEqual([]);
    // The media SDK only on demand, by its hashed name, in head.
    const ready = vi.fn();
    opts.loadLiveKitSdk(ready);
    const lk = p.win.document.head.querySelector('script[data-cc-livekit-sdk]') as HTMLScriptElement;
    expect(lk.src).toBe(`${ASSETS}${build.manifest.livekit}`);
  });

  it('mounts when the bootstrap is the last to arrive', async () => {
    const p = page();
    p.run(build.loader);
    const mount = p.runtime();
    for (const el of p.scripts()) el.onload!();
    expect(mount).not.toHaveBeenCalled();
    await p.respond(200, bootstrap());
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('falls back to the fixed names with a per-load token when a hashed file is missing', async () => {
    const p = page();
    p.run(build.loader);
    const mount = p.runtime();
    const [registry, presentation, rt] = p.scripts();
    await p.respond(200, bootstrap());
    registry.onerror!(); // another build's name: a 404
    presentation.onload!();
    expect(p.scripts()).toHaveLength(3);
    rt.onload!();
    expect(mount).not.toHaveBeenCalled();
    const retry = p.scripts().slice(3);
    expect(retry.map((el) => el.src.replace(/&t=\d+$/, '&t=N'))).toEqual([
      `${ASSETS}/call-widget/presentation-registry.js?v=abc123def456&t=N`,
      `${ASSETS}/call-widget/presentation-default.js?v=abc123def456&t=N`,
      `${ASSETS}/call-widget/runtime.js?v=abc123def456&t=N`,
    ]);
    for (const el of retry) expect(el.async).toBe(false);
    for (const el of retry) el.onload!();
    expect(mount).toHaveBeenCalledTimes(1);
    const opts = mount.mock.calls[0][0];
    expect(opts.runtimeAssetSuffix).toMatch(/^\?v=abc123def456&t=\d+$/);
    expect(opts.assetUrl('/call-widget/runtime.css')).toBe(`${ASSETS}/call-widget/runtime.css${opts.runtimeAssetSuffix}`);
    expect(opts.fontsUrl).toBeNull(); // the bootstrap's font_style_url then
    opts.loadLiveKitSdk(() => {});
    const lk = p.win.document.head.querySelector('script[data-cc-livekit-sdk]') as HTMLScriptElement;
    expect(lk.src).toBe(`${ASSETS}/call-widget/vendor/livekit-client.umd.min.js`);
  });

  it('sends the active call it remembers', () => {
    const p = page();
    p.win.sessionStorage.setItem(`ccw_active_call_session:${WS}:${API}`, 'call-token');
    p.run(build.loader);
    expect((p.fetches[0].init.headers as Record<string, string>)['x-cc-active-call']).toBe('call-token');
  });

  it('remembers "off" and then downloads nothing until the bootstrap says on', async () => {
    const p = page();
    const flag = `ccw_off:${WS}:${API}`;
    p.run(build.loader);
    expect(p.scripts()).toHaveLength(3);
    await p.respond(200, { status: 'disabled', reason: 'workspace_disabled', message: null });
    expect(p.win.localStorage.getItem(flag)).toBe('1');

    // Next page view: no script before the bootstrap answers.
    const q = page();
    q.win.localStorage.setItem(flag, '1');
    q.run(build.loader);
    expect(q.scripts()).toHaveLength(0);
    const mount = q.runtime();
    await q.respond(200, bootstrap());
    expect(q.win.localStorage.getItem(flag)).toBeNull();
    const s = q.scripts();
    expect(s.map((el) => el.src)).toEqual([
      hashed('presentation-registry.js'),
      hashed('presentation-default.js'),
      hashed('runtime.js'),
    ]);
    for (const el of s) el.onload!();
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, { status: 'error', reason: 'origin_denied' }, '1'],
    [404, { error: 'workspace_not_found' }, '1'],
    [429, { error: 'rate_limited' }, null],
    [500, { error: 'internal' }, null],
    [503, { error: 'unavailable' }, null],
  ])('a %i bootstrap: remembered as off = %j', async (status, body, expected) => {
    const p = page();
    p.run(build.loader);
    await p.respond(status, body);
    if (p.timers.length) { p.timers[0].fn(); await p.respond(status, body); } // the one retry
    expect(p.win.localStorage.getItem(`ccw_off:${WS}:${API}`)).toBe(expected);
  });

  it('asks again once after a rate limit, after Retry-After plus jitter, then mounts', async () => {
    const p = page();
    p.run(build.loader);
    const mount = p.runtime();
    for (const el of p.scripts()) el.onload!();
    await p.respond(429, { error: 'Too many requests. Please retry shortly.' }, { 'retry-after': '3' });
    expect(p.fetches).toHaveLength(1);
    expect(p.timers).toHaveLength(1);
    expect(p.timers[0].ms).toBeGreaterThanOrEqual(3000);
    expect(p.timers[0].ms).toBeLessThan(3500);
    p.timers[0].fn();
    expect(p.fetches).toHaveLength(2);
    await p.respond(200, bootstrap());
    expect(mount).toHaveBeenCalledTimes(1);
    expect(p.win.localStorage.getItem(`ccw_off:${WS}:${API}`)).toBeNull();
  });

  it('waits at most 10 s, 2 s when the server names no time, and asks only once', async () => {
    const p = page();
    p.run(build.loader);
    await p.respond(429, { retry_after: 120 });
    expect(p.timers[0].ms).toBeGreaterThanOrEqual(10000);
    expect(p.timers[0].ms).toBeLessThan(10500);
    p.timers[0].fn();
    await p.respond(503, undefined); // not even JSON
    expect(p.fetches).toHaveLength(2);
    expect(p.timers).toHaveLength(1); // given up, quietly
    expect(p.win.localStorage.getItem(`ccw_off:${WS}:${API}`)).toBeNull();

    const q = page();
    q.run(build.loader);
    await q.networkError();
    expect(q.timers).toHaveLength(1);
    expect(q.timers[0].ms).toBeGreaterThanOrEqual(2000);
    expect(q.timers[0].ms).toBeLessThan(2500);
    q.timers[0].fn();
    expect(q.fetches).toHaveLength(2);
    await q.networkError();
    expect(q.timers).toHaveLength(1);
  });

  it('does not ask again when the widget is off', async () => {
    const p = page();
    p.run(build.loader);
    await p.respond(200, { status: 'disabled', reason: 'workspace_disabled', message: null });
    expect(p.timers).toHaveLength(0);
    expect(p.fetches).toHaveLength(1);
  });

  it('loads the media SDK by the chat widget\'s hashed name, the fixed name if that fails, once for every caller', async () => {
    const p = page();
    p.run(build.loader);
    const mount = p.runtime();
    for (const el of p.scripts()) el.onload!();
    await p.respond(200, bootstrap());
    const { loadLiveKitSdk } = mount.mock.calls[0][0];
    const a = vi.fn();
    const b = vi.fn();
    loadLiveKitSdk(a);
    loadLiveKitSdk(b);
    const sdk = () => [...p.win.document.head.querySelectorAll('script[data-cc-livekit-sdk]')] as ScriptEl[];
    expect(sdk().map((el) => el.src)).toEqual([`${ASSETS}${build.manifest.livekit}`]);
    expect(build.manifest.livekit).toMatch(/^\/widget\/vendor\/livekit-client\.umd\.min\.[a-f0-9]{8}\.js$/);
    sdk()[0].onerror!(); // the other container during a rolling deploy
    expect(a).not.toHaveBeenCalled();
    expect(sdk().map((el) => el.src)).toEqual([`${ASSETS}/call-widget/vendor/livekit-client.umd.min.js`]);
    (p.win as unknown as { LivekitClient: object }).LivekitClient = {};
    sdk()[0].onload!();
    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
    const c = vi.fn();
    loadLiveKitSdk(c);
    expect(c).toHaveBeenCalledWith(true);
    expect(sdk()).toHaveLength(1);
  });
});

describe('the raw l.js (the API image, dev)', () => {
  it('waits for the bootstrap, then loads the fixed names versioned by assets_version, without a per-load token', async () => {
    const p = page();
    p.run(RAW_LOADER);
    expect(p.scripts()).toHaveLength(0);
    const mount = p.runtime();
    await p.respond(200, bootstrap());
    const s = p.scripts();
    expect(s.map((el) => el.src)).toEqual([
      `${ASSETS}/call-widget/presentation-registry.js?v=abc123def456`,
      `${ASSETS}/call-widget/presentation-default.js?v=abc123def456`,
      `${ASSETS}/call-widget/runtime.js?v=abc123def456`,
    ]);
    for (const el of s) expect(el.async).toBe(false);
    expect(p.stylesheets()).toEqual([]);
    for (const el of s) el.onload!();
    const opts = mount.mock.calls[0][0];
    expect(opts.runtimeAssetSuffix).toBe('?v=abc123def456');
    expect(opts.assetUrl('/call-widget/runtime.css')).toBe(`${ASSETS}/call-widget/runtime.css?v=abc123def456`);
    expect(opts.fontsUrl).toBeNull();
  });

  it('loads the template the bootstrap names', async () => {
    const p = page();
    p.run(RAW_LOADER);
    await p.respond(200, bootstrap({
      assets: { presentation_registry_url: '/call-widget/presentation-registry.js', presentation_script_url: '/call-widget/presentation-other.js' },
    }));
    expect(p.scripts().map((el) => el.src)[1]).toBe(`${ASSETS}/call-widget/presentation-other.js?v=abc123def456`);
  });
});

// ─── createHost (presentation-default.js) ───────────────────────────────────

type Link = HTMLLinkElement & { onload: (() => void) | null; onerror: (() => void) | null };
function host(context: Record<string, unknown>, timers?: Array<{ fn: () => void; ms: number }>) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://shop.example/page', runScripts: 'outside-only' });
  const win = dom.window as unknown as Win & { CallWidgetPresentations: { resolve(id: string): { createHost(c: unknown): { host: HTMLElement } } } };
  if (timers) (win as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  win.eval(readFileSync(resolve(ROOT, 'public/call-widget/presentation-registry.js'), 'utf8'));
  win.eval(readFileSync(resolve(ROOT, 'public/call-widget/presentation-default.js'), 'utf8'));
  const { host: el } = win.CallWidgetPresentations.resolve('default').createHost({
    origin: ASSETS,
    runtimeAssetSuffix: '?v=abc123def456',
    bootstrap: bootstrap({ assets: { ...bootstrap().assets, presentation_style_url: '/call-widget/presentation-intl.css' } }),
    ...context,
  });
  const links = () => [...el.shadowRoot!.querySelectorAll('link')] as Link[];
  return { win, el, links };
}

describe('createHost', () => {
  const assetUrl = (path: string) => `${ASSETS}/call-widget/${path.split('/').pop()!.replace(/\.(css|js)$/, '.0123456789ab.$1')}`;

  it('links the hashed stylesheets in the shadow root only, hidden until both have loaded', () => {
    const h = host({ assetUrl, fontsUrl: `${ASSETS}/widget/${FONTS_NAME}` });
    expect(h.links().map((l) => l.href)).toEqual([
      `${ASSETS}/call-widget/runtime.0123456789ab.css`,
      `${ASSETS}/call-widget/presentation-intl.0123456789ab.css`,
    ]);
    expect(h.el.style.display).toBe('none');
    h.links()[0].onload!();
    expect(h.el.style.display).toBe('none');
    h.links()[1].onload!();
    expect(h.el.style.display).toBe('inline');
    // The only head stylesheet is the fonts one, from the build, once.
    const head = [...h.win.document.head.querySelectorAll('link')] as HTMLLinkElement[];
    expect(head.map((l) => [l.id, l.href])).toEqual([['gs-presentation-fonts', `${ASSETS}/widget/${FONTS_NAME}`]]);
  });

  it('retries a missing hashed stylesheet once by its fixed name, then shows', () => {
    const h = host({ assetUrl });
    const [rt, pres] = h.links();
    rt.onerror!();
    expect(rt.href).toBe(`${ASSETS}/call-widget/runtime.css?v=abc123def456`);
    pres.onload!();
    expect(h.el.style.display).toBe('none');
    rt.onerror!(); // the fixed name failed too: show what there is
    expect(h.el.style.display).toBe('inline');
  });

  it('an older loader (no assetUrl): the fixed names with its suffix, the bootstrap\'s fonts, no retry', () => {
    const h = host({ runtimeAssetSuffix: '?v=abc123def456&t=1' });
    expect(h.links().map((l) => l.href)).toEqual([
      `${ASSETS}/call-widget/runtime.css?v=abc123def456&t=1`,
      `${ASSETS}/call-widget/presentation-intl.css?v=abc123def456&t=1`,
    ]);
    h.links()[0].onerror!();
    expect(h.links()[0].href).toBe(`${ASSETS}/call-widget/runtime.css?v=abc123def456&t=1`);
    h.links()[1].onload!();
    expect(h.el.style.display).toBe('inline');
    const fonts = h.win.document.getElementById('gs-presentation-fonts') as HTMLLinkElement;
    expect(fonts.href).toBe(`${ASSETS}/widget/presentation-default-fonts.fromapi.css`);
  });

  it('without the registry (its hashed file missing), the presentation file runs silently; l.js retries all three', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://shop.example/', runScripts: 'outside-only' });
    const win = dom.window as unknown as Win & { CallWidgetPresentations?: unknown };
    expect(() => win.eval(readFileSync(resolve(ROOT, 'public/call-widget/presentation-default.js'), 'utf8'))).not.toThrow();
    win.eval(readFileSync(resolve(ROOT, 'public/call-widget/presentation-registry.js'), 'utf8'));
    win.eval(readFileSync(resolve(ROOT, 'public/call-widget/presentation-default.js'), 'utf8'));
    expect((win.CallWidgetPresentations as { has(id: string): boolean }).has('default')).toBe(true);
  });

  it('shows the host after 10 s even if no stylesheet event ever fires', () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const h = host({ assetUrl }, timers);
    expect(h.el.style.display).toBe('none');
    const safety = timers.find((t) => t.ms === 10000);
    expect(safety).toBeTruthy();
    safety!.fn();
    expect(h.el.style.display).toBe('inline');
    // A late stylesheet event changes nothing.
    h.links()[0].onload!();
    h.links()[1].onload!();
    expect(h.el.style.display).toBe('inline');
  });
});
