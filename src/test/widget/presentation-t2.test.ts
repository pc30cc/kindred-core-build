/**
 * The `t2` renderer (public/widget/presentation-t2.js): a home with a hero,
 * an ask card and quiet rows, the operator-side thread, the help center.
 *
 * What these tests hold it to:
 *   - every data-* hook the `default` renderer emits is still emitted (Core
 *     binds them; a missing one is a dead control nobody notices);
 *   - every string a view-model or the config carries is escaped, and an
 *     address is drawn only from an allowed scheme;
 *   - each Core behaviour in `features` is actually drawn, and nothing is
 *     drawn for a capability Core says it cannot serve;
 *   - skeletons wear the real surfaces' structure; Persian digits in fa; the
 *     accent tokens it computes (brand look, on-accent ink);
 *   - the platform's marks stay out of the RESPOK build.
 * Geometry against the design's PNGs is checked with the screenshot harness
 * (e2e/harness/templateScreens.ts --template t2), not here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const REGISTRY_SRC = read('public/widget/presentation-registry.js');
const T2_SRC = read('public/widget/presentation-t2.js');
const DEFAULT_SRC = read('public/widget/presentation-default.js');
const T2_CSS = read('public/widget/presentation-t2.css');

type Vm = Record<string, unknown>;
type Fn = (...args: unknown[]) => string;
type Renderer = Record<string, Fn> & {
  id: string;
  features: Record<string, boolean>;
  format: Record<string, (...args: unknown[]) => string>;
};

/** Core's own escaping (runtime.js Util.escapeHtml): quotes included. */
const escapeHtml = (v: unknown) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const FA: Record<string, string> = {
  homeGreeting: 'سلام 👋', homeReplyFast: 'معمولاً در چند دقیقه پاسخ می‌دهیم', homeReplySlow: 'به‌محض بازگشت پاسخ می‌دهیم',
  help: 'مرکز راهنما', wyNewConversation: 'گفتگوی جدید', you: 'شما', wyStatusOpen: 'باز', wyStatusResolved: 'حل شده',
  email: 'ایمیل', name: 'نام', phone: 'شماره تلفن', searchKb: 'جستجو در مقالات...', intro: 'سوالی دارید؟',
};

const BASE_CONFIG: Vm = {
  workspaceName: 'فروشگاه نیلوفر',
  teamMembers: [{ name: 'سارا', online: true }, { name: 'مهدی' }, { name: 'رضا' }],
  poweredBy: { text: 'قدرت گرفته از', brand: 'Platform', url: 'https://platform.test' },
  attachments: { enabled: true, voiceNotesEnabled: true, allowedMimes: ['image/png'] },
  composer: { emojiEnabled: true },
  readReceipts: { enabled: true },
};

function load() {
  const w = window as unknown as Record<string, unknown>;
  // jsdom has neither; the recorder is drawn only with real voice support.
  w.MediaRecorder = function () {};
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {} }, configurable: true });
  }
  new Function(REGISTRY_SRC).call(window);
  new Function(T2_SRC).call(window);
  new Function(DEFAULT_SRC).call(window);
}

function make(opts: { locale?: string; primaryColor?: string; config?: Vm; capabilities?: Vm; t?: (k: string) => string } = {}): Renderer {
  const w = window as unknown as Record<string, { create: (env: Vm) => Renderer }>;
  return w.__gs_presentation_t2.create({
    t: opts.t || ((k: string) => FA[k] ?? k),
    escapeHtml,
    config: { ...BASE_CONFIG, ...(opts.config || {}) },
    locale: opts.locale || 'fa',
    primaryColor: opts.primaryColor ?? '#3B82F6',
    capabilities: opts.capabilities || { kbNeutral: true, csat: false, reactions: false, orderCard: false, prechatSteps: false, instantAnswers: false },
  });
}

const parse = (html: string) => new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html').getElementById('r')!;
const IDENTITY = (asked: string[], required: string[] = []) => ({
  isAsked: (k: string) => asked.includes(k),
  isRequired: (k: string) => required.includes(k),
});
const now = new Date().toISOString();
const msg = (over: Vm): Vm => ({ __id: 'm' + Math.random(), sender: 'operator', senderType: 'agent', body: 'hi', time: now, ...over });
const HEART = '\u2764\uFE0F';
const UUID = '7d1f3e2a-4b5c-4d6e-8f90-a1b2c3d4e5f6';

beforeAll(load);

const T2_X_SRC = read('public/widget/presentation-t2-x.js');
/** The renderer's extras module (presentation-t2-x.js), fresh, as Core hands it over. */
function extrasModule() {
  const w = window as unknown as Record<string, unknown>;
  delete w.__gs_mod_extras;
  new Function(T2_X_SRC).call(window);
  return w.__gs_mod_extras as { id: string; v: number; create: (h: unknown) => Record<string, Fn> };
}
/** A renderer that took its extras. */
function withExtras(r: Renderer): Renderer {
  expect((r.extend as unknown as (m: unknown) => number)(extrasModule())).toBeGreaterThan(0);
  return r;
}
/** A `conversation_closed` row as Core keeps it. */
const closedRow = (id: string, agentName: string | null, over: Vm = {}): Vm => msg({
  __id: id, sender: 'operator', senderType: 'system', senderName: agentName, body: `${agentName} closed the conversation`,
  metadata: { kind: 'conversation_closed', by: 'agent', agent_name: agentName, operator_name: agentName, status: 'resolved' }, ...over,
});
/** The rating card's view-model (runtime-late.js `view.csat`). */
const CSAT = (closedId: string, over: Vm = {}): Vm => ({
  closedId, name: 'سارا', avatar: null, rating: 0, comment: '', state: 'ask', transcript: null, ...over,
});

describe('t2: registration', () => {
  it('registers under the registry key with id t2 and the shared contract', () => {
    const reg = (window as unknown as { __gs_presentation_registry: { resolve: (id: string) => { globalKey: string; id: string } } })
      .__gs_presentation_registry.resolve('t2');
    expect(reg.id).toBe('t2');
    expect(T2_SRC).toContain(`window.${reg.globalKey} = { id: 't2', create: create, prepare: prepare };`);
    const r = make();
    expect(r.id).toBe('t2');
    for (const key of [
      'shellHtml', 'chatFrameHtml', 'homeHtml', 'emptyHtml', 'messagesHtml', 'aiThinkingRowHtml', 'qnaChipsHtml',
      'messageAttachmentHtml', 'callInvitationCardHtml', 'callEndedRowHtml', 'routingOutcomeRowHtml',
      'prechatFieldRowHtml', 'prechatFormHtml', 'handoffPrechatCardHtml', 'contactFallbackHtml', 'smartSurfaceHtml',
      'conversationListHtml', 'conversationRowHtml', 'kbHtml', 'kbSearchBarHtml', 'kbHomeHtml', 'kbSearchResultsHtml',
      'kbArticleHtml', 'kbEmptyHtml', 'kbLoadingHtml', 'kbArticleFeedbackHtml', 'skeletonHtml', 'connIndicatorHtml',
      'chatHeaderHtml', 'prechatSummaryHtml',
    ]) {
      expect(typeof r[key], key).toBe('function');
    }
    for (const f of ['msgTime', 'callDuration', 'invitationRemaining', 'humanSize', 'clock']) {
      expect(typeof r.format[f], f).toBe('function');
    }
  });
});

describe('t2: every hook the default renderer emits', () => {
  const hooks = (src: string) => new Set((src.match(/data-[a-z0-9]+(?:-[a-z0-9]+)*(?=[\s="'>])/g) || []));

  it('is emitted by t2 too', () => {
    const missing = [...hooks(DEFAULT_SRC)].filter((h) => !hooks(T2_SRC).has(h));
    expect(missing).toEqual([]);
  });

  it('in the rendered surfaces, not only in the source', () => {
    const d = (window as unknown as Record<string, { create: (env: Vm) => Renderer }>).__gs_presentation_default.create({
      t: (k: string) => k, escapeHtml, config: BASE_CONFIG, locale: 'fa', primaryColor: '#3B82F6',
    });
    const r = make();
    const id = IDENTITY(['name', 'email', 'phone']);
    const surfaces = (x: Renderer) => [
      x.shellHtml({}),
      x.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }),
      x.homeHtml({ rtl: true, isOnline: true, kbEnabled: true, chatEnabled: true, articles: [{ slug: 'a', title: 'A' }],
        conversations: [{ id: 'c', status: 'open', preview: 'p' }], conversationsError: false }),
      x.homeHtml({ rtl: true, isOnline: true, chatEnabled: true, conversations: [], conversationsError: true }),
      x.conversationListHtml({ conversations: [{ id: 'c', status: 'open' }], chatEnabled: true }),
      x.conversationListHtml({ conversations: [], error: true, chatEnabled: true }),
      x.messagesHtml({ messages: [
        msg({ attachment: { id: 'i', kind: 'image', file_name: 'a.png' } }),
        msg({ attachment: { id: 'v', kind: 'audio', file_name: 'a.wav' } }),
        msg({ attachment: { id: 'f', kind: 'file', file_name: 'a.pdf' } }),
        msg({ sender: 'visitor', senderType: 'contact', status: 'failed', localId: 'l1' }),
        msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: 'pending', channel: 'audio', invitation_id: 'x' } }),
      ] }, '', { qna: { questions: [{ question: 'q' }, { question: 'q2' }, { question: 'q3' }, { question: 'q4' }] } }),
      x.messagesHtml({ messages: [msg({ metadata: { source: 'ai_agent_intro' } })] }, '',
        { qna: { questions: [{ question: 'q' }, { question: 'q2' }, { question: 'q3' }, { question: 'q4' }], collapsedCount: 3 } }),
      x.handoffPrechatCardHtml(id, {}, 'fa', 'sub', true),
      x.prechatFormHtml(id, {}, 'fa'),
      x.contactFallbackHtml(id, {}, 'fa', {}),
      x.smartSurfaceHtml({ title: 't', body: 'b', ctaLabel: 'c' }),
      x.kbHtml({ state: 'article', article: { title: 'A', contentHtml: '<p>x</p>' }, feedback: { enabled: true } }),
      x.kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }], categories: [] }),
      x.connIndicatorHtml(),
    ].join('');
    const attrs = (html: string) => new Set((html.match(/\sdata-[a-z0-9-]+/g) || []).map((s) => s.trim()));
    const theirs = attrs(surfaces(d));
    const ours = attrs(surfaces(r));
    expect([...theirs].filter((h) => !ours.has(h))).toEqual([]);
  });
});

