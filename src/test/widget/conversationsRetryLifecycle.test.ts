/**
 * P0 regression, review round 3 — Recent Conversations retry: bounded
 * exponential backoff.
 *
 * Round 2 fixed the render→load→render recursion and proved a fixed 15s
 * retry loop was recursion-free. This round replaces that fixed loop with
 * bounded exponential backoff (15s, 30s, 60s, 120s, capped at 300s) so a
 * sustained outage doesn't keep hammering the endpoint every 15 seconds
 * forever, while keeping every round-2 invariant intact: at most one
 * in-flight request, at most one pending timer, a genuine failure is never
 * reported as "no conversations", and manual Retry stays immediate.
 *
 * Boots the SHIPPED runtime.js + presentation-web-yar.js inside jsdom (same
 * harness as round 2) and proves, against REAL fetch call counts (never
 * internal state reads):
 *   - the exact 15/30/60/120/240/300(cap)-second schedule, boundary-exact
 *     (no retry at N-1ms, exactly one at Nms)
 *   - a success resets the failure counter — the NEXT failure, whenever it
 *     happens, starts again from 15s, never resuming from where it left off
 *   - manual Retry cancels the pending automatic timer, fires exactly one
 *     immediate request bypassing backoff, and — if it also fails — the
 *     NEXT automatic retry is computed from the (now incremented) failure
 *     count, with no duplicate timer left over from before the manual tap
 *   - a single huge time jump produces exactly the number of requests the
 *     schedule predicts — never more (no storm)
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
 * — the backoff-schedule tests switch to fake timers before boot. */
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
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
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

  it('a manual Retry tap bypasses backoff, makes exactly one more request, and clears the error on success without erasing anything', async () => {
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
});

