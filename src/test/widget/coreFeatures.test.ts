/**
 * Core's renderer-declared features (contract §3). A renderer returns
 * `features: { … }` from `create()`; Core then runs the matching behaviour.
 * Here a renderer built from `default` declares every feature and adds the
 * hooks a t1/t2 renderer draws, and each test drives the shipped runtime.js
 * in jsdom through one of them. coreFeaturesDefaultInert.test.ts proves the
 * same paths stay off for `default`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boot, click, flush, key, resetWindow, typeInto,
  type BaseRenderer, type Dict, type Renderer,
} from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ALL_FEATURES = {
  tabs: true, kbSearch: true, operatorTyping: true, chatHeader: true, emptyQna: true, topics: true,
  homeAsk: true, prechatOperator: true, prechatSummary: true, kbCategories: true, kbArticleMeta: true,
  kbProgress: true, recSend: true, vnRate: true, clock: true, emojiTabs: true, visitorName: true,
  conversationOperator: true,
};

// The view-models Core hands the new surfaces (only what these tests read).
interface Row { slug: string; title: string }
interface CategoryVm { id: string; name: string; count: number; icon?: string | null }
interface KbVm {
  state: string; query: string; hasSearch?: boolean; unreadTotal?: number;
  results: Row[]; articles: Row[]; categories: CategoryVm[]; category?: CategoryVm;
  article?: { contentHtml: string; categoryTitle?: string | null; readingMinutes?: number; updatedAt?: string | null };
}
interface HomeVm { visitorName?: string; unreadTotal?: number; hasSearch?: boolean; conversations: Dict[] }
interface ListVm { unreadTotal?: number }
interface Person { name: string; avatar?: string | null }
interface MessagesView { operatorTyping?: Person | null }
interface EmptyVm { topics?: Array<{ label: string; icon?: string }>; qna?: Dict; operatorTyping?: Person | null; prechatSummaryHtml?: string }
interface HeaderVm { online: boolean; typing: boolean; operator: (Person & { online?: boolean }) | null; isNew: boolean }

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function nav(active: string) {
  const tab = (v: string) => `<button type="button" data-view="${v}" aria-current="${v === active ? 'page' : 'false'}">${v}` +
    (v === 'list' ? '<span data-tab-badge hidden></span>' : '') + '</button>';
  return `<nav>${tab('home')}${tab('list')}${tab('help')}</nav>`;
}

function kbMarkup(vm: KbVm): string {
  const rows = (list: Row[]) => list.map((a) => `<button type="button" data-kb-action="open" data-kb-slug="${esc(a.slug)}">${esc(a.title)}</button>`).join('');
  if (vm.state === 'article' && vm.article) {
    const a = vm.article;
    return `<div class="kb-root"><div class="article" data-meta="${esc(a.categoryTitle)}|${a.readingMinutes}|${esc(a.updatedAt)}">` +
      '<div data-kb-progress></div><div class="scroller" style="overflow:auto">' + a.contentHtml + '</div>' +
      '<button type="button" data-kb-rate="neutral">neutral</button>' +
      '<button type="button" data-view-back="back" data-view-back-fallback="home">back</button></div></div>';
  }
  let inner;
  if (vm.state === 'results') inner = `<p data-count>${vm.results.length}</p>` + rows(vm.results);
  else if (vm.state === 'searching') inner = '<p data-searching>…</p>';
  else if (vm.state === 'category' && vm.category) inner = `<h2 data-category>${esc(vm.category.name)}:${vm.category.count}</h2>` + rows(vm.articles);
  else inner = vm.categories.map((c) => `<button type="button" data-kb-category="${esc(c.id)}">${esc(c.name)}:${c.count}</button>`).join('') + rows(vm.articles);
  return `<div class="kb-root" data-has-search="${!!vm.hasSearch}">` +
    `<input type="search" class="kb-search" data-kb-search value="${esc(vm.query)}" />` +
    '<button type="button" data-kb-search-clear>clear</button>' +
    `<div data-kb-results data-state="${esc(vm.state)}">${inner}</div>${nav('help')}</div>`;
}

/** A t1/t2-like renderer: default's markup plus the new hooks. */
function featureRenderer(features: Record<string, boolean> = ALL_FEATURES) {
  return (base: BaseRenderer): Renderer => ({
    features,
    format: {
      clock: (sec: number) => `c${sec}`,
      badge: (n: number) => `b${n}`,
      rate: (r: number) => `r${r}`,
    },
    homeHtml: (vm: HomeVm) => base.homeHtml(vm).replace(/<\/div>$/, '') +
      `<p data-greeting>${esc(vm.visitorName)}</p>` +
      '<textarea data-home-ask rows="1"></textarea>' +
      '<input type="search" class="kb-search" data-kb-search />' +
      '<button type="button" data-topic="زمان ارسال">topic</button>' +
      nav('home') + '</div>',
    conversationListHtml: (vm: ListVm) => base.conversationListHtml(vm) + nav('list'),
    kbHtml: kbMarkup,
    chatHeaderHtml: (vm: HeaderVm) => `<span data-head>${esc(JSON.stringify(vm))}</span>` +
      '<span class="presence bar-status" data-presence><span data-presence-dot></span><span data-presence-label></span></span>',
    messagesHtml: (s: unknown, extra: unknown, view: MessagesView) => {
      const html = base.messagesHtml(s, extra, view);
      if (!view || !view.operatorTyping) return html;
      return html.replace(/<\/div>$/, '') +
        `<div class="msg-row operator typing-row" aria-hidden="true">typing:${esc(view.operatorTyping.name)}</div></div>`;
    },
    emptyHtml: (vm?: EmptyVm) => '<div class="messages welcome-only">' +
      (vm && vm.topics ? vm.topics.map((t) => `<button type="button" data-topic="${esc(t.label)}">${esc(t.label)}</button>`).join('') : '') +
      (vm && vm.operatorTyping ? `<div class="msg-row operator typing-row">typing:${esc(vm.operatorTyping.name)}</div>` : '') +
      (vm && vm.prechatSummaryHtml ? vm.prechatSummaryHtml : '') +
      '</div>',
    handoffPrechatCardHtml: (...args: unknown[]) => base.handoffPrechatCardHtml(...args)
      .replace(/<\/div>\s*<\/div>$/, '<button type="button" data-prechat-skip>skip</button></div></div>'),
    prechatSummaryHtml: (contact: { email?: string }) => `<div class="msg-row operator" data-summary>${esc(contact.email)}` +
      '<button type="button" data-prechat-edit>edit</button></div>',
  });
}

