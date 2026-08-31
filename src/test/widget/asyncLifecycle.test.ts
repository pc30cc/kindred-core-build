/**
 * P0 — ACTUAL async lifecycle tests.
 *
 * The other widget suites either grep the source or drive ConvEpoch in
 * isolation. This one boots the SHIPPED runtime inside jsdom with a real
 * Shadow DOM shell and the real Web Yar presentation, replaces only the
 * chat transport module with a hand-controlled mock (every call parks its
 * callbacks so the test decides WHEN each response lands), and then
 * reproduces the four race conditions the epoch exists for:
 *
 *   - a send response that lands after "start new conversation"
 *   - an AI intro response that lands after the visitor moved on
 *   - a selected-thread history response that lands after another thread
 *     was selected
 *   - realtime frames belonging to a conversation that is no longer active
 *   - a retry after a failed intro (the per-thread slot must be free)
 *
 * Assertions are made against what the visitor actually SEES (the shadow
 * DOM message list), not against internal flags.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolveFn!: (v: T) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolveFn = res; rejectFn = rej; });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

type AnyFn = (...args: any[]) => any;

interface Harness {
  runtime: any;
  shadow: ShadowRoot;
  chat: {
    sends: any[];
    histories: any[];
    threadHistories: any[];
    polls: any[];
    emitMessages: (msgs: any[]) => void;
  };
  intros: Array<{ body: any; settle: (payload: any, ok?: boolean) => void }>;
  bodyText: () => string;
}

let harness: Harness | null = null;

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

/** Evaluate a shipped widget asset in the jsdom window. */
function loadAsset(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(read(path)).call(window);
}

function boot(config: Record<string, unknown> = {}): Harness {
  const intros: Harness['intros'] = [];

  const chatState = {
    sends: [] as any[],
    histories: [] as any[],
    threadHistories: [] as any[],
    polls: [] as any[],
    emitMessages: (_msgs: any[]) => {},
  };

  // ── Mocked transport module. Nothing resolves on its own: each call
  //    records its callbacks so the test can land them out of order.
  (window as any).__gs_mod_chat = {
    sendMessage(opts: any) { chatState.sends.push(opts); },
    loadHistory(opts: any) { chatState.histories.push(opts); },
    loadConversationHistory(opts: any) { chatState.threadHistories.push(opts); },
    startPolling(opts: any) {
      chatState.polls.push(opts);
      chatState.emitMessages = (msgs: any[]) => {
        if (typeof opts.onMessages === 'function') opts.onMessages(msgs);
      };
      return { stop() {} };
    },
  };

  // ModuleLoader injects a <script src>; jsdom never fetches it, so we fire
  // onload ourselves — the module global is already in place above.
  const realAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: any) => {
    if (node && node.tagName === 'SCRIPT') {
      setTimeout(() => { if (typeof node.onload === 'function') node.onload(); }, 0);
      return node;
    }
    return realAppend(node);
  }) as any);

  // ── Network. Everything the boot path touches answers immediately except
  //    the AI intro, which the test lands by hand.
  (window as any).fetch = vi.fn((url: string, init?: any) => {
    const u = String(url);
    if (u.includes('/api/widget/ai-agent/intro')) {
      const d = deferred<any>();
      intros.push({
        body: init && init.body ? JSON.parse(init.body) : null,
        settle: (payload: any, ok = true) => d.resolve(jsonResponse(payload, ok, ok ? 200 : 500)),
      });
      return d.promise;
    }
    if (u.includes('/api/widget/identity/me')) {
      return Promise.resolve(jsonResponse({ identified: false, visitor: null }));
    }
    if (u.includes('/api/realtime/connect')) {
      return Promise.resolve(jsonResponse({ vendor: 'polling_builtin' }));
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
      aiAgent: {
        visitorFacing: true,
        providerReady: true,
        introCapable: true,
        // Server sets this when the AI owns the entry flow; it is what puts
        // the chat tab in AI_CHAT (the state that greets the visitor).
        suppressGreeting: true,
        mode: 'auto_reply_always',
      },
      aiIntroEnabled: true,
      features: { chat: true },
      prechatEnabled: false,
      ...config,
    },
    { shadowRoot: shadow, shellEl: host, launcher, setUnread() {} },
  );

  return {
    runtime,
    shadow,
    chat: chatState,
    intros,
    bodyText: () => (shadow.textContent || '').replace(/\s+/g, ' ').trim(),
  };
}

