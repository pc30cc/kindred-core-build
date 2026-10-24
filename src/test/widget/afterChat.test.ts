/**
 * After a chat (issue #340, g1): the "closed the conversation" line, the
 * rating card under it, the transcript by email and the chat bar's ⋯ menu,
 * with the SHIPPED runtime.js, runtime-ext.js, runtime-late.js and the real
 * t1 / t2 renderers and extras (coreFeaturesHarness.ts).
 *
 *  - runtime.js keeps a `conversation_closed` row only for a renderer that
 *    declares `closedNotice` (t1, t2): `default` never gets it, from a
 *    history or a realtime frame, in the store, the renderer, the unread
 *    count or the page's public `message` event (the toast and chime gate);
 *    with t1 and t2 it is drawn but never counted as unread. t1 and t2 (one
 *    conversation per visitor) draw a close only: the row an older backend
 *    wrote for a resolve is dropped like default's (no rating asked for).
 *  - runtime-late.js asks GET …/csat once when the thread ends with a closed
 *    row (again when the panel reopens or the history reloads), shows the
 *    card only when the server says rateable (or rated), and only with the
 *    late pack in; a pick changes the card in place; the rating, its errors
 *    and the transcript go through POST …/csat and POST …/transcript with the
 *    exact bodies the server reads.
 *  - The ⋯ is put in the chat bar when the pack lands, for an existing
 *    conversation only: an ARIA menu (Escape closes it and gives the focus
 *    back without closing the widget, arrows move, a press outside closes),
 *    the transcript item when the server offers it, the sound switch on
 *    Core's own preference, remembered per visitor.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, key, resetWindow, typeInto, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  try { localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { vi.restoreAllMocks(); });

const T = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const agent = (id: string, text: string, min: number) =>
  ({ id, role: 'agent', sender_type: 'agent', sender_name: 'سارا', text, time: T(min), conversation_id: 'c1' });
const visitorMsg = (id: string, text: string, min: number) =>
  ({ id, role: 'visitor', sender_type: 'contact', text, time: T(min), conversation_id: 'c1' });
/**
 * A closed row as /history and the realtime envelope carry it: a close (the
 * server writes the line for a close only, owner 2026-10-24); `status`
 * 'resolved' is the line an older backend wrote for a resolve.
 */
const closed = (id = 'cl1', min = 1, status: 'closed' | 'resolved' = 'closed') => ({
  id, role: 'system', sender_type: 'system', text: 'سارا closed the conversation', body: 'سارا closed the conversation',
  time: T(min), conversation_id: 'c1', sender_name: 'سارا',
  metadata: { kind: 'conversation_closed', by: 'agent', agent_id: 'u1', agent_name: 'سارا', operator_id: 'u1', operator_name: 'سارا', status },
});
const THREAD = [visitorMsg('m1', 'مرسی، مشکلم حل شد!', 5), agent('m2', 'خوشحالم که حل شد!', 4)];
const CSAT_OK = {
  closed_id: 'cl1', rateable: true, rating: null, operator: { name: 'سارا', avatar: null },
  transcript: { available: true, to: 'a•••@example.com' },
};

type Route = (url: string, body: Record<string, unknown> | null) => ApiAnswer | Promise<ApiAnswer> | undefined;
/**
 * The list's row for c1, as its thread has it: closed by the close it
 * holds, its answer unseen (one conversation: the current one, rule 2, then
 * held by this tab, rule 3), else live (open, or resolved by an older
 * backend's line).
 */
function rowFor(messages: Array<Record<string, unknown>>) {
  const close = messages.map((m) => m.metadata as { kind?: string; status?: string } | undefined)
    .filter((md) => md && md.kind === 'conversation_closed').pop();
  const status = close ? close.status || 'closed' : 'open';
  return { id: 'c1', status, operatorName: 'سارا', operatorOnline: true, ...(status === 'closed' ? { unreadCount: 1, unreadReplies: 1 } : {}) };
}
/** Boots t2 (or t1) on thread c1 with the late pack in; `route` answers the after-chat routes. */
async function thread(opts: BootOptions & { route?: Route; messages?: Array<Record<string, unknown>> } = {}) {
  const route = opts.route || ((u: string) => (u.includes('/csat') ? { body: CSAT_OK } : undefined));
  const messages = opts.messages || [...THREAD, closed()];
  const h = boot({
    renderer: 't2',
    realtime: true,
    conversations: [rowFor(messages)],
    history: { c1: messages },
    assignedOperator: { name: 'سارا', avatar: null, online: true },
    identity: { identity_state: 'identified', contact: { name: 'علی', email: 'ali@example.com' } },
    api: (url, init) => {
      if (!/\/csat|\/transcript/.test(url)) return undefined;
      let body: Record<string, unknown> | null = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      return route(url, body) || { status: 404, body: { error: 'not_found' } };
    },
    ...opts,
  });
  await flush(20);
  h.runtime.__test.openConversation('c1');
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(5);
  return h;
}
const csatGets = (h: ReturnType<typeof boot>) => h.fetches.filter((u) => /\/conversations\/c1\/csat\?/.test(u));
const posts = (h: ReturnType<typeof boot>, path: string) => h.posts.filter((p) => p.url.endsWith('/conversations/c1/' + path));
const active = (h: ReturnType<typeof boot>) => h.shadow.activeElement as HTMLElement | null;

