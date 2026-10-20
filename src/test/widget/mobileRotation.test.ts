/**
 * A phone turned while the chat panel is open (the owner's iPhone, t1,
 * 2026-10-19). public/widget/loader.js owns the phone shell
 * (`.gs-mobile-open`: the shell is the whole visual viewport):
 *
 *  - its phone test was `max-width: 640px` only, so a phone turned to
 *    landscape (844×390) was "not a phone": the panel fell back to the desktop
 *    box, cut off below the hero;
 *  - the test ran only when the open state was re-read, so a re-read in
 *    landscape dropped the class and turning back to portrait left a floating
 *    card (the class was never put back).
 *
 * Now the phone test includes a short touch screen, it is re-run on every
 * resize / orientationchange while the panel is open, and the panel's fill
 * is Core's (runtime.css), not behind any template's width query. The real
 * layout is checked in e2e/widgetMobileRotation.spec.ts for every template.
 *
 * Also t1's home help card with no articles: as much room below its search
 * field as above it.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER = read('public/widget/loader.js');
const RUNTIME_CSS = read('public/widget/runtime.css');
const T1_CSS = read('public/widget/presentation-t1.css');
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const CONFIG = {
  enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 't1', locale: 'fa',
  styleUrl: 'https://cdn.test/widget/runtime.0123abcd.css',
  runtimeUrl: 'https://cdn.test/widget/runtime.0123abcd.js',
  presentationRegistryUrl: 'https://cdn.test/widget/presentation-registry.0123abcd.js',
  presentationUrl: 'https://cdn.test/widget/presentation-t1.0123abcd.js',
  presentationStyleUrl: 'https://cdn.test/widget/presentation-t1.0123abcd.css',
  callRuntimeUrl: 'https://cdn.test/widget/runtime-call.0123abcd.js',
  loaderVersion: 'lv1',
};

/** A screen: its size and whether its pointer is coarse (a touch screen). */
const screen = { w: 390, h: 844, coarse: true };

/** Enough of a media query evaluator for the loader's queries. */
function matches(query: string): boolean {
  return query.split(',').some((part) => {
    const conds = part.split(/\band\b/).map((c) => c.trim()).filter(Boolean);
    return conds.every((c) => {
      let m = c.match(/^\(max-width:\s*(\d+)px\)$/);
      if (m) return screen.w <= Number(m[1]);
      m = c.match(/^\(max-height:\s*(\d+)px\)$/);
      if (m) return screen.h <= Number(m[1]);
      if (/^\(pointer:\s*coarse\)$/.test(c)) return screen.coarse;
      return false; // prefers-reduced-motion and the like
    });
  });
}

function turn(w: number, h: number, event: 'resize' | 'orientationchange' = 'resize') {
  screen.w = w; screen.h = h;
  window.dispatchEvent(new Event(event));
}

