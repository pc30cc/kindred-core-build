/**
 * The SHIPPED loader.js in jsdom: what a Smart Engagement rule and an
 * operator's reply do on a page where the visitor has not opened the widget.
 *
 *   V-27  a rule meant for the panel (home card, chat message, announcement)
 *         never opens it by itself: it waits in the panel (the runtime booted
 *         silently) and shows as a bubble beside the launcher, whose tap
 *         opens the panel; "Open the widget" opens it on a computer without
 *         taking the focus, and on a phone (where the panel is the whole
 *         screen) shows as that bubble instead;
 *   V-40  every bubble is a live region (role=status) in the widget's
 *         language and direction, and stays while the pointer or the focus
 *         is on it;
 *   V-26  the shell (launcher, bubbles, panel) carries the widget's `lang`;
 *   V-07  a conversation going on in this browser (`gs_active`) boots the
 *         runtime silently on the next page, and so does a publication on
 *         the visitor's presence channel (an operator wrote to them).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const RULE = '0c6b1c2e-1d2a-4e3b-9c4d-5e6f7a8b9c0d';
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Real time: the loader polls for the runtime every 150 ms. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const w = window as unknown as Record<string, unknown>;

type Mode = 'launcher_nudge' | 'open_widget' | 'home_card' | 'chat_message' | 'announcement';

function configFor(mode: Mode | null, over: Record<string, unknown> = {}) {
  return {
    enabled: true, features: { chat: true, visitorTracking: over.tracking === true }, primaryColor: '#3B82F6', templateId: 'default',
    locale: over.locale || 'fa', edition: 'iran',
    styleUrl: 'https://cdn.test/widget/runtime.0123abcd.css',
    runtimeUrl: 'https://cdn.test/widget/runtime.0123abcd.js',
    presentationRegistryUrl: 'https://cdn.test/widget/presentation-registry.0123abcd.js',
    presentationUrl: 'https://cdn.test/widget/presentation-default.0123abcd.js',
    presentationStyleUrl: 'https://cdn.test/widget/presentation-default.0123abcd.css',
    presentationFontsUrl: 'https://cdn.test/widget/presentation-default-fonts.0123abcd.css',
    ...(mode ? {
      smart: {
        enabled: true,
        engineUrl: 'https://cdn.test/widget/smart-engine.0123abcd.js',
        rules: [{ id: RULE, version: 1, priority: 1, presentation_config: { mode, dismissible: true }, behavior_config: { auto_hide_seconds: 1 } }],
      },
    } : {}),
  };
}

interface Instance {
  open: ReturnType<typeof vi.fn>;
  showSmart: ReturnType<typeof vi.fn>;
  hideSmart: ReturnType<typeof vi.fn>;
}

describe('the loader on a page where the widget is closed', () => {
  let init: ReturnType<typeof vi.fn>;
  let instance: Instance;
  let opened = false;
  let sockets: Array<{ onmessage: ((ev: { data: string }) => void) | null; onopen: (() => void) | null }> = [];

  // Every <script> and <link> the loader adds (the document's head, the
  // widget's shadow root) "loads" on the next tick, as a network answers.
  function watchAll() {
    const real = Node.prototype.appendChild;
    vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function (this: Node, node: Node) {
      const el = node as HTMLElement & { src?: string; href?: string; rel?: string };
      const url = el.src || el.href || '';
      if (el.tagName === 'SCRIPT' && /smart-engine/.test(url)) {
        w.__gs_smart_engine = {
          evaluateSmartRule: () => ({ outcome: 'matched', reasons: [] }),
          resolveSmartContent: () => ({ title: '', body: 'برای انتخاب سایز کمک می‌خواهید؟', cta_label: '' }),
          renderSmartTemplate: (s: string) => s,
          isSafeSmartUrl: () => true,
        };
      }
      if ((el.tagName === 'SCRIPT' || el.tagName === 'LINK') && el.rel !== 'preconnect') {
        setTimeout(() => {
          el.dispatchEvent(new Event('load'));
          const onload = (el as unknown as { onload?: () => void }).onload;
          if (typeof onload === 'function') onload();
        }, 0);
      }
      return real.call(this, node);
    } as never);
  }

  async function bootLoader(mode: Mode | null, over: Record<string, unknown> = {}) {
    w.__gs_id = WS;
    w.__gs_api_base = 'https://api.test';
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), headers: { get: () => null } });
    w.fetch = vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/widget/boot')) return json({ session_token: 't', workspace_id: WS, protocol: 3, availability: { state: 'online' }, config: configFor(mode, over) });
      if (u.includes('/api/widget/track')) return json({ session_id: '5e1d0c2b-0000-4000-8000-000000000001' });
      if (u.includes('/api/realtime/visitor-presence')) {
        return json({ vendor: 'centrifugo', presence: true, ws_url: 'wss://rt.test', token: 'tk', sub_token: 'st', channel: 'vp:v2:x:y' });
      }
      return json({});
    });
    watchAll();
    // The runtime's files define these as they run (here: before they "load").
    w.__gs_presentation_registry = { resolve: () => ({ globalKey: '__gs_presentation_x' }) };
    w.__gs_presentation_x = { prepare: () => Promise.resolve(), create: () => ({}) };
    instance = {
      open: vi.fn(() => { opened = true; return true; }),
      showSmart: vi.fn(() => true),
      hideSmart: vi.fn(),
    };
    init = vi.fn(() => ({
      ...instance,
      close() { opened = false; },
      toggle() { opened = !opened; },
      isOpen: () => opened,
      getSmartInteractionState: () => ({ widgetOpen: opened, conversationActive: false, callActive: false, prechatOpen: false, visitorTyping: false, visitorReplied: false }),
      onSmartInteractionChange: () => () => {},
    }));
    w.__gs_runtime = { init };
    new Function(LOADER).call(window);
    await tick(30);
    return document.querySelector('gs-widget')!.shadowRoot!;
  }

  const phone = (on: boolean) => {
    w.matchMedia = (q: string) => ({ matches: on && /max-width:640px/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  };

  // Each test's loader keeps its timers (the rule loop, the runtime poll):
  // they are tracked and stopped after the test, so none reaches the next one.
  let timers: unknown[] = [];
  beforeEach(() => {
    timers = [];
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const id = realTimeout(fn, ms);
      timers.push(id);
      return id;
    }) as never);
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const id = realInterval(fn, ms);
      timers.push(id);
      return id;
    }) as never);
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete w[key];
    try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom */ }
    document.cookie = 'gs_active=; path=/; max-age=0';
    opened = false;
    sockets = [];
    phone(false);
    class FakeSocket {
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1;
      constructor() { sockets.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
      send() {}
      close() {}
    }
    w.WebSocket = FakeSocket;
    // An idle page at once (scheduleDeferred).
    w.requestIdleCallback = (fn: () => void) => setTimeout(fn, 0);
  });
  afterEach(() => {
    for (const id of timers) { clearTimeout(id as never); clearInterval(id as never); }
    vi.restoreAllMocks();
  });

  for (const mode of ['home_card', 'chat_message', 'announcement'] as const) {
    it(`${mode}: waits in the panel and shows beside the launcher; the panel never opens by itself`, async () => {
      const root = await bootLoader(mode);
      await wait(400);
      // The runtime booted silently (no open), and holds the surface.
      expect(init).toHaveBeenCalledTimes(1);
      expect(instance.showSmart).toHaveBeenCalledWith(expect.objectContaining({ id: RULE, mode }));
      expect(instance.open).not.toHaveBeenCalled();
      const bubble = root.querySelector('.smart-nudge') as HTMLElement;
      expect(bubble).not.toBeNull();
      expect(bubble.textContent).toContain('برای انتخاب سایز');
      // A tap on the preview opens the panel, where the surface is.
      bubble.querySelector('.smart-body')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await tick(5);
      expect(instance.open).toHaveBeenCalledTimes(1);
      expect(instance.open.mock.calls[0][0]).not.toBe(true);
    });
  }

  it('the preview\'s dismiss takes the surface out of the panel too, and does not open it', async () => {
    const root = await bootLoader('home_card');
    await wait(400);
    (root.querySelector('[data-smart-dismiss]') as HTMLElement).click();
    await tick(5);
    expect(instance.hideSmart).toHaveBeenCalled();
    expect(instance.open).not.toHaveBeenCalled();
  });

  it('open_widget on a computer: opens, with the focus left where the visitor has it', async () => {
    await bootLoader('open_widget');
    await wait(400);
    expect(init).toHaveBeenCalledTimes(1);
    // The runtime loaded for the open, then opened it quietly (runtime.js
    // open(quiet): no focus move); never a plain, focus-taking open.
    expect(instance.open).toHaveBeenCalledTimes(1);
    expect(instance.open.mock.calls[0][0]).toBe(true);
  });

  it('open_widget on a phone: a bubble beside the launcher; the full-screen panel waits for a tap', async () => {
    phone(true);
    const root = await bootLoader('open_widget');
    await wait(200);
    expect(instance.open).not.toHaveBeenCalled();
    const bubble = root.querySelector('.smart-nudge') as HTMLElement;
    expect(bubble).not.toBeNull();
    bubble.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(200);
    expect(init).toHaveBeenCalled();
    // The visitor asked: a plain open (the focus goes into the panel).
    expect(instance.open.mock.calls[0][0]).not.toBe(true);
  });

  it('V-40: a bubble is a live region in the widget\'s language; it stays while hovered or focused', async () => {
    const root = await bootLoader('launcher_nudge');
    let bubble: HTMLElement | null = null;
    for (let i = 0; i < 50 && !bubble; i++) { await wait(10); bubble = root.querySelector('.smart-nudge'); }
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute('role')).toBe('status');
    expect(bubble!.lang).toBe('fa');
    expect(bubble!.dir).toBe('rtl');
    // Hovered past its 1 s: still there.
    bubble!.dispatchEvent(new Event('mouseenter'));
    await wait(1300);
    expect(root.querySelector('.smart-nudge:not(.leaving)')).not.toBeNull();
    // Left: it goes after its time; focus holds it the same way.
    bubble!.dispatchEvent(new Event('mouseleave'));
    bubble!.dispatchEvent(new Event('focusin'));
    await wait(1300);
    expect(root.querySelector('.smart-nudge:not(.leaving)')).not.toBeNull();
    bubble!.dispatchEvent(new Event('focusout'));
    await wait(1300);
    expect(root.querySelector('.smart-nudge:not(.leaving)')).toBeNull();
  }, 15_000);

  it('V-26: the shell carries the widget\'s language', async () => {
    const root = await bootLoader(null, { locale: 'tr' });
    expect((root.querySelector('.shell') as HTMLElement).lang).toBe('tr');
  });

  it('V-07: with a conversation going on in this browser, the next page boots the runtime silently', async () => {
    document.cookie = 'gs_active=1; path=/';
    await bootLoader(null);
    await tick(80);
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.open).not.toHaveBeenCalled();
  });

  it('V-07: without one, the runtime waits for an open', async () => {
    await bootLoader(null);
    await tick(80);
    expect(init).not.toHaveBeenCalled();
  });

  it('V-07: a publication on the visitor\'s presence channel (an operator wrote) boots the runtime silently', async () => {
    await bootLoader(null, { tracking: true });
    await tick(120);
    expect(init).not.toHaveBeenCalled();
    expect(sockets.length).toBeGreaterThan(0);
    const ws = sockets[sockets.length - 1];
    ws.onmessage!({ data: JSON.stringify({ push: { channel: 'vp:v2:x:y', pub: { data: { type: 'event', payload: { kind: 'wake' } } } } }) });
    await tick(60);
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.open).not.toHaveBeenCalled();
  });
});