describe('default (one conversation per visitor): a real close is its quiet line; a resolve is nothing; never a rating or a late pack', () => {
  it('from a history: the close drawn as the line, nothing late is asked for', async () => {
    const h = boot({
      renderer: 'default',
      conversations: [{ id: 'c1', status: 'closed' }],
      history: { c1: [...THREAD, closed()] },
    });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    const msgs = h.runtime.__test.chatState().messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.__id)).toEqual(['m1', 'm2', 'cl1']);
    expect(h.q('[data-chat-messages]')!.textContent).toContain('سارا گفتگو را به پایان رساند');
    expect(h.q('[data-chat-messages]')!.textContent).not.toContain('closed the conversation');
    expect(h.fetches.some((u) => /\/csat|\/transcript/.test(u))).toBe(false);
    expect(h.scripts.some((s) => /runtime-late|runtime-ext|-x\./.test(s))).toBe(false);
  });

  it('a resolve line an older backend wrote: dropped (no line, no unread, no public `message` event)', async () => {
    const h = boot({ renderer: 'default', realtime: true, publicEvents: true, conversations: [{ id: 'c1' }], history: { c1: THREAD } });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    h.runtime.setTab('home');
    await flush();
    const unreadBefore = h.unread.length ? h.unread[h.unread.length - 1] : 0;
    h.emitMessages([closed('cl1', 1, 'resolved')]);
    await flush(10);
    expect((h.runtime.__test.chatState().messages as unknown[]).length).toBe(2);
    expect(h.events.filter((e) => e.name === 'message')).toEqual([]);
    expect(h.unread.length ? h.unread[h.unread.length - 1] : 0).toBe(unreadBefore);
    // The same frame shape with a real reply does count (the test can see it).
    h.emitMessages([agent('m3', 'سلام دوباره', 0)]);
    await flush(10);
    expect(h.events.filter((e) => e.name === 'message')).toHaveLength(1);
    expect(h.unread[h.unread.length - 1]).toBe(unreadBefore + 1);
  });

  it('a close arriving by /poll (no realtime): the line joins the thread, no rating is asked for', async () => {
    const h = boot({ renderer: 'default', publicEvents: true, conversations: [{ id: 'c1' }], history: { c1: THREAD } });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    h.emitPoll([closed()]);
    await flush(10);
    expect((h.runtime.__test.chatState().messages as Array<Record<string, unknown>>).map((m) => m.__id)).toEqual(['m1', 'm2', 'cl1']);
    expect(h.q('[data-chat-messages]')!.textContent).toContain('سارا گفتگو را به پایان رساند');
    expect(h.fetches.some((u) => /\/csat|\/transcript/.test(u))).toBe(false);
  });

});

