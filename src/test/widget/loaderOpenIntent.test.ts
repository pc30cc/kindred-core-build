/**
 * public/widget/loader.js before and around the first open:
 *
 *  - An open intent (a mouse MOVING over the launcher, a press, keyboard
 *    focus) opens the two uncredentialed connections a first open needs
 *    (rel=preconnect crossorigin, the API and the fonts' host) and loads the
 *    panel's files, but runtime.init() — the realtime connection and every
 *    API read — waits for a real open. A mouse loads the files only once it
 *    stays 100 ms; a launcher appearing under a resting cursor warms nothing.
 *    A page view without an intent adds nothing.
 *  - A click while that load is still running opens the panel when it ends.
 *  - A hashed script that is missing is retried once by its canonical name in
 *    a FRESH element: a cloned <script> keeps its "already started" flag and
 *    is never fetched, which left the panel closed for good.
 *  - Core's renderer-feature module (runtime-ext.js), which /config names
 *    only for a template that builds on it (`modules.ext`), is fetched with
 *    that template's files and never awaited: runtime.js finds it cached.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const CONFIG = {
  enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'en',
  styleUrl: 'https://cdn.test/widget/runtime.0123abcd.css',
  runtimeUrl: 'https://cdn.test/widget/runtime.0123abcd.js',
  presentationRegistryUrl: 'https://cdn.test/widget/presentation-registry.0123abcd.js',
  presentationUrl: 'https://cdn.test/widget/presentation-default.0123abcd.js',
  presentationStyleUrl: 'https://cdn.test/widget/presentation-default.0123abcd.css',
  presentationFontsUrl: 'https://fonts.cdn.test/widget/presentation-default-fonts.0123abcd.css',
  callRuntimeUrl: 'https://cdn.test/widget/runtime-call.0123abcd.js',
  loaderVersion: 'lv1',
};

/** A script or link the loader appended (both have src/href-ish fields we read). */
type Held = HTMLElement & { src?: string; href?: string; rel?: string; async?: boolean };