describe('the chat loader: the phone shell follows the screen while the panel is open', () => {
  const w = window as unknown as Record<string, unknown>;
  let opened = false;

  async function bootAndOpen() {
    w.__gs_id = WS;
    w.__gs_api_base = 'https://api.test';
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), headers: { get: () => null } });
    w.fetch = vi.fn((url: string) => (String(url).includes('/api/widget/boot')
      ? json({ session_token: 't', workspace_id: WS, protocol: 3, availability: { state: 'online' }, config: CONFIG })
      : json({})));
    // Every script / stylesheet the loader appends "loads" on the next tick.
    for (const target of [document.head]) {
      const real = target.appendChild.bind(target);
      vi.spyOn(target, 'appendChild').mockImplementation(((node: HTMLElement) => {
        if (node.tagName === 'SCRIPT' || (node.tagName === 'LINK' && (node as HTMLLinkElement).rel !== 'preconnect')) {
          setTimeout(() => node.dispatchEvent(new Event('load')), 0);
        }
        return real(node);
      }) as never);
    }
    new Function(LOADER).call(window);
    await tick();
    const shadow = document.querySelector('gs-widget')!.shadowRoot!;
    const realShadowAppend = shadow.appendChild.bind(shadow);
    vi.spyOn(shadow, 'appendChild').mockImplementation(((node: HTMLElement) => {
      if (node.tagName === 'SCRIPT' || node.tagName === 'LINK') setTimeout(() => node.dispatchEvent(new Event('load')), 0);
      return realShadowAppend(node);
    }) as never);
    w.__gs_presentation_t1 = { prepare: () => Promise.resolve(), create: () => ({}) };
    w.__gs_presentation_registry = { resolve: () => ({ globalKey: '__gs_presentation_t1' }) };
    w.__gs_runtime = {
      init: () => ({ open() { opened = true; }, close() { opened = false; }, toggle() { opened = !opened; }, isOpen: () => opened }),
    };
    (shadow.querySelector('.launcher') as HTMLButtonElement).click();
    await tick(16);
    return shadow.querySelector('.shell') as HTMLElement;
  }

  /** The window listeners each loader adds, taken off after each test (a loader per test). */
  const added: Array<[string, EventListenerOrEventListenerObject]> = [];

  beforeEach(() => {
    const realAdd = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, o?: unknown) => {
      added.push([type, fn]);
      return realAdd(type, fn, o as never);
    }) as never);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
    for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete w[key];
    opened = false;
    Object.assign(screen, { w: 390, h: 844, coarse: true });
    vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({
      matches: matches(q), media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [type, fn] of added.splice(0)) window.removeEventListener(type, fn);
  });

  it('portrait → landscape → portrait: the phone shell (and the page lock) stays, as on a fresh open', async () => {
    const shell = await bootAndOpen();
    expect(opened).toBe(true);
    expect(shell.classList.contains('gs-mobile-open')).toBe(true);
    expect(document.body.style.position).toBe('fixed');

    turn(844, 390);
    expect(shell.classList.contains('gs-mobile-open'), 'a phone in landscape is still a phone').toBe(true);
    // The open state re-read in landscape (the public API, a runtime event).
    (w.__gs as { push: (c: unknown[]) => void }).push(['open']);
    await tick();
    expect(shell.classList.contains('gs-mobile-open'), 'a re-read in landscape keeps it').toBe(true);

    turn(390, 844, 'orientationchange');
    expect(shell.classList.contains('gs-mobile-open')).toBe(true);
    expect(document.body.style.position).toBe('fixed');
  });

  it('re-evaluated on resize: a window made wide (a desktop) gives the page back, made narrow again takes the screen again', async () => {
    const shell = await bootAndOpen();
    screen.coarse = false;
    turn(1280, 900);
    expect(shell.classList.contains('gs-mobile-open')).toBe(false);
    expect(document.body.style.position).toBe('');
    turn(390, 844);
    expect(shell.classList.contains('gs-mobile-open')).toBe(true);
    expect(document.body.style.position).toBe('fixed');
  });

  it('closing gives the page back where it was', async () => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    try {
      await bootAndOpen();
      expect([document.body.style.position, document.body.style.top]).toEqual(['fixed', '-300px']);
      (w.__gs as { push: (c: unknown[]) => void }).push(['close']);
      await tick();
      expect([document.body.style.position, document.body.style.top, document.body.style.overflow]).toEqual(['', '', '']);
      expect(window.scrollTo).toHaveBeenLastCalledWith(0, 300);
    } finally {
      delete (window as unknown as { scrollY?: number }).scrollY;
    }
  });

  it('a page another widget already holds (the call widget\'s phone panel) is left to it: the chat restores only what it changed', async () => {
    // The call panel opened first: the page is fixed where the visitor had scrolled to.
    Object.assign(document.body.style, { position: 'fixed', top: '-300px', width: '100%', overflow: 'hidden' });
    const look = () => [document.body.style.position, document.body.style.top, document.body.style.width, document.body.style.overflow];
    const shell = await bootAndOpen();
    expect(shell.classList.contains('gs-mobile-open')).toBe(true);
    // No jump of the page behind (a second lock would read scrollY 0 on the fixed page and pin it at the top).
    expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
    // The call closes first and lets the page go; then the chat closes: the page stays free, not frozen again.
    Object.assign(document.body.style, { position: '', top: '', width: '', overflow: '' });
    (w.__gs as { push: (c: unknown[]) => void }).push(['close']);
    await tick();
    expect(shell.classList.contains('gs-mobile-open')).toBe(false);
    expect(look()).toEqual(['', '', '', '']);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('the moment the other widget lets the page go while the chat stays open, the chat holds it (no resize needed)', async () => {
    Object.assign(document.body.style, { position: 'fixed', top: '-300px', width: '100%', overflow: 'hidden' });
    const look = () => [document.body.style.position, document.body.style.top, document.body.style.width, document.body.style.overflow];
    await bootAndOpen();
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    try {
      // The call panel closes first: it puts the page back where it was (its scroll included) and does nothing else.
      Object.assign(document.body.style, { position: '', top: '', width: '', overflow: '' });
      await tick(1);
      // The chat panel, still open on the phone, holds the page at once, where the visitor is.
      expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
      (w.__gs as { push: (c: unknown[]) => void }).push(['close']);
      await tick();
      expect(look()).toEqual(['', '', '', '']);
      expect(window.scrollTo).toHaveBeenLastCalledWith(0, 300);
    } finally {
      delete (window as unknown as { scrollY?: number }).scrollY;
    }
  });

  it('when the other widget lets the page go while the chat stays open, the chat holds it from the next resize, and gives it back on close', async () => {
    Object.assign(document.body.style, { position: 'fixed', top: '-300px', width: '100%', overflow: 'hidden' });
    const look = () => [document.body.style.position, document.body.style.top, document.body.style.width, document.body.style.overflow];
    await bootAndOpen();
    // The call closes and puts the page back where it was.
    Object.assign(document.body.style, { position: '', top: '', width: '', overflow: '' });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    try {
      turn(390, 844);
      expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
      (w.__gs as { push: (c: unknown[]) => void }).push(['close']);
      await tick();
      expect(look()).toEqual(['', '', '', '']);
      expect(window.scrollTo).toHaveBeenLastCalledWith(0, 300);
    } finally {
      delete (window as unknown as { scrollY?: number }).scrollY;
    }
  });

  it('a tablet in landscape (820px tall) keeps the desktop panel, and a closed panel never takes the screen', async () => {
    Object.assign(screen, { w: 1180, h: 820, coarse: true });
    const shell = await bootAndOpen();
    expect(shell.classList.contains('gs-mobile-open')).toBe(false);
    (w.__gs as { push: (c: unknown[]) => void }).push(['close']);
    await tick();
    turn(390, 844);
    expect(shell.classList.contains('gs-mobile-open')).toBe(false);
  });
});