describe('t2: strings are escaped, addresses are allow-listed', () => {
  const X = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  const JS = 'javascript:alert(3)';
  // An allowed scheme does not make an address safe to print unescaped.
  const QUOTED = 'https://cdn.test/a.png" onerror="alert(4)';

  function assertInert(html: string) {
    const root = parse(html);
    expect(root.querySelector('script'), 'a <script> element').toBeNull();
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) {
        expect(a.name.startsWith('on'), `${el.tagName} ${a.name}`).toBe(false);
        if (['src', 'href'].includes(a.name)) expect(a.value.trim().toLowerCase().startsWith('javascript:'), a.value).toBe(false);
      }
      if (el.tagName === 'IMG') expect(el.getAttribute('src')).not.toBe('x');
    }
  }

  it('in every surface fed hostile names, previews, titles and addresses', () => {
    const r = make({
      config: {
        workspaceName: X, brandName: X, logoUrl: JS, welcomeMessage: X, replyTimeText: X,
        teamMembers: [{ name: X, avatar: JS, online: true }, { name: X, avatar: 'data:text/html,x' }, { name: X, avatar: QUOTED }],
        poweredBy: { text: X, brand: X, url: X, logo: JS },
        availability: { state: 'offline', next_open_at: X },
        templateOptions: { topics: [{ label: X, icon: X }], askExamples: [X, X] },
        attachments: { enabled: true, voiceNotesEnabled: true, allowedMimes: [X] },
      },
    });
    const conv = { id: X, status: X, preview: X, timeLabel: X, unreadCount: 3, operatorName: X, operatorAvatar: JS, lastFromVisitor: true, title: X };
    const kbVm = { query: X, results: [{ slug: X, title: X, excerpt: X }], articles: [{ slug: X, title: X, excerpt: X }],
      categories: [{ id: X, name: X, icon: X, count: 2 }], category: { id: X, name: X } };
    const html = [
      r.shellHtml({}),
      r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: { attachments: { enabled: true, voiceNotesEnabled: true, allowedMimes: [X] }, composer: {} } }),
      r.chatHeaderHtml({ online: true, typing: false, operator: { name: X, avatar: JS, online: true }, isNew: false }),
      r.chatHeaderHtml({ online: false, typing: true, operator: null, isNew: true }),
      make({ config: { logoUrl: QUOTED, showLogo: true } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true }),
      r.chatHeaderHtml({ online: true, typing: false, operator: { name: X, avatar: QUOTED, online: true }, isNew: false }),
      r.homeHtml({ rtl: true, isOnline: true, kbEnabled: true, chatEnabled: true, visitorName: X, conversations: [conv],
        articles: [{ slug: X, title: X }], categories: [{ name: X }], smartSurface: { mode: 'home_card', title: X, body: X, ctaLabel: X } }),
      r.homeHtml({ rtl: true, isOnline: false, kbEnabled: true, chatEnabled: true, conversations: [], conversationsError: true }),
      r.conversationListHtml({ conversations: [conv, { ...conv, status: 'resolved', operatorName: null }], chatEnabled: true }),
      r.conversationRowHtml(conv, true),
      r.emptyHtml({ qna: { questions: [{ question: X }] }, topics: [], operatorTyping: { name: X, avatar: JS } }),
      r.emptyHtml({ qna: { questions: [{ question: X }, { question: X }, { question: X }, { question: X }] } }),
      r.messagesHtml({ messages: [
        msg({ body: X, senderName: X, senderAvatar: JS, replyTo: { text: X } }),
        msg({ body: '> ' + X + '\n\n' + X, senderType: 'ai', senderName: X }),
        msg({ sender: 'visitor', senderType: 'contact', body: X, status: 'failed', localId: X }),
        msg({ body: '', attachment: { id: X, kind: 'image', file_name: X } }),
        msg({ body: X, attachment: { id: X, kind: 'file', file_name: X + '.' + X, size_bytes: 9 } }),
        msg({ body: '', attachment: { id: X, kind: 'audio', file_name: X } }),
        msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: X, operator_name: X, invitation_id: X } }),
        msg({ senderType: 'system', metadata: { kind: 'routing_agent_joined', agent_name: X } }),
      ] }, '', { operatorTyping: { name: X, avatar: JS }, qna: { questions: [] } }),
      r.handoffPrechatCardHtml(IDENTITY(['name', 'email', 'phone']), { name: X, email: X, phone: X }, 'fa', X, false),
      r.prechatSummaryHtml({ email: X }),
      r.prechatFormHtml(IDENTITY(['name', 'email']), { name: X, email: X }, 'fa'),
      r.contactFallbackHtml(IDENTITY(['phone']), { name: X, email: X, phone: X }, 'fa', { introLabel: X }),
      r.smartSurfaceHtml({ title: X, body: X, ctaLabel: X }),
      r.kbHtml({ ...kbVm, state: 'results' }),
      r.kbHtml({ ...kbVm, state: 'category' }),
      r.kbHtml({ ...kbVm, state: 'list' }),
      r.kbHtml({ state: 'article', article: { title: X, categoryTitle: X, readingMinutes: 2, contentHtml: '' }, feedback: { enabled: true, rating: X } }),
      r.skeletonHtml('home', { rtl: true }),
    ].join('');
    assertInert(html);
    // The hostile text arrived (escaped), it was not dropped.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('draws an image only from http(s), protocol-relative, same-origin or blob addresses', () => {
    const r = make({ config: { logoUrl: 'https://cdn.test/l.png', teamMembers: [{ name: 'a', avatar: '//cdn.test/a.png' }, { name: 'b', avatar: '/media/b.png' }] } });
    const html = r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true });
    expect(html).toContain('src="https://cdn.test/l.png"');
    expect(html).toContain('src="//cdn.test/a.png"');
    expect(html).toContain('src="/media/b.png"');
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=1>', 'vbscript:x', ' JaVaScRiPt:x']) {
      const h = make({ config: { logoUrl: bad, teamMembers: [{ name: 'a', avatar: bad }] } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true });
      expect(parse(h).querySelectorAll('img').length, bad).toBe(0);
    }
  });

  it('highlights a search query inside escaped text only', () => {
    const r = make();
    const html = r.kbHtml({ state: 'results', query: 'ارسال <b>', results: [{ slug: 's', title: 'زمان ارسال <b>bold</b>', excerpt: 'x' }] });
    const tt = parse(html).querySelector('.tt')!;
    expect(tt.querySelector('b')).toBeNull();
    expect(tt.querySelectorAll('mark').length).toBe(2);
    expect(tt.querySelector('mark')!.textContent).toBe('ارسال');
  });

  it('puts a name into Core\'s sentences literally (no $& / $\' replacement patterns)', () => {
    const own: Record<string, string> = { routingAgentJoined: '{name} پیوست', ciHeadlineAudioFrom: '{op} تماس می‌گیرد' };
    const r = make({ t: (k: string) => own[k] ?? FA[k] ?? k });
    const name = "A$'B$&C$`";
    for (const meta of [{ agent_name: name }, { to_name: name }]) {
      const row = parse(r.routingOutcomeRowHtml(msg({ senderType: 'system', metadata: { kind: 'routing_agent_joined', ...meta } })));
      expect(row.querySelector('.msg-system-pill')!.textContent).toBe(name + ' پیوست');
    }
    const call = parse(r.callInvitationCardHtml(msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: 'joined', channel: 'audio', operator_name: name } })));
    expect(call.querySelector('.ci-title')!.textContent).toBe(name + ' تماس می‌گیرد');
  });
});

/** What Core serves today (runtime.js env.capabilities). */
const SERVED = {
  kbNeutral: true, csat: true, reactions: true, orderCard: true, prechatSteps: true, instantAnswers: true, chatMenu: true, awayThread: true,
  queuePosition: true, emojiSearch: true, dlProgress: true, kbAuthor: true,
};

describe('t2: the Core behaviours it declares are the ones it draws', () => {
  const r = () => make({ capabilities: SERVED, config: { templateOptions: { topics: [{ label: 'زمان ارسال', icon: 'truck' }] } } });
  const checks: Record<string, () => void> = {
    homeAsk: () => {
      const h = parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
      expect(h.querySelector('textarea[data-home-ask]')).not.toBeNull();
      expect(h.querySelector('.ask [data-home-action="chat"]')).not.toBeNull();
    },
    topics: () => {
      expect(parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true })).querySelector('[data-topic="زمان ارسال"]')).not.toBeNull();
      expect(parse(r().emptyHtml({ qna: { questions: [] } })).querySelector('[data-topic="زمان ارسال"]')).not.toBeNull();
    },
    visitorName: () => {
      expect(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, visitorName: 'علی' })).toContain('سلام علی، خوش برگشتی');
    },
    conversationOperator: () => {
      const row = parse(r().conversationRowHtml({ id: 'c', status: 'open', preview: 'ممنون', operatorName: 'سارا', operatorOnline: true, lastFromVisitor: true }, false));
      expect(row.querySelector('.l1')!.textContent).toContain('سارا');
      expect(row.querySelector('.l2 em')!.textContent).toBe('شما: ممنون');
      expect(row.querySelector('.av .pr')).not.toBeNull();
    },
    chatHeader: () => {
      const h = parse(r().chatHeaderHtml({ online: true, typing: false, operator: { name: 'سارا', online: true }, isNew: false }));
      expect(h.querySelector('[data-presence]')).not.toBeNull();
      expect(h.querySelector('.nm')!.textContent).toBe('سارا');
      expect(h.querySelector('.ondot')).not.toBeNull();
      // Core rewrites the header: nothing it binds once may live in there.
      expect(h.querySelector('[data-chat-jump],[data-escalate-btn],[data-msg-input]')).toBeNull();
      const frame = parse(r().chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }));
      expect(frame.querySelector('[data-chat-header] [data-chat-jump]')).toBeNull();
      expect(frame.querySelector('[data-chat-header] [data-presence]')).not.toBeNull();
    },
    operatorTyping: () => {
      const h = parse(r().messagesHtml({ messages: [msg({})] }, '', { operatorTyping: { name: 'سارا', avatar: null } }));
      const row = h.querySelector('.messages > .msg-row.typing-row:last-child')!;
      expect(row.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('.msg-avatar')!.textContent).toBe('س');
    },
    emptyQna: () => {
      const h = parse(make().emptyHtml({ qna: { questions: [{ question: 'سفارشم کجاست؟' }] }, topics: [] }));
      expect(h.querySelector('[data-qna] [data-qna-question="سفارشم کجاست؟"]')).not.toBeNull();
    },
    prechatOperator: () => {
      const optional = parse(r().handoffPrechatCardHtml(IDENTITY(['email']), {}, 'fa', 'sub', false));
      expect(optional.querySelector('.msg-row.operator [data-prechat-skip]')).not.toBeNull();
      expect(optional.querySelector('.fi [data-prechat-submit]')).not.toBeNull();
      const required = parse(r().handoffPrechatCardHtml(IDENTITY(['email'], ['email']), {}, 'fa', 'sub', false));
      expect(required.querySelector('[data-prechat-skip]')).toBeNull();
    },
    prechatSummary: () => {
      const h = parse(r().prechatSummaryHtml({ email: 'ali@example.com' }));
      expect(h.querySelector('.fcard.done b')!.textContent).toBe('ali@example.com');
      expect(r().prechatSummaryHtml({})).toBe('');
    },
    kbSearch: () => {
      const h = parse(r().kbHtml({ state: 'list', query: '', articles: [] }));
      expect(h.querySelector('input.kb-search[data-kb-search]')).not.toBeNull();
      expect(h.querySelector('[data-kb-search-clear]')).not.toBeNull();
      // Only the region repaints while typing: the count lives inside it.
      const res = parse(r().kbHtml({ state: 'results', query: 'x', results: [{ slug: 'a', title: 'x' }] }));
      expect(res.querySelector('[data-kb-results] .cnt')).not.toBeNull();
      expect(res.querySelector('[data-kb-results] [data-kb-search]')).toBeNull();
    },
    kbCategories: () => {
      const h = parse(r().kbHtml({ state: 'list', articles: [], categories: [{ id: 'c1', name: 'سفارش', count: 5 }] }));
      expect(h.querySelector('[data-kb-category="c1"]')!.textContent).toContain('۵ مقاله');
      const cat = parse(r().kbHtml({ state: 'category', category: { id: 'c1', name: 'سفارش' }, articles: [{ slug: 'a', title: 'x' }] }));
      expect(cat.querySelector('.ttl')!.textContent).toBe('سفارش');
    },
    kbArticleMeta: () => {
      const h = parse(r().kbHtml({ state: 'article', article: { title: 'چطور', categoryTitle: 'سفارش و ارسال', readingMinutes: 2, contentHtml: '' }, feedback: { enabled: true } }));
      expect(h.querySelector('.ttl')!.textContent).toBe('سفارش و ارسال');
      expect(h.querySelector('.am')!.textContent).toBe('۲ دقیقه مطالعه');
    },
    kbProgress: () => {
      const h = parse(r().kbHtml({ state: 'article', article: { title: 'x', contentHtml: '' }, feedback: { enabled: false } }));
      expect(h.querySelector('.bar [data-kb-progress]')).not.toBeNull();
    },
    recSend: () => {
      const h = parse(r().chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }));
      expect(h.querySelector('[data-rec-bar] [data-rec-send]')).not.toBeNull();
      // Core still binds the stop-to-preview control; this design hides it.
      expect(h.querySelector('[data-rec-stop]')!.hasAttribute('hidden')).toBe(true);
    },
    clock: () => {
      expect(make().format.clock(14)).toBe('۰:۱۴');
      expect(make({ locale: 'en' }).format.clock(75)).toBe('1:15');
    },
    // Drawn by the extras (presentation-t2-x.js), tested below.
    closedNotice: () => {
      const h = parse(withExtras(r()).messagesHtml({ messages: [closedRow('c1', 'سارا')] }, undefined, {}));
      expect(h.querySelector('.msg-system-pill')!.textContent).toBe('سارا گفتگو را بست');
    },
    csat: () => {
      const h = parse(withExtras(r()).messagesHtml({ messages: [closedRow('c1', 'سارا')] }, undefined, { csat: CSAT('c1') }));
      expect(h.querySelectorAll('[data-csat] [data-csat-rate]')).toHaveLength(5);
    },
    chatMenu: () => {
      const h = parse(withExtras(r()).chatHeaderHtml({ online: true, isNew: false, menu: { open: false, items: [{ action: 'sound', on: true }] } }));
      expect(h.querySelector('[data-chat-menu-toggle][aria-haspopup="menu"]')).not.toBeNull();
    },
    reactions: () => {
      const m = msg({ __id: UUID, metadata: { reactions: [{ emoji: HEART, count: 1, mine: true }] } });
      const h = parse(withExtras(r()).messagesHtml({ messages: [m] }, undefined, { react: true }));
      expect(h.querySelector('.msg-line.rel > .react[role="img"]')).not.toBeNull();
      expect(h.querySelector('[data-msg-react][aria-pressed="true"]')).not.toBeNull();
    },
    awayThread: () => {
      const h = parse(withExtras(r()).messagesHtml({ messages: [msg({ sender: 'visitor', senderType: 'contact' })] }, undefined, { awayReply: { at: 0, status: 'ask' } }));
      expect(h.querySelector('.away-reply form [data-fb="email"]')).not.toBeNull();
    },
    // Tested below: the tray (extras), the arc (stylesheet), the byline.
    instantAnswers: () => {
      const h = parse(withExtras(r()).kbSuggestHtml({ results: [{ slug: 'a', title: 'مرجوعی', matches: ['مرجوعی'] }] }));
      expect(h.querySelector('[data-kb-suggest] [data-kb-action="open"][data-kb-slug="a"] mark')).not.toBeNull();
    },
    dlProgress: () => {
      expect(T2_CSS).toContain('.dl-on.msg-att-action::after, .dl-on .wy-ap-play::after {');
    },
    kbAuthor: () => {
      const h = parse(r().kbArticleHtml({ article: { title: 't', author: 'سارا', readingMinutes: 2, contentHtml: '' } }));
      expect(h.querySelector('.am')!.textContent).toBe('سسارا۲ دقیقه مطالعه');
    },
  };

  it('declares exactly the behaviours it implements', () => {
    expect(Object.keys(r().features).sort()).toEqual(Object.keys(checks).sort());
    expect(Object.values(r().features).every((v) => v === true)).toBe(true);
    // A Core that does not serve them gets none of them.
    const off = make().features;
    for (const f of ['reactions', 'awayThread', 'instantAnswers', 'dlProgress', 'kbAuthor']) expect(off[f], f).toBe(false);
  });
  for (const [name, check] of Object.entries(checks)) it(name, check);

  it('declares none of the behaviours it does not draw', () => {
    for (const f of ['tabs', 'emojiTabs', 'vnRate']) expect(make().features[f], f).toBeUndefined();
    expect(T2_SRC).not.toMatch(/data-tab-badge|data-emoji-tab|data-vn-rate/);
  });
});