const vmOf = <T>(h: ReturnType<typeof boot>, surface: string, index = 0) => h.lastCall(surface)![index] as T;
const capabilities = (h: ReturnType<typeof boot>) => h.env().capabilities as Record<string, boolean>;
/** The body the fake chat module got for the first sent message. */
const sentText = (h: ReturnType<typeof boot>) => h.posts.find((p) => p.url === 'chat:sendMessage')?.body;

const OPERATOR_MSG = { id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString() };

describe('env and the gate', () => {
  it('a renderer gets env.capabilities and only what it declares runs', async () => {
    const h = boot({ renderer: featureRenderer({ visitorName: true }), identity: { identity_state: 'identified', contact: { name: 'علی رضایی' } } });
    await flush(20);
    expect(capabilities(h).kbNeutral).toBe(true);
    // The rating after a chat, the chat's menu, reactions, the pre-chat in
    // steps, the message left away and the queue place are served
    // (runtime-late.js); the order card and instant answers are not yet.
    for (const k of ['csat', 'chatMenu', 'reactions', 'prechatSteps', 'awayThread', 'queuePosition']) expect(capabilities(h)[k], k).toBe(true);
    expect(capabilities(h).orderCard).toBe(false);
    expect(capabilities(h).instantAnswers).toBe(false);
    const vm = h.lastCall('homeHtml')![0] as Record<string, unknown>;
    expect(vm.visitorName).toBe('علی');
    expect(vm).not.toHaveProperty('unreadTotal');
    expect(vm).not.toHaveProperty('hasSearch');
  });
});

describe('tabs', () => {
  it('home and list carry unreadTotal; the badge is painted with format.badge and aria-current follows the view', async () => {
    const h = boot({
      renderer: featureRenderer(),
      conversations: [{ id: 'c1', unreadCount: 2 }, { id: 'c2', unreadCount: 1, status: 'resolved' }],
      hint: { tab: 'home', conversationId: null },
    });
    await flush(20);
    expect(vmOf<HomeVm>(h, 'homeHtml').unreadTotal).toBe(3);
    const badge = h.q('[data-tab-badge]')!;
    expect(badge.textContent).toBe('b3');
    expect(badge.hidden).toBe(false);
    expect(h.q('[data-view="home"][aria-current]')!.getAttribute('aria-current')).toBe('page');

    click(h.q('nav [data-view="list"]'));
    await flush();
    expect(vmOf<ListVm>(h, 'conversationListHtml').unreadTotal).toBe(3);
    expect(h.q('nav [data-view="list"]')!.getAttribute('aria-current')).toBe('page');
    expect(h.q('nav [data-view="home"]')!.getAttribute('aria-current')).toBe('false');
    // Focus follows the pressed tab into the repainted view.
    expect(h.shadow.activeElement).toBe(h.q('nav [data-view="list"]'));
  });
});

