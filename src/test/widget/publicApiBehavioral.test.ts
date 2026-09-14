/**
 * P0 — ACTUAL loader.js public-API behavioral tests.
 *
 * asyncLifecycle.test.ts boots runtime.js directly via
 * window.__gs_runtime.init(...), bypassing loader.js entirely. This suite
 * boots the SHIPPED loader.js inside jsdom instead — the layer that owns
 * window.__gs (the command queue), the placeholder-then-real widgetApi
 * handoff, and the getState()/isOpen() callback contract — and proves
 * behavior, not source strings:
 *
 *   - commands pushed before the widget is ready are queued and replayed
 *   - onReady fires, including late registration after ready
 *   - onOpen/onClose fire exactly once per real state transition
 *   - getState()/isOpen() callbacks receive the correct state before/after
 *     open()/close()/show()/hide()
 *   - a second loader injection is a no-op (no duplicate listeners)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER_SRC = read('public/widget/loader.js');

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

/** Let queued microtasks + 0ms timers (fetch chains, script onload) run. */
const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** Auto-fire onload for injected <script>/<link> tags — jsdom never
 *  actually fetches src'd assets, so the loader's asset-loading chain
 *  (runtime.css / runtime.js / presentation registry+renderer) would hang
 *  forever waiting for onload otherwise. */
function autoLoad(node: any) {
  if (!node || (node.tagName !== 'SCRIPT' && node.tagName !== 'LINK')) return;
  // The optional call-module sidecar script is intentionally left "in
  // flight" (never resolved) — it's fire-and-forget non-blocking
  // infrastructure the loader itself never awaits for readiness, and
  // firing its onload here without a real window.__gs_call implementation
  // only produces an unhandled rejection unrelated to what this suite
  // tests (the public command/event API).
  if (node.getAttribute && node.getAttribute('data-gs-runtime-call') === 'true') return;
  setTimeout(() => { if (typeof node.onload === 'function') node.onload(); }, 0);
}

function patchAppendChild(target: any) {
  const real = target.appendChild.bind(target);
  return vi.spyOn(target, 'appendChild').mockImplementation((node: any) => {
    autoLoad(node);
    return real(node);
  });
}

const BOOTSTRAP_RESPONSE = {
  session_token: 'tok-1',
  workspace_id: 'ws-test',
  is_new_visitor: false,
  availability: { state: 'online' },
};

const CONFIG_RESPONSE = {
  enabled: true,
  features: { chat: true },
  primaryColor: '#3B82F6',
  styleUrl: 'https://cdn.test/runtime.css',
  runtimeUrl: 'https://cdn.test/runtime.js',
  presentationRegistryUrl: 'https://cdn.test/presentation-registry.js',
  presentationUrl: 'https://cdn.test/presentation-web-yar.js',
  presentationStyleUrl: 'https://cdn.test/presentation.css',
  templateId: 'web-yar',
};

interface Harness {
  gs: any;
  fakeRuntimeInstance: {
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
    isOpen: () => boolean;
    _open: boolean;
  };
}

/** Boots loader.js in the current jsdom window and waits for it to reach
 *  the "ready" (bootstrapped, config loaded, placeholder widgetApi live)
 *  state. */
async function bootLoader(): Promise<void> {
  (window as any).__gs_id = 'ws-test';
  (window as any).__gs_api_base = 'https://api.test';

  patchAppendChild(document.head);

  (window as any).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse(BOOTSTRAP_RESPONSE));
    if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse(CONFIG_RESPONSE));
    return Promise.resolve(jsonResponse({}));
  });

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LOADER_SRC).call(window);
  await flush();
}

/** Wires a fake window.__gs_runtime and drives the loader through
 *  loadRuntimeAssets() -> initRuntime() so open()/close() exercise the
 *  REAL widgetApi handoff (not the pre-runtime placeholder). */
