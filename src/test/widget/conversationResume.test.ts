/**
 * Conversation continuity across a reload.
 *
 * A visitor who is mid-conversation and refreshes the page — or closes the
 * widget and opens it again — used to be dropped back on the home surface,
 * because the active surface and thread lived in memory only. These tests
 * boot the SHIPPED runtime.js + presentation in jsdom and assert on what
 * the visitor actually ends up looking at, plus the real fetch calls made
 * on their behalf.
 *
 * The rule under test: as long as the thread is still live (`open` or
 * `pending` per the server's own list), every reload lands back in THAT
 * thread. A terminal thread (`resolved` / `closed`) sends them home.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

function loadAsset(path: string) {
  new Function(read(path)).call(window);
}

/** The widget publishes and reads a handful of `__gs*` globals. */
const win = window as unknown as Record<string, unknown>;

type HistoryResult = { conversationId: string | null; messages: unknown[] };
type ChatModuleCall = { conversationId: string; onResult: (r: HistoryResult) => void };
type ContinuationCall = { onResult: (r: HistoryResult) => void };

interface RuntimeInstance {
  open: () => boolean;
  close: () => boolean;
  setTab: (key: string) => void;
}

interface RuntimeGlobal {
  init: (config: Record<string, unknown>, shell: Record<string, unknown>) => RuntimeInstance;
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

const VIEW_KEY = 'gs:view:ws-test';

type Conversation = { id: string; status: string };

interface BootOpts {
  /** Thread list the server reports for this visitor. */
  conversations?: Conversation[];
  /** Make GET /conversations fail outright. */
  conversationsFail?: boolean;
  /** Conversation id the smart-continuation endpoint would pick on its own. */
  serverContinuation?: string | null;
  /** Open the panel before booting (default: stays closed). */
  open?: boolean;
}

interface Harness {
  runtime: RuntimeInstance;
  shadow: ShadowRoot;
  bodyText: () => string;
  /** Conversation ids explicitly loaded via the thread-scoped history call. */
  explicitHistoryLoads: () => string[];
  /** Did the generic "what is my latest thread" continuation run? */
  smartContinuationCalls: () => number;
  /** Conversation ids whose durable read marker was POSTed. */
  readMarkers: () => string[];
  storedHint: () => { tab?: string; conversationId?: string | null } | null;
}

function boot(opts: BootOpts = {}): Harness {
  const conversations = opts.conversations ?? [];
  const explicitLoads: string[] = [];
  const readMarkers: string[] = [];
  let smartCalls = 0;

  const messagesFor = (cid: string) => [
    { id: cid + '-m1', role: 'visitor', text: 'hello from ' + cid, time: new Date().toISOString() },
    { id: cid + '-m2', role: 'agent', text: 'reply inside ' + cid, time: new Date().toISOString() },
  ];

  win.__gs_mod_chat = {
    sendMessage() {},
    loadHistory(o: ContinuationCall) {
      smartCalls++;
      const cid = opts.serverContinuation ?? null;
      o.onResult({ conversationId: cid, messages: cid ? messagesFor(cid) : [] });
    },
    loadConversationHistory(o: ChatModuleCall) {
      explicitLoads.push(o.conversationId);
      o.onResult({ conversationId: o.conversationId, messages: messagesFor(o.conversationId) });
    },
    startPolling() { return { stop() {} }; },
  };

  const realAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const script = node as unknown as HTMLScriptElement;
    if (script && script.tagName === 'SCRIPT') {
      setTimeout(() => { if (typeof script.onload === 'function') script.onload(new Event('load')); }, 0);
      return node;
    }
    return realAppend(node);
  });

  win.fetch = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/widget/conversations') && u.includes('/read')) {
      const m = u.match(/conversations\/([^/]+)\/read/);
      if (m) readMarkers.push(decodeURIComponent(m[1]));
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (u.includes('/api/widget/conversations')) {
      if (opts.conversationsFail) return Promise.resolve(jsonResponse({ error: 'boom' }, false, 500));
      return Promise.resolve(jsonResponse({
        conversations: conversations.map((c) => ({
          id: c.id,
          status: c.status,
          preview: 'preview ' + c.id,
          unreadCount: 0,
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
        })),
      }));
    }
    if (u.includes('/api/realtime/connect')) return Promise.resolve(jsonResponse({ vendor: 'polling_builtin' }));
    if (u.includes('/api/widget/identity/me')) return Promise.resolve(jsonResponse({ identified: false, visitor: null }));
    if (u.includes('/api/widget/ai-agent/intro')) return Promise.resolve(jsonResponse({ sent: false }));
    void init;
    return Promise.resolve(jsonResponse({}));
  });

  loadAsset('public/widget/presentation-registry.js');
  loadAsset('public/widget/presentation-default.js');
  loadAsset('public/widget/runtime.js');

  const host = document.createElement('gs-widget-test');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = document.createElement('button');
  shadow.appendChild(launcher);

  const runtime = (win.__gs_runtime as RuntimeGlobal).init(
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
  if (opts.open) runtime.open();

  return {
    runtime,
    shadow,
    bodyText: () => (shadow.textContent || '').replace(/\s+/g, ' ').trim(),
    explicitHistoryLoads: () => explicitLoads,
    smartContinuationCalls: () => smartCalls,
    readMarkers: () => readMarkers,
    storedHint: () => {
      try {
        const raw = sessionStorage.getItem(VIEW_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Writes the hint a previous page load would have left behind. */
function seedHint(tab: string, conversationId: string | null) {
  sessionStorage.setItem(VIEW_KEY, JSON.stringify({ tab, conversationId }));
}

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  sessionStorage.clear();
  for (const key of Object.keys(win)) {
    if (key.startsWith('__gs')) delete win[key];
  }
  win.__GS_WIDGET_TEST_HOOKS__ = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reload lands back in a live conversation', () => {
  it('restores the exact thread the visitor was in', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({
      conversations: [{ id: 'conv-A', status: 'open' }, { id: 'conv-B', status: 'open' }],
      // The server's own continuation would have picked a DIFFERENT thread.
      serverContinuation: 'conv-B',
      open: true,
    });
    await flush();

    // The visitor is looking at their thread, not the front door.
    expect(h.bodyText()).toContain('reply inside conv-A');
    expect(h.bodyText()).not.toContain('conv-B');
    // Loaded by explicit thread id — never whatever the server felt like.
    expect(h.explicitHistoryLoads()).toEqual(['conv-A']);
    expect(h.smartContinuationCalls()).toBe(0);
  });

  it('a pending thread is live too', async () => {
    seedHint('chat', 'conv-P');
    const h = boot({ conversations: [{ id: 'conv-P', status: 'pending' }], open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual(['conv-P']);
    expect(h.bodyText()).toContain('reply inside conv-P');
  });

  it('survives a thread-list failure rather than evicting the visitor', async () => {
    // We could not verify the status — keeping them in their conversation
    // beats throwing them out over one flaky request.
    seedHint('chat', 'conv-A');
    const h = boot({ conversationsFail: true, open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual(['conv-A']);
  });
});

describe('a closed conversation sends the visitor home', () => {
  it('does not restore a resolved thread', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'resolved' }], open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
    expect(h.bodyText()).not.toContain('reply inside conv-A');
  });

  it('does not restore a closed thread', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'closed' }], open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
  });

  it('does not restore a thread the visitor no longer has', async () => {
    seedHint('chat', 'conv-GONE');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'open' }], open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
  });
});