describe('t1 and t2: a real close kept, an older backend\'s resolve line dropped', () => {
  it('t1 (`closedNotice`, one conversation per visitor) keeps a close as its day-divider line, and asks for no rating', async () => {
    const h = await thread({ renderer: 't1' });
    expect((h.runtime.__test.chatState().messages as Array<Record<string, unknown>>).map((m) => m.__id)).toEqual(['m1', 'm2', 'cl1']);
    expect(h.q('[data-chat-messages] .msg-day.cl')!.textContent).toBe('سارا گفتگو را به پایان رساند');
    expect(h.q('[data-csat]')).toBeNull();
    expect(csatGets(h)).toEqual([]);
  });

  it('t1 drops the line an older backend wrote for a resolve (a resolve ends nothing for the visitor)', async () => {
    const h = await thread({ renderer: 't1', messages: [...THREAD, closed('cl1', 1, 'resolved')] });
    expect((h.runtime.__test.chatState().messages as Array<Record<string, unknown>>).map((m) => m.__id)).toEqual(['m1', 'm2']);
    expect(h.q('[data-chat-messages] .msg-day.cl')).toBeNull();
    expect(csatGets(h)).toEqual([]);
  });

  it('t2 drops it too: no line, no rating asked for or drawn, the composer as it was', async () => {
    const h = await thread({ renderer: 't2', messages: [...THREAD, closed('cl1', 1, 'resolved')] });
    await flush(20);
    expect((h.runtime.__test.chatState().messages as Array<Record<string, unknown>>).map((m) => m.__id)).toEqual(['m1', 'm2']);
    const drawn = h.calls.filter((c) => c.surface === 'messagesHtml')
      .flatMap((c) => ((c.args[0] as { messages: Array<Record<string, unknown>> }).messages || []).map((m) => m.__id));
    expect(drawn).not.toContain('cl1');
    expect(h.q('[data-chat-messages] .msg-system-pill')).toBeNull();
    expect(h.q('[data-csat]')).toBeNull();
    expect(csatGets(h)).toEqual([]);
    // Still the visitor's conversation: writable, no past bar.
    expect(h.q<HTMLElement>('[data-input-bar]')!.style.display).not.toBe('none');
    expect(h.q('[data-past-bar]')).toBeNull();
  });
});