function installFakeRuntime(): Harness['fakeRuntimeInstance'] {
  const instance = {
    _open: false,
    open: vi.fn(function (this: any) { instance._open = true; }),
    close: vi.fn(function (this: any) { instance._open = false; }),
    toggle: vi.fn(function (this: any) { instance._open = !instance._open; }),
    isOpen: () => instance._open,
  };
  (window as any).__gs_runtime = { init: vi.fn(() => instance) };
  // shadowRoot.appendChild(link) needs the same onload auto-fire as
  // document.head — grab the live shell now that mountShell() has run.
  const shell = document.querySelector('gs-widget') as any;
  if (shell && shell.shadowRoot) patchAppendChild(shell.shadowRoot);
  return instance;
}

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.head.querySelectorAll('script,link,style').forEach((n) => {
    if ((n as any).id !== undefined || n.tagName) n.remove();
  });
  for (const key of Object.keys(window as any)) {
    if (key.indexOf('__gs') === 0) delete (window as any)[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loader.js public API — window.__gs queue + widgetApi', () => {
  it('replays commands pushed before the widget is ready, in order', async () => {
    const calls: string[] = [];
    (window as any).__gs = [
      ['onReady', () => calls.push('ready')],
      ['onUnreadChange', (n: number) => calls.push('unread:' + n)],
      ['setUnread', 5],
    ];
    await bootLoader();

    expect(calls[0]).toBe('ready');
    // Registration (onUnreadChange) ran before the command that triggers
    // the event (setUnread) because both were replayed in push order —
    // proving the queue is FIFO, not just "eventually all runs".
    expect(calls).toContain('unread:5');
    expect(calls.indexOf('unread:5')).toBeGreaterThan(calls.indexOf('ready'));
  });

  it('onReady fires immediately when registered after the widget is already ready', async () => {
    await bootLoader();
    let firedSync = false;
    (window as any).__gs.push(['onReady', () => { firedSync = true; }]);
    expect(firedSync).toBe(true);
  });

  it('getState()/isOpen() callback returns correct state before/after open, close, show, hide', async () => {
    await bootLoader();
    const runtime = installFakeRuntime();

    const states: any[] = [];
    const read = () => new Promise<any>((res) => (window as any).__gs.push(['getState', res]));

    states.push(await read());
    expect(states[0]).toEqual({ ready: true, open: false, visible: true, unread: 0 });

    (window as any).__gs.push(['open']);
    await flush();
    expect(runtime.open).toHaveBeenCalledTimes(1);
    states.push(await read());
    expect(states[1].open).toBe(true);
    expect(states[1].ready).toBe(true);

    // isOpen is the same callback contract, shorthand for the same payload.
    const viaIsOpen = await new Promise<any>((res) => (window as any).__gs.push(['isOpen', res]));
    expect(viaIsOpen.open).toBe(true);

    (window as any).__gs.push(['close']);
    await flush();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    states.push(await read());
    expect(states[2].open).toBe(false);

    (window as any).__gs.push(['setUnread', 3]);
    states.push(await read());
    expect(states[3].unread).toBe(3);

    (window as any).__gs.push(['hide']);
    await flush();
    states.push(await read());
    expect(states[4].visible).toBe(false);
    expect(states[4].open).toBe(false); // hide() also closes the panel

    (window as any).__gs.push(['show']);
    states.push(await read());
    expect(states[5].visible).toBe(true);
  });

  it('onOpen/onClose fire exactly once per real transition, never on no-ops', async () => {
    await bootLoader();
    const runtime = installFakeRuntime();
    let opens = 0;
    let closes = 0;
    (window as any).__gs.push(['onOpen', () => { opens++; }]);
    (window as any).__gs.push(['onClose', () => { closes++; }]);

    (window as any).__gs.push(['open']);
    await flush();
    expect(opens).toBe(1);
    expect(closes).toBe(0);

    // toggle() while already open -> closes.
    (window as any).__gs.push(['toggle']);
    await flush();
    expect(opens).toBe(1);
    expect(closes).toBe(1);

    // close() again while already closed must NOT re-fire onClose — the
    // loader only emits on an actual isOpen flip (syncOpenStateFromRuntime).
    (window as any).__gs.push(['close']);
    await flush();
    expect(closes).toBe(1);
    expect(runtime.close).toHaveBeenCalled();
  });

  it('duplicate loader injection is a no-op and does not duplicate listeners', async () => {
    await bootLoader();
    const shellsAfterFirst = document.querySelectorAll('gs-widget').length;
    expect(shellsAfterFirst).toBe(1);

    let readyCount = 0;
    (window as any).__gs.push(['onReady', () => { readyCount++; }]);
    expect(readyCount).toBe(1);

    // Second injection: loader.js re-executed (e.g. a second <script> tag,
    // or an SPA re-mounting it). window.__gs_loaded guards this.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(LOADER_SRC).call(window);
    await flush();

    expect(document.querySelectorAll('gs-widget').length).toBe(1);
    // The existing onReady listener must not have been re-invoked or
    // duplicated by the second (no-op) execution.
    expect(readyCount).toBe(1);

    // The singleton instance's queue/API must still work after the
    // duplicate injection attempt.
    let stateSeen: any = null;
    (window as any).__gs.push(['getState', (s: any) => { stateSeen = s; }]);
    expect(stateSeen).toEqual({ ready: true, open: false, visible: true, unread: 0 });
  });

  it('unreadchange fires with the current count and getState reflects it without a runtime', async () => {
    await bootLoader();
    let lastUnread: number | null = null;
    (window as any).__gs.push(['onUnreadChange', (n: number) => { lastUnread = n; }]);
    (window as any).__gs.push(['setUnread', 7]);
    expect(lastUnread).toBe(7);

    const state = await new Promise<any>((res) => (window as any).__gs.push(['getState', res]));
    expect(state.unread).toBe(7);
  });
});
