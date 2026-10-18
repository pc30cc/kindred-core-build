/**
 * A message's reactions in t2 (issue #340, g2), with the SHIPPED runtime.js,
 * runtime-ext.js, runtime-late.js and the real t2 renderer and extras
 * (coreFeaturesHarness.ts):
 *
 *  - the conversation's reactions are read (GET …/conversations/:id/reactions)
 *    when its thread shows, again when it shows a minute later and after a
 *    reconnect; never on home, never for `default`;
 *  - the visitor's heart toggles at once (optimistic) and the POST's answer
 *    settles it; a failed POST puts the state before back;
 *  - a live `message_reactions` event (the drivers' hook) repaints the
 *    badge; the newest `at` wins, so a late answer never undoes a newer one;
 *  - a badge already on screen does not pop in again, and the keyboard
 *    focus stays on the heart it toggled;
 *  - before the late pack is in (or without it) no heart is drawn.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, resetWindow, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

const HEART = '❤️';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333333';
const T = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const agent = (id: string, text: string, min: number, cid = 'c1') =>
  ({ id, role: 'agent', sender_type: 'agent', sender_name: 'سارا', text, time: T(min), conversation_id: cid });
const visitor = (id: string, text: string, min: number, cid = 'c1') =>
  ({ id, role: 'visitor', sender_type: 'contact', text, time: T(min), conversation_id: cid });
const THREAD = [visitor(V1, 'فاکتور سفارشم رو می‌خوام', 5), agent(M1, 'این هم فاکتور سفارشتان.', 4), agent(M2, 'چیز دیگری هست؟', 3)];

type Route = (url: string, body: Record<string, unknown> | null) => ApiAnswer | Promise<ApiAnswer> | undefined;
function start(opts: BootOptions & { route?: Route } = {}) {
  const route = opts.route || (() => ({ body: { reactions: {}, at: 1 } }));
  return boot({
    renderer: 't2',
    realtime: true,
    conversations: [{ id: 'c1', operatorName: 'سارا', operatorOnline: true }, { id: 'c2' }],
    history: { c1: THREAD, c2: [agent('44444444-4444-4444-8444-444444444444', 'سلام', 2, 'c2')] },
    hint: { tab: 'home', conversationId: null },
    api: (url, init) => {
      if (!/\/reactions\b/.test(url)) return undefined;
      let body: Record<string, unknown> | null = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      return route(url, body);
    },
    ...opts,
  });
}
async function open(h: ReturnType<typeof boot>, cid = 'c1') {
  h.runtime.__test.openConversation(cid);
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
}
const gets = (h: ReturnType<typeof boot>, cid = 'c1') => h.fetches.filter((u) => u.includes(`/conversations/${cid}/reactions?`));
const posts = (h: ReturnType<typeof boot>) => h.posts.filter((p) => /\/conversations\/c1\/reactions$/.test(p.url));
const badge = (h: ReturnType<typeof boot>, id: string) => h.q(`.react[data-msg-id="${id}"]`);
const heart = (h: ReturnType<typeof boot>, id: string) => h.q<HTMLButtonElement>(`[data-msg-react][data-msg-id="${id}"]`)!;

describe('reading a conversation\'s reactions', () => {
  it('asks once when the thread shows (never on home) and draws the badges it gets', async () => {
    const h = start({ route: (u) => (u.includes('?') ? { body: { reactions: { [M1]: [{ emoji: HEART, count: 1, mine: true }] }, at: 10 } } : undefined) });
    await flush(30);
    expect(gets(h)).toEqual([]);
    await open(h);
    expect(gets(h)).toEqual([`https://api.test/api/widget/conversations/c1/reactions?workspace_id=ws-test`]);
    expect(badge(h, M1)!.getAttribute('aria-label')).toBe('واکنش‌ها: ❤️ ۱');
    expect(heart(h, M1).getAttribute('aria-pressed')).toBe('true');
    expect(heart(h, M2).getAttribute('aria-pressed')).toBe('false');
    // Never on the visitor's own message.
    expect(h.q(`[data-msg-react][data-msg-id="${V1}"]`)).toBeNull();
    // Repaints in the same minute ask again for nothing.
    h.emitTyping();
    await flush(10);
    expect(gets(h)).toHaveLength(1);
  });

  it('asks again when the thread shows a minute later, and after a reconnect', async () => {
    const h = start();
    await flush(30);
    await open(h);
    expect(gets(h)).toHaveLength(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    h.runtime.setTab('home');
    await flush();
    h.runtime.setTab('chat');
    await flush(20);
    expect(gets(h)).toHaveLength(2);
    clock.mockReturnValue(now + 62_000);
    h.runtime.__test.setConnectionState('reconnecting');
    await flush(5);
    h.runtime.__test.setConnectionState('online');
    await flush(20);
    expect(gets(h)).toHaveLength(3);
  });

  it('another conversation drops the maps; an answer for the one left is not drawn', async () => {
    let release: (a: ApiAnswer) => void = () => {};
    const h = start({
      route: (u) => (u.includes('/c1/reactions?')
        ? new Promise<ApiAnswer>((res) => { release = res; })
        : { body: { reactions: {}, at: 5 } }),
    });
    await flush(30);
    await open(h);
    await open(h, 'c2');
    release({ body: { reactions: { [M1]: [{ emoji: HEART, count: 3, mine: false }] }, at: 99 } });
    await flush(20);
    expect(h.q('.react')).toBeNull();
    expect(gets(h, 'c2')).toHaveLength(1);
  });
});

describe('the visitor\'s heart', () => {
  it('shows at once, sends exactly what the server reads, and takes the server\'s answer', async () => {
    let answer: (a: ApiAnswer) => void = () => {};
    const h = start({
      route: (u, body) => (body
        ? new Promise<ApiAnswer>((res) => { answer = res; })
        : { body: { reactions: {}, at: 1 } }),
    });
    await flush(30);
    await open(h);
    expect(badge(h, M1)).toBeNull();
    click(heart(h, M1));
    await flush(5);
    expect(posts(h).map((p) => p.body)).toEqual([{ workspace_id: 'ws-test', message_id: M1, emoji: HEART, on: true }]);
    expect(badge(h, M1)!.textContent).toBe('۱');
    expect(heart(h, M1).getAttribute('aria-pressed')).toBe('true');
    // A second tap while the first is on its way does nothing.
    click(heart(h, M1));
    await flush(5);
    expect(posts(h)).toHaveLength(1);
    // The server counts an operator's heart too.
    answer({ body: { ok: true, message_id: M1, reactions: [{ emoji: HEART, count: 2, mine: true }], at: 20 } });
    await flush(10);
    expect(badge(h, M1)!.getAttribute('aria-label')).toBe('واکنش‌ها: ❤️ ۲');
    // Toggled off: on false.
    const h2 = posts(h).length;
    click(heart(h, M1));
    await flush(10);
    expect(posts(h)[h2].body).toEqual({ workspace_id: 'ws-test', message_id: M1, emoji: HEART, on: false });
  });

  it('a POST that fails (network, 4xx, 503) puts the state before back', async () => {
    for (const status of [0, 403, 422, 503]) {
      resetWindow();
      vi.restoreAllMocks();
      const h = start({
        route: (u, body) => (body
          ? (status ? { status, body: { error: 'x' } } : Promise.reject(new Error('offline')) as unknown as ApiAnswer)
          : { body: { reactions: { [M1]: [{ emoji: HEART, count: 2, mine: false }] }, at: 1 } }),
      });
      await flush(30);
      await open(h);
      expect(badge(h, M1)!.textContent).toBe('۲');
      click(heart(h, M1));
      await flush(20);
      expect(badge(h, M1)!.textContent, String(status)).toBe('۲');
      expect(heart(h, M1).getAttribute('aria-pressed'), String(status)).toBe('false');
    }
  });

  it('a heart above a pre-chat card answers too (no dead control)', async () => {
    const h = start({
      identity: {
        identity_state: 'anonymous', contact: null,
        prechat: { ask_name: true, require_name: true, ask_email: false, ask_phone: false, timing: 'after_handoff' },
      },
      route: (u, body) => (body ? { body: { ok: true, reactions: [{ emoji: HEART, count: 1, mine: true }], at: 5 } } : { body: { reactions: {}, at: 1 } }),
    });
    await flush(30);
    await open(h);
    // The pre-chat card asks for the name under the thread; the thread's hearts are drawn.
    expect(h.q('[data-prechat="name"]')).not.toBeNull();
    // (The pack came after the card's paint: the next paint draws the hearts.)
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(20);
    click(heart(h, M1));
    await flush(20);
    expect(posts(h).map((p) => p.body)).toEqual([{ workspace_id: 'ws-test', message_id: M1, emoji: HEART, on: true }]);
    expect(badge(h, M1)!.textContent).toBe('۱');
  });

  it('the keyboard focus stays on the heart it toggled', async () => {
    const h = start({ route: (u, body) => (body ? { body: { ok: true, reactions: [{ emoji: HEART, count: 1, mine: true }], at: 5 } } : { body: { reactions: {}, at: 1 } }) });
    await flush(30);
    await open(h);
    heart(h, M2).focus();
    click(heart(h, M2));
    await flush(20);
    expect(h.shadow.activeElement).toBe(heart(h, M2));
    expect(heart(h, M2).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('live events', () => {
  it('repaint the badge; the visitor\'s own reaction (another tab) is pressed; an older state is ignored', async () => {
    const h = start({ route: () => ({ body: { reactions: {}, at: 50 } }) });
    await flush(30);
    await open(h);
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [{ emoji: HEART, count: 1, visitor: true }], at: 60 });
    await flush(10);
    expect(badge(h, M1)!.textContent).toBe('۱');
    expect(heart(h, M1).getAttribute('aria-pressed')).toBe('true');
    // An operator's 👍 on the visitor's message.
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: V1, reactions: [{ emoji: '👍', count: 1, visitor: false }], at: 61 });
    await flush(10);
    expect(badge(h, V1)!.getAttribute('aria-label')).toBe('واکنش‌ها: 👍 ۱');
    // Older than what is in hand: ignored.
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [], at: 55 });
    await flush(10);
    expect(badge(h, M1)).not.toBeNull();
    // Another conversation's event changes nothing here.
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c2', message_id: M1, reactions: [], at: 99 });
    await flush(10);
    expect(badge(h, M1)).not.toBeNull();
    // Newer: the reaction is gone.
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [], at: 70 });
    await flush(10);
    expect(badge(h, M1)).toBeNull();
  });

  it('an event while the heart is on its way stays when the toggle fails; a read older than an event does not undo it', async () => {
    let answer: (a: ApiAnswer) => void = () => {};
    let read: (a: ApiAnswer) => void = () => {};
    let reads = 0;
    const h = start({
      route: (u, body) => (body
        ? new Promise<ApiAnswer>((res) => { answer = res; })
        : ++reads === 1 ? { body: { reactions: {}, at: 1 } } : new Promise<ApiAnswer>((res) => { read = res; })),
    });
    await flush(30);
    await open(h);
    click(heart(h, M1));
    await flush(5);
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [{ emoji: '👍', count: 1, visitor: false }], at: 50 });
    await flush(5);
    answer({ status: 500, body: {} });
    await flush(10);
    expect(badge(h, M1)!.getAttribute('aria-label')).toBe('واکنش‌ها: 👍 ۱');
    // A reconnect reads again; its answer, older than the next event, comes last.
    h.runtime.__test.setConnectionState('offline');
    await flush(5);
    h.runtime.__test.setConnectionState('online');
    await flush(10);
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [{ emoji: HEART, count: 2, visitor: true }], at: 80 });
    await flush(5);
    read({ body: { reactions: {}, at: 60 } });
    await flush(10);
    expect(badge(h, M1)!.textContent).toBe('۲');
  });

  it('a badge already on screen does not pop in again; a new count does', async () => {
    const h = start({ route: () => ({ body: { reactions: { [M1]: [{ emoji: HEART, count: 1, mine: false }] }, at: 1 } }) });
    await flush(30);
    await open(h);
    expect(badge(h, M1)!.classList.contains('no-enter')).toBe(false);
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M2, reactions: [{ emoji: HEART, count: 1, visitor: false }], at: 5 });
    await flush(10);
    expect(badge(h, M1)!.classList.contains('no-enter')).toBe(true);
    expect(badge(h, M2)!.classList.contains('no-enter')).toBe(false);
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [{ emoji: HEART, count: 2, visitor: false }], at: 6 });
    await flush(10);
    expect(badge(h, M1)!.classList.contains('no-enter')).toBe(false);
  });
});

describe('without the late pack, and for `default`', () => {
  it('no heart before the pack is in (none if it never comes), the hearts once it is', async () => {
    const h = start({ late: 'hold' });
    await flush(30);
    await open(h);
    expect(h.q('[data-msg-react]')).toBeNull();
    expect(gets(h)).toEqual([]);
    h.releaseLate();
    await flush(30);
    expect(h.q(`[data-msg-react][data-msg-id="${M1}"]`)).not.toBeNull();
    expect(gets(h)).toHaveLength(1);
    resetWindow();
    vi.restoreAllMocks();
    const failed = start({ late: 'fail' });
    await flush(30);
    await open(failed);
    await flush(20);
    expect(failed.q('[data-msg-react], .react')).toBeNull();
    expect(gets(failed)).toEqual([]);
  });

  it('default asks nothing and an event reaching it changes nothing', async () => {
    const h = boot({ renderer: 'default', realtime: true, conversations: [{ id: 'c1' }], history: { c1: THREAD } });
    await flush(20);
    await open(h);
    const html = h.panel.innerHTML;
    const calls = h.calls.length;
    h.emitReaction({ kind: 'message_reactions', conversation_id: 'c1', message_id: M1, reactions: [{ emoji: HEART, count: 1, visitor: true }], at: 9 });
    await flush(10);
    expect(h.panel.innerHTML).toBe(html);
    expect(h.calls.length).toBe(calls);
    expect(h.fetches.some((u) => u.includes('/reactions'))).toBe(false);
    expect(h.scripts.some((s) => /runtime-late|runtime-ext/.test(s))).toBe(false);
  });
});