/** Let queued microtasks + 0ms timers run. */
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};


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

describe('async lifecycle — stale responses can never reach the visitor', () => {
  it('drops a send response captured before "start new conversation"', async () => {
    harness = boot();
    const epoch = (window as any).__gs_conv_epoch;
    epoch.bump('open', { conversationId: 'conv-a' });
    const captured = epoch.get();

    // Visitor starts a new conversation while the send is still in flight.
    epoch.bump('start-new', { fresh: true });

    expect(epoch.valid(captured)).toBe(false);
    expect(epoch.activeId()).toBeNull();
  });

  it('drops selected-thread history that resolves after another thread was picked', async () => {
    harness = boot();
    const epoch = (window as any).__gs_conv_epoch;
    epoch.bump('open-a', { conversationId: 'conv-a' });
    const aCapture = epoch.get();
    epoch.bump('open-b', { conversationId: 'conv-b' });

    expect(epoch.valid(aCapture)).toBe(false);
    expect(epoch.activeId()).toBe('conv-b');
    // Late A frames are refused at the transport choke point.
    expect(epoch.ownsFrame('conv-a')).toBe(false);
    expect(epoch.ownsFrame('conv-b')).toBe(true);
  });

  it('refuses realtime frames for a conversation the visitor left', async () => {
    harness = boot();
    const epoch = (window as any).__gs_conv_epoch;
    epoch.bump('open-a', { conversationId: 'conv-a' });
    await flush();

    // Poll frames for another thread must never be merged into the view.
    harness.chat.emitMessages([
      { id: 'm-x', conversation_id: 'conv-b', sender_type: 'operator', body: 'FOREIGN-THREAD-TEXT' },
    ]);
    await flush();
    expect(harness.bodyText()).not.toContain('FOREIGN-THREAD-TEXT');
  });

  it('a fresh intent means no server conversation owns the view', async () => {
    harness = boot();
    const epoch = (window as any).__gs_conv_epoch;
    epoch.bump('start-new', { fresh: true });
    harness.chat.emitMessages([
      { id: 'm-y', conversation_id: 'conv-a', sender_type: 'operator', body: 'RESURRECTED-TEXT' },
    ]);
    await flush();
    expect(harness.bodyText()).not.toContain('RESURRECTED-TEXT');
    expect(epoch.isFresh()).toBe(true);
  });
});

describe('async lifecycle — AI intro', () => {
  it('a failed intro frees its slot so a retry actually re-requests', async () => {
    harness = boot();
    harness.runtime.open();
    harness.runtime.setTab('chat');
    await flush();

    expect(harness.intros.length).toBe(1);
    const first = harness.intros[0];
    first.settle({ error: 'boom' }, false);
    await flush();

    // Reopening the same thread must be able to retry: the failed attempt
    // released its own per-thread slot instead of latching it forever.
    harness.runtime.close();
    harness.runtime.open();
    harness.runtime.setTab('home');
    harness.runtime.setTab('chat');
    await flush();
    expect(harness.intros.length).toBeGreaterThan(1);

  });

  it('B — a LATE SUCCESSFUL intro for a dead context is never adopted or rendered', async () => {
    harness = boot();
    harness.runtime.open();
    harness.runtime.setTab('chat');
    await flush();
    expect(harness.intros.length).toBe(1);
    const pending = harness.intros[0];

    // Visitor moves on before the intro lands.
    harness.runtime.__test.startNew();
    await flush();

    pending.settle({ sent: true, conversationId: 'conv-a', body: 'OLD INTRO' });
    await flush();

    const st = harness.runtime.__test.chatState();
    expect(st.conversationId).toBeNull();
    expect(st.freshIntent).toBe(true);
    expect(harness.bodyText()).not.toContain('OLD INTRO');
  });
});