describe('kbSearch', () => {
  const RESULTS = { 'ارسال سفارش': [{ slug: 'ship', title: 'زمان ارسال', excerpt: '' }], 'ارسال': [{ slug: 'ship', title: 'زمان ارسال', excerpt: '' }] };

  it('searches after 300 ms and two characters, repaints only [data-kb-results] and keeps the field', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    expect(vmOf<KbVm>(h, 'kbHtml').hasSearch).toBe(true);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    field.focus();
    vi.useFakeTimers();
    typeInto(field, 'ا');
    vi.advanceTimersByTime(400);
    typeInto(field, 'ارسال');
    vi.advanceTimersByTime(299);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(0);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await flush(20);
    const searches = h.fetches.filter((u) => u.includes('/kb/search'));
    expect(searches).toHaveLength(1);
    expect(new URL(searches[0]).searchParams.get('q')).toBe('ارسال');
    // Word by word: the help center, which never sends it, keeps its phrase search.
    expect(new URL(searches[0]).searchParams.get('match')).toBe('words');
    // The same element, still focused, with its text.
    expect(h.q('[data-kb-search]')).toBe(field);
    expect(h.shadow.activeElement).toBe(field);
    expect(field.value).toBe('ارسال');
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('results');
    expect(h.q('[data-count]')!.textContent).toBe('1');
  });

  it('keeps one request in flight, runs the latest query after it, and answers a repeated query from the session cache', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS, holdKbSearch: true });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    typeInto(field, 'ارسال');
    await new Promise((r) => setTimeout(r, 320));
    await flush();
    typeInto(field, 'ارسال سفارش');
    await new Promise((r) => setTimeout(r, 320));
    await flush();
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(1);
    h.releaseKbSearch();
    await flush(20);
    h.releaseKbSearch();
    await flush(20);
    const qs = h.fetches.filter((u) => u.includes('/kb/search')).map((u) => new URL(u).searchParams.get('q'));
    expect(qs).toEqual(['ارسال', 'ارسال سفارش']);

    typeInto(field, 'ارسال');
    await new Promise((r) => setTimeout(r, 320));
    await flush(20);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(2);
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('results');
  });

  it('a request that never answers frees its slot after 8 s, and the query typed meanwhile runs', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS, holdKbSearch: true });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeInto(field, 'ارسال');
    await vi.advanceTimersByTimeAsync(400);
    typeInto(field, 'ارسال سفارش');
    await vi.advanceTimersByTimeAsync(400);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    vi.useRealTimers();
    await flush(20);
    const qs = h.fetches.filter((u) => u.includes('/kb/search')).map((u) => new URL(u).searchParams.get('q'));
    expect(qs).toEqual(['ارسال', 'ارسال سفارش']);
    // The dropped query was not cached as "no results": it asks again.
    h.releaseKbSearch();
    await flush(20);
    typeInto(field, 'ارسال');
    await new Promise((r) => setTimeout(r, 320));
    await flush(20);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(3);
  });

  it('never searches during an IME composition; the composition end does', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    field.dispatchEvent(new CompositionEvent('compositionstart'));
    typeInto(field, 'ارسال');
    await new Promise((r) => setTimeout(r, 320));
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(0);
    field.dispatchEvent(new CompositionEvent('compositionend'));
    await new Promise((r) => setTimeout(r, 320));
    await flush(20);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(1);
  });

  it('Enter searches at once; an IME\'s Enter does not', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    typeInto(field, 'ارسال');
    key(field, 'Enter', { keyCode: 229 });
    await flush();
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(0);
    key(field, 'Enter');
    await flush(20);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(1);
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('results');
    // The pause that followed the typing does not search again.
    await new Promise((r) => setTimeout(r, 320));
    await flush();
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(1);
  });

  it('the clear button empties the field, shows the list and refocuses the field', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    typeInto(field, 'ارسال');
    await new Promise((r) => setTimeout(r, 320));
    await flush(20);
    click(h.q('[data-kb-search-clear]'));
    await flush();
    expect(h.q<HTMLInputElement>('[data-kb-search]')!.value).toBe('');
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('list');
    expect(h.shadow.activeElement).toBe(h.q('[data-kb-search]'));
  });

  it('Enter in the home field opens Help with the query in a focused field and searches it', async () => {
    const h = boot({ renderer: featureRenderer(), kbSearch: RESULTS });
    await flush(20);
    const homeField = h.q<HTMLInputElement>('[data-kb-search]')!;
    typeInto(homeField, 'ارسال');
    key(homeField, 'Enter');
    await flush(30);
    expect(h.panel.getAttribute('data-view')).toBe('help');
    const helpField = h.q<HTMLInputElement>('[data-kb-search]')!;
    expect(helpField.value).toBe('ارسال');
    expect(h.shadow.activeElement).toBe(helpField);
    expect(h.fetches.filter((u) => u.includes('/kb/search'))).toHaveLength(1);
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('results');
  });
});

