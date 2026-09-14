/**
 * P0 regression, review round 2 — Recent Conversations retry lifecycle.
 *
 * The first fix (conversationsIdentitySecurity.test.ts, source-text only)
 * proved the SHAPE of the fix was present but did not prove the LIFECYCLE
 * was actually safe: a prior version of loadConversations()'s cooldown-skip
 * branch still invoked its `onDone` callback synchronously, and both
 * renderHome()/renderConversationList() (and, more importantly,
 * renderBodyInner() — the real dispatcher behind 15+ call sites) called
 * loadConversations() again from inside that very callback whenever the
 * store was still `loaded:false`. That is a textbook synchronous
 * render → load → render recursion, and it would blow the call stack the
 * moment GET /conversations returned anything but 200.
 *
 * This suite boots the SHIPPED runtime.js + presentation-web-yar.js inside
 * jsdom (same harness pattern as asyncLifecycle.test.ts /
 * offlineOnlineLifecycle.test.ts), mocks fetch to return a real 500 for
 * GET /api/widget/conversations, and proves the lifecycle end to end:
 *   - exactly one request on the failing first load (a recursion bug would
 *     never even reach the assertions — it throws "Maximum call stack size
 *     exceeded" synchronously during boot)
 *   - a real, distinguishable, localized error+retry state renders (never
 *     silently "No conversations yet")
 *   - a manual Retry tap bypasses the cooldown and makes exactly one more
 *     request, clearing the error on success
 *   - the automatic retry fires exactly once after the 15s cooldown, not
 *     before, and exactly once more per subsequent failure — never a storm
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
  shadow: ShadowRoot;
  bodyText: () => string;
  conversationsCallCount: () => number;
}

/** `conversationsHandler(callIndex)` decides the response for the Nth
 * (0-based) call to GET /api/widget/conversations. */
function boot(conversationsHandler: (callIndex: number) => ReturnType<typeof jsonResponse>): Harness {
  let conversationsCalls = 0;

  (window as any).__gs_mod_chat = {
    sendMessage() {},
    loadHistory() {},
    loadConversationHistory() {},
    startPolling() { return { stop() {} }; },
  };

  // ModuleLoader injects a <script src>; jsdom never fetches it, so fire
  // onload ourselves — the module global is already in place above.
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
    if (u.includes('/api/widget/conversations') && !u.includes('/read')) {
      const idx = conversationsCalls++;
      return Promise.resolve(conversationsHandler(idx));
    }
    if (u.includes('/api/realtime/connect')) {
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
    shadow,
    bodyText: () => (shadow.textContent || '').replace(/\s+/g, ' ').trim(),
    conversationsCallCount: () => conversationsCalls,
  };
}

/** Let queued microtasks + 0ms real timers run. Real-timer boot phase only
 * — the cooldown/retry tests switch to fake timers afterward. */
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  harness = null;
});

describe('Recent Conversations — retry lifecycle is recursion-free', () => {
  it('a 500 triggers exactly ONE request and reaches a real error state — a recursion bug would blow the stack before this assertion is ever reached', async () => {
    harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
    harness.runtime.open();
    await flush();

    expect(harness.conversationsCallCount()).toBe(1);
    expect(harness.bodyText()).toContain("Couldn't load conversations");
    // Never the genuine-empty-state copy — a failure must be distinguishable.
    expect(harness.bodyText()).not.toContain('No conversations yet');
  });

  it('a manual Retry tap bypasses the cooldown, makes exactly one more request, and clears the error on success without erasing anything', async () => {
    let succeed = false;
    harness = boot((idx) => {
      if (idx === 0 || !succeed) return jsonResponse({ error: 'Internal error' }, false, 500);
      return jsonResponse({
        conversations: [{
          id: 'c1', status: 'open', updatedAt: new Date().toISOString(),
          preview: 'hello from retry', unreadCount: 0, lastMessageAt: new Date().toISOString(),
        }],
      });
    });
    harness.runtime.open();
    await flush();
    expect(harness.conversationsCallCount()).toBe(1);
    expect(harness.bodyText()).toContain("Couldn't load conversations");

    succeed = true;
    const retryBtn = harness.shadow.querySelector('[data-home-action="conversations-retry"]') as HTMLButtonElement | null;
    expect(retryBtn).toBeTruthy();
    retryBtn!.click();
    await flush();

    expect(harness.conversationsCallCount()).toBe(2);
    expect(harness.bodyText()).not.toContain("Couldn't load conversations");
    expect(harness.bodyText()).toContain('hello from retry');
  });

  it('exactly one bounded automatic retry fires after the 15s cooldown, not before, and never more than one at a time', async () => {
    // Fake timers must be active from BEFORE boot: scheduleConversationsRetry()'s
    // setTimeout is armed as soon as the first (failing) fetch settles, which
    // happens during the initial flush — if that setTimeout were created
    // under the real clock, switching to fake timers afterward could never
    // fast-forward it (fake timers only govern timers created after they're
    // enabled).
    vi.useFakeTimers();
    try {
      harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(14999);
      expect(harness.conversationsCallCount()).toBe(1); // not yet — cooldown hasn't elapsed

      await vi.advanceTimersByTimeAsync(2);
      expect(harness.conversationsCallCount()).toBe(2); // exactly one automatic retry

      // Still failing: exactly one more retry per subsequent cooldown —
      // never a burst, however long we advance.
      await vi.advanceTimersByTimeAsync(15000);
      expect(harness.conversationsCallCount()).toBe(3);
      await vi.advanceTimersByTimeAsync(45000); // 3 cooldown windows in one jump
      expect(harness.conversationsCallCount()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the automatic retry succeeding renders the recovered list and stops retrying', async () => {
    vi.useFakeTimers();
    try {
      harness = boot((idx) => {
        if (idx === 0) return jsonResponse({ error: 'Internal error' }, false, 500);
        return jsonResponse({
          conversations: [{
            id: 'c1', status: 'open', updatedAt: new Date().toISOString(),
            preview: 'recovered thread', unreadCount: 0, lastMessageAt: new Date().toISOString(),
          }],
        });
      });
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(15000);
      expect(harness.conversationsCallCount()).toBe(2);
      expect(harness.bodyText()).not.toContain("Couldn't load conversations");
      expect(harness.bodyText()).toContain('recovered thread');

      // Success must disarm future retries — advancing well past another
      // cooldown window must not fetch again.
      await vi.advanceTimersByTimeAsync(60000);
      expect(harness.conversationsCallCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