describe('the chat loader: open intent and the first open', () => {
  const appended: Held[] = [];
  /** URLs whose load the test decides (fail / hold); everything else loads on the next tick. */
  let failing: Set<string>;
  let holding: Set<string>;
  let init: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  const w = window as unknown as Record<string, unknown>;

  function watch(target: Node) {
    const real = target.appendChild.bind(target);
    vi.spyOn(target, 'appendChild').mockImplementation(((node: Held) => {
      appended.push(node);
      const url = node.src || node.href || '';
      if ((node.tagName === 'SCRIPT' || node.tagName === 'LINK') && node.rel !== 'preconnect' && !holding.has(url)) {
        // A real event: the fonts gate listens with addEventListener.
        setTimeout(() => node.dispatchEvent(new Event(failing.has(url) ? 'error' : 'load')), 0);
      }
      return real(node);
    }) as never);
  }

  async function boot(config: Record<string, unknown> = CONFIG) {
    w.__gs_id = WS;
    w.__gs_api_base = 'https://api.test';
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), headers: { get: () => null } });
    w.fetch = vi.fn((url: string) => (String(url).includes('/api/widget/boot')
      ? json({ session_token: 't', workspace_id: WS, protocol: 3, availability: { state: 'online' }, config })
      : json({})));
    watch(document.head);
    new Function(LOADER).call(window);
    await tick();
    watch(document.querySelector('gs-widget')!.shadowRoot!);
    // What the files define when they run.
    w.__gs_presentation_default = { prepare: () => Promise.resolve(), create: () => ({}) };
    w.__gs_presentation_registry = { resolve: () => ({ globalKey: '__gs_presentation_default' }) };
    open = vi.fn();
    init = vi.fn(() => ({ open, close() {}, toggle() {}, isOpen: () => open.mock.calls.length > 0 }));
    w.__gs_runtime = { init };
    return document.querySelector('gs-widget')!.shadowRoot!.querySelector('.launcher') as HTMLButtonElement;
  }

  const preconnects = () => [...document.head.querySelectorAll('link[rel="preconnect"]')] as HTMLLinkElement[];
  const requested = (re: RegExp) => appended.filter((n) => re.test(n.src || n.href || ''));

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete w[key];
    appended.length = 0;
    failing = new Set();
    holding = new Set();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a page view with no intent preconnects nothing and loads no panel file', async () => {
    await boot();
    await tick();
    expect(preconnects()).toEqual([]);
    expect(requested(/runtime\.0123abcd\.js|presentation-default\.0123abcd\.js/)).toEqual([]);
  });

  const pointer = (el: Element, type: string, x: number, y: number) =>
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: type !== 'pointerenter' && type !== 'pointerleave' }));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a mouse that moves over the launcher and stays: preconnects (crossorigin) to the API and the fonts\' host, then loads the panel, without init()', async () => {
    const launcher = await boot();
    pointer(launcher, 'pointerenter', 10, 10);
    pointer(launcher, 'pointermove', 14, 12);
    pointer(launcher, 'pointermove', 18, 14); // once only
    await tick();
    expect(preconnects()).toHaveLength(2);
    expect(requested(/runtime\.0123abcd\.js$/)).toHaveLength(0); // not before it stayed 100 ms
    await wait(120);
    await tick(12);
    expect(preconnects().map((l) => [l.href.replace(/\/$/, ''), l.crossOrigin])).toEqual([
      ['https://api.test', 'anonymous'],
      ['https://fonts.cdn.test', 'anonymous'],
    ]);
    expect(requested(/runtime\.0123abcd\.js$/)).toHaveLength(1);
    expect(requested(/presentation-default\.0123abcd\.js$/)).toHaveLength(1);
    expect(init).not.toHaveBeenCalled();

    launcher.click();
    await tick();
    expect(init).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    // Nothing was requested twice.
    expect(requested(/runtime\.0123abcd\.js$/)).toHaveLength(1);
  });

  it('a launcher that appears under a resting cursor (enter, no movement) warms nothing', async () => {
    const launcher = await boot();
    pointer(launcher, 'pointerenter', 30, 30);
    pointer(launcher, 'pointermove', 30, 30); // a synthetic move at the same spot
    await wait(150);
    await tick();
    expect(preconnects()).toEqual([]);
    expect(requested(/runtime\.0123abcd\.js|presentation-default\.0123abcd\.js/)).toEqual([]);
  });

  it('a mouse that only passes over the launcher opens the connections but downloads no panel file', async () => {
    const launcher = await boot();
    pointer(launcher, 'pointerenter', 0, 20);
    pointer(launcher, 'pointermove', 20, 20);
    pointer(launcher, 'pointerleave', 40, 20);
    await wait(150);
    await tick();
    expect(preconnects()).toHaveLength(2);
    expect(requested(/runtime\.0123abcd\.js|presentation-default\.0123abcd\.js/)).toEqual([]);
    expect(init).not.toHaveBeenCalled();
  });

  it('a press is an intent at once: pointerdown / touchstart / focus load the panel without a dwell', async () => {
    for (const type of ['pointerdown', 'touchstart', 'focus']) {
      document.head.innerHTML = '';
      document.body.innerHTML = '';
      for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete w[key];
      appended.length = 0;
      vi.restoreAllMocks();
      const launcher = await boot();
      launcher.dispatchEvent(new Event(type));
      await tick(12);
      expect(requested(/runtime\.0123abcd\.js$/), type).toHaveLength(1);
      expect(init, type).not.toHaveBeenCalled();
    }
  });

  it('a click while the warm-up load is still running opens the panel when it ends', async () => {
    const launcher = await boot();
    holding.add(CONFIG.runtimeUrl);
    launcher.dispatchEvent(new Event('touchstart'));
    await tick();
    launcher.click();
    await tick();
    expect(init).not.toHaveBeenCalled();
    (requested(/runtime\.0123abcd\.js$/)[0] as unknown as HTMLScriptElement).onload!(new Event('load'));
    await tick();
    expect(init).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  const EXT = 'https://cdn.test/widget/runtime-ext.0123abcd.js';
  const T1 = {
    ...CONFIG,
    templateId: 't1',
    presentationUrl: 'https://cdn.test/widget/presentation-t1.0123abcd.js',
    presentationStyleUrl: 'https://cdn.test/widget/presentation-t1.0123abcd.css',
    modules: { kb: 'https://cdn.test/widget/runtime-kb.0123abcd.js', ext: EXT },
  };

  it('a template that builds on Core\'s feature module: an intent fetches it with the template\'s files, and the panel never waits for it', async () => {
    const launcher = await boot(T1);
    holding.add(EXT); // a module that never answers
    launcher.dispatchEvent(new Event('touchstart'));
    await tick(12);
    const ext = requested(/runtime-ext\.0123abcd\.js$/) as unknown as HTMLScriptElement[];
    expect(ext).toHaveLength(1);
    expect(ext[0].tagName).toBe('SCRIPT');
    expect(ext[0].async).toBe(true);
    expect(ext[0].parentNode).toBe(document.head);
    // In the same pass as the renderer, right after runtime.js (which init()
    // needs first: on HTTP/1.1 the 7th request waits for a connection).
    const at = (re: RegExp) => appended.indexOf(requested(re)[0]);
    expect(at(/runtime-ext\.0123abcd\.js$/)).toBe(at(/runtime\.0123abcd\.js$/) + 1);
    expect(at(/presentation-t1\.0123abcd\.js$/)).toBeLessThan(at(/runtime\.0123abcd\.js$/));
    expect(init).not.toHaveBeenCalled();
    launcher.click();
    await tick();
    expect(init).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(requested(/runtime-ext/)).toHaveLength(1);
  });

  it('a template that names no such module (`default`) loads exactly the files it always did', async () => {
    const launcher = await boot();
    launcher.click();
    await tick(12);
    expect(init).toHaveBeenCalledTimes(1);
    expect(requested(/runtime-ext|runtime-kb/)).toEqual([]);
    const scripts = appended.filter((n) => n.tagName === 'SCRIPT').map((n) => n.src);
    expect(scripts).toEqual([CONFIG.presentationRegistryUrl, CONFIG.presentationUrl, CONFIG.runtimeUrl, CONFIG.callRuntimeUrl]);
  });

  it('a missing hashed script is retried once by its canonical name in a fresh element, and the panel opens', async () => {
    const launcher = await boot();
    failing.add(CONFIG.presentationUrl);
    const clone = vi.spyOn(Element.prototype, 'cloneNode');
    launcher.click();
    await tick(16);
    const retries = requested(/presentation-default\.js\?v=/);
    expect(retries).toHaveLength(1);
    const retry = retries[0] as unknown as HTMLScriptElement;
    const original = requested(/presentation-default\.0123abcd\.js$/)[0] as unknown as HTMLScriptElement;
    expect(retry).not.toBe(original);
    expect(retry.getAttribute('data-gs-template')).toBe('renderer');
    expect(retry.async).toBe(true);
    expect(clone.mock.calls.filter((c, i) => clone.mock.instances[i] === original)).toEqual([]);
    expect(init).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