describe('kbCategories, kbArticleMeta, kbProgress', () => {
  const KB = {
    categories: [{ id: 'cat-1', name: 'سفارش و ارسال', slug: 'orders', description: '', icon: 'box' }],
    articles: [
      { id: 'a1', title: 'چطور سفارشم را پیگیری کنم؟', slug: 'track', excerpt: '', category_id: 'cat-1' },
      { id: 'a2', title: 'راهنمای سایز', slug: 'size', excerpt: '', category_id: null },
    ],
    article: { id: 'a1', title: 'چطور سفارشم را پیگیری کنم؟', slug: 'track', content: '<p>' + 'کلمه '.repeat(450) + '</p>', updated_at: '2026-10-14T08:00:00Z', category_id: 'cat-1' },
  };

  it('categories carry id, icon and count; a category lists its articles; back returns', async () => {
    const h = boot({ renderer: featureRenderer(), kb: KB });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    const listVm = vmOf<KbVm>(h, 'kbHtml');
    expect(listVm.categories[0]).toMatchObject({ id: 'cat-1', icon: 'box', count: 1, name: 'سفارش و ارسال' });
    click(h.q('[data-kb-category="cat-1"]'));
    await flush();
    expect(h.q('[data-category]')!.textContent).toBe('سفارش و ارسال:1');
    expect(vmOf<KbVm>(h, 'kbHtml').articles.map((a) => a.slug)).toEqual(['track']);

    click(h.q('[data-kb-slug="track"]'));
    await flush(20);
    const meta = h.q('[data-meta]')!.getAttribute('data-meta');
    expect(meta).toBe('سفارش و ارسال|2|2026-10-14T08:00:00Z');
    // Back from the article returns to its category, then to the list.
    click(h.q('[data-view-back="back"]'));
    await flush();
    expect(h.q('[data-category]')).not.toBeNull();
    expect(h.runtime).toBeTruthy();
  });

  it('a search started inside a category: back from its article returns to the results', async () => {
    const h = boot({ renderer: featureRenderer(), kb: KB, kbSearch: { 'سفارش': [{ slug: 'track', title: KB.article.title, excerpt: '' }] } });
    await flush();
    h.runtime.setTab('help');
    await flush(20);
    click(h.q('[data-kb-category="cat-1"]'));
    await flush();
    typeInto(h.q<HTMLInputElement>('[data-kb-search]')!, 'سفارش');
    await new Promise((r) => setTimeout(r, 320));
    await flush(20);
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('results');
    click(h.q('[data-kb-slug="track"]'));
    await flush(20);
    click(h.q('[data-view-back="back"]'));
    await flush();
    expect(h.q('[data-kb-results]')!.getAttribute('data-state')).toBe('results');
  });

  it('writes the reading progress as --p on [data-kb-progress]', async () => {
    const h = boot({ renderer: featureRenderer(), kb: KB });
    await flush();
    h.runtime.setTab('help', 'track');
    await flush(20);
    const scroller = h.q<HTMLElement>('.scroller')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 40));
    expect(h.q<HTMLElement>('[data-kb-progress]')!.style.getPropertyValue('--p')).toBe('0.5');
  });

  it('a neutral face is sent as rating "neutral"', async () => {
    const h = boot({ renderer: featureRenderer(), kb: KB });
    await flush();
    h.runtime.setTab('help', 'track');
    await flush(20);
    click(h.q('[data-kb-rate="neutral"]'));
    await flush();
    const vote = h.posts.find((p) => p.url.includes('/feedback'));
    expect(vote!.body.rating).toBe('neutral');
  });
});