describe('a live conversation continues in a brand-new tab', () => {
  it('lands in the most recent live thread with no hint at all', async () => {
    const h = boot({
      conversations: [{ id: 'conv-B', status: 'open' }, { id: 'conv-A', status: 'open' }],
      open: true,
    });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual(['conv-B']);
    expect(h.bodyText()).toContain('reply inside conv-B');
  });

  it('stays on home when every thread is closed', async () => {
    const h = boot({
      conversations: [{ id: 'conv-A', status: 'resolved' }, { id: 'conv-B', status: 'closed' }],
      open: true,
    });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
  });

  it('stays on home when the thread list could not be loaded', async () => {
    // Volunteering a surface the visitor did not ask for needs positive
    // proof, unlike the hint path which must not evict them on a bad request.
    const h = boot({ conversationsFail: true, open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
  });
});

describe('only the chat surface is restored', () => {
  it('a visitor who navigated back to home still gets home', async () => {
    seedHint('home', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'open' }], open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
  });

  it('a first-ever visit is untouched by any of this', async () => {
    const h = boot({ conversations: [], open: true });
    await flush();
    expect(h.explicitHistoryLoads()).toEqual([]);
    // Cold boot still runs the normal smart-continuation path.
    expect(h.smartContinuationCalls()).toBe(1);
  });
});

describe('the hint is written as the visitor moves', () => {
  it('records the chat surface and its thread once one is open', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'open' }], open: true });
    await flush();
    const hint = h.storedHint();
    expect(hint?.tab).toBe('chat');
    expect(hint?.conversationId).toBe('conv-A');
  });

  it('stores no conversation id for a visitor who never opened one', async () => {
    const h = boot({ conversations: [], open: true });
    await flush();
    const hint = h.storedHint();
    expect(hint?.conversationId ?? null).toBeNull();
  });
});

