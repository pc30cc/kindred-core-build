/**
 * P0 — ACTUAL offline/online + visibility/focus lifecycle tests.
 *
 * Boots the SHIPPED runtime.js inside jsdom (same harness pattern as
 * asyncLifecycle.test.ts: a hand-controlled mock transport module + a real
 * Shadow DOM shell), then drives REAL browser `online`/`offline`,
 * `visibilitychange` and `focus` events through the window/document — not
 * internal test hooks — and asserts on the one thing that actually matters
 * in production: how many times the widget re-hits the network.
 *
 * Scope: the default resolved vendor here is `polling_builtin` (the
 * `/api/realtime/connect` resolver mock below returns it, same as every
 * other widget test in this repo that doesn't specifically load a
 * driver module). The centrifugo/supabase drivers' own reconnect/backoff
 * logic lives in separate files (runtime-rt-centrifugo.js /
 * runtime-rt-supabase.js) and is NOT exercised here — this suite proves
 * the vendor-agnostic guards in runtime.js itself:
 *   - a healthy ('connected') transport is never yanked by visibilitychange
 *     or focus (the documented WAKE_RECOVERABLE guard)
 *   - the browser 'offline' event is a pure state transition (no network
 *     call at all — nothing to storm)
 *   - the browser 'online' event does not itself force any re-resolve;
 *     recovery for the polling transport is exactly the next successful
 *     poll tick, never a burst of resolver calls
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

function loadAsset(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(read(path)).call(window);
}

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    blob: () => Promise.resolve(new Blob()),
    headers: { get: () => null },
  };
}

interface Harness {
  runtime: any;
  chat: {
    polls: any[];
  };
  realtimeConnectCalls: () => number;
}

function boot(): Harness {
  const chatState = { polls: [] as any[] };
  let realtimeConnectCalls = 0;

  (window as any).__gs_mod_chat = {
    sendMessage() {},
    loadHistory() {},
    loadConversationHistory() {},
    startPolling(opts: any) {
      chatState.polls.push(opts);
      return { stop() {} };
    },
  };

  const realAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: any) => {
    if (node && node.tagName === 'SCRIPT') {
      setTimeout(() => { if (typeof node.onload === 'function') node.onload(); }, 0);
      return node;
    }
    return realAppend(node);
  }) as any);

  (window as any).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/realtime/connect')) {
      realtimeConnectCalls++;
      return Promise.resolve(jsonResponse({ vendor: 'polling_builtin' }));
    }
    if (u.includes('/api/widget/identity/me')) {
      return Promise.resolve(jsonResponse({ identified: false, visitor: null }));
    }
    if (u.includes('/api/widget/ai-agent/intro')) {
      return Promise.resolve(jsonResponse({ sent: false }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  loadAsset('public/widget/presentation-registry.js');
  loadAsset('public/widget/presentation-web-yar.js');
  loadAsset('public/widget/runtime.js');

  const host = document.createElement('gs-widget-test');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = document.createElement('button');
  shadow.appendChild(launcher);

  const runtime = (window as any).__gs_runtime.init(
    {
      workspaceId: 'ws-test',
      _apiBase: 'https://api.test',
      _assetBase: 'https://cdn.test',
      _sessionToken: 'tok',
      locale: 'en',
      aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
      features: { chat: true },
      prechatEnabled: false,
    },
    { shadowRoot: shadow, shellEl: host, launcher, setUnread() {} },
  );

  return {
    runtime,
    chat: chatState,
    realtimeConnectCalls: () => realtimeConnectCalls,
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

let harness: Harness | null = null;

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  for (const key of Object.keys(window as any)) {
    if (key.startsWith('__gs')) delete (window as any)[key];
  }
  (window as any).__GS_WIDGET_TEST_HOOKS__ = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  harness = null;
});

describe('offline/online + visibility/focus — transport lifecycle guards', () => {
  it('connects exactly once on boot and reaches a healthy connected state on the first poll success', async () => {
    harness = boot();
    await flush();

    expect(harness.chat.polls.length).toBe(1);
    expect(harness.realtimeConnectCalls()).toBe(1);

    // Drive the mocked poll to a success — this is what flips the FSM to
    // 'connected' for the polling transport (see markPollSuccess()).
    harness.chat.polls[0].onTick(true);
    await flush();

    // Still exactly one resolver call — reaching "connected" must not by
    // itself trigger any further network negotiation.
    expect(harness.realtimeConnectCalls()).toBe(1);
  });

  it('a healthy connection is never torn down by visibilitychange or focus', async () => {
    harness = boot();
    await flush();
    harness.chat.polls[0].onTick(true);
    await flush();

    const connectCallsBeforeWake = harness.realtimeConnectCalls();
    const pollsBeforeWake = harness.chat.polls.length;

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    window.dispatchEvent(new Event('focus'));
    await flush();

    // Neither signal may force a reconnect while the transport is already
    // healthy — this is the documented WAKE_RECOVERABLE guard (runtime.js
    // deliberately excludes 'connected' from the set of states a wake
    // event is allowed to recover from).
    expect(harness.realtimeConnectCalls()).toBe(connectCallsBeforeWake);
    expect(harness.chat.polls.length).toBe(pollsBeforeWake);
  });

  it('rapid browser "offline" events are pure state transitions — no network call at all', async () => {
    harness = boot();
    await flush();
    harness.chat.polls[0].onTick(true);
    await flush();

    const connectCallsBefore = harness.realtimeConnectCalls();

    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event('offline'));
    }
    await flush();

    // "offline" only flips local state (handleBrowserOffline ->
    // setConnectionState('offline')); there is nothing here that could
    // ever fetch, so five rapid firings must produce zero network calls —
    // by construction there is no reconnect storm to guard against.
    expect(harness.realtimeConnectCalls()).toBe(connectCallsBefore);
  });

  it('"online" recovery for the polling transport is the next successful tick, not a burst of resolver calls', async () => {
    harness = boot();
    await flush();
    harness.chat.polls[0].onTick(true);
    await flush();

    window.dispatchEvent(new Event('offline'));
    await flush();
    const connectCallsAfterOffline = harness.realtimeConnectCalls();

    // Fire "online" — repeatedly, as a flapping connection would.
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event('online'));
    }
    await flush();

    // "online" alone (handleBrowserOnline) only marks the FSM
    // 'reconnecting' — it does not itself re-resolve the realtime vendor,
    // so no new /api/realtime/connect calls are expected from the event
    // itself, however many times it fires.
    expect(harness.realtimeConnectCalls()).toBe(connectCallsAfterOffline);

    // Recovery instead comes from the transport's own next successful
    // tick — exactly one, driven by the poll loop already in place, never
    // a new connect/resolve round-trip.
    harness.chat.polls[0].onTick(true);
    await flush();
    expect(harness.realtimeConnectCalls()).toBe(connectCallsAfterOffline);
    expect(harness.chat.polls.length).toBe(1);
  });
});