describe('operatorTyping and chatHeader', () => {
  it('typing shows the named row for 3.5 s, the header knows it, and the row is not counted as a message', async () => {
    const h = boot({
      renderer: featureRenderer(),
      realtime: true,
      conversations: [{ id: 'c1', operatorName: 'سارا', operatorOnline: true }],
      history: { c1: [OPERATOR_MSG] },
    });
    await flush();
    h.runtime.__test.openConversation('c1');
    await flush(20);
    const head = () => JSON.parse(h.q('[data-head]')!.textContent || '{}');
    expect(head().operator).toMatchObject({ name: 'سارا', online: true });
    expect(head().typing).toBe(false);
    expect(head().isNew).toBe(false);

    vi.useFakeTimers();
    h.emitTyping();
    expect(h.q('.typing-row')!.textContent).toBe('typing:سارا');
    expect(head().typing).toBe(true);
    // Real rows keep their entrance suppression; the typing row is extra.
    expect(h.q('[data-chat-messages]')!.querySelectorAll('.msg-row:not(.typing-row)').length).toBe(1);
    vi.advanceTimersByTime(3600);
    vi.useRealTimers();
    expect(h.q('.typing-row')).toBeNull();
    expect(head().typing).toBe(false);
  });

  it('the header uses the assigned operator from the thread\'s history, and the presence line keeps its own classes', async () => {
    const h = boot({
      renderer: featureRenderer(),
      conversations: [{ id: 'c1' }],
      history: { c1: [] },
      assignedOperator: { name: 'مهدی', avatar: null, online: false },
    });
    await flush();
    h.runtime.__test.openConversation('c1');
    await flush(20);
    const head = JSON.parse(h.q('[data-head]')!.textContent || '{}');
    expect(head.operator).toEqual({ name: 'مهدی', avatar: null, online: false });
    expect(head.isNew).toBe(true);
    const presence = h.q('[data-presence]')!;
    expect(presence.classList.contains('bar-status')).toBe(true);
    expect([...presence.classList].some((c) => c.startsWith('status-'))).toBe(true);
    expect(presence.classList.contains('sr-only')).toBe(false);
  });

  it('a renderer that only draws typing names the assigned operator ahead of the last one who wrote', async () => {
    const h = boot({
      renderer: featureRenderer({ operatorTyping: true }),
      realtime: true,
      conversations: [{ id: 'c1' }],
      history: { c1: [OPERATOR_MSG] },
      assignedOperator: { name: 'مهدی', avatar: null, online: true },
    });
    await flush();
    h.runtime.__test.openConversation('c1');
    await flush(20);
    vi.useFakeTimers();
    h.emitTyping();
    expect(h.q('.typing-row')!.textContent).toBe('typing:مهدی');
    vi.advanceTimersByTime(3600);
    vi.useRealTimers();
    expect(h.q('.typing-row')).toBeNull();
  });
});

describe('emptyQna and topics', () => {
  it('a new conversation gets { qna, topics, operatorTyping }; a topic in it is sent as the visitor\'s message', async () => {
    const h = boot({ renderer: featureRenderer(), config: { templateOptions: { topics: [{ label: 'مرجوعی کالا', icon: 'return' }] } } });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    h.runtime.__test.startNew();
    await flush();
    const vm = vmOf<EmptyVm>(h, 'emptyHtml');
    expect(vm.topics).toEqual([{ label: 'مرجوعی کالا', icon: 'return' }]);
    expect(vm.qna).toMatchObject({ questions: [] });
    expect(vm).toHaveProperty('operatorTyping', null);
    expect(h.fetches.some((u) => u.includes('/qna-suggestions'))).toBe(true);
    click(h.q('[data-topic="مرجوعی کالا"]'));
    await flush();
    expect(sentText(h)!.text).toBe('مرجوعی کالا');
    // No AI owns this thread: no 25-second "thinking" row.
    expect(h.runtime.__test.chatState().aiThinking).toBe(false);
  });

  it('a renderer that declares topics alone (not emptyQna) still gets them in the empty thread, sent on a press', async () => {
    const h = boot({
      renderer: featureRenderer({ topics: true }),
      config: { templateOptions: { topics: [{ label: 'مرجوعی کالا', icon: 'return' }] } },
    });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    h.runtime.__test.startNew();
    await flush();
    expect(vmOf<EmptyVm>(h, 'emptyHtml').topics).toEqual([{ label: 'مرجوعی کالا', icon: 'return' }]);
    // Q&A is emptyQna's: not fetched for topics alone.
    expect(h.fetches.some((u) => u.includes('/qna-suggestions'))).toBe(false);
    click(h.q('[data-chat-messages] [data-topic="مرجوعی کالا"]'));
    await flush();
    expect(sentText(h)!.text).toBe('مرجوعی کالا');
  });

  it('a topic on home starts a NEW conversation whose first message is the label, with no AI greeting ahead of it', async () => {
    const h = boot({
      renderer: featureRenderer(),
      config: { aiAgent: { visitorFacing: true, providerReady: true, introCapable: true, suppressGreeting: true } },
      conversations: [{ id: 'c-old' }],
      hint: { tab: 'home', conversationId: null },
    });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    click(h.q('[data-topic="زمان ارسال"]'));
    await flush();
    const sent = sentText(h)!;
    expect(sent.text).toBe('زمان ارسال');
    expect(sent.forceNewConversation).toBe(true);
    expect(h.fetches.some((u) => u.includes('/ai-agent/intro'))).toBe(false);
    expect(h.panel.getAttribute('data-view')).toBe('chat');
  });
});