describe('t2: nothing is drawn for a capability Core cannot serve', () => {
  const cases = [
    { csat: false, reactions: false, orderCard: false, instantAnswers: false, kbNeutral: false },
    // Even a Core that says yes gets nothing without its view-model and the
    // extras (reactions: `view.react`; the order card and the tray come with
    // the extras), and no track-order row without a store (`config.commerce`).
    { csat: true, reactions: true, orderCard: true, instantAnswers: true, kbNeutral: false },
  ];
  for (const capabilities of cases) {
    it(JSON.stringify(capabilities), () => {
      const r = make({ capabilities });
      const html = [
        r.messagesHtml({ messages: [
          msg({ metadata: { kind: 'order_status', order: { number: '48213' } }, body: 'سفارش' }),
          msg({ metadata: { reactions: [{ emoji: '❤️', count: 1 }] } }),
          msg({ senderType: 'system', metadata: { kind: 'conversation_closed', closed_by: 'سارا' } }),
        ] }, '', {}),
        r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }),
        r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true, kbEnabled: true }),
      ].join('');
      const root = parse(html);
      expect(root.querySelector('.card, .steps, .react, .csat, .faces, [data-csat-rate], [data-msg-react], .tray, [data-kb-suggest], .away-reply')).toBeNull();
      expect(html).not.toContain('track-order');
      const fb = parse(r.kbArticleFeedbackHtml({ enabled: true, rating: null }));
      expect(fb.querySelectorAll('[data-kb-rate]').length).toBe(2);
      expect(fb.querySelector('[data-kb-rate="neutral"]')).toBeNull();
    });
  }

  it('draws the neutral face once the server stores it (kbNeutral)', () => {
    const fb = parse(make().kbArticleFeedbackHtml({ enabled: true, rating: 'neutral' }));
    expect(Array.from(fb.querySelectorAll('[data-kb-rate]')).map((b) => b.getAttribute('data-kb-rate'))).toEqual(['down', 'neutral', 'up']);
    expect(fb.querySelector('[data-kb-rate="neutral"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(make().kbArticleFeedbackHtml({ enabled: false })).toBe('');
  });
});

describe('t2: skeletons wear the real surfaces', () => {
  const r = () => make();
  const classes = (html: string) => new Set((html.match(/class="([^"]+)"/g) || []).flatMap((m) => m.slice(7, -1).split(/\s+/)));
  const pairs: Array<[string, () => string, () => string, string[]]> = [
    // With the help center on (Core's kbEnabled), as the real home is drawn.
    ['home', () => make({ config: { features: { knowledgeBase: true } } }).skeletonHtml('home', { rtl: true, chatEnabled: true }),
      () => r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, kbEnabled: true, articles: [{ slug: 'a', title: 'A' }] }),
      ['wy-view-home', 'wy-home-scroll', 'hero', 'top', 'logo', 'hi', 'hq', 'pres', 'ask', 'field', 'chips', 'list', 'r', 'pw']],
    ['chat', () => r().skeletonHtml('chat', { rtl: true, chatEnabled: true, composer: { voiceNotes: true, attachments: true, emoji: true } }),
      () => r().chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }),
      ['wy-view-chat', 'bar', 'who', 'cs', 'wy-chat-scroll-host', 'wy-chat-scroll', 'composer-zone', 'cmp', 'input-bar', 'input-wrap',
        'input-row', 'input', 'composer-actions', 'composer-actions-start', 'mic-btn', 'attach-btn', 'emoji-btn', 'pw']],
    ['list', () => r().skeletonHtml('list', { rtl: true }), () => r().conversationListHtml({ conversations: [{ id: 'c' }] }),
      ['wy-view-list', 'bar', 'ttl', 'cs', 'inbox', 'pw']],
    ['help', () => r().skeletonHtml('help', { rtl: true }), () => r().kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }] }),
      ['wy-view-kb', 'bar', 'ttl', 'sfield', 'kb-scroll', 'res', 'kb-article', 'pw']],
    ['article', () => r().skeletonHtml('article', { rtl: true }),
      () => r().kbHtml({ state: 'article', article: { title: 'A', contentHtml: '' }, feedback: { enabled: true } }),
      ['wy-view-kb', 'kb-article-root', 'bar', 'ttl', 'art', 'kb-article-body', 'fb', 'face', 'cta', 'pw']],
    ['prechat', () => r().skeletonHtml('prechat', { rtl: true, fields: 2 }), () => r().prechatFormHtml(IDENTITY(['name', 'email']), {}, 'fa'),
      ['wy-view-precontact', 'bar', 'who', 'form-body', 'prechat-fields', 'prechat-field', 'fi', 'btn', 'pw']],
  ];
  for (const [name, skel, real, shared] of pairs) {
    it(name, () => {
      const s = classes(skel());
      const v = classes(real());
      for (const c of shared) {
        expect(s.has(c), `skeleton lacks .${c}`).toBe(true);
        expect(v.has(c), `view lacks .${c}`).toBe(true);
      }
      const root = parse(skel()).firstElementChild!;
      expect(root.classList.contains('wy-skeleton')).toBe(true);
      expect(root.getAttribute('aria-hidden')).toBe('true');
      expect(root.getAttribute('dir')).toBe('rtl');
      // Skeletons never carry names, times or counts.
      expect(parse(skel()).textContent!.replace(/قدرت گرفته از|Platform/g, '').trim()).toBe('');
    });
  }

  it('mirror the composer controls Core is about to mount', () => {
    const none = classes(r().skeletonHtml('chat', { chatEnabled: true, composer: {} }));
    expect(none.has('send-btn')).toBe(true);
    expect(none.has('mic-btn') || none.has('attach-btn') || none.has('emoji-btn')).toBe(false);
    expect(classes(r().skeletonHtml('chat', { chatEnabled: false })).has('composer-zone')).toBe(false);
  });

  it('falls back to the home skeleton for an unknown view', () => {
    expect(r().skeletonHtml('nope', {})).toContain('wy-view-home');
  });
});

describe('t2: numbers in the visitor\'s digits', () => {
  it('fa prints Persian digits everywhere it counts', () => {
    const r = make();
    expect(r.format.humanSize(245760)).toBe('۲۴۰ کیلوبایت');
    expect(r.format.humanSize(3 * 1048576)).toBe('۳ مگابایت');
    expect(r.format.clock(0)).toBe('۰:۰۰');
    const home = r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true, kbEnabled: true,
      articles: Array.from({ length: 24 }, (_, i) => ({ slug: 's' + i, title: 't' })),
      categories: [{ name: 'سفارش' }, { name: 'ارسال' }, { name: 'مرجوعی' }],
      conversations: [{ id: 'c', status: 'open', unreadCount: 2, preview: 'p', operatorName: 'سارا' }, { id: 'd', status: 'resolved' }, { id: 'e', status: 'resolved' }] });
    const text = parse(home).textContent!;
    expect(text).toContain('۲۴ مقاله درباره سفارش، ارسال و مرجوعی');
    expect(text).toContain('۳ گفتگو، یکی باز است');
    expect(parse(home).querySelector('.nb')!.textContent).toBe('۲');
    expect(text).not.toMatch(/[0-9]/);
    const results = r.kbHtml({ state: 'results', query: 'x', results: [{ slug: 'a', title: 'a' }, { slug: 'b', title: 'b' }, { slug: 'c', title: 'c' }] });
    expect(parse(results).querySelector('.cnt')!.textContent).toBe('۳ مقاله پیدا شد');
    expect(r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG })).toContain('data-rec-timer role="timer" aria-live="off">۰:۰۰<');
    const many = parse(r.conversationRowHtml({ id: 'c', unreadCount: 120, preview: 'p' }, false));
    expect(many.querySelector('.nb')!.textContent).toBe('۹۹+');
  });

  it('en and tr keep Latin digits', () => {
    expect(make({ locale: 'en' }).format.humanSize(245760)).toBe('240 KB');
    expect(make({ locale: 'tr' }).format.clock(8)).toBe('0:08');
  });
});

describe('t2: accent tokens', () => {
  const styleOf = (r: Renderer) => parse(r.homeHtml({ rtl: true, isOnline: true })).firstElementChild!.getAttribute('style')!;

  it('wears the brand look when the colour is uncustomised or the brand\'s own', () => {
    for (const c of ['', '#3B82F6', '#3b82f6', '#0B7D6C', 'not-a-colour', 'red;background:url(x)']) {
      const s = styleOf(make({ primaryColor: c }));
      expect(s, c).toBe('--a:#0B7D6C;--on-a:#FFFFFF;--gs-primary:#0B7D6C;--h1:#22C4A6;--h2:#0F927D;--h3:#08594E;--glow:#7CF5DF');
    }
  });

  it('uses the workspace colour, with white or ink on it by contrast', () => {
    expect(styleOf(make({ primaryColor: '#7c3aed' }))).toBe('--a:#7C3AED;--on-a:#FFFFFF;--gs-primary:#7C3AED');
    expect(styleOf(make({ primaryColor: '#111827' }))).toContain('--on-a:#FFFFFF');
    expect(styleOf(make({ primaryColor: '#22C4A6' }))).toContain('--on-a:#16142B');
    expect(styleOf(make({ primaryColor: '#FFEB3B' }))).toContain('--on-a:#16142B');
    expect(styleOf(make({ primaryColor: '#fc0' })))
      .toBe('--a:#FFCC00;--on-a:#16142B;--gs-primary:#79630A;--a-tx:#79630A;--a-ink:#79630A');
  });

  it('a light accent reads as text and as a ring through its darkened tone', () => {
    const s = styleOf(make({ primaryColor: '#F5D90A' }));
    const dk = /--a-tx:(#[0-9A-F]{6})/.exec(s)![1];
    expect(s).toContain(`--a-ink:${dk}`);
    expect(s).toContain(`--gs-primary:${dk}`);
    // WCAG contrast of the dark tone on white (the logo initial, links, rings).
    const ch = [1, 3, 5].map((i) => parseInt(dk.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    expect(1.05 / (L + 0.05)).toBeGreaterThan(4.5);
    // A dark accent keeps itself as text: no override.
    expect(styleOf(make({ primaryColor: '#2563EB' }))).not.toContain('--a-tx');
  });

  it('sets the tokens on every view root and on the close button', () => {
    const r = make({ primaryColor: '#2563EB' });
    const roots = [
      r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }), r.conversationListHtml({}), r.kbHtml({}),
      r.prechatFormHtml(IDENTITY(['email']), {}, 'fa'), r.contactFallbackHtml(IDENTITY([]), {}, 'fa', {}),
      ...['home', 'chat', 'list', 'help', 'article', 'prechat'].map((v) => r.skeletonHtml(v, {})),
    ];
    for (const html of roots) expect(parse(html).firstElementChild!.getAttribute('style'), html.slice(0, 60)).toContain('--a:#2563EB');
    expect(parse(r.shellHtml({})).querySelector('[data-panel-close]')!.getAttribute('style')).toContain('--a:#2563EB');
  });

  it('derives every shade in the stylesheet, with resolved fallbacks for browsers without color-mix()', () => {
    expect(T2_CSS).toMatch(/@supports \(color: color-mix\(in oklab, red, blue\)\)/);
    expect(T2_CSS).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\)/);
    expect(T2_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(T2_CSS).not.toMatch(/Vazirmatn/);
  });
});