describe('the phone shell and panel styles do not hang on a width query', () => {
  it("the loader's .gs-mobile-open shell rules apply in any orientation (the class is the phone test)", () => {
    const at = LOADER.indexOf('".shell.gs-mobile-open{top:0;left:0;right:0;bottom:auto;"');
    expect(at).toBeGreaterThan(0);
    // The statement just before it is not an opened @media block.
    const before = LOADER.slice(LOADER.lastIndexOf('SHELL_CSS', at), at);
    expect(before).not.toMatch(/"@media\(max-width:640px\)\{",\s*$/);
    expect(LOADER).toContain('(max-width:640px),(max-height:500px) and (pointer:coarse)');
  });

  it("Core's runtime.css fills the screen with the panel outside any @media block", () => {
    const top = RUNTIME_CSS.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
    const rule = top.match(/\.shell\.gs-mobile-open \.panel \{([^}]*)\}/);
    expect(rule, 'unconditional .shell.gs-mobile-open .panel').toBeTruthy();
    for (const d of ['inset: 0', 'width: 100%', 'max-width: 100%', 'height: 100%', 'max-height: 100%', 'border-radius: 0']) {
      expect(rule![1]).toContain(d);
    }
    expect(top).toMatch(/\.shell\.gs-mobile-open \.panel\.visible \{ transform: none; \}/);
  });

  it("t1's home help card: a search field with no articles under it gets the room the list would have", () => {
    expect(T1_CSS).toContain('.cd.hc, .cd.lc { padding: 12px 14px 4px; }');
    expect(T1_CSS).toContain('.hc .sr:last-child { margin-bottom: 8px; }');
  });
});