describe('homeAsk', () => {
  it('keeps the draft, focus and caret across a home repaint', async () => {
    const h = boot({ renderer: featureRenderer() });
    await flush(20);
    const ask = h.q<HTMLTextAreaElement>('[data-home-ask]')!;
    ask.focus();
    typeInto(ask, 'سفارشم کجاست؟');
    ask.setSelectionRange(3, 3);
    h.runtime.setTab('home');
    await flush();
    const again = h.q<HTMLTextAreaElement>('[data-home-ask]')!;
    expect(again).not.toBe(ask);
    expect(again.value).toBe('سفارشم کجاست؟');
    expect(h.shadow.activeElement).toBe(again);
    expect(again.selectionStart).toBe(3);
  });

  it('does not repaint home under an IME composition, and repaints when it ends', async () => {
    const h = boot({ renderer: featureRenderer() });
    await flush(20);
    const ask = h.q<HTMLTextAreaElement>('[data-home-ask]')!;
    ask.focus();
    ask.dispatchEvent(new CompositionEvent('compositionstart'));
    h.runtime.setTab('home');
    await flush();
    expect(h.q('[data-home-ask]')).toBe(ask);
    ask.dispatchEvent(new CompositionEvent('compositionend'));
    await flush();
    expect(h.q('[data-home-ask]')).not.toBe(ask);
  });

  it('a composition whose field left the screen without ending never freezes home', async () => {
    const h = boot({ renderer: featureRenderer() });
    await flush(20);
    const ask = h.q<HTMLTextAreaElement>('[data-home-ask]')!;
    ask.focus();
    ask.dispatchEvent(new CompositionEvent('compositionstart'));
    // Taken off screen by a switch nobody typed (no blur, no compositionend).
    h.runtime.setTab('list');
    await flush();
    h.runtime.setTab('home');
    await flush();
    const fresh = h.q<HTMLTextAreaElement>('[data-home-ask]');
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(ask);
    h.runtime.setTab('home');
    await flush();
    expect(h.q('[data-home-ask]')).not.toBe(fresh);
  });

  it('Enter (not Shift+Enter) sends the draft as the first message of a new conversation', async () => {
    const h = boot({ renderer: featureRenderer(), conversations: [{ id: 'c-old' }], hint: { tab: 'home', conversationId: null } });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    const ask = h.q<HTMLTextAreaElement>('[data-home-ask]')!;
    typeInto(ask, 'سفارشم کجاست؟');
    key(ask, 'Enter', { shiftKey: true });
    await flush();
    expect(sentText(h)).toBeUndefined();
    key(ask, 'Enter');
    await flush();
    const sent = sentText(h)!;
    expect(sent.text).toBe('سفارشم کجاست؟');
    expect(sent.forceNewConversation).toBe(true);
  });

  it('every [data-home-action="chat"] sends a written draft; with pre-chat required the draft waits in the composer', async () => {
    const h = boot({
      renderer: featureRenderer(),
      identity: { identity_state: 'anonymous', contact: null, prechat: { ask_email: true, require_email: true, timing: 'always' } },
    });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    typeInto(h.q<HTMLTextAreaElement>('[data-home-ask]')!, 'یک سؤال');
    click(h.q('[data-home-action="chat"]'));
    await flush();
    expect(sentText(h)).toBeUndefined();
    expect(h.q('[data-prechat="email"]')).not.toBeNull();
    // The composer (mounted again after the form) holds it as the draft.
    expect(h.runtime.__test.chatState().drafts.__pending__).toBe('یک سؤال');
    // …as a real draft once the form is sent: the value and the send button
    // (has-draft), not a bare value under the mic.
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'ali@example.com');
    click(h.q('[data-prechat-submit]'));
    await flush(20);
    expect(h.q<HTMLTextAreaElement>('[data-msg-input]')!.value).toBe('یک سؤال');
    expect(h.q('[data-input-bar]')!.classList.contains('has-draft')).toBe(true);
  });

  it('away (the leave-a-message form owns the tab) pre-fills that form', async () => {
    const h = boot({
      renderer: featureRenderer(),
      config: { availability: { state: 'offline', quota_full: true } },
    });
    await flush(20);
    typeInto(h.q<HTMLTextAreaElement>('[data-home-ask]')!, 'پیام من');
    click(h.q('[data-home-action="chat"]'));
    await flush();
    expect(h.q<HTMLTextAreaElement>('[data-fb="message"]')!.value).toBe('پیام من');
  });
});

