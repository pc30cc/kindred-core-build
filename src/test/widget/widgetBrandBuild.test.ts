/**
 * The embeddable widgets as each build ships them (scripts/build/widgetBrand.mjs,
 * run by scripts/widget-hash.js and scripts/call-widget-hash.js).
 *
 *  - The RESPOK build's widget files carry nothing of the Iran region's brand
 *    (scripts/build/brandAudit.mjs's patterns), in any file or file name.
 *  - Its loader still boots, renders the launcher, opens, closes and counts
 *    unread messages for every edition, with no ReferenceError from the
 *    local kit it no longer has; the Iran build's loader still wears the kit.
 *  - Minifying keeps what the pages and the other scripts rely on: the
 *    globals each file defines.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';
import { LOCAL_KIT_LAUNCHER_CSS } from '../../../shared/localKitLauncher';

type Brand = 'respok' | 'iran' | 'both';
const ROOT = process.cwd();
const DIRS = ['public/widget', 'public/call-widget'];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * A widget file as `brand` ships it (top-level JS/CSS transformed, the rest
 * as is). esbuild refuses to run inside jsdom, so the transform runs in its
 * own node process (scripts/build/widgetBrand.mjs's command line).
 */
const cache = new Map<string, string>();
/** scripts/build/widgetBrand.mjs isWidgetSource (not imported: it loads esbuild). */
const isWidgetSource = (name: string) => /^[^/]+\.(js|css)$/.test(name);
function shipped(dir: string, name: string, brand: Brand): string {
  const file = resolve(ROOT, dir, name);
  if (!isWidgetSource(name)) return readFileSync(file).toString('utf8');
  const key = `${brand}:${file}`;
  if (!cache.has(key)) {
    cache.set(key, execFileSync(process.execPath, [resolve(ROOT, 'scripts/build/widgetBrand.mjs'), brand, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  }
  return cache.get(key)!;
}

describe('the RESPOK widget carries nothing of the Iran brand', () => {
  for (const dir of DIRS) {
    const files = [...walk(resolve(ROOT, dir))].map((f) => relative(resolve(ROOT, dir), f));
    it.each(files)(`${dir}/%s`, (name) => {
      for (const re of IRAN_BRAND_PATTERNS) {
        expect(re.test(name), `file name matches ${re}`).toBe(false);
        const text = shipped(dir, name, 'respok');
        const m = re.exec(text);
        expect(m && text.slice(Math.max(0, m.index - 60), m.index + 60), `content matches ${re}`).toBeNull();
      }
    });
  }

  it('RESPOK\'s launcher kit (@intl-kit) ships in the RESPOK loader only', () => {
    // The loader is the only file marked: what the Iran build leaves out is
    // RESPOK's button, so an Iran-brand deployment switched to the
    // International edition shows the plain launcher (below).
    for (const name of readdirSync(resolve(ROOT, 'public/widget')).filter(isWidgetSource)) {
      if (name === 'loader.js') continue;
      expect(readFileSync(resolve(ROOT, 'public/widget', name), 'utf8'), name).not.toMatch(/@intl-kit|\bINTL_KIT\b/);
    }
    const iran = shipped('public/widget', 'loader.js', 'iran');
    const respok = shipped('public/widget', 'loader.js', 'respok');
    expect(iran).not.toMatch(/rpk-kit|#FF5A3C|#16142B|RESPOK_KIT|respokKitOn|INTL_KIT/i);
    expect(respok).toContain('rpk-kit');
    expect(respok).toContain('#FF5A3C');
    expect(respok).toContain('rpk-kit-o');
    expect(shipped('public/widget', 'loader.js', 'both')).toContain('rpk-kit');
  });

  it('the local kit is gone from the RESPOK loader and kept in the Iran one', () => {
    const respok = shipped('public/widget', 'loader.js', 'respok');
    const iran = shipped('public/widget', 'loader.js', 'iran');
    expect(respok).not.toMatch(/lk-kit|#22D3B4/i);
    expect(iran).toContain('lk-kit');
    expect(iran).toContain('#22D3B4');
    // The minifier drops comments in every build.
    expect(iran).not.toMatch(/\/\/ |\/\*[^!]/);
  });
});

describe('the shipped files', () => {
  it('keeps every global the widget files define (classic scripts, not modules)', () => {
    for (const brand of ['respok', 'iran'] as const) {
      expect(shipped('public/widget', 'smart-engine.js', brand)).toMatch(/^var __gs_smart_engine_module=/m);
      const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
      const win = dom.window as unknown as Window & { eval(code: string): unknown } & Record<string, unknown>;
      win.eval(shipped('public/widget', 'presentation-registry.js', brand));
      win.eval(shipped('public/widget', 'presentation-default.js', brand));
      win.eval(shipped('public/widget', 'smart-engine.js', brand));
      win.eval(shipped('public/call-widget', 'presentation-registry.js', brand));
      const registry = win.__gs_presentation_registry as { resolve: (id: string) => { id: string; globalKey: string } };
      expect(registry.resolve('intl').id).toBe('intl');
      expect(registry.resolve('default').id).toBe('default');
      // The legacy id is the Iran region's only; elsewhere it falls back to the default anyway.
      expect(registry.resolve(['web', 'yar'].join('-')).id).toBe('default');
      expect(typeof win[registry.resolve('intl').globalKey]).toBe('object');
      expect(win.__gs_smart_engine).toBeTruthy();
      expect(win.CallWidgetPresentations).toBeTruthy();
      // The late pack: each renderer's extras (handshake intact) and Core's late module.
      for (const id of ['t1', 't2']) {
        win.eval(shipped('public/widget', `presentation-${id}-x.js`, brand));
        expect(win.__gs_mod_extras, `${id} (${brand})`).toMatchObject({ id, v: 2 });
      }
      win.eval(shipped('public/widget', 'runtime-late.js', brand));
      expect(win.__gs_mod_late).toMatchObject({ v: 2 });
    }
  });
});

// ─── The loader as each build ships it, booted in jsdom ─────────────────────

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}

/** jsdom never fetches src'd assets: fire their onload so the runtime chain runs. */
function patchAppendChild(target: Node) {
  const real = target.appendChild.bind(target);
  vi.spyOn(target, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const el = node as unknown as HTMLElement & { onload?: () => void };
    if (el && (el.tagName === 'SCRIPT' || el.tagName === 'LINK') && el.getAttribute('data-gs-runtime-call') !== 'true') {
      setTimeout(() => { if (typeof el.onload === 'function') el.onload(); }, 0);
    }
    return real(node) as T;
  });
}

const errors: unknown[] = [];
const onError = (e: ErrorEvent) => { errors.push(e.error ?? e.message); };

beforeEach(() => {
  vi.useRealTimers();
  errors.length = 0;
  window.addEventListener('error', onError);
  document.body.innerHTML = '';
  for (const key of Object.keys(window)) {
    if (key.indexOf('__gs') === 0) delete (window as unknown as Record<string, unknown>)[key];
  }
});
afterEach(() => {
  window.removeEventListener('error', onError);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function bootShipped(brand: Brand, config: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const w = window as unknown as Record<string, unknown>;
  w.__gs_id = 'ws-test';
  w.__gs_api_base = 'https://api.test';
  patchAppendChild(document.head);
  w.fetch = vi.fn((url: string) => Promise.resolve(jsonResponse(
    String(url).includes('/api/widget/bootstrap')
      ? { session_token: 't', workspace_id: 'ws-test', availability: { state: 'online' } }
      : String(url).includes('/api/widget/config')
        ? {
          enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'fa', fab: {},
          styleUrl: 'https://cdn.test/runtime.css', runtimeUrl: 'https://cdn.test/runtime.js',
          presentationRegistryUrl: 'https://cdn.test/presentation-registry.js',
          presentationUrl: 'https://cdn.test/presentation-default.js', presentationStyleUrl: 'https://cdn.test/presentation.css',
          ...config,
        }
        : {},
  )));
  new Function(shipped('public/widget', 'loader.js', brand)).call(window);
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
  const root = document.querySelector('gs-widget')!.shadowRoot!;
  patchAppendChild(root);
  const instance = { open: false };
  w.__gs_runtime = {
    init: vi.fn(() => ({
      open: () => { instance.open = true; },
      close: () => { instance.open = false; },
      toggle: () => { instance.open = !instance.open; },
      isOpen: () => instance.open,
    })),
  };
  return { root, launcher: root.querySelector('.launcher') as HTMLButtonElement };
}

/** Everything a visitor does with the launcher, with every timer run out. */
async function exercise(launcher: HTMLButtonElement) {
  const gs = (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs;
  gs.push(['setUnread', 3]);
  launcher.click();
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
  gs.push(['close']);
  await vi.advanceTimersByTimeAsync(10_000);
  gs.push(['open']);
  await vi.advanceTimersByTimeAsync(10_000);
  const state = await new Promise<{ ready: boolean; open: boolean }>((res) => gs.push(['getState', res]));
  return state;
}

describe('the RESPOK loader boots, renders and opens without the local kit', () => {
  it.each([
    ['international (intl)', { edition: 'international', templateId: 'intl' }, 'rpk-kit'],
    ['international, the Open logo (t1-intl)', { edition: 'international', templateId: 't1-intl', templateOptions: { logoDirection: 'open' } }, 'rpk-kit'],
    ['iran (never served by RESPOK)', { edition: 'iran' }, null],
    ['unknown edition', { edition: null }, null],
    ['an older backend (no edition)', {}, null],
  ])('%s', async (_name, config, kitClass) => {
    const { root, launcher } = await bootShipped('respok', config);
    expect(launcher).not.toBeNull();
    expect(launcher.classList.contains('revealed')).toBe(true);
    expect(launcher.className).not.toMatch(/lk-kit/);
    expect(root.querySelector('style[data-lk-kit]')).toBeNull();
    if (kitClass) expect(launcher.classList.contains(kitClass)).toBe(true);
    const state = await exercise(launcher);
    expect(state.ready).toBe(true);
    expect(state.open).toBe(true);
    // Latin digits: the Persian ones are the local kit's.
    expect(launcher.querySelector('.badge')?.textContent ?? '3').toBe('3');
    expect(errors).toEqual([]);
  });
});

describe('the Iran build\'s loader in the International edition (a WebYar deployment switched over)', () => {
  it.each([['intl', 'intl'], ['t1-intl', 't1-intl']])('%s: the plain launcher, no other brand\'s art, and everything works', async (_name, templateId) => {
    const { root, launcher } = await bootShipped('iran', { edition: 'international', templateId, templateOptions: { logoDirection: 'open' } });
    expect(launcher.classList.contains('revealed')).toBe(true);
    expect(launcher.className).not.toMatch(/rpk-kit|lk-kit/);
    expect(root.querySelector('style[data-rpk-kit], style[data-lk-kit]')).toBeNull();
    expect(root.querySelector('.shell')!.className).not.toMatch(/lg-/);
    expect(launcher.querySelector('svg.chat-icon')!.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(root.querySelector('.shell')!.getAttribute('style')).toContain('--gs-fab-size: 56px');
    const state = await exercise(launcher);
    expect(state.open).toBe(true);
    expect(launcher.querySelector('.badge')?.textContent ?? '3').toBe('3');
    expect(errors).toEqual([]);
  });
});

describe('the Iran build\'s loader still wears the local kit', () => {
  it('its button, stylesheet, entrance, ping and Persian badge', async () => {
    const { root, launcher } = await bootShipped('iran', { edition: 'iran' });
    expect(launcher.classList.contains('lk-kit')).toBe(true);
    expect(launcher.classList.contains('lk-kit-enter')).toBe(true);
    expect(root.querySelector('style[data-lk-kit]')!.textContent).toBe(LOCAL_KIT_LAUNCHER_CSS);
    await vi.advanceTimersByTimeAsync(6_500);
    expect(launcher.classList.contains('lk-kit-pinging')).toBe(true);
    (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs.push(['setUnread', 3]);
    expect(launcher.querySelector('.badge')!.textContent).toBe('۳');
    const state = await exercise(launcher);
    expect(state.open).toBe(true);
    expect(errors).toEqual([]);
  });
});

// ─── The call widget as the RESPOK build ships it ───────────────────────────

describe('the RESPOK call widget', () => {
  function mount(brand: Brand, extra: Record<string, unknown>, locale = 'en') {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://customer.example/page', runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { eval(code: string): unknown; CallCenterWidget: { mount(o: unknown): void } };
    win.eval(shipped('public/call-widget', 'presentation-registry.js', brand));
    win.eval(shipped('public/call-widget', 'presentation-default.js', brand));
    win.eval(shipped('public/call-widget', 'runtime.js', brand));
    win.CallCenterWidget.mount({
      apiBase: 'https://api.example',
      origin: 'https://app.example',
      preview: true,
      bootstrap: {
        status: 'ok', provider_ready: true, session: 'preview',
        config: { widget_template_id: 'intl', widget_position: 'right', offline_behavior: 'show_callback', pre_call_form_enabled: false, pre_call_form_schema: [] },
        capabilities: { voice: true, video: false, callback: true },
        callback_policy: { enabled: true, show_when_online: true },
        recording: { effective_enabled: false },
        departments: { voice: [], video: [], callback: [] },
        i18n: { default_locale: locale, available_locales: [locale] },
        ...extra,
      },
    });
    const root = (win.document.querySelector('#call-center-widget-host') as HTMLElement).shadowRoot!.querySelector('.ccw-root') as HTMLElement;
    (root.querySelector('.ccw-launcher-btn') as HTMLButtonElement | null)?.click();
    return root;
  }

  it('credits the platform the bootstrap names', () => {
    const root = mount('respok', { edition: 'international', powered_by: { brand: 'RESPOK', url: 'https://respok.app' } });
    expect(root.querySelector('.ccw-powered')!.textContent).toContain('RESPOK');
  });

  it.each([['iran', { edition: 'iran', powered_by_logo: '/x.svg' }], ['unknown', { edition: null }], ['older backend', {}]])(
    '%s: mounts, and never names the Iran region\'s platform',
    (_name, extra) => {
      for (const locale of ['en', 'fa', 'tr']) {
        const root = mount('respok', extra, locale);
        for (const re of IRAN_BRAND_PATTERNS) expect(root.innerHTML).not.toMatch(re);
        expect(root.querySelector('img.ccw-powered-logo')).toBeNull();
      }
    },
  );

  it('the Iran build keeps its words', () => {
    const root = mount('iran', { edition: 'iran' }, 'en');
    expect(root.querySelector('.ccw-powered')!.textContent).toBe(`Powered by ${['Web', 'Yar'].join(' ')}`);
  });
});