describe('Recent Conversations — bounded exponential backoff schedule', () => {
  it('failures #1-#6 retry at exactly 15s, 30s, 60s, 120s, 240s, then cap at 300s — boundary-exact, never one tick early', async () => {
    // Fake timers must be active from BEFORE boot: scheduleConversationsRetry()'s
    // setTimeout is armed as soon as the first (failing) fetch settles,
    // which happens during the initial advance — if that setTimeout were
    // created under the real clock, switching to fake timers afterward
    // could never fast-forward it.
    vi.useFakeTimers();
    try {
      harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1); // failure #1

      // failure #1 -> retry after 15s
      await vi.advanceTimersByTimeAsync(14999);
      expect(harness.conversationsCallCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(2); // failure #2 just occurred

      // failure #2 -> retry after 30s
      await vi.advanceTimersByTimeAsync(29999);
      expect(harness.conversationsCallCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(3); // failure #3

      // failure #3 -> retry after 60s
      await vi.advanceTimersByTimeAsync(59999);
      expect(harness.conversationsCallCount()).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(4); // failure #4

      // failure #4 -> retry after 120s
      await vi.advanceTimersByTimeAsync(119999);
      expect(harness.conversationsCallCount()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(5); // failure #5

      // failure #5 -> retry after 240s (15000 * 2^4)
      await vi.advanceTimersByTimeAsync(239999);
      expect(harness.conversationsCallCount()).toBe(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(6); // failure #6

      // failure #6 -> the formula gives 480s, but the schedule caps at 300s
      await vi.advanceTimersByTimeAsync(299999);
      expect(harness.conversationsCallCount()).toBe(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(7); // failure #7

      // failure #7 and beyond stay capped at 300s, not growing further.
      await vi.advanceTimersByTimeAsync(299999);
      expect(harness.conversationsCallCount()).toBe(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a success resets the failure counter — a subsequent failure starts again from 15s, never resuming from a higher backoff', async () => {
    vi.useFakeTimers();
    try {
      // idx0 fail, idx1 (auto retry @15s) fail, idx2 (auto retry @15s+30s)
      // succeed, then a manual retry (idx3) fails again.
      let allowManualFailAfterSuccess = false;
      harness = boot((idx) => {
        if (idx === 2) {
          return jsonResponse({
            conversations: [{
              id: 'c1', status: 'open', updatedAt: new Date().toISOString(),
              preview: 'recovered', unreadCount: 0, lastMessageAt: new Date().toISOString(),
            }],
          });
        }
        if (idx === 3 && allowManualFailAfterSuccess) return jsonResponse({ error: 'Internal error' }, false, 500);
        return jsonResponse({ error: 'Internal error' }, false, 500);
      });
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1); // fail #1 (15s next)

      await vi.advanceTimersByTimeAsync(15000);
      expect(harness.conversationsCallCount()).toBe(2); // fail #2 (30s next)

      await vi.advanceTimersByTimeAsync(30000);
      expect(harness.conversationsCallCount()).toBe(3); // success — counter reset to 0
      expect(harness.bodyText()).toContain('recovered');
      expect(harness.bodyText()).not.toContain("Couldn't load conversations");

      // No timer should be pending after success — advancing well past
      // what would have been "failure #4's" 120s window must NOT fetch.
      await vi.advanceTimersByTimeAsync(200000);
      expect(harness.conversationsCallCount()).toBe(3);

      // Now trigger a fresh failure via manual retry (idx3 -> fail). This
      // is "the final failure" in the fail/fail/success/fail sequence.
      // No DOM retry affordance exists once conversations are showing
      // successfully (the button only renders in the error+empty state) —
      // use the test-only equivalent (__test.retryConversations), which
      // calls the exact same retryConversationsLoad() the button's click
      // handler calls.
      allowManualFailAfterSuccess = true;
      expect(harness.runtime.__test?.retryConversations).toBeTypeOf('function');
      harness.runtime.__test.retryConversations();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(4); // fail (post-reset failure #1 again)

      // Must schedule 15s (fresh start), NOT 60s/120s (which it would be
      // if the old pre-reset failure count had leaked through).
      await vi.advanceTimersByTimeAsync(14999);
      expect(harness.conversationsCallCount()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.conversationsCallCount()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual Retry cancels the pending automatic timer and the NEXT automatic retry is computed from the incremented failure count — no duplicate timer', async () => {
    vi.useFakeTimers();
    try {
      harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1); // failure #1, auto-retry armed for 15s

      // User manually retries well before the 15s auto-timer would fire.
      await vi.advanceTimersByTimeAsync(5000);
      const retryBtn = harness.shadow.querySelector('[data-home-action="conversations-retry"]') as HTMLButtonElement | null;
      expect(retryBtn).toBeTruthy();
      retryBtn!.click();
      await vi.advanceTimersByTimeAsync(0);
      // The manual tap made exactly one immediate request (no wait for the
      // remaining ~10s of the original 15s window).
      expect(harness.conversationsCallCount()).toBe(2); // manual retry also fails -> failure #2

      // If the original 15s timer had NOT been cancelled, it would still
      // fire at t=15000 (10s from now) — a stray, duplicate request. The
      // real next retry must come from failure count #2's 30s schedule,
      // counted from THIS moment (t=5000), i.e. at absolute t=35000, not
      // at the stale t=15000.
      await vi.advanceTimersByTimeAsync(9999); // absolute t=14999 — stale timer's moment, minus 1ms
      expect(harness.conversationsCallCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1); // absolute t=15000 — exactly where the cancelled timer would have fired
      expect(harness.conversationsCallCount()).toBe(2); // still 2 — proves the old timer was truly cancelled, not just superseded

      await vi.advanceTimersByTimeAsync(19999); // absolute t=34999
      expect(harness.conversationsCallCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1); // absolute t=35000 = 5000 (manual tap) + 30000 (failure #2's backoff)
      expect(harness.conversationsCallCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no storm: a single huge time jump produces exactly the number of requests the schedule predicts, never more', async () => {
    vi.useFakeTimers();
    try {
      harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1);

      // Predicted call times from t=0: 0, 15000, 45000, 105000, 225000,
      // 465000, 765000, 1065000, 1365000, 1665000, 1965000 (11 calls);
      // the 12th would land at 2265000, past this 2,000,000ms jump.
      await vi.advanceTimersByTimeAsync(2000000);
      expect(harness.conversationsCallCount()).toBe(11);

      // And never more than one in-flight request at a time throughout —
      // if the guard were broken, this jump alone would have produced a
      // burst far larger than 11 (a fixed setInterval-style storm at 15s
      // resolution over 2,000,000ms would be ~133 calls).
    } finally {
      vi.useRealTimers();
    }
  });

  it('an automatic retry defers while the tab is hidden and fires as soon as it becomes visible again — a manual retry still works immediately while hidden', async () => {
    vi.useFakeTimers();
    try {
      harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });

      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1); // failure #1, 15s auto-retry armed

      // The 15s window elapses, and well beyond it, while hidden — the
      // deferred auto-retry must not fire at all.
      await vi.advanceTimersByTimeAsync(60000);
      expect(harness.conversationsCallCount()).toBe(1);

      // Tab becomes visible again — the deferred retry fires immediately,
      // with no further wait (the hidden time already served as the delay).
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual Retry still fires immediately while the tab is hidden, ignoring the visibility defer entirely', async () => {
    vi.useFakeTimers();
    try {
      harness = boot(() => jsonResponse({ error: 'Internal error' }, false, 500));
      harness.runtime.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(1);

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      const retryBtn = harness.shadow.querySelector('[data-home-action="conversations-retry"]') as HTMLButtonElement | null;
      expect(retryBtn).toBeTruthy();
      retryBtn!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.conversationsCallCount()).toBe(2); // fired immediately despite being hidden
    } finally {
      vi.useRealTimers();
    }
  });
});
