/**
 * Core's renderer-declared features (contract §3: `features` returned by
 * `create()`) are inert for `default`, which declares none: with the live
 * template mounted, Core passes exactly the view-models it always passed,
 * binds nothing new and changes nothing on screen. The other half of the
 * proof is that every existing test pinning `default` (designContract,
 * presentationContract, skeletonParity, conversationResume, …) passes.
 *
 * One deliberate change (2026-10-24): default runs one conversation per
 * visitor, a mode Core keys on the renderer drawing a past bar
 * (`pastBarHtml`), never on `features`. Home gets `pastCount` and
 * `pastUnread`, the list (the history) its `back`; the rest is default's
 * own markup, below, still with no runtime-ext.js and no late pack.
 *
 * Boots the shipped runtime.js + presentation-default.js in jsdom; every
 * renderer surface is wrapped only to record what Core passed.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, resetWindow, typeInto, type ConversationSeed } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

const HOME_VM_KEYS = [
  'rtl', 'isOnline', 'teamMembers', 'categories', 'articles', 'conversations', 'conversationsError',
  'headerTitle', 'kbEnabled', 'chatEnabled', 'primaryColor', 'welcomeMessage', 'showTeamAvatars', 'smartSurface',
  // One conversation per visitor: how many are history, and the answers unseen there.
  'pastCount', 'pastUnread',
];
const CONVERSATION_VM_KEYS = ['id', 'status', 'preview', 'unreadCount', 'timeLabel'];
// …and the history's back (where the visitor came from).
const LIST_VM_KEYS = ['rtl', 'loading', 'conversations', 'error', 'chatEnabled', 'back'];
const KB_VM_KEYS = ['rtl', 'state', 'query', 'article', 'feedback', 'results', 'articles', 'categories'];

describe('default declares no feature and Core stays as it was', () => {
  it('gets the capabilities in env and declares no features', async () => {
    const h = boot({ renderer: 'default' });
    await flush();
    expect(h.env().capabilities).toEqual({
      kbNeutral: true, csat: true, reactions: true, orderCard: true, prechatSteps: true, instantAnswers: true, chatMenu: true,
      awayThread: true, queuePosition: true, emojiSearch: true, dlProgress: true, kbAuthor: true,
    });
    expect(h.calls.some((c) => c.surface === 'chatHeaderHtml' || c.surface === 'prechatSummaryHtml')).toBe(false);
  });

  it('home and list get exactly today\'s view-models (no visitorName, unreadTotal, hasSearch, operator fields), plus one conversation\'s', async () => {
    const h = boot({
      renderer: 'default',
      identity: { identity_state: 'identified', contact: { name: 'علی رضایی' } },
      conversations: [
        { id: 'c1', unreadCount: 2, outbound: true, operatorName: 'سارا', operatorOnline: true },
        { id: 'c0', status: 'closed', operatorName: 'رضا' },
      ],
      hint: { tab: 'home', conversationId: null },
    });
    await flush(20);
    const homeVm = h.lastCall('homeHtml')![0] as Record<string, unknown>;
    expect(Object.keys(homeVm).sort()).toEqual([...HOME_VM_KEYS].sort());
    expect(homeVm).toMatchObject({ pastCount: 1, pastUnread: 0 });
    const convs = homeVm.conversations as Array<Record<string, unknown>>;
    expect(convs.map((c) => c.id)).toEqual(['c1']);
    expect(Object.keys(convs[0]).sort()).toEqual([...CONVERSATION_VM_KEYS].sort());

    h.runtime.setTab('list');
    await flush();
    const listVm = h.lastCall('conversationListHtml')![0] as Record<string, unknown>;
    expect(Object.keys(listVm).sort()).toEqual([...LIST_VM_KEYS].sort());
    expect(listVm.back).toBe('home');
    const rows = listVm.conversations as Array<Record<string, unknown>>;
    expect(rows.map((c) => c.id)).toEqual(['c0']);
    expect(Object.keys(rows[0]).sort()).toEqual([...CONVERSATION_VM_KEYS].sort());
  });

  it('the help view gets today\'s view-model (no hasSearch, unreadTotal, category ids or article meta)', async () => {
    const h = boot({
      renderer: 'default',
      kb: {
        categories: [{ id: 'cat-1', name: 'ارسال', slug: 'shipping', description: '', icon: 'truck' }],
        articles: [{ id: 'a1', title: 'زمان ارسال', slug: 'shipping-time', excerpt: '', category_id: 'cat-1' }],
        article: { id: 'a1', title: 'زمان ارسال', slug: 'shipping-time', content: '<p>یک دو سه</p>', updated_at: '2026-10-01T00:00:00Z', category_id: 'cat-1' },
      },
    });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const listVm = h.lastCall('kbHtml')![0] as { categories: Array<Record<string, unknown>> };
    expect(Object.keys(listVm).sort()).toEqual([...KB_VM_KEYS].sort());
    expect(Object.keys(listVm.categories[0]).sort()).toEqual(['description', 'name', 'url']);

    h.runtime.setTab('help', 'shipping-time');
    await flush(20);
    const articleVm = h.lastCall('kbHtml')![0] as { state: string; article: Record<string, unknown> };
    expect(articleVm.state).toBe('article');
    expect(Object.keys(articleVm.article).sort()).toEqual(['contentHtml', 'excerpt', 'publicUrl', 'title']);
  });

  it('the thread gets today\'s arguments: emptyHtml() with none, messagesHtml with { typewriter, qna }', async () => {
    const h = boot({
      renderer: 'default',
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString() }] },
    });
    await flush();
    h.runtime.__test.startNew();
    await flush();
    const empty = h.lastCall('emptyHtml')!;
    expect(empty.every((a) => a === undefined)).toBe(true);

    h.runtime.__test.openConversation('c1');
    await flush(20);
    const [, extra, view] = h.lastCall('messagesHtml')! as [unknown, unknown, Record<string, unknown>];
    expect(extra).toBeUndefined();
    expect(Object.keys(view).sort()).toEqual(['qna', 'typewriter']);
  });

  // I-09: the operator's typing shows in default's own row above the
  // composer (Core's [data-typing-row]); the thread and the header stay as they were.
  it('typing from the operator shows only the row above the composer (no row in the thread, header untouched)', async () => {
    const h = boot({
      renderer: 'default',
      realtime: true,
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString() }] },
    });
    await flush();
    h.runtime.__test.openConversation('c1');
    await flush(20);
    const header = h.q('[data-chat-header]')!;
    const before = header.innerHTML;
    const thread = h.q('[data-chat-messages]')!.innerHTML;
    h.emitTyping();
    await flush();
    expect(header.innerHTML).toBe(before);
    expect(h.q('[data-chat-messages]')!.innerHTML).toBe(thread);
    expect(h.q('.typing-row')).toBeNull();
    const row = h.q('[data-typing-row]')!;
    expect(row.hidden).toBe(false);
    expect(row.textContent!.length).toBeGreaterThan(0);
  });

  it('the composer stays hidden (not locked) while the pre-chat card waits, and no skip is bound', async () => {
    const h = boot({
      renderer: 'default',
      identity: { identity_state: 'anonymous', contact: null, prechat: { ask_email: true, require_email: false, timing: 'after_handoff' } },
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString() }] },
    });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(20);
    expect(h.q('.hc-card')).not.toBeNull();
    const bar = h.q('[data-input-bar]')!;
    expect(bar.style.display).toBe('none');
    expect(bar.classList.contains('is-locked')).toBe(false);
  });

  it('a "start chat" press resumes the thread as before (no home ask, no new conversation)', async () => {
    const h = boot({ renderer: 'default' });
    await flush(20);
    const epochBefore = h.runtime.__test.chatState().freshIntent;
    click(h.q('[data-home-action="chat"]'));
    await flush();
    expect(h.runtime.__test.chatState().freshIntent).toBe(epochBefore);
    expect(h.panel.getAttribute('data-view')).toBe('chat');
  });

  // Issue #340 (g5-3a, approved): the label was never written, as Core
  // looked it up in the panel before the chat frame was mounted.
  it('the hidden presence label says the team\'s presence (it stayed empty), and stays hidden', async () => {
    const h = boot({ renderer: 'default', config: { availability: { state: 'online' } } });
    await flush(20);
    h.runtime.setTab('chat');
    await flush();
    const wrap = h.q('[data-presence]')!;
    expect(wrap.className).toBe('presence sr-only status-online');
    expect(h.q('[data-presence-label]')!.textContent).toBe((h.env().t as (k: string) => string)('availOnline'));
  });

  // Issue #340 round 4: what t1/t2 ask the server for and draw, default never does.
  it('asks for an article without meta=1 (no author), as before', async () => {
    const h = boot({ renderer: 'default', kb: { article: { id: 'a1', title: 'x', slug: 'x', content: '<p>x</p>', author_name: 'سارا' } } });
    await flush();
    h.runtime.setTab('help', 'x');
    await flush(20);
    const req = h.fetches.filter((u) => u.includes('/api/widget/kb/article?'));
    expect(req).toHaveLength(1);
    expect(new URL(req[0]).searchParams.has('meta')).toBe(false);
    expect(Object.keys((h.lastCall('kbHtml')![0] as { article: Record<string, unknown> }).article).sort()).toEqual(['contentHtml', 'excerpt', 'publicUrl', 'title']);
  });

  it('draws an AI answer about an order as its text alone', async () => {
    const order = { v: 1, number: '48213', summary: 'x', more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null, trackingUrl: 'https://post.ir/t' };
    const h = boot({
      renderer: 'default',
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: 'ai-1', role: 'ai', sender_type: 'ai', text: 'سفارشتان ارسال شد.', time: new Date().toISOString(), metadata: { source: 'ai_agent', kind: 'order_status', order } }] },
    });
    await flush();
    h.runtime.__test.openConversation('c1');
    await flush(20);
    const thread = h.q('[data-chat-messages]')!;
    expect(thread.textContent).toContain('سفارشتان ارسال شد.');
    expect(thread.textContent).not.toContain('48213');
    expect(thread.querySelector('a[href="https://post.ir/t"], .card, .steps')).toBeNull();
  });

  it('asks nothing while a first message is written, and loads no late pack or emoji keywords', async () => {
    const h = boot({ renderer: 'default', config: { modules: { emoji: 'https://cdn.test/widget/runtime-emoji.0123abcd.js' } } });
    await flush(20);
    h.runtime.setTab('chat');
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    typeInto(h.q<HTMLTextAreaElement>('[data-msg-input]')!, 'مرجوعی کفش');
    await new Promise((r) => setTimeout(r, 320));
    await flush(10);
    click(h.q('[data-emoji-btn]'));
    await flush(10);
    expect(h.fetches.filter((u) => u.includes('kb-suggest'))).toEqual([]);
    expect(h.scripts.filter((u) => /runtime-(emoji|late|ext)|-x\./.test(u))).toEqual([]);
    expect(h.q('[data-kb-suggest], [data-emoji-search]')).toBeNull();
  });

  it('draws no track-order row, even with a store in its config', async () => {
    const h = boot({ renderer: 'default', config: { commerce: { trackOrder: true } } });
    await flush(20);
    expect(h.q('[data-home-action="track-order"]')).toBeNull();
  });

  // runtime-ext.js's `autofocus` (t1/t2: a control of the panel the visitor
  // is on keeps the focus) is nothing without the module: default's late
  // composer focus is as it was.
  it('Core\'s late composer focus (after the identity answer, after an open) still takes the composer', async () => {
    const late: Array<() => void> = [];
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms === 200 || ms === 300) && typeof fn === 'function' && /msgInput\.focus\(\)/.test(String(fn))) {
        late.push(fn);
        return 0;
      }
      return realTimeout(fn, ms, ...rest);
    }) as unknown as typeof setTimeout);
    const h = boot({ renderer: 'default', conversations: [{ id: 'c1' }], history: { c1: [{ id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: '2026-10-18T09:00:00.000Z', conversation_id: 'c1' }] } });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    h.runtime.__test.setConnectionState('online');
    await flush(10);
    expect(late).toHaveLength(2);
    expect(h.scripts.filter((u) => /runtime-ext/.test(u))).toEqual([]);
    for (const fn of late) {
      h.q<HTMLButtonElement>('[data-chat-header] [data-view-back]')!.focus();
      fn();
      expect(h.shadow.activeElement).toBe(h.q('[data-msg-input]'));
    }
  });
});

// One conversation per visitor, in default's own markup (no features, no
// runtime-ext.js, no late pack): home's one door and its quiet link into
// history, a closed conversation read-only with its past bar in the
// composer's place, back to the history, the way to the current one, and
// the closed line.
describe('default: one conversation per visitor', () => {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const LIVE: ConversationSeed[] = [{ id: 'c-live', status: 'open', unreadCount: 1 }, { id: 'c-past', status: 'closed' }];
  const HISTORY = {
    'c-live': [
      { id: 'l1', role: 'visitor', sender_type: 'contact', text: 'سفارشم کجاست؟', time: at(9), conversation_id: 'c-live' },
      { id: 'l2', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'ارسال شد', time: at(8), conversation_id: 'c-live' },
    ],
    'c-past': [
      { id: 'p1', role: 'visitor', sender_type: 'contact', text: 'مرجوعی', time: at(3000), conversation_id: 'c-past' },
      { id: 'p2', role: 'agent', sender_type: 'agent', sender_name: 'مهدی', text: 'واریز شد', time: at(2990), conversation_id: 'c-past' },
      { id: 'p3', role: 'system', sender_type: 'system', text: 'مهدی closed the conversation', time: at(2989), conversation_id: 'c-past',
        metadata: { kind: 'conversation_closed', by: 'agent', agent_name: 'مهدی', operator_name: 'مهدی', status: 'closed' } },
    ],
  };
  type H = ReturnType<typeof boot>;
  const view = (h: H) => h.panel.getAttribute('data-view');
  const bar = (h: H) => h.q<HTMLElement>('[data-input-bar]')!;
  async function onHome(conversations: ConversationSeed[] = LIVE) {
    const h = boot({ renderer: 'default', conversations, history: HISTORY, hint: { tab: 'home', conversationId: null } });
    await flush(30);
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    return h;
  }
  async function readPast(h: H) {
    click(h.q('[data-body] .home-link[data-view="list"]'));
    await flush(10);
    expect(view(h)).toBe('list');
    click(h.q('[data-conversation-open="c-past"]'));
    await flush(20);
  }

  it('home: «گفتگوی شما» and its row, «ادامه گفتگو» as the one door, «گفتگوهای قبلی» into history', async () => {
    const h = await onHome();
    expect(h.q('.home-recent .home-section-title')!.textContent).toBe('گفتگوی شما');
    expect(h.q('.home-recent [data-conversation-open="c-live"]')).not.toBeNull();
    const doors = h.body.querySelectorAll('[data-home-action="chat"]');
    expect(doors).toHaveLength(1);
    expect(doors[0].textContent).toBe('ادامه گفتگو');
    expect(h.q('[data-body] .home-link[data-view="list"]')!.textContent).toBe('گفتگوهای قبلی');
    click(doors[0]);
    await flush(20);
    expect([view(h), h.runtime.__test.chatState().conversationId]).toEqual(['chat', 'c-live']);
  });

  it('a closed one from history is read-only: its past bar in the composer\'s place, no quote, back to history', async () => {
    const h = await onHome();
    await readPast(h);
    expect(h.runtime.__test.chatState().conversationId).toBe('c-past');
    const past = h.q('.composer-zone .wy-past[data-past-bar]')!;
    expect(past).not.toBeNull();
    expect(past.nextElementSibling).toBe(bar(h));
    expect(bar(h).style.display).toBe('none');
    expect(past.textContent).toBe('این گفتگو به پایان رسیده و فقط خواندنی است' + 'گفتگوی فعلی');
    // Its close, as default draws it.
    const days = Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-day span')).map((e) => e.textContent);
    expect(days).toContain('مهدی گفتگو را به پایان رساند');
    // Read, not answered: a quote press fills no reply preview.
    click(h.q('[data-chat-messages] [data-msg-reply]'));
    await flush();
    expect(h.q<HTMLElement>('[data-reply-preview]')!.hidden).toBe(true);
    // Back: the history it came from.
    click(h.q('[data-chat-header] [data-view-back]'));
    await flush(10);
    expect(view(h)).toBe('list');
    expect(h.q('[data-past-bar]')).toBeNull();
  });

  it('the past bar\'s way on: the current conversation, writable again', async () => {
    const h = await onHome();
    await readPast(h);
    click(h.q('[data-past-bar] [data-chat-current]'));
    await flush(20);
    expect([view(h), h.runtime.__test.chatState().conversationId]).toEqual(['chat', 'c-live']);
    expect(h.q('[data-past-bar]')).toBeNull();
    expect(bar(h).style.display).toBe('flex');
    // Back from the current one: home, where it was opened from.
    click(h.q('[data-chat-header] [data-view-back]'));
    await flush(10);
    expect(view(h)).toBe('home');
  });

  it('nothing current (the team away): home offers a message beside the link, and so does the past bar', async () => {
    const h = await onHome([{ id: 'c-past', status: 'closed' }]);
    expect(h.q('.home-recent .home-section-title')).toBeNull();
    expect(h.q('[data-body] .home-link[data-view="list"]')).not.toBeNull();
    expect(h.q('[data-home-action="chat"]')!.textContent).toBe('پیغام بگذارید');
    await readPast(h);
    expect(h.q('[data-past-bar] [data-chat-current]')!.textContent).toBe('پیغام بگذارید');
  });

  it('an unseen answer in history: the link counts it', async () => {
    const h = await onHome([{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed' }, { id: 'c-old', status: 'open', unreadCount: 2 }]);
    expect(h.q('[data-body] .home-link[data-view="list"] .conv-unread')!.textContent).toBe('۲');
  });

  it('…and still no features, no runtime-ext.js, no late pack', async () => {
    const h = await onHome();
    await readPast(h);
    expect(h.scripts.filter((u) => /runtime-(ext|late)|-x\./.test(u))).toEqual([]);
    expect(h.calls.some((c) => c.surface === 'chatHeaderHtml' || c.surface === 'chatMenuHtml')).toBe(false);
  });
});