describe('prechatOperator and prechatSummary', () => {
  const PRECHAT = { identity_state: 'anonymous', contact: null, prechat: { ask_email: true, require_email: false, timing: 'after_handoff' } };

  it('keeps a locked composer under the card; skip hides the card for the session and unlocks it', async () => {
    const h = boot({ renderer: featureRenderer(), identity: PRECHAT, conversations: [{ id: 'c1' }], history: { c1: [OPERATOR_MSG] } });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    h.runtime.__test.openConversation('c1');
    await flush(20);
    const bar = h.q('[data-input-bar]')!;
    expect(h.q('.hc-card')).not.toBeNull();
    expect(bar.style.display).toBe('flex');
    expect(bar.classList.contains('is-locked')).toBe(true);
    expect(h.q<HTMLTextAreaElement>('[data-msg-input]')!.disabled).toBe(true);
    click(h.q('[data-prechat-skip]'));
    await flush();
    expect(h.q('.hc-card')).toBeNull();
    expect(bar.classList.contains('is-locked')).toBe(false);
    expect(h.q<HTMLTextAreaElement>('[data-msg-input]')!.disabled).toBe(false);
  });

  it('after a submit the summary row shows once; edit reopens the card with the saved values', async () => {
    const h = boot({ renderer: featureRenderer(), identity: PRECHAT, conversations: [{ id: 'c1' }], history: { c1: [OPERATOR_MSG] } });
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    h.runtime.__test.openConversation('c1');
    await flush(20);
    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'ali@example.com');
    click(h.q('[data-prechat-submit]'));
    await flush(20);
    expect(h.q('[data-summary]')!.textContent).toContain('ali@example.com');
    expect(h.q('.hc-card')).toBeNull();
    click(h.q('[data-prechat-edit]'));
    await flush();
    expect(h.q('[data-summary]')).toBeNull();
    expect(h.q<HTMLInputElement>('[data-prechat="email"]')!.value).toBe('ali@example.com');
  });

  // A card is not repainted for typing (its fields are in use), so a typing
  // row drawn under it by any other repaint would stay after the typing.
  it('typing is never drawn under the handoff card, and does not repaint the details being edited', async () => {
    const h = boot({ renderer: featureRenderer(), realtime: true, identity: PRECHAT, conversations: [{ id: 'c1' }], history: { c1: [OPERATOR_MSG] } });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(20);
    expect(h.q('.hc-card')).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.emitTyping();
    h.runtime.setTab('chat'); // any repaint inside the 3.5 s window
    expect(h.q('.typing-row')).toBeNull();
    await vi.advanceTimersByTimeAsync(3600);
    vi.useRealTimers();
    expect(h.q('.typing-row')).toBeNull();

    typeInto(h.q<HTMLInputElement>('[data-prechat="email"]')!, 'ali@example.com');
    click(h.q('[data-prechat-submit]'));
    await flush(20);
    click(h.q('[data-prechat-edit]'));
    await flush();
    const field = h.q<HTMLInputElement>('[data-prechat="email"]')!;
    field.focus();
    h.emitTyping();
    await flush();
    expect(h.q('[data-prechat="email"]')).toBe(field);
    expect(h.shadow.activeElement).toBe(field);
    expect(h.q('.typing-row')).toBeNull();
    // The header still says so.
    expect(JSON.parse(h.q('[data-head]')!.textContent || '{}').typing).toBe(true);
  });
});

