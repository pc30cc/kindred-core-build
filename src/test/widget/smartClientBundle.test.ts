/**
 * Smart Engagement's visitor side (the rules' loop, the bubble, the panel
 * surfaces, the AI proactive nudge) is src/lib/widget/smartClient.js, which
 * scripts/build-smart-engine.mjs appends to public/widget/smart-engine.js
 * after the engine. It used to live in loader.js, which every page view of
 * every site downloads; now only a site whose workspace has active rules
 * gets it, in the request it makes for the engine. The loader starts it
 * (startSmart) and hands it its state through `host`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { AI_JOURNEY_MAX_PAGES } from '../../lib/widget/smartEngine';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const CLIENT = read('src/lib/widget/smartClient.js');
const BUNDLE = read('public/widget/smart-engine.js');
const LOADER = read('public/widget/loader.js');

describe('the bundle and the loader', () => {
  it('smart-engine.js carries the visitor side as it is, after the engine (regenerated: node scripts/build-smart-engine.mjs)', () => {
    expect(BUNDLE.endsWith(CLIENT.trimEnd() + '\n')).toBe(true);
    const engine = BUNDLE.indexOf('window.__gs_smart_engine = __gs_smart_engine_module.SmartEngine');
    expect(engine).toBeGreaterThan(-1);
    expect(BUNDLE.indexOf('window.__gs_smart_start = function (host, config) {')).toBeGreaterThan(engine);
  });

  it('the loader keeps only the start: none of the loop, the surfaces or the nudge', () => {
    for (const gone of ['/api/widget/smart/event', '/api/widget/nudge/evaluate', 'function showPanelSurface(', 'function interactionSnapshot(', 'function bubble(', 'evaluateSmartRule']) {
      expect(LOADER, gone).not.toContain(gone);
    }
    expect(LOADER).toContain('window.__gs_smart_start(host, config)');
    // The bubble's look came along: the loader's shell sheet has none of it.
    expect(LOADER).not.toContain('.smart-nudge{position:absolute');
    expect(LOADER).not.toContain('@keyframes gs-smart-in');
    expect(CLIENT).toContain('.smart-nudge{position:absolute');
    expect(LOADER).toContain('engineScript.setAttribute("data-gs-smart", "true");');
  });

  it('the journey cap is the engine\'s', () => {
    const m = CLIENT.match(/var AI_JOURNEY_MAX_PAGES = (\d+);/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(AI_JOURNEY_MAX_PAGES);
  });
});

type Dict = Record<string, unknown>;
interface SmartWin {
  eval(src: string): void;
  fetch: unknown;
  __gs_smart_engine: unknown;
  __gs_smart_start: (host: Dict, config: Dict) => void;
  sessionStorage: Storage;
  document: Document;
}

describe('the visitor side, started with a host', () => {
  const doms: JSDOM[] = [];
  afterEach(() => { while (doms.length) doms.pop()!.window.close(); });

  function page(opts: { tracking?: boolean; engine?: unknown } = {}) {
    const dom = new JSDOM('<!doctype html><title>Shoes</title><body></body>', { url: 'https://shop.example/shoes', runScripts: 'outside-only' });
    doms.push(dom);
    const win = dom.window as unknown as SmartWin;
    win.eval(BUNDLE);
    expect(typeof win.__gs_smart_start).toBe('function');
    expect(typeof (win.__gs_smart_engine as Dict).evaluateSmartRule).toBe('function');
    if ('engine' in opts) win.__gs_smart_engine = opts.engine;
    const posts: Array<{ url: string; init: { headers: Dict; body: string } }> = [];
    win.fetch = vi.fn((url: string, init: { headers: Dict; body: string }) => { posts.push({ url, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); });
    const shell = win.document.createElement('div');
    win.document.body.appendChild(shell);
    const warn = vi.fn();
    const host: Dict = {
      startedAt: Date.now() - 10_000,
      configData: { _apiBase: 'https://api.test', locale: 'fa', position: 'bottom-right', templateId: 'default', brandName: 'نیلوفر' },
      workspaceId: 'ws-1',
      isOpen: () => false,
      runtimeLoaded: () => false,
      sessionToken: () => 'tok-1',
      shellContentEl: () => shell,
      visitorIsNew: () => false,
      online: () => false,
      warn, log: () => {}, tracks: () => opts.tracking !== false, vh: (h: Dict) => h,
      recoverPost: vi.fn(() => Promise.resolve({ ok: true })),
      lt: (k: string) => k, widgetLang: () => 'fa', detectBrowser: () => 'Chrome', detectOS: () => 'macOS',
      injectPresentationFonts: () => {}, onOpenIntent: () => {}, isPhoneViewport: () => false,
      preloadRuntimeForSmart: () => {}, triggerOpen: () => {}, onHistoryChange: () => {},
    };
    const config = { smart: { rules: [{ id: 'r1', version: 1, presentation_config: { mode: 'launcher_nudge', dismissible: true } }] } };
    return { win, shell, posts, warn, start: () => win.__gs_smart_start(host, config) };
  }

  it('reads the loader\'s state through the host: time on the page from the loader\'s start, a returning visitor, offline', () => {
    const seen: Dict[] = [];
    const { start } = page({ engine: { evaluateSmartRule: (_r: unknown, ctx: Dict) => { seen.push(ctx); return { outcome: 'not_matched', reasons: [] }; } } });
    start();
    expect(seen).toHaveLength(1);
    const ctx = seen[0] as { signals: { elapsedMs: number }; visitor: { isReturning: boolean }; availability: { online: boolean }; interaction: { widgetOpen: boolean }; locale: string };
    expect(ctx.signals.elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(ctx.visitor.isReturning).toBe(true);
    expect(ctx.availability.online).toBe(false);
    expect(ctx.interaction.widgetOpen).toBe(false);
    expect(ctx.locale).toBe('fa');
  });

  it('a matching launcher nudge: its bubble in the loader\'s shell, and "shown" sent with the page\'s token', async () => {
    const { start, shell, posts } = page({
      engine: {
        evaluateSmartRule: () => ({ outcome: 'matched', reasons: [] }),
        resolveSmartContent: () => ({ title: '', body: 'کمک می‌خواهید؟', cta_label: '' }),
        renderSmartTemplate: (s: string) => s,
        isSafeSmartUrl: () => true,
      },
    });
    start();
    const bubble = shell.querySelector('.smart-nudge') as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.querySelector('.smart-body')!.textContent).toBe('کمک می‌خواهید؟');
    expect(bubble.getAttribute('role')).toBe('status');
    expect(bubble.dir).toBe('rtl');
    const shown = posts.find((p) => p.url === 'https://api.test/api/widget/smart/event');
    expect(shown).toBeTruthy();
    expect(shown!.init.headers['X-Widget-Token']).toBe('tok-1');
    expect(JSON.parse(shown!.init.body)).toMatchObject({ workspace_id: 'ws-1', rule_id: 'r1', event_type: 'shown' });
  });

  it('stores its session state only while the page tracks (consent)', () => {
    const KEY = 'gs:smart:v1:ws-1:session';
    const off = page({ tracking: false, engine: { evaluateSmartRule: () => ({ outcome: 'not_matched', reasons: [] }) } });
    off.start();
    expect(off.win.sessionStorage.getItem(KEY)).toBeNull();
    const on = page({ engine: { evaluateSmartRule: () => ({ outcome: 'not_matched', reasons: [] }) } });
    on.start();
    expect(JSON.parse(on.win.sessionStorage.getItem(KEY)!)).toMatchObject({ pages: 1 });
  });

  it('the bubble\'s sheet goes right after the loader\'s, before any template\'s, once', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://shop.example/', runScripts: 'outside-only' });
    doms.push(dom);
    const win = dom.window as unknown as SmartWin;
    win.eval(BUNDLE);
    win.__gs_smart_engine = { evaluateSmartRule: () => ({ outcome: 'not_matched', reasons: [] }) };
    const el = win.document.createElement('gs-widget');
    win.document.body.appendChild(el);
    const root = el.attachShadow({ mode: 'open' });
    const shellSheet = win.document.createElement('style');
    shellSheet.textContent = '.shell{}';
    root.appendChild(shellSheet);
    const shell = win.document.createElement('div');
    root.appendChild(shell);
    const template = win.document.createElement('link');
    template.rel = 'stylesheet';
    root.appendChild(template);
    const host: Dict = {
      startedAt: Date.now(), configData: { _apiBase: 'https://api.test' }, workspaceId: 'ws-1',
      isOpen: () => false, runtimeLoaded: () => false, sessionToken: () => 't', shellContentEl: () => shell,
      visitorIsNew: () => null, online: () => true, warn: () => {}, log: () => {}, tracks: () => true, vh: (h: Dict) => h,
      recoverPost: () => Promise.resolve({ ok: true }), lt: (k: string) => k, widgetLang: () => 'en', detectBrowser: () => 'Chrome',
      detectOS: () => 'macOS', injectPresentationFonts: () => {}, onOpenIntent: () => {}, isPhoneViewport: () => false,
      preloadRuntimeForSmart: () => {}, triggerOpen: () => {}, onHistoryChange: () => {},
    };
    const config = { smart: { rules: [{ id: 'r1', version: 1, presentation_config: { mode: 'launcher_nudge' } }] } };
    win.__gs_smart_start(host, config);
    win.__gs_smart_start(host, config);
    const kids = Array.from(root.children);
    expect(kids.map((k) => k.tagName)).toEqual(['STYLE', 'STYLE', 'DIV', 'LINK']);
    expect(kids[1].hasAttribute('data-gs-smart')).toBe(true);
    expect(kids[1].textContent).toContain('.smart-nudge{position:absolute');
    expect(kids[1].textContent).toContain('@media(prefers-reduced-motion:reduce){');
  });

  it('without an engine on the page it says so and runs nothing', () => {
    const { start, shell, warn, posts } = page({ engine: undefined });
    start();
    expect(warn).toHaveBeenCalledWith('smart: engine bundle did not register');
    expect(shell.children).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});