describe('t2: direction, people, the workspace', () => {
  it('writes dir on every view root (rtl for fa, ltr otherwise)', () => {
    expect(parse(make().homeHtml({ rtl: true })).firstElementChild!.getAttribute('dir')).toBe('rtl');
    expect(parse(make({ locale: 'en' }).kbHtml({ rtl: false })).firstElementChild!.getAttribute('dir')).toBe('ltr');
    expect(parse(make({ locale: 'en' }).chatFrameHtml({ chatEnabled: true, locale: 'en', config: BASE_CONFIG })).firstElementChild!.getAttribute('dir')).toBe('ltr');
  });

  it('draws a person as a photo when there is one, else their initial; the workspace as its logo or initial', () => {
    const r = make({ config: { logoUrl: 'https://cdn.test/logo.png' } });
    const h = parse(r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
    expect(h.querySelector('.logo img')!.getAttribute('src')).toBe('https://cdn.test/logo.png');
    expect(Array.from(h.querySelectorAll('.pres .av')).map((a) => a.textContent)).toEqual(['س', 'م', 'ر']);
    expect(Array.from(h.querySelectorAll('.pres .av')).map((a) => a.className.split(' ')[2])).toEqual(['c1', 'c2', 'c3']);
    const noLogo = parse(make({ config: { showLogo: false } }).homeHtml({ rtl: true, isOnline: true }));
    expect(noLogo.querySelector('.logo')).toBeNull();
    const initial = parse(make().homeHtml({ rtl: true, isOnline: true }));
    expect(initial.querySelector('.logo')!.textContent).toBe('ف');
    const photo = parse(make().chatHeaderHtml({ online: true, operator: { name: 'سارا', avatar: 'https://cdn.test/s.png', online: true } }));
    expect(photo.querySelector('.who .av img')!.getAttribute('src')).toBe('https://cdn.test/s.png');
    expect(make({ config: { showTeamAvatars: false } }).homeHtml({ rtl: true, isOnline: true })).not.toContain('class="avs"');
    // The same person keeps one colour on every surface.
    const thread = parse(make().messagesHtml({ messages: [msg({ senderName: 'سارا' })] }, '', {}));
    expect(thread.querySelector('.msg-avatar')!.classList.contains('c1')).toBe(true);
    expect(thread.querySelector('.msg-sender-label')!.textContent).toBe('سارا');
  });

  it('labels the first row of a person\'s run only, and gives every run its avatar', () => {
    const t = parse(make().messagesHtml({ messages: [
      msg({ senderName: 'سارا', body: '1' }), msg({ senderName: 'سارا', body: '2' }),
      msg({ sender: 'visitor', senderType: 'contact', body: '3', status: 'seen' }),
      msg({ senderType: 'ai', senderName: 'دستیار', body: '4' }),
    ] }, '', {}));
    expect(t.querySelectorAll('.msg-sender-label').length).toBe(1);
    expect(t.querySelectorAll('.msg-row.operator .msg-avatar:not(.msg-avatar-spacer)').length).toBe(2);
    expect(t.querySelectorAll('.msg-avatar-spacer').length).toBe(1);
    expect(t.querySelector('.msg-row.visitor .msg-ticks.is-seen')).not.toBeNull();
    expect(t.innerHTML).not.toMatch(/style="background/);
  });

  it('a message that failed is its own run: the one before it keeps its time and ticks', () => {
    const t = parse(make().messagesHtml({ messages: [
      msg({ sender: 'visitor', senderType: 'contact', body: 'a', status: 'seen' }),
      msg({ sender: 'visitor', senderType: 'contact', body: 'b', status: 'failed', localId: 'l1' }),
    ] }, '', {}));
    const rows = t.querySelectorAll('.msg-row.visitor');
    expect(rows[0].classList.contains('is-last')).toBe(true);
    expect(rows[0].querySelector('.msg-time')).not.toBeNull();
    expect(rows[0].querySelector('.msg-ticks.is-seen')).not.toBeNull();
    expect(rows[1].classList.contains('is-failed')).toBe(true);
    expect(rows[1].querySelector('[data-msg-retry="l1"]')).not.toBeNull();
  });

  it('heads a thread with the away notice, shown by the stylesheet while the bar says away', () => {
    const r = make();
    expect(parse(r.messagesHtml({ messages: [msg({})] }, '', {})).querySelector('.messages > .away')).not.toBeNull();
    expect(r.messagesHtml({ messages: [] }, '', {})).not.toContain('class="away"');
    expect(r.chatHeaderHtml({ online: false })).toContain('class="st off"');
    expect(r.chatHeaderHtml({ online: true })).not.toContain('st off');
    expect(T2_CSS).toMatch(/\.wy-view-chat:has\(\.st\.off\) \.messages > \.away \{ display: flex; \}/);
  });
});

describe('t2: the platform\'s marks stay in the Iranian edition\'s build', () => {
  it('lives only inside the @iran-kit block, which the RESPOK build removes', () => {
    // esbuild refuses to run inside jsdom: the transform runs in its own
    // node process, as widgetBrandBuild.test.ts does.
    const shipped = (brand: string) => execFileSync(process.execPath,
      [resolve(process.cwd(), 'scripts/build/widgetBrand.mjs'), brand, resolve(process.cwd(), 'public/widget/presentation-t2.js')],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const mark = 'M42.28 27.95A12.4';
    expect(T2_SRC).toContain(mark);
    expect(shipped('iran')).toContain(mark);
    const respok = shipped('respok');
    expect(respok).not.toContain(mark);
    expect(respok).toContain('__gs_presentation_t2');
    expect(T2_CSS).not.toMatch(/M42\.28/);
  });
});

describe('t2: review fixes', () => {
  it('draws an icon only from the allow-list, never from an object\'s own machinery', () => {
    for (const icon of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = make({ config: { templateOptions: { topics: [{ label: 'x', icon }] } } });
      const html = r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true }) +
        r.kbHtml({ state: 'list', articles: [], categories: [{ id: 'c', name: 'n', icon, count: 1 }] });
      expect(html, icon).not.toMatch(/native code|\[object/);
      expect(parse(html).querySelector('[data-topic] svg path')).not.toBeNull();
    }
    const states = parse(make().callInvitationCardHtml({ metadata: { status: 'constructor', channel: 'audio', invitation_id: 'x' } }));
    expect(states.textContent).not.toMatch(/native code/);
  });

  it('links the footer only to a web address', () => {
    const footer = (url: string) => parse(make({ config: { poweredBy: { brand: 'P', url } } }).homeHtml({ rtl: true, isOnline: true }));
    expect(footer('https://platform.test').querySelector('a.wy-powered')!.getAttribute('href')).toBe('https://platform.test');
    for (const url of ['javascript:alert(1)', ' JaVaScRiPt:x', 'data:text/html,x', '//evil.test', '/relative']) {
      expect(footer(url).querySelector('a.wy-powered'), url).toBeNull();
      expect(footer(url).querySelector('span.wy-powered'), url).not.toBeNull();
    }
  });

  it('prints the call card\'s and the call row\'s numbers in Persian digits', () => {
    const CALL: Record<string, string> = {
      ciMinutesSeconds: '{m} دقیقه و {s} ثانیه', ciSeconds: '{s} ثانیه', ciMinutes: '{m} دقیقه', ciTimeLeft: '{time} باقی‌مانده',
      ciWaitMinutes: 'حداکثر {m} دقیقه', csEndedByOperator: 'مدت مکالمه {duration}',
    };
    const r = make({ t: (k) => CALL[k] ?? FA[k] ?? k });
    const card = parse(r.callInvitationCardHtml({ createdAt: new Date().toISOString(), metadata: {
      status: 'pending', channel: 'audio', invitation_id: 'x', wait_minutes: 5,
      expires_at: new Date(Date.now() + 125_500).toISOString() } })).textContent!;
    expect(card).toMatch(/[۰-۹]+ دقیقه و [۰-۹]+ ثانیه باقی‌مانده/);
    expect(card).toContain('حداکثر ۵ دقیقه');
    expect(card).not.toMatch(/[0-9]/);
    expect(parse(r.callEndedRowHtml({ metadata: { ended_by: 'operator', duration_seconds: 65 } })).textContent).toBe('مدت مکالمه ۰۱:۰۵');
    expect(parse(r.conversationRowHtml({ id: 'c', timeLabel: '5m', preview: 'p' }, false)).querySelector('time')!.textContent).toBe('۵m');
    expect(make({ locale: 'en' }).callEndedRowHtml({ metadata: { ended_by: 'operator', duration_seconds: 65 } })).toContain('csEndedByOperator');
  });

  it('keeps the presence line a polite live region, as the default renderer does', () => {
    expect(parse(make().chatHeaderHtml({ online: true })).querySelector('[data-presence]')!.getAttribute('aria-live')).toBe('polite');
  });

  it('heads an away thread with the return time, never the online reply promise', () => {
    const at = new Date(); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0);
    const away = parse(make({ config: { replyTimeText: 'معمولاً در ۲ دقیقه پاسخ می‌دهیم', availability: { state: 'offline', next_open_at: at.toISOString() } } })
      .messagesHtml({ messages: [msg({})] }, '', {})).querySelector('.away small')!.textContent!;
    expect(away).toMatch(/^از .*۹.* پاسخ می‌دهیم$/);
  });

  it('an away pre-contact form makes no reply-time promise, and a phone-only contact gets no e-mail promise', () => {
    const promise = 'معمولاً در ۲ دقیقه پاسخ می‌دهیم';
    const status = (availability?: Vm) => parse(make({ config: { replyTimeText: promise, availability } })
      .prechatFormHtml(IDENTITY(['name', 'phone']), {}, 'fa')).querySelector('.st')!.textContent;
    expect(status()).toBe(promise);
    expect(status({ state: 'offline' })).toBe('آفلاین؛ پاسخ با ایمیل');
    // Chat replies are never sent by SMS: the card's copy is for an e-mail.
    expect(make().prechatSummaryHtml({ phone: '09123456789' })).toBe('');
    expect(make().prechatSummaryHtml({ phone: '09123456789', email: 'ali@example.com' })).toContain('ali@example.com');
  });

  it('says one article or conversation in English, never "1 articles" (fa and tr do not inflect)', () => {
    const en = make({ locale: 'en' });
    const tile = (count: number) => parse(en.kbHtml({ state: 'list', articles: [], categories: [{ id: 'c', name: 'N', count }] })).querySelector('small')!.textContent;
    expect(tile(1)).toBe('1 article');
    expect(tile(2)).toBe('2 articles');
    expect(parse(en.kbHtml({ state: 'results', query: 'x', results: [{ slug: 'a', title: 'x' }] })).querySelector('.cnt')!.textContent).toBe('1 article found');
    const home = (conversations: Vm[]) => parse(en.homeHtml({ rtl: false, isOnline: true, chatEnabled: true, conversations })).textContent!;
    expect(home([{ id: 'c1', status: 'open' }])).toContain('1 conversation, one open');
    expect(home([{ id: 'c1', status: 'resolved' }, { id: 'c2', status: 'resolved' }])).toContain('2 conversations');
    expect(parse(make().kbHtml({ state: 'list', articles: [], categories: [{ id: 'c', name: 'N', count: 1 }] })).querySelector('small')!.textContent).toBe('۱ مقاله');
  });

  it('rotates one or two ask examples after the prompt', () => {
    const field = (askExamples: string[]) => parse(make({ config: { templateOptions: { askExamples } } })
      .homeHtml({ rtl: true, isOnline: true, chatEnabled: true })).querySelector('.ask .field')!;
    expect(field([]).className).toBe('field static');
    expect(field(['کفش ۴۲ دارید؟']).className).toBe('field two');
    expect(Array.from(field(['کفش ۴۲ دارید؟']).querySelectorAll('.ph span')).map((s) => s.textContent)).toEqual(['سؤالتان را بنویسید…', 'مثلاً: کفش ۴۲ دارید؟']);
    expect(field(['a', 'b']).className).toBe('field');
    expect(field(['a', 'b']).querySelectorAll('.ph span').length).toBe(3);
    expect(T2_CSS).toMatch(/\.two \.ph span \{ animation-name: t2-ph2; animation-duration: 8s; \}/);
  });

  it('skeletons draw what the real view will: the away note, faces only with a team, the article\'s meta line', () => {
    const home = (config: Vm) => parse(make({ config }).skeletonHtml('home', { rtl: true, chatEnabled: true }));
    const away = home({ availability: { state: 'offline' }, features: { knowledgeBase: true } });
    expect(away.querySelector('.ask .note')).not.toBeNull();
    expect(away.querySelector('.ask .chips')).toBeNull();
    expect(home({ features: { knowledgeBase: true } }).querySelector('.pres .skc')).not.toBeNull();
    expect(home({ teamMembers: [] }).querySelector('.pres .skc')).toBeNull();
    expect(home({ showTeamAvatars: false }).querySelector('.pres .skc')).toBeNull();
    expect(home({ features: {} }).querySelector('.ask .chips')).toBeNull();
    expect(home({ templateOptions: { topics: [{ label: 'x', icon: 'box' }] } }).querySelector('.ask .chips')).not.toBeNull();
    expect(parse(make().skeletonHtml('article', { rtl: true })).querySelector('.art h1 + .am')).not.toBeNull();
  });

  it('rings a focused text field in the darkened accent (a light accent such as #F5D90A is ~1.4:1 on white)', () => {
    for (const sel of ['.field:focus-within', '.input-wrap:focus-within', '.fi:focus-within', '.sfield:focus-within']) {
      const rule = T2_CSS.split('\n').find((l) => l.startsWith(sel + ' {'))!;
      expect(rule).toMatch(/1\.5px var\(--a-tx, var\(--a\)\)/);
    }
  });

  it('shows keyboard focus on the greeting bubble, whose whole-bubble action is transparent', () => {
    expect(T2_CSS).toMatch(/\.smart-nudge \.smart-cta \{[^}]*opacity: 0;/);
    expect(T2_CSS).toContain('.smart-nudge:has(.smart-cta:focus-visible) { outline: 2px solid var(--ink); outline-offset: -4px; }');
  });

  it('keeps each control\'s shape when it takes keyboard focus', () => {
    // The round recorder send is also a .rec-btn: a later 12px rule for
    // .rec-btn would win and square it.
    expect(T2_CSS).not.toMatch(/\.rec-btn:focus-visible/);
    expect(T2_CSS).toMatch(/\.rec-send:focus-visible[^{]*\{ border-radius: 999px; \}/);
    expect(T2_CSS).toMatch(/\.msg-link:focus-visible[^{]*\{ border-radius: 999px; \}/);
    // The bubble clips an image: its ring goes inside, above the
    // `.wy-view :is(button, a):focus-visible` offset (0,2,1).
    expect(T2_CSS).toMatch(/\.msg \.msg-att-img-btn:focus-visible \{ outline-offset: -4px; border-radius: 16px; \}/);
    // A scrolling chip row on phones leaves room for the ring.
    expect(T2_CSS).toMatch(/margin-block: 8px -4px;\s*padding-block: 4px;/);
  });

  it('painted without Core\'s module (`.ext-off`), the ask field opens a chat and the topics are set aside', () => {
    // The topic chips' rows, and the track-order row (a topic too): never the list it sits in.
    expect(T2_CSS).toContain('.ext-off .ask-in, .ext-off :has(> .chip[data-topic]), .ext-off .r[data-topic] { display: none; }');
    expect(T2_CSS).toContain('.ext-off .ask .send { position: static; transform: none; }');
    expect(T2_CSS).toContain(".ext-off .ask .send::before { content: ''; position: absolute; inset: 0; }");
    expect(T2_CSS).toMatch(/\.field \{\s*position: relative;/);
  });

  it('a composer locked under the pre-chat card looks locked, not live', () => {
    expect(T2_CSS).toContain('.is-locked .input-wrap { background: var(--paper); box-shadow: 0 0 0 1px var(--line); cursor: not-allowed; }');
    expect(T2_CSS).toContain('.is-locked .input-row { opacity: .45; }');
  });

  it('never opens the emoji picker under a locked composer, and draws an English greeting in Inter', () => {
    expect(T2_CSS).toMatch(/\.composer-zone:has\(\.is-locked\) \.emoji-picker \{ display: none; \}/);
    expect(T2_CSS).toMatch(/\.smart-nudge\[dir='ltr'\],\n\.smart-nudge\[dir='ltr'\] \* \{\n {2}font-family: 'InterWY'/);
  });
});

describe('t2: its extras (presentation-t2-x.js)', () => {

  it('registers as the renderer\'s extras, with the renderer\'s id and contract version', () => {
    expect(T2_X_SRC).toContain("window.__gs_mod_extras = { id: 't2', v: 2, create: create };");
    expect(T2_SRC).toContain("mod.id !== 't2' || mod.v !== 2");
  });

  it('takes only its own file: another template\'s, another version or no module is refused', () => {
    const extend = make().extend as unknown as (m: unknown, dry?: boolean) => number;
    const mod = extrasModule();
    for (const bad of [null, {}, { ...mod, id: 't1' }, { ...mod, v: 1 }, { ...mod, v: 3 }, { id: 't2', v: 2 }]) expect(extend(bad)).toBe(0);
    expect(extend(mod, true)).toBe(1);
    // Nothing was asked for before: taken, no repaint; taken again: the same.
    expect(extend(mod)).toBe(1);
    expect(extend(mod)).toBe(1);
  });

  it('builds its surfaces on the renderer\'s helpers', () => {
    let H: Record<string, unknown> | null = null;
    const mod = extrasModule();
    (make().extend as unknown as (m: unknown) => number)({ ...mod, create: (h: Record<string, unknown>) => { H = h; return mod.create(h); } });
    expect(Object.keys(H!).sort()).toEqual(['L', 'avatarHtml', 'config', 'digits', 'esc', 'fa', 'fmtNum', 'ico', 'lang', 'storeAvatarHtml', 'systemPillHtml', 't', 'tf'].sort());
    expect((H!.fa as boolean)).toBe(true);
    expect((H!.digits as (s: string) => string)('12')).toBe('۱۲');
  });

  it('its emoji picker stays Core\'s: the frame draws an empty picker, which Core fills with its list', () => {
    const r = make();
    const frame = parse(r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }));
    expect(frame.querySelector('[data-emoji-picker]')!.innerHTML).toBe('');
    expect(r.emojiPickerHtml).toBeUndefined();
  });
});

describe('t2: after a chat — the closed line, the rating card, the transcript (extras)', () => {
  const thread = (r: Renderer, messages: Vm[], view: Vm = {}) => parse(r.messagesHtml({ messages }, undefined, view));
  const card = (over: Vm = {}, opts: { locale?: string } = {}) =>
    thread(withExtras(make(opts)), [closedRow('c1', 'سارا')], { csat: CSAT('c1', over) }).querySelector('.msg-row.system > .csat[data-csat]')!;

  it('the line names who closed it, else the workspace; in fa, en and tr', () => {
    const line = (name: string | null, locale = 'fa') =>
      thread(withExtras(make({ locale })), [closedRow('c1', name)]).querySelector('.msg-row.system .msg-system-pill')!.textContent;
    expect(line('سارا')).toBe('سارا گفتگو را بست');
    expect(line(null)).toBe('فروشگاه نیلوفر گفتگو را بست');
    expect(line('Sara', 'en')).toBe('Sara closed the conversation');
    expect(line('Sara', 'tr')).toBe('Sara sohbeti kapattı');
  });

  it('before the extras: no line, no card, and taking them asks Core for one repaint', () => {
    const r = make();
    const h = thread(r, [closedRow('c1', 'سارا')], { csat: CSAT('c1') });
    expect(h.querySelector('.msg-system-pill, [data-csat]')).toBeNull();
    expect((r.extend as unknown as (m: unknown) => number)(extrasModule())).toBe(2);
  });

  it('the card goes only under the row Core names (`view.csat.closedId`)', () => {
    const r = withExtras(make());
    const rows = [closedRow('c0', 'رضا'), msg({ body: 'باز شد' }), closedRow('c1', 'سارا')];
    expect(thread(r, rows).querySelector('[data-csat]')).toBeNull();
    const h = thread(r, rows, { csat: CSAT('c1') });
    expect(h.querySelectorAll('[data-csat]')).toHaveLength(1);
    const pills = Array.from(h.querySelectorAll('.msg-row.system'));
    // The card follows the line it answers.
    expect(pills[pills.length - 1].querySelector('[data-csat]')).not.toBeNull();
    expect(pills[pills.length - 2].textContent).toBe('سارا گفتگو را بست');
  });

  it('a closed line that ends the thread stays last with its card: a row Core adds (the saved details) goes above it', () => {
    const r = withExtras(make());
    const extra = '<div class="msg-row prechat-summary-row" data-extra-row></div>';
    const rows = [msg({ senderName: 'سارا', body: 'بفرمایید' }), closedRow('c1', 'سارا')];
    const h = parse(r.messagesHtml({ messages: rows }, extra, { csat: CSAT('c1') }));
    const order = Array.from(h.querySelectorAll('.messages > .msg-row')).map((el) =>
      el.hasAttribute('data-extra-row') ? 'extra' : el.querySelector('[data-csat]') ? 'card' : el.querySelector('.msg-system-pill') ? 'line' : 'bubble');
    expect(order).toEqual(['bubble', 'extra', 'line', 'card']);
    // Anywhere else the row stays where Core puts it: after the thread.
    const reopened = parse(r.messagesHtml({ messages: [...rows, msg({ sender: 'visitor', body: 'یک سؤال دیگر' })] }, extra, {}));
    const rest = Array.from(reopened.querySelectorAll('.messages > .msg-row'));
    expect(rest[rest.length - 1].hasAttribute('data-extra-row')).toBe(true);
  });

  it('a closed line ends the operator\'s run: the bubble before it keeps its avatar and time', () => {
    const r = withExtras(make());
    const h = thread(r, [msg({ senderName: 'سارا', body: 'خوشحالم که حل شد!' }), closedRow('c1', 'سارا')]);
    const bubble = h.querySelector('.msg-row.operator')!;
    expect(bubble.querySelector('.msg-avatar:not(.msg-avatar-spacer)')).not.toBeNull();
    expect(bubble.querySelector('.msg-time')).not.toBeNull();
  });

  it('asks: the operator, the question, five faces from very bad to great (in DOM order), the comment, a send that waits for a pick', () => {
    const c = card();
    expect(c.getAttribute('role')).toBe('group');
    expect(c.getAttribute('aria-label')).toBe('گفتگو با سارا چطور بود؟');
    expect(c.querySelector('.av.s44')!.textContent).toBe('س');
    expect(c.querySelector('h3')!.textContent).toBe('گفتگو با سارا چطور بود؟');
    expect(c.querySelector('p')!.textContent).toBe('نظرتان کمک می‌کند بهتر شویم.');
    const faces = Array.from(c.querySelectorAll('.faces > button[data-csat-rate]'));
    expect(faces.map((b) => b.getAttribute('data-csat-rate'))).toEqual(['1', '2', '3', '4', '5']);
    expect(faces.map((b) => b.getAttribute('aria-label'))).toEqual(['خیلی بد', 'بد', 'معمولی', 'خوب', 'عالی']);
    expect(faces.every((b) => b.getAttribute('aria-pressed') === 'false' && b.getAttribute('type') === 'button')).toBe(true);
    // The design's mouths: a frown for very bad, a filled smile for great.
    expect(faces[0].innerHTML).toContain('M8.5 16.4c1-1.1 2.2-1.7 3.5-1.7s2.5.6 3.5 1.7');
    expect(faces[2].innerHTML).toContain('M9 15.2h6');
    expect(faces[4].innerHTML).toContain('fill="currentColor"');
    const ta = c.querySelector('textarea[data-csat-comment]') as HTMLTextAreaElement;
    expect(ta.getAttribute('placeholder')).toBe('چیز دیگری هم بگویید (اختیاری)');
    expect(ta.getAttribute('aria-label')).toBe('چیز دیگری هم بگویید (اختیاری)');
    expect(ta.getAttribute('maxlength')).toBe('1000');
    const send = c.querySelector('button.btn[data-csat-submit]')!;
    expect(send.textContent).toBe('ارسال نظر');
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(c.querySelector('[data-csat-transcript]')).toBeNull();
  });

  it('a pick presses its face and enables send; the comment comes back escaped', () => {
    const c = card({ rating: 5, comment: '</textarea><img src=x onerror=alert(1)>' });
    expect(Array.from(c.querySelectorAll('[data-csat-rate]')).map((b) => b.getAttribute('aria-pressed')))
      .toEqual(['false', 'false', 'false', 'false', 'true']);
    expect(c.querySelector('[data-csat-submit]')!.hasAttribute('disabled')).toBe(false);
    expect(c.querySelector('img')).toBeNull();
    expect((c.querySelector('[data-csat-comment]') as HTMLTextAreaElement).value).toBe('</textarea><img src=x onerror=alert(1)>');
  });

  it('sending: nothing can be pressed twice; an error says so and lets the visitor send again', () => {
    const busy = card({ rating: 4, state: 'sending' });
    expect(Array.from(busy.querySelectorAll('[data-csat-rate]')).every((b) => b.hasAttribute('disabled'))).toBe(true);
    expect(busy.querySelector('[data-csat-submit]')!.hasAttribute('disabled')).toBe(true);
    expect(busy.querySelector('[data-csat-submit]')!.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector('[data-csat-comment]')!.hasAttribute('readonly')).toBe(true);
    const err = card({ rating: 4, state: 'error' });
    expect(err.querySelector('.er[role="alert"]')!.textContent).toBe('ارسال نشد');
    expect(err.querySelector('[data-csat-submit]')!.hasAttribute('disabled')).toBe(false);
  });

  it('rated: the chosen face and a thanks, no form; the transcript link stays', () => {
    const c = card({ rating: 5, state: 'done', transcript: { state: 'idle', to: 'a•••@example.com' } });
    expect(c.classList.contains('done')).toBe(true);
    expect(c.querySelector('.cf')!.innerHTML).toContain('fill="currentColor"');
    expect(c.querySelector('[role="status"] h3')!.textContent).toBe('از نظرتان سپاسگزاریم!');
    expect(c.querySelector('[role="status"] p')!.textContent).toBe('امتیاز شما: عالی');
    expect(c.querySelector('[data-csat-rate], [data-csat-comment], [data-csat-submit]')).toBeNull();
    expect(c.querySelector('button[data-csat-transcript]')).not.toBeNull();
  });

  it('no longer ratable: said once, nothing to press', () => {
    const c = card({ state: 'gone' });
    expect(c.querySelector('.er')!.textContent).toBe('دیگر نمی‌شود به این گفتگو امتیاز داد.');
    expect(c.querySelector('[data-csat-rate], [data-csat-comment], [data-csat-submit]')).toBeNull();
  });

  it('the transcript link: idle, sending, sent to the masked address (an isolated run), a retry, no more', () => {
    const link = (state: string, to = 'a•••@example.com') => card({ transcript: { state, to } });
    const idle = link('idle').querySelector('button.lnk2[data-csat-transcript]')!;
    expect(idle.textContent).toBe('ارسال متن گفتگو به ایمیل');
    expect(idle.hasAttribute('disabled')).toBe(false);
    expect(link('sending').querySelector('[data-csat-transcript]')!.hasAttribute('disabled')).toBe(true);
    const sent = link('sent').querySelector('p.lnk2[role="status"]')!;
    expect(sent.textContent).toBe('متن گفتگو به a•••@example.com فرستاده شد');
    expect(sent.querySelector('b[dir="ltr"]')!.textContent).toBe('a•••@example.com');
    expect(link('sent').querySelector('[data-csat-transcript]')).toBeNull();
    expect(link('failed').querySelector('[data-csat-transcript]')!.textContent).toBe('ارسال نشد · تلاش دوباره');
    expect(link('no').querySelector('p.lnk2')!.textContent).toBe('ارسال متن گفتگو ممکن نشد');
    expect(link('no').querySelector('[data-csat-transcript]')).toBeNull();
    const evil = link('sent', '<img src=x onerror=alert(1)>');
    expect(evil.querySelector('img')).toBeNull();
  });

  it('escapes the operator\'s name and draws a photo only from an allowed address', () => {
    const c = card({ name: '<b>سارا</b>', avatar: 'javascript:alert(1)' });
    expect(c.querySelector('b')).toBeNull();
    expect(c.querySelector('h3')!.textContent).toBe('گفتگو با <b>سارا</b> چطور بود؟');
    expect(c.querySelector('img')).toBeNull();
    expect(card({ avatar: 'https://cdn.test/s.png' }).querySelector('.av img')!.getAttribute('src')).toBe('https://cdn.test/s.png');
    // No operator name: the workspace asks.
    const ws = card({ name: '' });
    expect(ws.querySelector('h3')!.textContent).toBe('گفتگو با فروشگاه نیلوفر چطور بود؟');
    expect(ws.querySelector('.av.c4')).not.toBeNull();
  });

  it('speaks en and tr', () => {
    const en = card({ rating: 2, transcript: { state: 'idle' } }, { locale: 'en' });
    expect(en.querySelector('h3')!.textContent).toBe('How was your chat with سارا?');
    expect(Array.from(en.querySelectorAll('[data-csat-rate]')).map((b) => b.getAttribute('aria-label'))).toEqual(['Very bad', 'Bad', 'Okay', 'Good', 'Great']);
    expect(en.querySelector('[data-csat-submit]')!.textContent).toBe('Send feedback');
    expect(en.querySelector('[data-csat-transcript]')!.textContent).toBe('Email me the transcript');
    const tr = card({ rating: 2, state: 'done' }, { locale: 'tr' });
    expect(tr.querySelector('h3')!.textContent).toBe('Geri bildiriminiz için teşekkürler!');
    expect(tr.querySelector('[role="status"] p')!.textContent).toBe('Puanınız: Kötü');
  });

  it('carries its own copy in fa, en and tr, in key order (the registry\'s names)', () => {
    const keys = (/var COPY_KEYS = '([^']+)'/.exec(T2_X_SRC) || [])[1]!.split(' ');
    for (const k of ['convClosedBy', 'csatTitle', 'csatSub', 'csat1', 'csat5', 'csatComment', 'csatSend', 'csatTranscript', 'csatTranscriptSent', 'moreOptions', 'menuSound']) {
      expect(keys, k).toContain(k);
    }
    expect(keys).not.toContain('menuEndConversation');
    expect(new Set(keys).size).toBe(keys.length);
    for (const lang of ['fa', 'en', 'tr']) {
      const parts = (new RegExp(`\\n    ${lang}: '([^']*)',`).exec(T2_X_SRC) || [])[1]!.split('|');
      expect(parts.length, lang).toBe(keys.length);
      expect(parts.every((p) => p.trim().length > 0), lang).toBe(true);
    }
    // Any other language reads English (a locale 'constructor' too).
    for (const locale of ['de', 'constructor']) {
      expect(thread(withExtras(make({ locale })), [closedRow('c1', 'Sara')]).querySelector('.msg-system-pill')!.textContent).toBe('Sara closed the conversation');
    }
  });

  it('the chat bar\'s ⋯ sits between the person and the close slot, its menu as on t1', () => {
    const vm = { online: true, isNew: false, operator: { name: 'سارا', online: true } };
    const r = withExtras(make());
    const h = parse(r.chatHeaderHtml({ ...vm, menu: { open: true, items: [{ action: 'transcript', state: 'idle' }, { action: 'sound', on: false }] } }));
    const kids = Array.from(h.children).map((el) => el.className.split(' ')[0]);
    expect(kids.slice(1, 4)).toEqual(['who', 'cm', 'cs']);
    const toggle = h.querySelector('.cm > button.ib[data-chat-menu-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('گزینه‌های بیشتر');
    expect(toggle.innerHTML).toContain('M5 12h.01M12 12h.01M19 12h.01');
    const menu = h.querySelector('[data-chat-menu][role="menu"]')!;
    expect(menu.hasAttribute('hidden')).toBe(false);
    expect(Array.from(menu.querySelectorAll('[data-chat-menu-action]')).map((b) => [b.getAttribute('role'), b.textContent]))
      .toEqual([['menuitem', 'ارسال متن گفتگو به ایمیل'], ['menuitemcheckbox', 'صدای اعلان‌ها']]);
    expect(menu.querySelector('[data-chat-menu-action="sound"]')!.getAttribute('aria-checked')).toBe('false');
    // No list, no ⋯ (Core never passes one for a new conversation).
    expect(parse(r.chatHeaderHtml(vm)).querySelector('.cm')).toBeNull();
    expect(parse(r.chatHeaderHtml({ ...vm, menu: { open: false, items: [] } })).querySelector('.cm')).toBeNull();
  });

  it('its stylesheet: the card stretches across the thread, a repaint replays nothing, logical sides only', () => {
    expect(T2_CSS).toMatch(/\.csat \{ flex: 1; min-width: 0;/);
    expect(T2_CSS).toContain(".no-enter :is(.csat, .cf, .faces [aria-pressed='true']) { animation: none; }");
    expect(T2_CSS).toMatch(/\.menu \{ position: absolute; top: calc\(100% \+ 6px\); inset-inline-end: 0;/);
    for (const sel of ['.csat', '.faces', '.menu', '.lnk2', '.sw']) {
      const rules = T2_CSS.split('\n').filter((l) => l.startsWith(sel));
      expect(rules.length, sel).toBeGreaterThan(0);
      for (const rule of rules) expect(rule, rule).not.toMatch(/\b(margin|padding)-(left|right)|[{;]\s*(left|right):/);
    }
  });
});

describe('t2: a message\'s reactions (extras, feature `reactions`)', () => {
  const r = (locale = 'fa') => withExtras(make({ locale, capabilities: SERVED }));
  const team = (reactions?: Vm[], over: Vm = {}) => msg({ __id: UUID, body: 'این هم فاکتور سفارشتان.', ...(reactions ? { metadata: { reactions } } : {}), ...over });
  const thread = (rr: Renderer, messages: Vm[], view: Vm = { react: true }) => parse(rr.messagesHtml({ messages }, undefined, view));

  it('draws the badge under the bubble it belongs to: the heart drawn, other kinds as glyphs, three at most, then the total', () => {
    const h = thread(r(), [team([{ emoji: HEART, count: 1, mine: true }, { emoji: '👍', count: 2 }, { emoji: '😂', count: 1 }, { emoji: '🙏', count: 1 }])]);
    const badge = h.querySelector('.msg-line.rel > .react')!;
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('data-msg-id')).toBe(UUID);
    expect(badge.getAttribute('aria-label')).toBe('واکنش‌ها: ❤️ ۱، 👍 ۲، 😂 ۱، 🙏 ۱');
    expect(badge.querySelectorAll('svg')).toHaveLength(1);
    expect(Array.from(badge.querySelectorAll('i')).map((i) => i.textContent)).toEqual(['👍', '😂']);
    expect(badge.textContent).toBe('👍😂۵');
    // The badge sits on the bubble's line (as wide as the bubble), not inside it.
    expect(badge.parentElement!.querySelector(':scope > .msg')).not.toBeNull();
    expect(h.querySelector('.msg .react')).toBeNull();
  });

  it('an attachment-only message carries its badge on the attachment\'s line', () => {
    const att = { id: 'a1', kind: 'file', mime_type: 'application/pdf', file_name: 'f.pdf', size_bytes: 1000 };
    const h = thread(r(), [team([{ emoji: HEART, count: 1 }], { body: '', attachment: att })]);
    expect(h.querySelector('.msg-line.rel > .msg.has-att-only + .react')).not.toBeNull();
    const both = thread(r(), [team([{ emoji: HEART, count: 1 }], { attachment: att })]);
    expect(both.querySelectorAll('.react')).toHaveLength(1);
    expect(both.querySelector('.msg-line:not(.rel) > .msg.has-att-only')).not.toBeNull();
    expect(both.querySelector('.msg-line.rel > .msg:not(.has-att-only) ~ .react')).not.toBeNull();
  });

  it('the visitor\'s heart: on team and AI messages the server stores, pressed once given, labelled', () => {
    const h = thread(r(), [team([{ emoji: HEART, count: 1, mine: true }]), team(undefined, { __id: '8d1f3e2a-4b5c-4d6e-8f90-a1b2c3d4e5f6', senderType: 'ai' })]);
    const hearts = Array.from(h.querySelectorAll('.msg-actions [data-msg-react]'));
    expect(hearts.map((b) => [b.getAttribute('data-msg-react'), b.getAttribute('aria-pressed'), b.getAttribute('aria-label'), b.getAttribute('title')]))
      .toEqual([[HEART, 'true', 'پسندیدن', 'پسندیدن'], [HEART, 'false', 'پسندیدن', 'پسندیدن']]);
    expect(hearts[0].getAttribute('data-msg-id')).toBe(UUID);
    expect((hearts[0] as HTMLButtonElement).type).toBe('button');
    // None on the visitor's own messages, a local row (no server id yet), or an attachment without text.
    const none = thread(r(), [
      msg({ __id: UUID, sender: 'visitor', senderType: 'contact' }),
      msg({ __id: 'ai-intro-local-1' }),
      msg({ __id: UUID, body: '', attachment: { id: 'a1', kind: 'file', mime_type: 'application/pdf', file_name: 'f.pdf', size_bytes: 1 } }),
    ]);
    expect(none.querySelector('[data-msg-react]')).toBeNull();
  });

  it('a badge on the visitor\'s message too (the team reacted), in English digits and words', () => {
    const h = thread(r('en'), [msg({ __id: UUID, sender: 'visitor', senderType: 'contact', metadata: { reactions: [{ emoji: '👍', count: 1 }] } })]);
    expect(h.querySelector('.react')!.getAttribute('aria-label')).toBe('Reactions: 👍 1');
    expect(h.querySelector('.react')!.textContent).toBe('👍1');
    expect(thread(r('en'), [team()]).querySelector('[data-msg-react]')!.getAttribute('aria-label')).toBe('Like');
    expect(thread(r('tr'), [team()]).querySelector('[data-msg-react]')!.getAttribute('aria-label')).toBe('Beğen');
  });

  it('nothing without Core\'s `view.react`, and a message without reactions is drawn exactly as before', () => {
    expect(thread(r(), [team([{ emoji: HEART, count: 1 }])], {}).querySelector('.react, [data-msg-react]')).toBeNull();
    const plain = make({ capabilities: SERVED });
    const m = team();
    const before = plain.messagesHtml({ messages: [m] }, undefined, {});
    expect(r().messagesHtml({ messages: [m] }, undefined, {})).toBe(before);
    // With `view.react` only the heart is added.
    const withHeart = r().messagesHtml({ messages: [m] }, undefined, { react: true });
    expect(withHeart.replace(/<button type="button" class="msg-act" data-msg-react=[\s\S]*?<\/button>/, '')).toBe(before);
  });

  it('escapes what a reaction carries and ignores empty or odd counts', () => {
    const h = thread(r(), [team([{ emoji: '<img src=x onerror=1>', count: 1 }, { emoji: '👍', count: 0 }, { emoji: '😮', count: 'x' }])]);
    expect(h.querySelector('img')).toBeNull();
    expect(h.querySelector('.react')!.textContent).toBe('<img src=x onerror=1>۱');
    expect(thread(r(), [team([{ emoji: '👍', count: 0 }])]).querySelector('.react')).toBeNull();
  });

  it('its stylesheet places the badge on the inner bottom corner in either direction and fills a given heart', () => {
    expect(T2_CSS).toMatch(/\.react \{\n {2}position: absolute; bottom: -10px; inset-inline-end: 10px;/);
    expect(T2_CSS).toContain('.msg-line.rel { margin-bottom: 10px; }');
    expect(T2_CSS).toContain('.react.no-enter { animation: none; }');
    expect(T2_CSS).toMatch(/\.react svg, \.msg-act\[aria-pressed='true'\] \{ color: #E5484D; \}/);
    const rule = /\.react \{([^}]*)\}/.exec(T2_CSS)![1];
    expect(rule).not.toMatch(/\b(left|right):/);
  });
});

describe('t2: the message left while the team is away (extras, feature `awayThread`)', () => {
  const r = (locale = 'fa') => withExtras(make({ locale, capabilities: SERVED }));
  const VISITOR = () => msg({ sender: 'visitor', senderType: 'contact', body: 'سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟', status: 'sent' });
  const reply = (vm: Vm, locale?: string) =>
    parse(r(locale).messagesHtml({ messages: [VISITOR()] }, undefined, { awayReply: { at: 0, ...vm } })).querySelector('.away-reply')!;

  it('asks where to send the reply: the details card\'s look, the contact-fallback hooks, "no thanks" when not required', () => {
    const row = reply({ status: 'ask', value: '', skip: true });
    expect(Array.from(row.querySelectorAll('.msg.operator')).map((b) => b.textContent))
      .toEqual(['پیامتان ثبت شد.', 'اگر از سایت رفتید، پاسخ را کجا بفرستیم؟']);
    const form = row.querySelector('form.fcard')!;
    expect(form.hasAttribute('novalidate')).toBe(true);
    expect(form.querySelector('label[for="fb-email"]')!.textContent).toBe('ایمیل');
    const input = form.querySelector('.fi #fb-email[data-fb="email"]') as HTMLInputElement;
    expect([input.type, input.getAttribute('dir'), input.getAttribute('aria-describedby')]).toEqual(['email', 'ltr', 'fb-status']);
    expect(form.querySelector('.fi button[type="submit"][data-fb-submit].ok')!.getAttribute('aria-label')).toBe('ثبت ایمیل');
    expect(form.querySelector('[data-fb-skip]')!.textContent).toBe('نه ممنون، همین‌جا منتظر می‌مانم');
    expect(row.querySelector('.msg-meta')!.textContent).toBe('پاسخ خودکار');
    // The composer's placeholder meanwhile.
    expect(row.getAttribute('data-ph-away')).toBe('اگر چیزی اضافه دارید بنویسید…');
    expect(reply({ status: 'ask', skip: false }).querySelector('[data-fb-skip]')).toBeNull();
  });

  it('saved: «پاسخ را به {email} می‌فرستیم.» (04·11); skipped: the recorded line alone', () => {
    const saved = reply({ status: 'saved', email: 'ali@example.com' });
    expect(saved.querySelector('form')).toBeNull();
    const done = saved.querySelector('.fcard.done[role="status"]')!;
    expect(done.textContent).toBe('پاسخ را به ali@example.com می‌فرستیم.');
    expect(done.querySelector('b[dir="ltr"]')!.textContent).toBe('ali@example.com');
    expect(done.querySelector('.ck svg')).not.toBeNull();
    const skipped = reply({ status: 'skipped' });
    expect(Array.from(skipped.querySelectorAll('.msg.operator')).map((b) => b.textContent)).toEqual(['پیامتان ثبت شد.']);
    expect(skipped.querySelector('form, .fcard')).toBeNull();
  });

  it('saving locks the field; an error is Core\'s string; values are escaped', () => {
    const saving = reply({ status: 'saving', value: 'a@b.io' });
    expect(saving.querySelector('input')!.hasAttribute('readonly')).toBe(true);
    expect((saving.querySelector('[data-fb-submit]') as HTMLButtonElement).disabled).toBe(true);
    const bad = reply({ status: 'ask', value: '"><img src=x onerror=1>', error: 'fallbackError' });
    expect(bad.querySelector('img')).toBeNull();
    expect(bad.querySelector('[data-fb-status]')!.textContent).toBe('fallbackError');
    expect(bad.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
    expect(reply({ status: 'saved', email: '<i>x</i>' }).querySelector('.fcard.done b i')).toBeNull();
  });

  it('speaks en and tr', () => {
    expect(reply({ status: 'saved', email: 'a@b.io' }, 'en').querySelector('.msg.operator')!.textContent).toBe('Your message is saved.');
    expect(reply({ status: 'ask' }, 'en').getAttribute('data-ph-away')).toBe('Add anything else…');
    expect(reply({ status: 'ask' }, 'tr').querySelector('.msg-meta')!.textContent).toBe('Otomatik yanıt');
  });
});

// ─── Issue #340 round 4: the order card, track order, instant answers ───

/** An AI answer about one order (`metadata.kind` 'order_status'), as the server stores it. */
const ORDER = (order: Vm, over: Vm = {}): Vm => msg({
  __id: 'ai-1', senderType: 'ai', senderName: 'دستیار', body: 'سلام علی! سفارشتان امروز صبح ارسال شد.',
  metadata: { source: 'ai_agent', kind: 'order_status', order: { v: 1, number: '48213', summary: null, more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null, trackingUrl: null, ...order } },
  ...over,
});
/** A local calendar day `days` from today, as the server sends `arrives`. */
const dayIso = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

describe('t2: an AI answer\'s order card (02·04, extras, capability `orderCard`)', () => {
  const r = (locale = 'fa') => withExtras(make({ locale, capabilities: SERVED }));
  const card = (order: Vm, locale?: string, over?: Vm) => parse(r(locale).messagesHtml({ messages: [ORDER(order, over)] }, undefined, {})).querySelector('.card');
  const steps = (c: Element) => Array.from(c.querySelectorAll('.steps li')).map((li) => li.className + (li.getAttribute('aria-current') ? '@' : ''));

  it('sits under the answer\'s text, in the same run, before its time line', () => {
    const h = parse(r().messagesHtml({ messages: [ORDER({})] }, undefined, {}));
    const col = h.querySelector('.msg-row.operator .msg-col')!;
    const lines = Array.from(col.querySelectorAll(':scope > .msg-line'));
    expect(lines).toHaveLength(2);
    expect(lines[0].querySelector('.msg-text')!.textContent).toBe('سلام علی! سفارشتان امروز صبح ارسال شد.');
    expect(lines[1].querySelector('.msg.operator.has-card > .card[role="group"]')).not.toBeNull();
    expect(lines[1].nextElementSibling!.classList.contains('msg-footline')).toBe(true);
  });

  it('titles the order in Persian digits, with its status pill and the four steps up to the current one', () => {
    const c = card({ summary: 'کفش رانینگ، سایز ۴۲', more: 2 })!;
    expect(c.getAttribute('aria-label')).toBe('سفارش ۴۸۲۱۳');
    expect(c.querySelector('.th svg[aria-hidden="true"]')).not.toBeNull();
    expect(c.querySelector('.tt b')!.textContent).toBe('سفارش ۴۸۲۱۳');
    expect(c.querySelector('.tt small')!.textContent).toBe('کفش رانینگ، سایز ۴۲ +۲');
    expect(c.querySelector('.pill')!.textContent).toBe('ارسال شد');
    expect(c.querySelector('.pill')!.classList.contains('done')).toBe(false);
    expect(Array.from(c.querySelectorAll('.steps li')).map((li) => li.textContent)).toEqual(['ثبت', 'آماده‌سازی', 'ارسال', 'تحویل']);
    expect(steps(c)).toEqual(['ok', 'ok', 'now@', '']);
    expect(c.querySelector('.steps')!.getAttribute('style')).toBe('--f:0.667');
    expect(c.querySelector('ol.steps')).not.toBeNull();
  });

  it('draws every status with its copy, step and look; completed is all four done', () => {
    const cases: Array<[Vm, string, string[] | null, boolean]> = [
      [{ status: 'pending', step: 0 }, 'در انتظار پرداخت', ['now@', '', '', ''], false],
      [{ status: 'on_hold', step: 0 }, 'در انتظار بررسی', ['now@', '', '', ''], false],
      [{ status: 'processing', step: 1 }, 'در حال آماده‌سازی', ['ok', 'now@', '', ''], false],
      [{ status: 'shipped', step: 2 }, 'ارسال شد', ['ok', 'ok', 'now@', ''], false],
      [{ status: 'completed', step: 3 }, 'تکمیل شد', ['ok', 'ok', 'ok', 'ok'], true],
      [{ status: 'cancelled', step: null }, 'لغو شد', null, true],
      [{ status: 'refunded', step: null }, 'مسترد شد', null, true],
      [{ status: 'failed', step: null }, 'ناموفق', null, true],
    ];
    for (const [order, pill, st, done] of cases) {
      const c = card(order)!;
      expect(c.querySelector('.pill')!.textContent, String(order.status)).toBe(pill);
      expect(c.querySelector('.pill')!.classList.contains('done'), String(order.status)).toBe(done);
      if (st) expect(steps(c), String(order.status)).toEqual(st);
      else expect(c.querySelector('.steps'), String(order.status)).toBeNull();
    }
    expect(card({ status: 'completed', step: 3 })!.querySelector('.steps')!.getAttribute('style')).toBe('--f:1');
    // A store's own status name wins; an unknown status without one has no pill.
    expect(card({ status: 'unknown', statusLabel: 'در صف ارسال', step: null })!.querySelector('.pill.done')!.textContent).toBe('در صف ارسال');
    expect(card({ status: 'unknown', step: null })!.querySelector('.pill')).toBeNull();
    expect(card({ status: 'constructor', step: 1 })!.querySelector('.pill')).toBeNull();
  });

  it('shows the item line, the delivery day and the tracking link only when present', () => {
    const bare = card({})!;
    expect(bare.querySelector('.tt small')).toBeNull();
    expect(bare.querySelector('.ft')).toBeNull();
    const link = card({ trackingUrl: 'https://post.ir/track?id=1&x=2' })!.querySelector('.ft a.trk')!;
    expect(link.getAttribute('href')).toBe('https://post.ir/track?id=1&x=2');
    expect(r().messagesHtml({ messages: [ORDER({ trackingUrl: 'https://post.ir/track?id=1&x=2' })] }, undefined, {})).toContain('href="https://post.ir/track?id=1&amp;x=2"');
    expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer']);
    expect(link.textContent).toBe('پیگیری مرسوله');
    expect(card({ more: 3 })!.querySelector('.tt small')).toBeNull();
  });

  it('never links an unsafe address, and escapes every field', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'https://a b.ir', 'https://x.ir/"><img src=x>', "https://x.ir/'x", 'https://x.ir/' + 'a'.repeat(500)]) {
      expect(card({ trackingUrl: url })!.querySelector('a'), url).toBeNull();
    }
    const evil = '<img src=x onerror=1>';
    const c = card({ number: evil, summary: evil, statusLabel: evil, status: 'unknown', arrives: evil })!;
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('.tt b')!.textContent).toBe('سفارش <img src=x onerror=۱>');
    expect(c.querySelector('.tt small')!.textContent).toBe(evil);
    expect(c.querySelector('.pill')!.textContent).toBe(evil);
    expect(c.querySelector('.ft')).toBeNull();
  });

  describe('the delivery day', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('is the weekday within six days, else the day and month; past or unreadable days are not shown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 18, 10, 0));
      const day = (iso: string, locale = 'fa') => card({ arrives: iso }, locale)?.querySelector('.ft span');
      const weekday = (d: number, tag: string) => new Intl.DateTimeFormat(tag, { weekday: 'long' }).format(new Date(2026, 9, 18 + d, 12));
      expect(day('2026-10-22')!.textContent).toBe('تحویل: ' + weekday(4, 'fa-IR-u-ca-persian'));
      expect(day('2026-10-22')!.querySelector('b')!.textContent).toBe(weekday(4, 'fa-IR-u-ca-persian'));
      expect(day('2026-10-18')!.textContent).toBe('تحویل: ' + weekday(0, 'fa-IR-u-ca-persian'));
      expect(day('2026-11-16')!.textContent).toBe('تحویل: ' + new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long' }).format(new Date(2026, 10, 16, 12)));
      expect(day('2026-10-22', 'en')!.textContent).toBe('Arrives ' + weekday(4, 'en-US'));
      expect(day('2026-10-22', 'tr')!.textContent).toBe('Teslimat: ' + weekday(4, 'tr-TR'));
      expect(day('2026-10-17')).toBeFalsy();
      expect(day('soon')).toBeFalsy();
      // The day alone (no link) still gets its footer, with the truck.
      expect(card({ arrives: '2026-10-20' })!.querySelector('.ft svg')).not.toBeNull();
    });
  });

  it('speaks en and tr, left to right', () => {
    const en = card({ summary: 'Running shoes', more: 1, trackingUrl: 'https://t.example/1' }, 'en')!;
    expect(en.querySelector('.tt b')!.textContent).toBe('Order 48213');
    expect(en.querySelector('.tt small')!.textContent).toBe('Running shoes +1');
    expect(Array.from(en.querySelectorAll('.steps li')).map((li) => li.textContent)).toEqual(['Placed', 'Packed', 'Shipped', 'Delivered']);
    expect(en.querySelector('.trk')!.textContent).toBe('Track package');
    expect(parse(r('en').messagesHtml({ messages: [ORDER({})] }, undefined, {})).firstElementChild!.closest('[dir]')).toBeNull();
    const tr = card({ status: 'completed', step: 3 }, 'tr')!;
    expect(tr.querySelector('.tt b')!.textContent).toBe('Sipariş 48213');
    expect(tr.querySelector('.pill')!.textContent).toBe('Tamamlandı');
  });

  it('is the text only before the extras, without the capability, on a visitor\'s message or without a number', () => {
    const none = (h: string) => expect(parse(h).querySelector('.card')).toBeNull();
    none(make({ capabilities: SERVED }).messagesHtml({ messages: [ORDER({})] }, undefined, {}));
    none(withExtras(make({ capabilities: { ...SERVED, orderCard: false } })).messagesHtml({ messages: [ORDER({})] }, undefined, {}));
    none(r().messagesHtml({ messages: [ORDER({}, { sender: 'visitor', senderType: 'contact' })] }, undefined, {}));
    none(r().messagesHtml({ messages: [ORDER({ number: '' })] }, undefined, {}));
    none(r().messagesHtml({ messages: [msg({ metadata: { kind: 'order_status' } })] }, undefined, {}));
    // The text is there in every case.
    expect(parse(make({ capabilities: SERVED }).messagesHtml({ messages: [ORDER({})] }, undefined, {})).querySelector('.msg-text')!.textContent)
      .toBe('سلام علی! سفارشتان امروز صبح ارسال شد.');
  });

  it('is in the page while the answer types out, hidden by the stylesheet until it is done', () => {
    const m = ORDER({});
    const h = parse(r().messagesHtml({ messages: [m] }, undefined, { typewriter: { id: m.__id, tokens: ['سلام', ' علی'], revealedCount: 1 } }));
    expect(h.querySelector('[data-typing-active]')).not.toBeNull();
    expect(h.querySelector('.card')).not.toBeNull();
    expect(T2_CSS).toContain('.msg-col:has([data-typing-active]) .card { display: none; }');
    expect(T2_CSS).toContain('.no-enter .card, .no-enter .steps::after { animation: none; }');
    // The track's fill and the current step's pulse, both directions.
    expect(T2_CSS).toContain("[dir='rtl'] .steps::after { transform-origin: right; }");
    expect(T2_CSS).toMatch(/@keyframes t2-now \{/);
    expect(T2_CSS).toMatch(/@keyframes t2-fill \{/);
  });
});

describe('t2: the track-order row (01·01, 01·03; `config.commerce.trackOrder`)', () => {
  const STORE = { commerce: { trackOrder: true } };
  const home = (vm: Vm, config: Vm = STORE, locale = 'fa') => parse(make({ locale, config, capabilities: SERVED })
    .homeHtml({ rtl: locale === 'fa', isOnline: true, chatEnabled: true, kbEnabled: true, ...vm }));
  const rows = (h: Element) => Array.from(h.querySelectorAll('.list > .r')).map((b) => b.querySelector('.t1')!.textContent);

  it('comes after the help center, its first message the localized «پیگیری سفارشم» (a topic Core sends)', () => {
    const h = home({});
    expect(rows(h)).toEqual(['مرکز راهنما', 'پیگیری سفارش']);
    const row = h.querySelector('.r[data-home-action="track-order"]')!;
    expect(row.getAttribute('data-topic')).toBe('پیگیری سفارشم');
    expect(row.querySelector('.t2x')!.textContent).toBe('وضعیت سفارشتان را همین‌جا بپرسید');
    expect(row.querySelector('.it svg')).not.toBeNull();
    expect(row.querySelector('.ch')).not.toBeNull();
  });

  it('is there while the team is away (01·03)', () => {
    expect(rows(home({ isOnline: false }))).toEqual(['مرکز راهنما', 'پیگیری سفارش']);
  });

  it('is only for a store that answers order questions, with the chat on', () => {
    expect(home({}, {}).querySelector('[data-home-action="track-order"]')).toBeNull();
    expect(home({}, { commerce: { trackOrder: 'yes' } }).querySelector('[data-home-action="track-order"]')).toBeNull();
    expect(home({ chatEnabled: false }).querySelector('[data-home-action="track-order"]')).toBeNull();
  });

  it('keeps the rows at three: a returning visitor (01·02) has no room for it', () => {
    const conv = { id: 'c1', status: 'open', preview: 'سلام', operatorName: 'سارا' };
    expect(rows(home({ conversations: [conv] }))).toEqual(['ادامه گفتگو با سارا', 'گفتگوهای شما', 'مرکز راهنما']);
    expect(rows(home({ kbEnabled: false, conversations: [conv] }))).toEqual(['ادامه گفتگو با سارا', 'گفتگوهای شما', 'پیگیری سفارش']);
  });

  it('speaks en and tr', () => {
    const en = home({}, STORE, 'en').querySelector('[data-home-action="track-order"]')!;
    expect([en.querySelector('.t1')!.textContent, en.querySelector('.t2x')!.textContent, en.getAttribute('data-topic')])
      .toEqual(['Track an order', 'Ask about your order here', 'Track my order']);
    const tr = home({}, STORE, 'tr').querySelector('[data-home-action="track-order"]')!;
    expect([tr.querySelector('.t1')!.textContent, tr.querySelector('.t2x')!.textContent, tr.getAttribute('data-topic')])
      .toEqual(['Sipariş takibi', 'Siparişinizi buradan sorun', 'Siparişimi takip et']);
  });
});

describe('t2: help articles while the first message is written (02·06, extras, feature `instantAnswers`)', () => {
  const r = (locale = 'fa') => withExtras(make({ locale, capabilities: SERVED }));
  const A = (slug: string, title: string, matches: string[], readingMinutes: number | null = 2) => ({ slug, title, snippet: '', matches, readingMinutes });

  it('is a labelled region (no live region) with at most two rows that open their article', () => {
    const t = parse(r().kbSuggestHtml({ results: [A('returns', 'شرایط مرجوعی کالا', ['مرجوعی']), A('refund', 'بازگشت وجه بعد از مرجوعی چقدر طول می‌کشد؟', ['مرجوعی'], 1), A('x', 'سوم', [])] }));
    const tray = t.querySelector('.tray[data-kb-suggest][role="region"]')!;
    expect(tray.getAttribute('aria-labelledby')).toBe('kbs-h');
    expect(tray.querySelector('#kbs-h')!.textContent).toBe('پاسخ‌های آماده از مرکز راهنما');
    expect(tray.hasAttribute('aria-live')).toBe(false);
    const rows = Array.from(tray.querySelectorAll('button.ta[data-kb-action="open"]'));
    expect(rows.map((b) => b.getAttribute('data-kb-slug'))).toEqual(['returns', 'refund']);
    expect(rows.map((b) => b.querySelector('small')!.textContent)).toEqual(['۲ دقیقه مطالعه', '۱ دقیقه مطالعه']);
    expect(rows[0].querySelector('.tt')!.innerHTML).toBe('شرایط <mark>مرجوعی</mark> کالا');
  });

  it('marks the matched words escaped, regex characters included; nothing for no results', () => {
    const t = parse(r().kbSuggestHtml({ results: [A('"><x', '<b>ارسال</b> با c++ و (کد)', ['ارسال', 'c++', '(کد)', 'x'])] }));
    const row = t.querySelector('[data-kb-slug]')!;
    expect(row.getAttribute('data-kb-slug')).toBe('"><x');
    expect(row.querySelector('.tt b')).toBeNull();
    expect(Array.from(row.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['ارسال', 'c++', '(کد)']);
    expect(row.querySelector('.tt')!.textContent).toBe('<b>ارسال</b> با c++ و (کد)');
    expect(r().kbSuggestHtml({ results: [] })).toBe('');
    expect(r().kbSuggestHtml({ results: [{ slug: '', title: 'x' }] })).toBe('');
    expect(parse(r().kbSuggestHtml({ results: [A('a', 'x', [], null)] })).querySelector('small')).toBeNull();
    expect(make({ capabilities: SERVED }).kbSuggestHtml({ results: [A('a', 'x', [])] })).toBe('');
  });

  it('marks a Turkish «İ» for the server\'s case-folded word (kb-suggest folds «İade» to «iade», as ILIKE does)', () => {
    const row = parse(r('tr').kbSuggestHtml({ results: [A('a', 'İade ve iptal: IADE', ['iade', 'iptal'], 3)] })).querySelector('.tt')!;
    expect(Array.from(row.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['İade', 'iptal', 'IADE']);
    expect(row.textContent).toBe('İade ve iptal: IADE');
  });

  it('speaks en and tr', () => {
    expect(parse(r('en').kbSuggestHtml({ results: [A('a', 'Returns', [], 3)] })).querySelector('h4')!.textContent).toBe('Answers from the help center');
    expect(parse(r('en').kbSuggestHtml({ results: [A('a', 'Returns', [], 3)] })).querySelector('small')!.textContent).toBe('3 min read');
    expect(parse(r('tr').kbSuggestHtml({ results: [A('a', 'İade', [], 3)] })).querySelector('h4')!.textContent).toBe('Yardım merkezinden yanıtlar');
  });

  it('has its look in the stylesheet, out of the frame Core builds', () => {
    expect(T2_CSS).toMatch(/\.tray \{ margin: 0 12px 8px;/);
    expect(parse(make({ capabilities: SERVED }).chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG })).querySelector('[data-kb-suggest]')).toBeNull();
  });
});

describe('t2: help search results with the server\'s snippet and matches (03·07)', () => {
  const results = (rs: Vm[], query = 'ارسال') => parse(make({ capabilities: SERVED }).kbHtml({ state: 'results', query, results: rs }));

  it('shows the snippet over the summary, the matched words marked (escaped)', () => {
    const h = results([{ slug: 'a', title: 'زمان و هزینه ارسال', excerpt: 'خلاصه', snippet: '…هزینه‌ی ارسال برای خریدهای بالای ۲ میلیون…', matches: ['ارسال'] }]);
    const item = h.querySelector('[data-kb-slug="a"]')!;
    expect(item.querySelector('small')!.innerHTML).toBe('…هزینه‌ی <mark>ارسال</mark> برای خریدهای بالای ۲ میلیون…');
    expect(item.querySelector('.tt mark')!.textContent).toBe('ارسال');
  });

  it('keeps the summary and the query\'s words without them, and escapes both', () => {
    const plain = results([{ slug: 'a', title: 'ارسال', excerpt: '<img src=x> ارسال' }]);
    expect(plain.querySelector('small')!.innerHTML).toBe('&lt;img src=x&gt; <mark>ارسال</mark>');
    const evil = results([{ slug: 'a', title: 't', snippet: '<img src=x onerror=1>', matches: ['img', '['] }], 'zz');
    expect(evil.querySelector('small img')).toBeNull();
    expect(evil.querySelector('small mark')!.textContent).toBe('img');
  });
});

describe('t2: an article\'s author (03·08, feature `kbAuthor`)', () => {
  const am = (article: Vm, locale = 'fa') => parse(make({ locale, capabilities: SERVED }).kbArticleHtml({ article: { title: 'چطور', contentHtml: '', ...article } })).querySelector('.am');

  it('draws the initial on its tile and the name, then the reading time', () => {
    const line = am({ author: 'سارا', readingMinutes: 2 })!;
    const spans = Array.from(line.children);
    expect(spans.map((s) => s.textContent)).toEqual(['سسارا', '۲ دقیقه مطالعه']);
    expect(spans[0].querySelector('.av.s24[aria-hidden="true"]')!.textContent).toBe('س');
    expect(am({ author: 'سارا' })!.children).toHaveLength(1);
  });

  it('draws nothing of it without a name, and escapes it', () => {
    expect(am({ author: ' ', readingMinutes: 2 })!.querySelector('.av')).toBeNull();
    expect(am({})).toBeNull();
    const evil = am({ author: '<img src=x onerror=1>' })!;
    expect(evil.querySelector('img')).toBeNull();
    expect(evil.textContent).toBe('<<img src=x onerror=1>');
  });
});

describe('t2: a download\'s progress (feature `dlProgress`, the stylesheet\'s)', () => {
  it('draws an arc from the top on the download control and the voice note\'s play button, in place of the spinner', () => {
    const rule = /\.dl-on\.msg-att-action::after, \.dl-on \.wy-ap-play::after \{([^}]*)\}/.exec(T2_CSS)![1];
    expect(rule).toContain('conic-gradient(currentColor calc(var(--dl, 0) * 360deg), transparent 0)');
    expect(rule).toContain('animation: none');
    expect(T2_CSS).toContain('.dl-on .wy-ap-spinner { display: none; }');
  });
});