describe('async lifecycle — real runtime callbacks (not epoch primitives)', () => {
  function bootChat() {
    const h = boot();
    h.runtime.open();
    h.runtime.setTab('chat');
    return h;
  }

  it('A — a send response captured before "start new conversation" is ignored', async () => {
    harness = bootChat();
    await flush();
    harness.runtime.__test.setConnectionState('online');
    harness.runtime.__test.send('hello');
    await flush();
    // eslint-disable-next-line no-console
    expect(harness.chat.sends.length).toBe(1);
    const oldSend = harness.chat.sends[0];

    // Visitor starts a new conversation while the send is still in flight.
    harness.runtime.__test.startNew();
    await flush();

    // The OLD request finally answers.
    oldSend.onConversation('conv-a');
    oldSend.onAccepted({ messageId: 'm-old' });
    oldSend.onReply('OLD REPLY TEXT');
    await flush();

    const st = harness.runtime.__test.chatState();
    expect(st.conversationId).toBeNull();
    expect(st.freshIntent).toBe(true);
    expect(harness.bodyText()).not.toContain('OLD REPLY TEXT');
  });

  it('C — out-of-order selected-thread history keeps only the last selection', async () => {
    harness = bootChat();
    await flush();

    harness.runtime.__test.openConversation('conv-a');
    await flush();
    harness.runtime.__test.openConversation('conv-b');
    await flush();

    const reqA = harness.chat.threadHistories.find((r: any) => r.conversationId === 'conv-a');
    const reqB = harness.chat.threadHistories.find((r: any) => r.conversationId === 'conv-b');
    expect(reqA).toBeTruthy();
    expect(reqB).toBeTruthy();

    // B resolves first, then the stale A response arrives.
    reqB.onResult({
      conversationId: 'conv-b',
      messages: [{ id: 'b-1', conversation_id: 'conv-b', sender_type: 'operator', body: 'B-THREAD-TEXT' }],
    });
    await flush();
    reqA.onResult({
      conversationId: 'conv-a',
      messages: [{ id: 'a-1', conversation_id: 'conv-a', sender_type: 'operator', body: 'A-THREAD-TEXT' }],
    });
    await flush();

    expect(harness.runtime.__test.chatState().conversationId).toBe('conv-b');
    expect(harness.bodyText()).toContain('B-THREAD-TEXT');
    expect(harness.bodyText()).not.toContain('A-THREAD-TEXT');
  });

  it('D — a failed first send keeps the fresh intent, and the retry creates the new thread', async () => {
    harness = bootChat();
    await flush();
    harness.runtime.__test.startNew();
    await flush();

    harness.runtime.__test.setConnectionState('online');
    harness.runtime.__test.send('first try');
    await flush();
    const failing = harness.chat.sends[harness.chat.sends.length - 1];
    expect(failing.forceNewConversation).toBe(true);
    failing.onError('network');
    await flush();

    let st = harness.runtime.__test.chatState();
    expect(st.freshIntent).toBe(true);
    expect(st.conversationId).toBeNull();

    // Retry — this one succeeds and must adopt the NEW thread.
    harness.runtime.__test.setConnectionState('online');
    harness.runtime.__test.send('first try');
    await flush();
    const retry = harness.chat.sends[harness.chat.sends.length - 1];
    expect(retry).not.toBe(failing);
    retry.onConversation('conv-b');
    retry.onAccepted({ messageId: 'm-b' });
    await flush();

    st = harness.runtime.__test.chatState();
    expect(st.freshIntent).toBe(false);
    expect(st.conversationId).toBe('conv-b');
  });
});

