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
import { beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(load);

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

describe('t2: the Core behaviours it declares are the ones it draws', () => {
  const r = () => make({ config: { templateOptions: { topics: [{ label: 'زمان ارسال', icon: 'truck' }] } } });
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
  };

  it('declares exactly the behaviours it implements', () => {
    expect(Object.keys(make().features).sort()).toEqual(Object.keys(checks).sort());
    expect(Object.values(make().features).every((v) => v === true)).toBe(true);
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
    // Even a Core that says yes gets nothing: this renderer implements none of them yet.
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
      expect(root.querySelector('.card, .steps, .react, .csat, .faces, [data-csat-rate], .tray, [data-kb-suggest]')).toBeNull();
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

  it('never opens the emoji picker under a locked composer, and draws an English greeting in Inter', () => {
    expect(T2_CSS).toMatch(/\.composer-zone:has\(\.is-locked\) \.emoji-picker \{ display: none; \}/);
    expect(T2_CSS).toMatch(/\.smart-nudge\[dir='ltr'\],\n\.smart-nudge\[dir='ltr'\] \* \{\n {2}font-family: 'InterWY'/);
  });
});