describe('restoring behind a closed panel does not consume the unread badge', () => {
  it('defers the read marker until the visitor actually opens the widget', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'open' }], open: false });
    await flush();

    // Thread restored, but the visitor has not looked at it yet.
    expect(h.explicitHistoryLoads()).toEqual(['conv-A']);
    expect(h.readMarkers()).toEqual([]);

    h.runtime.open();
    await flush();
    expect(h.readMarkers()).toEqual(['conv-A']);
  });

  it('marks it read immediately when the panel is already open', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'open' }], open: true });
    await flush();
    expect(h.readMarkers()).toEqual(['conv-A']);
  });
});

describe('the round trip the visitor actually performs', () => {
  it('closing and reopening the widget keeps them in the conversation', async () => {
    seedHint('chat', 'conv-A');
    const h = boot({ conversations: [{ id: 'conv-A', status: 'open' }], open: true });
    await flush();
    expect(h.bodyText()).toContain('reply inside conv-A');

    h.runtime.close();
    h.runtime.open();
    await flush();

    // Same thread, and no second load — the surface never went home.
    expect(h.bodyText()).toContain('reply inside conv-A');
    expect(h.explicitHistoryLoads()).toEqual(['conv-A']);
  });

  it('a genuine reload re-enters the thread the visitor chose, not the newest one', async () => {
    // Two live threads. Left alone, a hintless boot resumes the most recent
    // one (conv-B) — so picking conv-A by hand and getting conv-A back after
    // a reload can only be the per-tab hint doing its job.
    const first = boot({
      conversations: [{ id: 'conv-B', status: 'open' }, { id: 'conv-A', status: 'open' }],
      open: true,
    });
    await flush();
    expect(first.explicitHistoryLoads()).toEqual(['conv-B']);

    // The visitor walks back out to the thread list and picks the other one.
    first.runtime.setTab('list');
    await flush();
    const row = first.shadow.querySelector('[data-conversation-open="conv-A"]');
    expect(row).not.toBeNull();
    (row as HTMLElement).click();
    await flush();
    expect(first.bodyText()).toContain('reply inside conv-A');

    // ── page reload ── everything in memory is gone; sessionStorage is not.
    const carried = sessionStorage.getItem(VIEW_KEY);
    expect(carried).toBeTruthy();
    document.body.innerHTML = '';
    for (const key of Object.keys(win)) {
      if (key.startsWith('__gs')) delete win[key];
    }
    vi.restoreAllMocks();

    const second = boot({
      conversations: [{ id: 'conv-B', status: 'open' }, { id: 'conv-A', status: 'open' }],
      open: true,
    });
    await flush();

    // Straight back into conv-A, without the visitor touching anything —
    // and NOT into conv-B, which is what a hintless boot would have chosen.
    expect(second.explicitHistoryLoads()).toEqual(['conv-A']);
    expect(second.bodyText()).toContain('reply inside conv-A');
  });
});