describe('t2: the closed line and the rating card', () => {
  it('a thread that ends with a closed row: the line, one GET, the card (with the transcript link)', async () => {
    const h = await thread();
    const pills = Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-system-pill')).map((p) => p.textContent);
    expect(pills).toEqual(['سارا گفتگو را به پایان رساند']);
    expect(csatGets(h)).toEqual(['https://api.test/api/widget/conversations/c1/csat?workspace_id=ws-test']);
    const card = h.q('[data-csat]')!;
    expect(card.querySelector('h3')!.textContent).toBe('گفتگو با سارا چطور بود؟');
    expect(card.querySelectorAll('[data-csat-rate]')).toHaveLength(5);
    expect(card.querySelector('[data-csat-transcript]')!.textContent).toBe('ارسال متن گفتگو به ایمیل');
    // The composer stays under the card.
    expect(h.q<HTMLElement>('[data-input-bar]')!.style.display).not.toBe('none');
    // Repaints ask nothing more.
    h.runtime.setTab('home');
    await flush();
    h.runtime.setTab('chat');
    await flush(10);
    expect(csatGets(h)).toHaveLength(1);
  });

  it('a pick changes the card in place (focus kept), the comment is kept, send posts exactly what the server reads', async () => {
    let answer: (a: ApiAnswer) => void = () => {};
    const h = await thread({
      route: (u) => (u.includes('/csat?') ? { body: CSAT_OK } : u.endsWith('/csat') ? new Promise<ApiAnswer>((r) => { answer = r; }) : undefined),
    });
    const face = h.q<HTMLButtonElement>('[data-csat-rate="5"]')!;
    const cardBefore = h.q('[data-csat]');
    face.focus();
    click(face);
    expect(face.getAttribute('aria-pressed')).toBe('true');
    expect(h.q('[data-csat-rate="1"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(h.q<HTMLButtonElement>('[data-csat-submit]')!.disabled).toBe(false);
    expect(active(h)).toBe(face);
    // In place: the same card, not a repaint.
    expect(h.q('[data-csat]')).toBe(cardBefore);
    typeInto(h.q<HTMLTextAreaElement>('[data-csat-comment]')!, 'خیلی سریع جواب دادید');
    click(h.q('[data-csat-submit]'));
    click(h.q('[data-csat-submit]'));
    await flush(5);
    expect(posts(h, 'csat')).toEqual([{
      url: 'https://api.test/api/widget/conversations/c1/csat',
      body: { workspace_id: 'ws-test', closed_id: 'cl1', rating: 5, comment: 'خیلی سریع جواب دادید' },
    }]);
    // Sending: nothing to press twice.
    expect(h.q<HTMLButtonElement>('[data-csat-submit]')!.disabled).toBe(true);
    expect(Array.from(h.shadow.querySelectorAll<HTMLButtonElement>('[data-csat-rate]')).every((b) => b.disabled)).toBe(true);
    answer({ body: { ok: true, rating: { score: 5, comment: 'خیلی سریع جواب دادید', rated_at: T(0) } } });
    await flush(10);
    const card = h.q('[data-csat]')!;
    expect(card.querySelector('[role="status"] h3')!.textContent).toBe('از نظرتان سپاسگزاریم!');
    expect(card.querySelector('[role="status"] p')!.textContent).toBe('امتیاز شما: عالی');
    expect(card.querySelector('[data-csat-rate], [data-csat-submit], [data-csat-comment]')).toBeNull();
    // The focus is not dropped on the page: the card itself (its status is read out).
    expect(active(h)).toBe(card);
  });

  it('a comment being typed survives a repaint, with its caret', async () => {
    const h = await thread();
    const ta = h.q<HTMLTextAreaElement>('[data-csat-comment]')!;
    ta.focus();
    typeInto(ta, 'سلام');
    ta.setSelectionRange(2, 2);
    // Anything that repaints the thread (here: a pick's state reaching the markup).
    click(h.q('[data-csat-rate="3"]'));
    h.runtime.setTab('home');
    await flush();
    h.runtime.setTab('chat');
    await flush(10);
    const again = h.q<HTMLTextAreaElement>('[data-csat-comment]')!;
    expect(again.value).toBe('سلام');
    expect(h.q('[data-csat-rate="3"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('rated before (a reload): the thanks with the stored score, nothing to ask', async () => {
    const h = await thread({ route: (u) => (u.includes('/csat') ? { body: { ...CSAT_OK, rateable: false, rating: { score: 4, comment: null, rated_at: T(60) } } } : undefined) });
    const card = h.q('[data-csat]')!;
    expect(card.querySelector('[role="status"] p')!.textContent).toBe('امتیاز شما: خوب');
    expect(card.querySelector('[data-csat-rate]')).toBeNull();
  });

  for (const [why, over] of [
    ['not rateable (AI only, past the window)', { rateable: false }],
    ['about another closure', { closed_id: 'cl0' }],
  ] as const) {
    it(`no card when the server says ${why}: the line only`, async () => {
      const h = await thread({ route: (u) => (u.includes('/csat') ? { body: { ...CSAT_OK, ...over } } : undefined) });
      expect(h.q('.msg-system-pill')!.textContent).toBe('سارا گفتگو را به پایان رساند');
      expect(h.q('[data-csat]')).toBeNull();
    });
  }

  it('no card (and no request) when the workspace turned the rating off', async () => {
    const h = await thread({ config: { templateOptions: { csat: false } } });
    expect(h.q('.msg-system-pill')).not.toBeNull();
    expect(h.q('[data-csat]')).toBeNull();
    expect(csatGets(h)).toEqual([]);
  });

  it('a GET that fails draws no card', async () => {
    const h = await thread({ route: (u) => (u.includes('/csat') ? { status: 500, body: { error: 'Internal error' } } : undefined) });
    expect(h.q('[data-csat]')).toBeNull();
  });

  it('a reopened thread (a message after the closed row) has no card and asks nothing', async () => {
    const h = await thread({ messages: [...THREAD, closed(), visitorMsg('m9', 'یک سؤال دیگر', 0)] });
    expect(h.q('[data-csat]')).toBeNull();
    expect(csatGets(h)).toEqual([]);
  });

  it('a system row after the closed row (a transfer, a join) keeps its card: nobody said anything (the server\'s rule)', async () => {
    const notice = (id: string, kind: string) => ({
      id, role: 'system', sender_type: 'system', text: 'سارا transferred the conversation', time: T(0), conversation_id: 'c1',
      metadata: { kind, to_name: 'رضا' },
    });
    const h = await thread({ messages: [...THREAD, closed(), notice('n1', 'conversation_transferred')] });
    const card = h.q('[data-csat]')!;
    expect(card).not.toBeNull();
    // Under its line, the notice after it.
    const rows = Array.from(h.shadow.querySelectorAll('[data-chat-messages] .messages > .msg-row'));
    expect(rows.indexOf(card.closest('.msg-row')!)).toBe(rows.length - 2);
    expect(csatGets(h)).toHaveLength(1);
    h.emitMessages([notice('n2', 'routing_agent_joined')]);
    await flush(10);
    expect(h.q('[data-csat]')).not.toBeNull();
    expect(csatGets(h)).toHaveLength(1);
  });

  it('a live closed row: drawn and asked about, never an unread message or a chime; a reply after it takes the card away', async () => {
    const h = await thread({ messages: THREAD, publicEvents: true });
    expect(h.q('[data-csat]')).toBeNull();
    h.emitMessages([closed('cl1', 0)]);
    await flush(20);
    expect(h.q('.msg-system-pill')!.textContent).toBe('سارا گفتگو را به پایان رساند');
    expect(h.q('[data-csat]')).not.toBeNull();
    expect(csatGets(h)).toHaveLength(1);
    // Away from the thread (where a reply would count): still no count, no event.
    h.runtime.setTab('home');
    await flush();
    const unread = h.unread[h.unread.length - 1] || 0;
    h.emitMessages([closed('cl2', 0)]);
    await flush(10);
    expect(h.events.filter((e) => e.name === 'message')).toEqual([]);
    expect(h.unread[h.unread.length - 1] || 0).toBe(unread);
    h.runtime.setTab('chat');
    await flush(10);
    h.emitMessages([visitorMsg('m9', 'یک سؤال دیگر', 0)]);
    await flush(10);
    expect(h.q('[data-csat]')).toBeNull();
  });

  it('the panel reopened, or the history reloaded: asked again', async () => {
    const h = await thread({
      conversations: [rowFor([closed()]), { id: 'c2' }],
      history: { c1: [...THREAD, closed()], c2: [agent('n1', 'سلام', 9)] },
    });
    expect(csatGets(h)).toHaveLength(1);
    (h.runtime as unknown as { close: () => void }).close();
    await flush();
    h.runtime.open();
    await flush(20);
    expect(csatGets(h)).toHaveLength(2);
    // Another thread (no closed row: nothing asked), then back: its history reloads.
    h.runtime.__test.openConversation('c2');
    await flush(30);
    expect(csatGets(h)).toHaveLength(2);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    expect(csatGets(h)).toHaveLength(3);
    expect(h.q('[data-csat]')).not.toBeNull();
  });

  const submitWith = async (status: number, body: unknown) => {
    const h = await thread({ route: (u) => (u.includes('/csat?') ? { body: CSAT_OK } : u.endsWith('/csat') ? { status, body } : undefined) });
    click(h.q('[data-csat-rate="2"]'));
    click(h.q('[data-csat-submit]'));
    await flush(15);
    return h;
  };
  it('409 already rated (another tab): the thanks with the server\'s score', async () => {
    const h = await submitWith(409, { error: 'already_rated', rating: { score: 1, comment: null, rated_at: T(1) } });
    expect(h.q('[data-csat] [role="status"] p')!.textContent).toBe('امتیاز شما: خیلی بد');
  });
  for (const [status, body] of [[409, { error: 'not_ratable' }], [403, { error: 'csat_disabled', code: 'CSAT_DISABLED' }], [503, { error: 'csat_unavailable' }]] as const) {
    it(`${status} ${body.error}: said once, nothing left to press`, async () => {
      const h = await submitWith(status, body);
      expect(h.q('[data-csat] .er')!.textContent).toBe('دیگر نمی‌شود به این گفتگو امتیاز داد.');
      expect(h.q('[data-csat-submit], [data-csat-rate]')).toBeNull();
    });
  }
  for (const [status, body] of [[500, { error: 'Internal error' }], [429, { error: 'Too many requests' }], [400, { error: 'invalid_rating' }]] as const) {
    it(`${status}: an error line, the pick kept, send again`, async () => {
      const h = await submitWith(status, body);
      expect(h.q('[data-csat] .er[role="alert"]')!.textContent).toBe('ارسال نشد');
      expect(h.q('[data-csat-rate="2"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(h.q<HTMLButtonElement>('[data-csat-submit]')!.disabled).toBe(false);
    });
  }
  it('offline: an error, and no request', async () => {
    const h = await thread();
    h.runtime.__test.setConnectionState('offline');
    click(h.q('[data-csat-rate="4"]'));
    click(h.q('[data-csat-submit]'));
    await flush(5);
    expect(posts(h, 'csat')).toEqual([]);
    expect(h.q('[data-csat] .er')!.textContent).toBe('ارسال نشد');
  });

  it('the card itself keeps the focus through a repaint (the visitor reading its status)', async () => {
    const h = await thread();
    click(h.q('[data-csat-rate="4"]'));
    const card = h.q<HTMLElement>('[data-csat]')!;
    card.focus();
    h.emitTyping();
    await flush(10);
    expect(active(h)).toBe(h.q('[data-csat]'));
  });

  it('repaints add no listener to the thread, the bar or the panel', async () => {
    const h = await thread();
    const host = h.q('[data-chat-messages]')!;
    const bar = h.q('[data-chat-header]')!;
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    for (let i = 0; i < 4; i++) {
      h.runtime.setTab('home');
      await flush(3);
      h.runtime.setTab('chat');
      await flush(5);
      h.emitTyping();
      await flush(3);
      click(h.q('[data-chat-menu-toggle]'));
      await flush(3);
      click(h.q('[data-chat-menu-toggle]'));
      await flush(3);
    }
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.contexts.filter((c) => c === host || c === bar || c === h.panel)).toEqual([]);
  });

  it('no late pack, no card: the line and the card come only with it', async () => {
    const h = await thread({ late: 'fail' });
    expect(h.q('.msg-system-pill, [data-csat], [data-chat-menu-toggle]')).toBeNull();
    expect(csatGets(h)).toEqual([]);
  });
});

describe('t2: the transcript by email (the card\'s link)', () => {
  const send = async (status: number, body: unknown) => {
    const h = await thread({
      route: (u) => (u.includes('/csat') ? { body: CSAT_OK } : u.endsWith('/transcript') ? { status, body } : undefined),
    });
    click(h.q('[data-csat-transcript]'));
    await flush(15);
    return h;
  };

  it('posts the visitor\'s locale and time zone, then says where it went', async () => {
    const h = await send(200, { ok: true, to: 'a•••@example.com' });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(posts(h, 'transcript')).toEqual([{
      url: 'https://api.test/api/widget/conversations/c1/transcript',
      body: { workspace_id: 'ws-test', locale: 'fa', tz },
    }]);
    const sent = h.q('[data-csat] p.lnk2[role="status"]')!;
    expect(sent.textContent).toBe('متن گفتگو به a•••@example.com فرستاده شد');
    expect(h.q('[data-csat-transcript]')).toBeNull();
    // The menu's item says the same.
    click(h.q('[data-chat-menu-toggle]'));
    await flush(5);
    expect(h.q('[data-chat-menu-action="transcript"]')!.textContent).toBe('متن گفتگو به a•••@example.com فرستاده شد');
  });

  for (const [status, body] of [[502, { error: 'send_failed' }], [429, { error: 'rate_limited', code: 'RATE_LIMITED', retry_after: 300 }], [500, {}]] as const) {
    it(`${status}: not sent, try again`, async () => {
      const h = await send(status, body);
      expect(h.q('[data-csat-transcript]')!.textContent).toBe('ارسال نشد · تلاش دوباره');
    });
  }
  for (const [status, body] of [
    [429, { error: 'limit_reached' }], [429, { error: 'workspace_limit' }], [409, { error: 'no_email' }],
    [409, { error: 'nothing_to_send' }], [403, { error: 'transcript_disabled', code: 'TRANSCRIPT_DISABLED' }], [503, { error: 'email_unavailable' }],
  ] as const) {
    it(`${status} ${body.error}: said, nothing left to press`, async () => {
      const h = await send(status, body);
      expect(h.q('[data-csat] p.lnk2')!.textContent).toBe('ارسال متن گفتگو ممکن نشد');
      expect(h.q('[data-csat-transcript]')).toBeNull();
    });
  }

  it('no link when the server does not offer it, or the workspace turned it off', async () => {
    const off = await thread({ route: (u) => (u.includes('/csat') ? { body: { ...CSAT_OK, transcript: { available: false, to: null } } } : undefined) });
    expect(off.q('[data-csat]')).not.toBeNull();
    expect(off.q('[data-csat-transcript]')).toBeNull();
    resetWindow();
    const opt = await thread({ config: { templateOptions: { transcriptEmail: false } } });
    expect(opt.q('[data-csat]')).not.toBeNull();
    expect(opt.q('[data-csat-transcript]')).toBeNull();
  });
});

for (const renderer of ['t1', 't2'] as const) {
  describe(`${renderer}: the chat bar's ⋯ menu`, () => {
    const menuThread = (opts: BootOptions & { route?: Route } = {}) => thread({ renderer, messages: THREAD, ...opts });
    const toggle = (h: ReturnType<typeof boot>) => h.q<HTMLButtonElement>('[data-chat-header] [data-chat-menu-toggle]');
    const items = (h: ReturnType<typeof boot>) => Array.from(h.shadow.querySelectorAll<HTMLElement>('[data-chat-header] [data-chat-menu-action]'));

    it('is put in the bar when the late pack lands; never on a new conversation; never without the pack', async () => {
      const h = await menuThread();
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('false');
      expect(toggle(h)!.getAttribute('aria-label')).toBe('گزینه‌های بیشتر');
      expect(h.q('[data-chat-menu]')!.hasAttribute('hidden')).toBe(true);
      h.runtime.__test.startNew();
      await flush(10);
      expect(toggle(h)).toBeNull();
      resetWindow();
      const bare = await menuThread({ late: 'fail' });
      expect(toggle(bare)).toBeNull();
    });

    it('opens on a press (focus on its first item, asks the server once), arrows move, Escape closes it and gives the focus back, the widget stays open', async () => {
      const h = await menuThread();
      expect(csatGets(h)).toEqual([]);
      toggle(h)!.focus();
      click(toggle(h));
      await flush(10);
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('true');
      expect(h.q('[data-chat-menu]')!.hasAttribute('hidden')).toBe(false);
      expect(csatGets(h)).toHaveLength(1);
      // The transcript item came with the answer; the focus stayed on an item.
      expect(items(h).map((b) => b.getAttribute('data-chat-menu-action'))).toEqual(['transcript', 'sound']);
      expect(items(h)).toContain(active(h));
      items(h)[0].focus();
      key(active(h)!, 'ArrowDown');
      expect(active(h)!.getAttribute('data-chat-menu-action')).toBe('sound');
      key(active(h)!, 'ArrowDown');
      expect(active(h)!.getAttribute('data-chat-menu-action')).toBe('transcript');
      key(active(h)!, 'ArrowUp');
      expect(active(h)!.getAttribute('data-chat-menu-action')).toBe('sound');
      key(active(h)!, 'Escape');
      await flush(5);
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('false');
      expect(active(h)).toBe(toggle(h));
      expect(h.panel.classList.contains('visible') || h.panel.getAttribute('aria-hidden') !== 'true').toBe(true);
      expect(h.runtime.__test.chatState()).toBeTruthy();
      expect((h.runtime as unknown as { isOpen: () => boolean }).isOpen()).toBe(true);
      // Opened again: no second request.
      click(toggle(h));
      await flush(5);
      expect(csatGets(h)).toHaveLength(1);
    });

    it('a press outside closes it; another view closes it', async () => {
      const h = await menuThread();
      click(toggle(h));
      await flush(5);
      click(h.q('[data-chat-messages]'));
      await flush(5);
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('false');
      click(toggle(h));
      await flush(5);
      h.runtime.setTab('home');
      await flush(5);
      h.runtime.setTab('chat');
      await flush(10);
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('false');
    });

    it('stays open while the bar repaints (the operator types), with the focus where it was', async () => {
      const h = await menuThread();
      click(toggle(h));
      await flush(10);
      const sound = h.q<HTMLElement>('[data-chat-menu-action="sound"]')!;
      sound.focus();
      h.emitTyping();
      await flush(5);
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('true');
      expect(active(h)!.getAttribute('data-chat-menu-action')).toBe('sound');
    });

    it('the sound switch: Core\'s preference, remembered for this visitor; off by the workspace, no switch', async () => {
      const h = await menuThread();
      click(toggle(h));
      await flush(10);
      const sound = () => h.q<HTMLElement>('[data-chat-menu-action="sound"]')!;
      expect(sound().getAttribute('role')).toBe('menuitemcheckbox');
      expect(sound().getAttribute('aria-checked')).toBe('true');
      click(sound());
      await flush(5);
      expect(sound().getAttribute('aria-checked')).toBe('false');
      expect(localStorage.getItem('gs:sound:ws-test')).toBe('0');
      // A checkbox item keeps the menu open.
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('true');
      // The next visit starts with it off.
      resetWindow();
      localStorage.setItem('gs:sound:ws-test', '0');
      const next = await menuThread();
      click(toggle(next));
      await flush(10);
      expect(next.q('[data-chat-menu-action="sound"]')!.getAttribute('aria-checked')).toBe('false');
      click(next.q('[data-chat-menu-action="sound"]'));
      await flush(5);
      expect(localStorage.getItem('gs:sound:ws-test')).toBeNull();
      // A workspace without the chime: no switch, and a menu only when the transcript is offered.
      resetWindow();
      const quiet = await menuThread({ config: { features: { chat: true, knowledgeBase: true, notificationSound: false } } });
      await flush(10);
      expect(quiet.q('[data-chat-menu-action="sound"]')).toBeNull();
      expect(items(quiet).map((b) => b.getAttribute('data-chat-menu-action'))).toEqual(['transcript']);
      resetWindow();
      const none = await menuThread({
        config: { features: { chat: true, knowledgeBase: true, notificationSound: false } },
        route: (u) => (u.includes('/csat') ? { body: { ...CSAT_OK, closed_id: null, rateable: false, transcript: { available: false, to: null } } } : undefined),
      });
      await flush(10);
      expect(toggle(none)).toBeNull();
    });

    it('a storage that throws is no problem', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
      const h = await menuThread();
      click(toggle(h));
      await flush(10);
      click(h.q('[data-chat-menu-action="sound"]'));
      await flush(5);
      expect(h.q('[data-chat-menu-action="sound"]')!.getAttribute('aria-checked')).toBe('false');
    });

    it('a new conversation gets its ⋯ once its first message made it exist', async () => {
      const h = boot({ renderer, realtime: true, conversations: [] });
      await flush(20);
      h.runtime.__test.startNew();
      h.runtime.setTab('chat');
      await flush(20);
      h.runtime.__test.setConnectionState('online');
      await flush(5);
      typeInto(h.q<HTMLTextAreaElement>('[data-msg-input]')!, 'سلام');
      click(h.q('[data-send-btn]'));
      await flush(10);
      // The visitor's bubble is there, the conversation not yet: no ⋯.
      expect(toggle(h)).toBeNull();
      const send = h.posts.find((p) => p.url === 'chat:sendMessage')!.body as unknown as { onConversation: (cid: string) => void };
      send.onConversation('c9');
      await flush(10);
      expect(toggle(h)).not.toBeNull();
    });

    it('the late pack landing keeps the focus where it was in the bar (the back button)', async () => {
      const h = await menuThread({ late: 'hold' });
      expect(toggle(h)).toBeNull();
      // A draft in the composer, too.
      typeInto(h.q<HTMLTextAreaElement>('[data-msg-input]')!, 'یک پیش‌نویس');
      const back = h.q<HTMLElement>('[data-chat-header] [data-view-back]')!;
      back.focus();
      h.releaseLate();
      await flush(20);
      expect(toggle(h)).not.toBeNull();
      expect(active(h)).toBe(h.q('[data-chat-header] [data-view-back]'));
      expect(h.q<HTMLTextAreaElement>('[data-msg-input]')!.value).toBe('یک پیش‌نویس');
    });

    it('Home and End go to the ends; the focus leaving the bar (Tab) closes it', async () => {
      const h = await menuThread();
      click(toggle(h));
      await flush(10);
      key(active(h)!, 'End');
      expect(active(h)!.getAttribute('data-chat-menu-action')).toBe('sound');
      key(active(h)!, 'Home');
      expect(active(h)!.getAttribute('data-chat-menu-action')).toBe('transcript');
      h.q<HTMLElement>('[data-msg-input]')!.focus();
      await flush(5);
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('false');
      expect(h.q('[data-chat-menu]')!.hasAttribute('hidden')).toBe(true);
    });

    it('the menu\'s answers repaint the bar, not the thread', async () => {
      const h = await menuThread();
      const paints = () => h.calls.filter((c) => c.surface === 'messagesHtml').length;
      const before = paints();
      click(toggle(h));
      await flush(10);
      expect(csatGets(h)).toHaveLength(1);
      expect(items(h).map((b) => b.getAttribute('data-chat-menu-action'))).toEqual(['transcript', 'sound']);
      expect(paints()).toBe(before);
    });

    it('the transcript item: posts, then says where it went; the menu stays open on it', async () => {
      const h = await menuThread({
        route: (u) => (u.includes('/csat') ? { body: { ...CSAT_OK, closed_id: null, rateable: false } } : u.endsWith('/transcript') ? { body: { ok: true, to: 'a•••@example.com' } } : undefined),
      });
      click(toggle(h));
      await flush(10);
      const tr = h.q<HTMLElement>('[data-chat-menu-action="transcript"]')!;
      tr.focus();
      click(tr);
      click(tr);
      await flush(10);
      expect(posts(h, 'transcript')).toHaveLength(1);
      const done = h.q<HTMLElement>('[data-chat-menu-action="transcript"]')!;
      expect(done.textContent).toBe('متن گفتگو به a•••@example.com فرستاده شد');
      expect(done.getAttribute('aria-disabled')).toBe('true');
      expect(toggle(h)!.getAttribute('aria-expanded')).toBe('true');
      // Pressing a sent item sends nothing more.
      click(done);
      await flush(5);
      expect(posts(h, 'transcript')).toHaveLength(1);
    });
  });
}