describe('conversationOperator', () => {
  it('conversation rows carry lastFromVisitor and the assigned operator', async () => {
    const h = boot({
      renderer: featureRenderer(),
      conversations: [{ id: 'c1', outbound: true, operatorName: 'سارا', operatorAvatar: 'https://cdn.test/s.png', operatorOnline: true }],
    });
    await flush(20);
    const row = vmOf<HomeVm>(h, 'homeHtml').conversations[0];
    expect(row).toMatchObject({
      id: 'c1', lastFromVisitor: true, operatorName: 'سارا', operatorAvatar: 'https://cdn.test/s.png', operatorOnline: true,
    });
  });
});

describe('voice and emoji (clock, vnRate, recSend, emojiTabs)', () => {
  /** default's frame plus a stop-and-send button and a speed chip. */
  const voiceRenderer = (base: BaseRenderer) => Object.assign(featureRenderer()(base), {
    chatFrameHtml: (vm: unknown) => base.chatFrameHtml(vm)
      .replace('<button type="button" class="rec-btn rec-confirm" data-rec-stop', '<button type="button" data-rec-send>send</button><button type="button" class="rec-btn rec-confirm" data-rec-stop')
      .replace('<audio data-vn-audio', '<button type="button" data-vn-rate>1×</button><audio data-vn-audio'),
  });
  const VOICE = { attachments: { enabled: true, voiceNotesEnabled: true } };

  async function openChat(h: ReturnType<typeof boot>) {
    await flush(20);
    h.runtime.__test.setConnectionState('online');
    h.runtime.setTab('chat');
    await flush();
  }

  it('format.clock writes the recording timer; the preview speed cycles 1 → 1.5 → 2 → 1 with format.rate', async () => {
    const h = boot({ renderer: voiceRenderer, config: VOICE, media: true });
    await openChat(h);
    click(h.q('[data-mic-btn]'));
    await flush();
    expect(h.q('[data-rec-timer]')!.textContent).toBe('c0');
    click(h.q('[data-rec-stop]'));
    await flush(20);
    // The preview is up; its speed chip starts at 1 and cycles.
    expect(h.q('[data-vn-bar]')!.hidden).toBe(false);
    const rate = h.q('[data-vn-rate]')!;
    expect(rate.textContent).toBe('r1');
    click(rate);
    expect(rate.textContent).toBe('r1.5');
    expect(h.q<HTMLAudioElement>('[data-vn-audio]')!.playbackRate).toBe(1.5);
    click(rate);
    expect(rate.textContent).toBe('r2');
    click(rate);
    expect(rate.textContent).toBe('r1');
  });

  it('stop-and-send sends the note through the one send path, with no preview on the way', async () => {
    const h = boot({ renderer: voiceRenderer, config: VOICE, media: true });
    await openChat(h);
    click(h.q('[data-mic-btn]'));
    await flush();
    const bar = h.q('[data-vn-bar]')!;
    const seen: boolean[] = [];
    const watch = new MutationObserver(() => seen.push(bar.hidden));
    watch.observe(bar, { attributes: true });
    click(h.q('[data-rec-send]'));
    await flush(30);
    watch.disconnect();
    const sent = sentText(h)!;
    expect(sent.attachmentId).toBe('att-1');
    expect(seen.every((hidden) => hidden)).toBe(true);
    expect(bar.hidden).toBe(true);
  });

  it('a renderer\'s grouped emoji grid is kept, and a tab selects its group', async () => {
    const h = boot({
      renderer: (base: BaseRenderer) => Object.assign(featureRenderer()(base), {
        chatFrameHtml: (vm: unknown) => base.chatFrameHtml(vm).replace(
          '<div class="emoji-picker" data-emoji-picker hidden></div>',
          '<div class="emoji-picker" data-emoji-picker hidden><div role="tablist">' +
            '<button type="button" data-emoji-tab="faces" aria-selected="true">f</button>' +
            '<button type="button" data-emoji-tab="hearts" aria-selected="false">h</button></div>' +
            '<div class="grid" style="overflow:auto"><div data-emoji-group="faces"><button type="button" data-emoji="😀">😀</button></div>' +
            '<div data-emoji-group="hearts"><button type="button" data-emoji="❤️">❤️</button></div></div></div>'),
      }),
    });
    await flush(20);
    h.runtime.setTab('chat');
    await flush();
    const picker = h.q('[data-emoji-picker]')!;
    expect(picker.querySelectorAll('[data-emoji]')).toHaveLength(2);
    click(picker.querySelector('[data-emoji-tab="hearts"]'));
    expect(picker.querySelector('[data-emoji-tab="hearts"]')!.getAttribute('aria-selected')).toBe('true');
    expect(picker.querySelector('[data-emoji-tab="faces"]')!.getAttribute('aria-selected')).toBe('false');
  });
});
