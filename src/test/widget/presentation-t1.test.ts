/**
 * The `t1` renderer (public/widget/presentation-t1.js): a brand-gradient
 * hero with floating cards, a bottom menu, a single-box composer, an
 * operator-side pre-chat card and the help center.
 *
 * What these tests hold it to:
 *   - every data-* hook the `default` renderer emits is still emitted (Core
 *     binds them; a missing one is a dead control nobody notices);
 *   - every string a view-model or the config carries is escaped, and an
 *     address is drawn only from an allowed scheme;
 *   - each Core behaviour in `features` is actually drawn, nothing is
 *     declared that is not, and nothing is drawn for a capability Core says
 *     it cannot serve;
 *   - skeletons wear the real surfaces' structure; Persian digits in fa; the
 *     accent tokens it computes (brand default, on-accent ink);
 *   - its own copy exists in fa, en and tr; the platform's mark stays out of
 *     the RESPOK build.
 * Geometry against the design's PNGs is checked with the screenshot harness
 * (e2e/harness/templateScreens.ts --template t1), not here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const REGISTRY_SRC = read('public/widget/presentation-registry.js');
const T1_SRC = read('public/widget/presentation-t1.js');
const DEFAULT_SRC = read('public/widget/presentation-default.js');
const T1_CSS = read('public/widget/presentation-t1.css');

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
  home: 'خانه', you: 'شما', name: 'نام', email: 'ایمیل', wyNewConversation: 'گفتگوی جدید',
  homeStartChat: 'شروع گفتگو', homeLeaveMessage: 'پیام بگذارید', homeReplySlow: 'به‌محض بازگشت پاسخ می‌دهیم',
  wyStatusOpen: 'باز', wyStatusResolved: 'حل شده', prechatOptional: 'اختیاری', intro: 'سلام! چطور کمکتان کنیم؟',
  msgFailed: 'ارسال نشد', msgSeen: 'دیده شد', msgSent: 'ارسال شد', back: 'بازگشت', close: 'بستن',
};

const BASE_CONFIG: Vm = {
  workspaceName: 'فروشگاه نیلوفر',
  teamMembers: [{ name: 'سارا', online: true }, { name: 'مهدی' }, { name: 'رضا' }],
  poweredBy: { text: 'قدرت گرفته از', brand: 'Platform', url: 'https://platform.test' },
  attachments: { enabled: true, voiceNotesEnabled: true, allowedMimes: ['image/png'] },
  composer: { emojiEnabled: true },
  readReceipts: { enabled: true },
};
const NO_CAPS = { kbNeutral: false, csat: false, reactions: false, orderCard: false, prechatSteps: false, instantAnswers: false };

function load() {
  const w = window as unknown as Record<string, unknown>;
  // jsdom has neither; the recorder is drawn only with real voice support.
  w.MediaRecorder = function () {};
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {} }, configurable: true });
  }
  new Function(REGISTRY_SRC).call(window);
  new Function(T1_SRC).call(window);
  new Function(DEFAULT_SRC).call(window);
}

function make(opts: { locale?: string; primaryColor?: string; config?: Vm; capabilities?: Vm; t?: (k: string) => string } = {}): Renderer {
  const w = window as unknown as Record<string, { create: (env: Vm) => Renderer }>;
  return w.__gs_presentation_t1.create({
    t: opts.t || ((k: string) => FA[k] ?? k),
    escapeHtml,
    config: { ...BASE_CONFIG, ...(opts.config || {}) },
    locale: opts.locale || 'fa',
    primaryColor: opts.primaryColor ?? '#3B82F6',
    capabilities: opts.capabilities || { ...NO_CAPS, kbNeutral: true },
  });
}

const parse = (html: string) => new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html').getElementById('r')!;
const IDENTITY = (asked: string[], required: string[] = []) => ({
  isAsked: (k: string) => asked.includes(k),
  isRequired: (k: string) => required.includes(k),
});
const now = new Date().toISOString();
const msg = (over: Vm): Vm => ({ __id: 'm' + Math.random(), sender: 'operator', senderType: 'agent', body: 'hi', time: now, ...over });
const FRAME = (r: Renderer, config: Vm = BASE_CONFIG) => r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config });

beforeAll(load);

describe('t1: registration', () => {
  it('registers under the registry key with id t1 and the shared contract', () => {
    const reg = (window as unknown as { __gs_presentation_registry: { resolve: (id: string) => { globalKey: string; id: string } } })
      .__gs_presentation_registry.resolve('t1');
    expect(reg.id).toBe('t1');
    expect(T1_SRC).toContain(`window.${reg.globalKey} = { id: 't1', create: create, prepare: prepare };`);
    const r = make();
    expect(r.id).toBe('t1');
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
    for (const f of ['msgTime', 'callDuration', 'invitationRemaining', 'humanSize', 'clock', 'badge', 'rate', 'num']) {
      expect(typeof r.format[f], f).toBe('function');
    }
  });

  it('exports every function the default renderer exports', () => {
    const d = (window as unknown as Record<string, { create: (env: Vm) => Record<string, unknown> }>).__gs_presentation_default
      .create({ t: (k: string) => k, escapeHtml, config: BASE_CONFIG, locale: 'fa', primaryColor: '#3B82F6' });
    const r = make() as unknown as Record<string, unknown>;
    const missing = Object.keys(d).filter((k) => typeof d[k] === 'function' && typeof r[k] !== 'function');
    expect(missing).toEqual([]);
  });

  it('prepare() settles without a font API, and within its own wait with one', async () => {
    const w = window as unknown as Record<string, { prepare: (c?: Vm) => Promise<void> }>;
    await expect(w.__gs_presentation_t1.prepare({ locale: 'fa' })).resolves.toBeUndefined();
    const fonts = (document as unknown as { fonts?: unknown }).fonts;
    const asked: string[] = [];
    Object.defineProperty(document, 'fonts', {
      value: { load: (f: string) => { asked.push(f); return new Promise(() => {}); } }, configurable: true,
    });
    try {
      await expect(w.__gs_presentation_t1.prepare({ locale: 'en' })).resolves.toBeUndefined();
      expect(asked).toEqual(['500 16px InterWY']);
      asked.length = 0;
      await w.__gs_presentation_t1.prepare({ locale: 'fa' });
      expect(asked).toEqual(['400 16px IRANSans', '500 16px IRANSans', '600 16px IRANSans']);
    } finally {
      Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    }
  });
});

describe('t1: every hook the default renderer emits', () => {
  const hooks = (src: string) => new Set((src.match(/data-[a-z0-9]+(?:-[a-z0-9]+)*(?=[\s="'>])/g) || []));
  const attrs = (html: string) => new Set((html.match(/\sdata-[a-z0-9-]+/g) || []).map((s) => s.trim()));
  const surfaces = (x: Renderer) => {
    const id = IDENTITY(['name', 'email', 'phone']);
    return [
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
      x.messagesHtml({ messages: [msg({ senderType: 'ai', body: 'abc' })] }, '',
        { typewriter: { id: 'tw', tokens: ['a', 'b'], revealedCount: 1 } }),
      x.handoffPrechatCardHtml(id, {}, 'fa', 'sub', true),
      x.prechatFormHtml(id, {}, 'fa'),
      x.contactFallbackHtml(id, {}, 'fa', {}),
      x.smartSurfaceHtml({ title: 't', body: 'b', ctaLabel: 'c' }),
      x.kbHtml({ state: 'article', article: { title: 'A', contentHtml: '<p>x</p>' }, feedback: { enabled: true } }),
      x.kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }], categories: [] }),
      x.kbHtml({ state: 'results', query: 'x', results: [] }),
      x.connIndicatorHtml(),
    ].join('');
  };

  it('in the source, or drawn once rendered', () => {
    const ours = new Set([...hooks(T1_SRC), ...attrs(surfaces(make()))]);
    expect([...hooks(DEFAULT_SRC)].filter((h) => !ours.has(h))).toEqual([]);
  });

  it('in the rendered surfaces, not only in the source', () => {
    const d = (window as unknown as Record<string, { create: (env: Vm) => Renderer }>).__gs_presentation_default.create({
      t: (k: string) => k, escapeHtml, config: BASE_CONFIG, locale: 'fa', primaryColor: '#3B82F6',
    });
    const theirs = attrs(surfaces(d));
    const ours = attrs(surfaces(make()));
    expect([...theirs].filter((h) => !ours.has(h))).toEqual([]);
  });

  it('keeps the class names Core queries', () => {
    const r = make();
    const frame = parse(FRAME(r));
    for (const sel of ['.input-bar', '.input-wrap', '.input-row', 'textarea.input', '.send-btn', '.mic-btn', '.attach-btn', '.emoji-btn',
      '.emoji-picker', '.composer-zone', '.reply-preview', '.att-preview', '.rec-bar', '.vn-bar', '.wy-chat-scroll']) {
      expect(frame.querySelector(sel), sel).not.toBeNull();
    }
    const thread = parse(r.messagesHtml({ messages: [msg({ attachment: { id: 'i', kind: 'image', file_name: 'a.png' } })] }, '',
      { operatorTyping: { name: 'سارا' } }));
    expect(thread.querySelector('.messages > .msg-row.typing-row')).not.toBeNull();
    expect(thread.querySelector('.msg-att-img-btn img[data-att-media-src]')).not.toBeNull();
    const form = parse(r.prechatFormHtml(IDENTITY(['email']), {}, 'fa'));
    expect(form.querySelector('input.prechat-input[data-prechat="email"]')).not.toBeNull();
    expect(parse(r.kbHtml({ state: 'list', articles: [] })).querySelector('input.kb-search')).not.toBeNull();
    // Core toggles `.active` on `.tab`: the bottom menu must not be one.
    expect(parse(r.homeHtml({ rtl: true, isOnline: true })).querySelector('.tab')).toBeNull();
  });
});

describe('t1: strings are escaped, addresses are allow-listed', () => {
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
        if (['src', 'href'].includes(a.name)) {
          const v = a.value.trim().toLowerCase();
          expect(v.startsWith('javascript:') || v.startsWith('data:text'), a.value).toBe(false);
        }
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
        templateOptions: { navStyle: X, navMode: X },
        aiAgent: { agentName: X, agentLogoUrl: JS },
        attachments: { enabled: true, voiceNotesEnabled: true, allowedMimes: [X] },
      },
    });
    const conv = { id: X, status: X, preview: X, timeLabel: X, unreadCount: 3, operatorName: X, operatorAvatar: JS, lastFromVisitor: true, title: X };
    const kbVm = { query: X, results: [{ slug: X, title: X, excerpt: X }], articles: [{ slug: X, title: X, excerpt: X }],
      categories: [{ id: X, name: X, icon: X, count: 2 }], category: { id: X, name: X, count: 2 } };
    const html = [
      r.shellHtml({}),
      r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: { attachments: { enabled: true, voiceNotesEnabled: true, allowedMimes: [X] }, composer: {} } }),
      r.chatHeaderHtml({ online: true, typing: false, operator: { name: X, avatar: JS, online: true }, isNew: false }),
      r.chatHeaderHtml({ online: true, typing: false, operator: { name: X, avatar: QUOTED, online: true }, isNew: false }),
      r.chatHeaderHtml({ online: false, typing: true, operator: null, isNew: true }),
      make({ config: { logoUrl: QUOTED, showLogo: true } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true }),
      r.homeHtml({ rtl: true, isOnline: true, kbEnabled: true, chatEnabled: true, visitorName: X, conversations: [conv], unreadTotal: X,
        articles: [{ slug: X, title: X }], smartSurface: { mode: 'home_card', title: X, body: X, ctaLabel: X } }),
      r.homeHtml({ rtl: true, isOnline: false, kbEnabled: true, chatEnabled: true, conversations: [], conversationsError: true }),
      r.conversationListHtml({ conversations: [conv, { ...conv, status: 'resolved', operatorName: null }], chatEnabled: true }),
      r.conversationRowHtml(conv, true),
      r.emptyHtml({ qna: { questions: [{ question: X }] }, topics: [], operatorTyping: { name: X, avatar: JS }, prechatSummaryHtml: '' }),
      r.emptyHtml({ qna: { questions: [] }, topics: [{ label: X }, { label: X }] }),
      r.messagesHtml({ messages: [
        msg({ body: X, senderName: X, senderAvatar: JS, replyTo: { text: X } }),
        msg({ body: '> ' + X + ': ' + X + '\n\n' + X, senderType: 'ai', senderName: X }),
        msg({ sender: 'visitor', senderType: 'contact', body: X, status: 'failed', localId: X }),
        msg({ body: '', attachment: { id: X, kind: 'image', file_name: X, size_bytes: 9 } }),
        msg({ body: X, attachment: { id: X, kind: 'file', file_name: X + '.' + X, mime_type: X, size_bytes: 9 } }),
        msg({ body: '', attachment: { id: X, kind: 'audio', file_name: X } }),
        msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: X, operator_name: X, invitation_id: X, channel: X } }),
        msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: 'pending', operator_name: X, invitation_id: X, expires_at: X } }),
        msg({ senderType: 'system', metadata: { kind: 'routing_agent_joined', agent_name: X } }),
        msg({ senderType: 'system', metadata: { kind: 'call_ended', ended_by: X, duration_seconds: X } }),
      ] }, '', { operatorTyping: { name: X, avatar: JS }, qna: { questions: [] } }),
      r.aiThinkingRowHtml(),
      r.qnaChipsHtml({ questions: [{ question: X }, { question: X }, { question: X }, { question: X }] }),
      r.handoffPrechatCardHtml(IDENTITY(['name', 'email', 'phone']), { name: X, email: X, phone: X }, 'fa', X, false),
      r.prechatSummaryHtml({ name: X, email: X, phone: X }),
      r.prechatFormHtml(IDENTITY(['name', 'email']), { name: X, email: X }, 'fa'),
      r.contactFallbackHtml(IDENTITY(['phone']), { name: X, email: X, phone: X }, 'fa', { introLabel: X }),
      r.smartSurfaceHtml({ title: X, body: X, ctaLabel: X }),
      r.kbHtml({ ...kbVm, state: 'results' }),
      r.kbHtml({ ...kbVm, state: 'category' }),
      r.kbHtml({ ...kbVm, state: 'list' }),
      r.kbHtml({ state: 'article', article: { title: X, categoryTitle: X, readingMinutes: X, updatedAt: X, contentHtml: '' }, feedback: { enabled: true, rating: X } }),
      r.kbEmptyHtml({ emptyText: X }),
      ...['home', 'chat', 'list', 'help', 'article', 'prechat'].map((v) => r.skeletonHtml(v, { rtl: true })),
    ].join('');
    assertInert(html);
    // The hostile text arrived (escaped), it was not dropped.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Options outside their lists fall back to the defaults.
    expect(parse(r.homeHtml({ rtl: true })).querySelector('nav.wy-tabs.vb')).not.toBeNull();
    expect(parse(r.homeHtml({ rtl: true })).firstElementChild!.classList.contains('nv-active')).toBe(true);
  });

  it('draws an image only from http(s), protocol-relative, same-origin, blob or inline raster addresses', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const r = make({ config: { logoUrl: 'https://cdn.test/l.png',
      teamMembers: [{ name: 'a', avatar: '//cdn.test/a.png' }, { name: 'b', avatar: '/media/b.png' }, { name: 'c', avatar: png }] } });
    const html = r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true });
    expect(html).toContain('src="https://cdn.test/l.png"');
    expect(html).toContain('src="//cdn.test/a.png"');
    expect(html).toContain('src="/media/b.png"');
    expect(html).toContain('src="' + png + '"');
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=1>', 'vbscript:x', ' JaVaScRiPt:x', 'https://a.test/x y.png',
      '//cdn.test/a.png"x', 'ftp://cdn.test/a.png', 'cdn.test/a.png']) {
      const h = make({ config: { logoUrl: bad, teamMembers: [{ name: 'a', avatar: bad }] } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true });
      expect(parse(h).querySelectorAll('img').length, bad).toBe(0);
    }
  });

  it('links the platform credit only to an http(s) address, and opens it safely', () => {
    const link = (url: string) => parse(make({ config: { poweredBy: { text: 'قدرت گرفته از', brand: 'P', url } } }).homeHtml({ rtl: true }))
      .querySelector('a.wy-powered');
    expect(link('https://platform.test')!.getAttribute('rel')).toBe('noopener nofollow');
    expect(link('https://platform.test')!.getAttribute('target')).toBe('_blank');
    expect(link('javascript:alert(1)')).toBeNull();
    expect(link('//platform.test')).toBeNull();
  });

  it('leaves links in messages to Core (its scheme allow-list), plain escaped text without it', () => {
    const plain = make().messagesHtml({ messages: [msg({ body: 'see https://post.ir/x <b>' })] }, '', {});
    expect(parse(plain).querySelector('a')).toBeNull();
    expect(plain).toContain('see https://post.ir/x &lt;b&gt;');
    const w = window as unknown as Record<string, { create: (env: Vm) => Renderer }>;
    const calls: unknown[][] = [];
    const linked = w.__gs_presentation_t1.create({
      t: (k: string) => FA[k] ?? k, escapeHtml, config: BASE_CONFIG, locale: 'fa', primaryColor: '',
      linkifyHtml: (...a: unknown[]) => { calls.push(a); return '<a class="msg-link" href="https://post.ir/x">post.ir</a>'; },
      linkLabel: 'باز کردن لینک',
    }).messagesHtml({ messages: [msg({ body: 'https://post.ir/x' })] }, '', {});
    expect(calls).toEqual([['https://post.ir/x', 'باز کردن لینک']]);
    expect(parse(linked).querySelector('.msg-text a.msg-link')).not.toBeNull();
  });
});

describe('t1: the Core behaviours it declares are the ones it draws', () => {
  const r = () => make();
  const checks: Record<string, () => void> = {
    tabs: () => {
      const home = parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, unreadTotal: 3 }));
      const tabs = Array.from(home.querySelectorAll('nav.wy-tabs > button.wy-tab[data-view]'));
      expect(tabs.map((b) => b.getAttribute('data-view'))).toEqual(['home', 'list', 'help']);
      expect(tabs.map((b) => b.getAttribute('aria-current'))).toEqual(['page', 'false', 'false']);
      const badge = home.querySelector('[data-view="list"] [data-tab-badge]')!;
      expect(badge.textContent).toBe('۳');
      expect(badge.hasAttribute('hidden')).toBe(false);
      expect(parse(r().homeHtml({ rtl: true })).querySelector('[data-tab-badge]')!.hasAttribute('hidden')).toBe(true);
      expect(parse(r().conversationListHtml({})).querySelector('[data-view="list"]')!.getAttribute('aria-current')).toBe('page');
      expect(parse(r().kbHtml({ state: 'list' })).querySelector('[data-view="help"]')!.getAttribute('aria-current')).toBe('page');
      // Style and label mode come from the workspace's template options.
      const vd = parse(make({ config: { templateOptions: { navStyle: 'vd', navMode: 'icon' } } }).homeHtml({ rtl: true }));
      expect(vd.querySelector('nav.wy-tabs.vd')).not.toBeNull();
      expect(vd.firstElementChild!.classList.contains('nv-icon')).toBe(true);
      // Without a menu, the home links to all conversations itself.
      const none = parse(make({ config: { templateOptions: { navMode: 'none' } } })
        .homeHtml({ rtl: true, isOnline: true, chatEnabled: true, conversations: [{ id: 'c', preview: 'p' }] }));
      expect(none.querySelector('nav')).toBeNull();
      expect(none.querySelector('.wy-home-scroll [data-view="list"]')).not.toBeNull();
    },
    kbSearch: () => {
      const h = parse(r().kbHtml({ state: 'list', query: '', articles: [] }));
      expect(h.querySelector('input.kb-search[data-kb-search]')).not.toBeNull();
      // Only the results region repaints while typing; the field stays outside it.
      const res = parse(r().kbHtml({ state: 'results', query: 'x', results: [{ slug: 'a', title: 'x' }] }));
      expect(res.querySelector('[data-kb-results][data-state="results"] [data-kb-slug="a"]')).not.toBeNull();
      expect(res.querySelector('[data-kb-results] [data-kb-search]')).toBeNull();
      expect(parse(r().kbHtml({ state: 'searching' })).querySelector('[data-kb-results] .wy-sk-row')).not.toBeNull();
      // The home's help card searches too (Enter opens Help with the query).
      expect(parse(r().homeHtml({ rtl: true, isOnline: true, kbEnabled: true })).querySelector('.hc input[data-kb-search]')).not.toBeNull();
    },
    kbCategories: () => {
      const h = parse(r().kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }], categories: [{ id: 'c1', name: 'سفارش', icon: 'box', count: 5 }] }));
      expect(h.querySelector('[data-kb-category="c1"]')!.textContent).toContain('۵ مقاله');
      expect(h.querySelector('.cd.lc .sh')!.textContent).toBe('پربازدیدترین‌ها');
      const cat = parse(r().kbHtml({ state: 'category', category: { id: 'c1', name: 'سفارش', count: 5 }, articles: [{ slug: 'a', title: 'x' }] }));
      expect(cat.querySelector('.hn')!.textContent).toBe('سفارش');
      expect(cat.querySelector('.hs')!.textContent).toBe('۵ مقاله');
      expect(cat.querySelector('[data-view-back="back"][data-view-back-fallback="home"]')).not.toBeNull();
      expect(cat.querySelector('[data-kb-slug="a"]')).not.toBeNull();
    },
    kbArticleMeta: () => {
      const updatedAt = new Date(Date.now() - 3 * 864e5).toISOString();
      const h = parse(r().kbHtml({ state: 'article', article: { title: 'چطور', categoryTitle: 'سفارش و ارسال', readingMinutes: 2, updatedAt, contentHtml: '<p>x</p>' },
        categories: [{ id: 'c', name: 'سفارش و ارسال', count: 6 }], feedback: { enabled: true } }));
      expect(h.querySelector('.hn')!.textContent).toBe('سفارش و ارسال');
      expect(h.querySelector('.hs')!.textContent).toBe('۶ مقاله');
      expect(h.querySelector('.art h1')!.textContent).toBe('چطور');
      const meta = h.querySelector('.am')!.textContent!;
      expect(meta).toContain('۲ دقیقه مطالعه');
      expect(meta).toContain('به‌روز شده');
      expect(meta).not.toMatch(/[0-9]/);
      // The ask card under the article starts a chat.
      expect(h.querySelector('.cd.ask[data-kb-action="switch-chat"]')).not.toBeNull();
    },
    operatorTyping: () => {
      const h = parse(r().messagesHtml({ messages: [msg({})] }, '', { operatorTyping: { name: 'سارا', avatar: null } }));
      const row = h.querySelector('.messages > .msg-row.typing-row:last-child')!;
      expect(row.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('.msg-avatar')!.textContent).toBe('س');
      expect(row.querySelector('.msg-meta')!.textContent).toBe('سارا در حال نوشتن…');
      expect(parse(r().emptyHtml({ operatorTyping: { name: 'سارا' } })).querySelector('.typing-row')).not.toBeNull();
      expect(parse(r().messagesHtml({ messages: [msg({})] }, '', {})).querySelector('.typing-row')).toBeNull();
    },
    chatHeader: () => {
      const h = parse(r().chatHeaderHtml({ online: true, typing: false, operator: { name: 'سارا', online: true }, isNew: false }));
      expect(h.querySelector('[data-presence] [data-presence-label]')).not.toBeNull();
      expect(h.querySelector('.hn')!.textContent).toBe('سارا · فروشگاه نیلوفر');
      expect(h.querySelector('.hs')!.textContent).toBe('آنلاین · پاسخ در چند دقیقه');
      expect(h.querySelector('.who .av .pr:not(.off)')).not.toBeNull();
      expect(h.querySelector('.away')).toBeNull();
      // Away: the email line, and the marker the thread's away banner keys on.
      const away = parse(r().chatHeaderHtml({ online: false, operator: null, isNew: false }));
      expect(away.querySelector('.hs')!.textContent).toBe('آفلاین · پاسخ از طریق ایمیل');
      expect(away.querySelector('.away[hidden]')).not.toBeNull();
      expect(away.querySelector('.who .av.c4')!.textContent).toBe('ف');
      expect(parse(r().chatHeaderHtml({ online: true, isNew: true })).querySelector('.hn')!.textContent).toBe('گفتگوی جدید');
      // Core rewrites the header: nothing it binds once may live in there.
      for (const html of [h.innerHTML, away.innerHTML]) {
        expect(parse(html).querySelector('[data-chat-jump],[data-escalate-btn],[data-msg-input],[data-chat-messages]')).toBeNull();
      }
      const frame = parse(FRAME(r()));
      expect(frame.querySelector('[data-chat-header] [data-chat-jump]')).toBeNull();
      expect(frame.querySelector('[data-chat-header] [data-presence]')).not.toBeNull();
      expect(T1_CSS).toMatch(/\.wy-view-chat:has\(\.away\) \.ban-row \{ display: flex; \}/);
    },
    emptyQna: () => {
      const h = parse(make().emptyHtml({ qna: { questions: [{ question: 'سفارشم کجاست؟' }] }, topics: [] }));
      expect(h.querySelector('[data-qna] [data-qna-question="سفارشم کجاست؟"]')).not.toBeNull();
    },
    topics: () => {
      const h = parse(r().emptyHtml({ qna: { questions: [{ question: 'q' }] }, topics: [{ label: 'پیگیری سفارش' }, { label: 'مرجوعی' }] }));
      expect(Array.from(h.querySelectorAll('[data-topic]')).map((b) => b.getAttribute('data-topic'))).toEqual(['پیگیری سفارش', 'مرجوعی']);
      // Topics take the Q&A's place.
      expect(h.querySelector('[data-qna]')).toBeNull();
    },
    prechatOperator: () => {
      const optional = parse(r().handoffPrechatCardHtml(IDENTITY(['email']), {}, 'fa', 'sub', false));
      expect(optional.querySelector('.msg-row.operator .msg-avatar')).not.toBeNull();
      expect(optional.querySelector('.msg-row.operator .hc-card [data-prechat-skip]')).not.toBeNull();
      expect(optional.querySelector('.hc-card [data-prechat-submit]')).not.toBeNull();
      expect(optional.querySelector('.hc-card [data-prechat="email"]')).not.toBeNull();
      const required = parse(r().handoffPrechatCardHtml(IDENTITY(['email'], ['email']), {}, 'fa', 'sub', false));
      expect(required.querySelector('[data-prechat-skip]')).toBeNull();
      // The composer locks while the card waits: its message, and no emoji.
      const frame = parse(FRAME(r()));
      expect(frame.querySelector('.input-wrap .cmp-lock')!.textContent).toBe('اول فرم بالا را تکمیل کنید');
      expect(T1_CSS).toMatch(/\.is-locked \.input-row, \.is-locked \.att-preview, \.is-locked \.epk \{ display: none !important; \}/);
      expect(frame.querySelector('.input-row .emoji-btn')).not.toBeNull();
    },
    prechatSummary: () => {
      const h = parse(r().prechatSummaryHtml({ name: 'علی', email: 'ali@example.com', phone: '' }));
      expect(Array.from(h.querySelectorAll('.sum .rw b')).map((b) => b.textContent)).toEqual(['علی', 'ali@example.com']);
      expect(h.querySelector('.sum .rw b[dir="ltr"]')!.textContent).toBe('ali@example.com');
      expect(h.querySelector('.sum [data-prechat-edit]')).not.toBeNull();
      expect(r().prechatSummaryHtml({})).toBe('');
    },
    recSend: () => {
      const h = parse(FRAME(r()));
      expect(h.querySelector('[data-rec-bar] [data-rec-send]')).not.toBeNull();
      expect(h.querySelector('[data-rec-bar] [data-rec-stop]')).not.toBeNull();
    },
    vnRate: () => {
      expect(parse(FRAME(r())).querySelector('[data-vn-bar] [data-vn-rate]')!.textContent).toBe('۱×');
      expect(make().format.rate(1.5)).toBe('۱٫۵×');
      expect(make({ locale: 'en' }).format.rate(2)).toBe('2×');
    },
    clock: () => {
      expect(make().format.clock(14)).toBe('۰:۱۴');
      expect(make({ locale: 'en' }).format.clock(75)).toBe('1:15');
      expect(FRAME(make())).toContain('data-rec-timer role="timer" aria-live="off">۰:۰۰<');
      expect(FRAME(make())).toContain('data-vn-time>۰:۰۰<');
    },
    emojiTabs: () => {
      const h = parse(FRAME(r()));
      // The picker opens inside the composer's box.
      const picker = h.querySelector('.input-wrap > [data-emoji-picker][hidden]')!;
      const tabs = Array.from(picker.querySelectorAll('[role="tablist"] [data-emoji-tab][role="tab"]'));
      const groups = Array.from(picker.querySelectorAll('[data-emoji-group]'));
      expect(tabs.length).toBe(6);
      expect(groups.length).toBe(6);
      expect(tabs.map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
      expect(tabs.map((b) => b.getAttribute('data-emoji-tab'))).toEqual(groups.map((g) => g.getAttribute('data-emoji-group')));
      for (const g of groups) expect(g.querySelectorAll('button[data-emoji]').length).toBeGreaterThanOrEqual(8);
      expect(h.querySelector('[data-emoji-btn]')!.getAttribute('aria-expanded')).toBe('false');
      const off = parse(FRAME(r(), { ...BASE_CONFIG, composer: { emojiEnabled: false } }));
      expect(off.querySelector('[data-emoji-picker],[data-emoji-btn]')).toBeNull();
    },
    visitorName: () => {
      expect(parse(r().homeHtml({ rtl: true, isOnline: true, visitorName: 'علی' })).querySelector('.home-greeting')!.textContent).toBe('سلام دوباره، علی');
      expect(parse(r().homeHtml({ rtl: true, isOnline: true })).querySelector('.home-greeting')!.textContent).toBe('سلام، خوش آمدید');
    },
    conversationOperator: () => {
      const row = parse(r().conversationRowHtml({ id: 'c', status: 'open', preview: 'ممنون', operatorName: 'سارا', operatorOnline: true, lastFromVisitor: true, unreadCount: 2 }, false));
      expect(row.querySelector('.l1 .nm')!.textContent).toBe('سارا · فروشگاه نیلوفر');
      expect(row.querySelector('.l2 em')!.textContent).toBe('شما: ممنون');
      expect(row.querySelector('.l2 .nb')!.textContent).toBe('۲');
      expect(row.querySelector('.av .pr')).not.toBeNull();
      // No operator yet: the workspace, its initial on the reserved tile.
      const ws = parse(r().conversationRowHtml({ id: 'c', status: 'resolved', preview: 'x' }, false));
      expect(ws.querySelector('.l1 .nm')!.textContent).toBe('فروشگاه نیلوفر');
      expect(ws.querySelector('.av.c4')!.textContent).toBe('ف');
      expect(ws.querySelector('.tg.done')!.textContent).toBe('حل شده');
    },
  };

  it('declares exactly the behaviours it implements', () => {
    expect(Object.keys(make().features).sort()).toEqual(Object.keys(checks).sort());
    expect(Object.values(make().features).every((v) => v === true)).toBe(true);
  });
  for (const [name, check] of Object.entries(checks)) it(name, check);

  it('declares none of the behaviours it does not draw', () => {
    for (const f of ['homeAsk', 'kbProgress']) expect(make().features[f], f).toBeUndefined();
    expect(T1_SRC).not.toMatch(/data-home-ask|data-kb-progress|data-kb-search-clear/);
  });
});

describe('t1: nothing is drawn for a capability Core cannot serve', () => {
  const cases = [
    NO_CAPS,
    // Even a Core that says yes gets nothing: this renderer implements none of them.
    { csat: true, reactions: true, orderCard: true, prechatSteps: true, instantAnswers: true, kbNeutral: true },
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
        FRAME(r),
        r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true, kbEnabled: true }),
        r.handoffPrechatCardHtml(IDENTITY(['name', 'email', 'phone']), {}, 'fa', 'sub', false),
      ].join('');
      const root = parse(html);
      expect(root.querySelector('.card, .steps, .react, .csat, .faces, [data-csat-rate], [data-react], .tray, [data-kb-suggest], [data-prechat-step]')).toBeNull();
      expect(html).not.toContain('track-order');
      const fb = parse(r.kbArticleFeedbackHtml({ enabled: true, rating: null }));
      expect(Array.from(fb.querySelectorAll('[data-kb-rate]')).map((b) => b.getAttribute('data-kb-rate'))).toEqual(['up', 'down']);
      expect(fb.querySelector('[data-kb-rate="neutral"]')).toBeNull();
    });
  }

  it('thanks the visitor once a vote is saved, and draws nothing when feedback is off', () => {
    const fb = parse(make().kbArticleFeedbackHtml({ enabled: true, rating: 'up' }));
    expect(fb.querySelector('[data-kb-rate="up"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(fb.querySelector('[data-kb-rate="down"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(make().kbArticleFeedbackHtml({ enabled: false })).toBe('');
  });

  it('keeps the source free of the hooks of behaviours Core serves to other renderers only', () => {
    expect(T1_SRC).not.toMatch(/data-csat|data-react|data-order|data-kb-suggest|data-prechat-step/);
    expect(T1_SRC).toMatch(/void caps;/);
  });
});

describe('t1: skeletons wear the real surfaces', () => {
  const r = () => make({ config: { features: { knowledgeBase: true } } });
  const classes = (html: string) => new Set((html.match(/class="([^"]+)"/g) || []).flatMap((m) => m.slice(7, -1).split(/\s+/)));
  const pairs: Array<[string, () => string, () => string, string[]]> = [
    ['home', () => r().skeletonHtml('home', { rtl: true, chatEnabled: true }),
      () => r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, kbEnabled: true, teamMembers: BASE_CONFIG.teamMembers, articles: [{ slug: 'a', title: 'A' }] }),
      ['wy-view-home', 'hx', 'hx-top', 'logo', 'hx-hi', 'hx-q', 'wy-home-scroll', 'cd', 'team', 'avs', 'btn-p', 'hc', 'kb-search', 'li', 'wy-tabs', 'wy-tab', 'pw']],
    ['chat', () => r().skeletonHtml('chat', { rtl: true, chatEnabled: true, composer: { voiceNotes: true, attachments: true, emoji: true } }),
      () => FRAME(r()),
      ['wy-view-chat', 'hd', 'who', 'hn', 'hs', 'wy-chat-scroll-host', 'wy-chat-scroll', 'composer-zone', 'cmp', 'input-bar', 'input-wrap', 'cbox',
        'input-row', 'input', 'mic-btn', 'attach-btn', 'emoji-btn', 'pw']],
    ['list', () => r().skeletonHtml('list', { rtl: true }), () => r().conversationListHtml({ conversations: [{ id: 'c' }], chatEnabled: true }),
      ['wy-view-list', 'ttl', 'wy-head-list', 'wy-list-scroll', 'cta-w', 'btn-p', 'wy-tabs', 'pw']],
    ['help', () => r().skeletonHtml('help', { rtl: true }), () => r().kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }] }),
      ['wy-view-kb', 'kb-top', 'ttl', 'kb-search', 'wy-kb-scroll', 'kb-res', 'cd', 'ls', 'li', 'wy-tabs', 'pw']],
    ['article', () => r().skeletonHtml('article', { rtl: true }),
      () => r().kbHtml({ state: 'article', article: { title: 'A', contentHtml: '' }, feedback: { enabled: true } }),
      ['wy-view-kb', 'kb-art', 'hd', 'wy-head-article', 'art', 'kb-article-body', 'kb-feedback', 'kb-rate', 'pw']],
    ['prechat', () => r().skeletonHtml('prechat', { rtl: true, fields: 2 }), () => r().prechatFormHtml(IDENTITY(['name', 'email']), {}, 'fa'),
      ['wy-view-precontact', 'hd', 'who', 'fm', 'intro', 'prechat-fields', 'prechat-field', 'inp', 'fm-end', 'btn-p', 'priv', 'pw']],
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
      expect(root.getAttribute('style')).toContain('--a:#0b7d6c');
      // Nothing in it can be reached: inert, or no controls at all.
      if (!root.hasAttribute('inert')) expect(root.querySelector('button, input, textarea, a')).toBeNull();
      // Skeletons never carry names, times or counts.
      const text = parse(skel()).textContent!;
      expect(text).not.toMatch(/[0-9۰-۹]/);
      expect(text).not.toContain('سارا');
    });
  }

  it('mirror the composer controls Core is about to mount', () => {
    const none = classes(r().skeletonHtml('chat', { chatEnabled: true, composer: {} }));
    expect(none.has('send-btn')).toBe(true);
    expect(none.has('mic-btn') || none.has('attach-btn') || none.has('emoji-btn')).toBe(false);
    expect(classes(r().skeletonHtml('chat', { chatEnabled: false })).has('composer-zone')).toBe(false);
  });

  it('draw the home\'s article rows as empty bars, and fall back to home for an unknown view', () => {
    const home = parse(r().skeletonHtml('home', {}));
    expect(Array.from(home.querySelectorAll('.hc .li .lx')).every((x) => x.textContent === '')).toBe(true);
    expect(home.querySelectorAll('.hc .li').length).toBe(4);
    expect(r().skeletonHtml('nope', {})).toContain('wy-view-home');
    expect(T1_CSS).toMatch(/\.wy-skeleton \.li \.lx:empty/);
  });
});

describe('t1: numbers in the visitor\'s digits', () => {
  it('fa prints Persian digits everywhere it counts', () => {
    const r = make();
    expect(r.format.humanSize(860160)).toBe('۸۴۰ کیلوبایت');
    expect(r.format.humanSize(1.2 * 1048576)).toBe('۱٫۲ مگابایت');
    expect(r.format.humanSize(512)).toBe('۵۱۲ بایت');
    expect(r.format.clock(0)).toBe('۰:۰۰');
    expect(r.format.badge(7)).toBe('۷');
    expect(r.format.badge(120)).toBe('۹۹+');
    expect(r.format.num(24)).toBe('۲۴');
    expect(r.format.callDuration(75)).toBe('۰۱:۱۵');
    const home = parse(r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true, kbEnabled: true, unreadTotal: 12,
      articles: [{ slug: 'a', title: 'زمان ارسال' }], conversations: [{ id: 'c', status: 'open', unreadCount: 2, preview: 'p', operatorName: 'سارا' }] }));
    expect(home.querySelector('.rc .nb')!.textContent).toBe('۲');
    expect(home.querySelector('[data-tab-badge]')!.textContent).toBe('۱۲');
    expect(home.querySelector('[data-view="list"]')!.getAttribute('aria-label')).toBe('پیام‌ها، ۱۲ خوانده‌نشده');
    expect(home.textContent).not.toMatch(/[0-9]/);
    const more = parse(r.qnaChipsHtml({ questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }, { question: 'd' }, { question: 'e' }] }));
    expect(more.querySelector('.qna-more-count')!.textContent).toBe('+۲');
    const file = parse(r.messageAttachmentHtml({ id: 'f', kind: 'file', file_name: 'فاکتور-۴۸۲۱۳.pdf', size_bytes: 245760 }));
    expect(file.querySelector('.msg-att-sub')!.textContent).toBe('۲۴۰ کیلوبایت');
    expect(file.querySelector('.ft.pdf')!.textContent).toBe('PDF');
    const many = parse(r.conversationRowHtml({ id: 'c', unreadCount: 120, preview: 'p' }, false));
    expect(many.querySelector('.nb')!.textContent).toBe('۹۹+');
  });

  it('en and tr keep Latin digits', () => {
    expect(make({ locale: 'en' }).format.humanSize(860160)).toBe('840 KB');
    expect(make({ locale: 'en' }).format.humanSize(1.2 * 1048576)).toBe('1.2 MB');
    expect(make({ locale: 'tr' }).format.clock(8)).toBe('0:08');
    expect(make({ locale: 'en' }).format.badge(120)).toBe('99+');
  });
});

describe('t1: accent tokens', () => {
  const styleOf = (r: Renderer) => parse(r.homeHtml({ rtl: true, isOnline: true })).firstElementChild!.getAttribute('style')!;
  const BRAND = '--a:#0b7d6c;--a-rgb:11,125,108;--gs-primary:#0b7d6c;--hero:linear-gradient(155deg,#1DB99D 0%,#0F927D 46%,#0B7D6C 100%)';

  it('wears the brand look when the colour is uncustomised, unparseable or the brand\'s own', () => {
    for (const c of ['', '#3B82F6', '#3b82f6', '#0B7D6C', 'not-a-colour', 'red;background:url(x)', '#12345']) {
      expect(styleOf(make({ primaryColor: c })), c).toBe(BRAND);
    }
  });

  it('uses the workspace colour, with white or ink on it by contrast', () => {
    expect(styleOf(make({ primaryColor: '#7c3aed' }))).toBe('--a:#7c3aed;--a-rgb:124,58,237;--gs-primary:#7c3aed');
    expect(styleOf(make({ primaryColor: '#111827' }))).not.toContain('--on-a');
    const ink = ';--on-a:#16142B;--on-a-2:rgba(22,20,43,.78);--on-a-sf:rgba(22,20,43,.08)';
    expect(styleOf(make({ primaryColor: '#FFEB3B' }))).toBe('--a:#ffeb3b;--a-rgb:255,235,59;--gs-primary:#ffeb3b' + ink);
    expect(styleOf(make({ primaryColor: '#fc0' }))).toBe('--a:#ffcc00;--a-rgb:255,204,0;--gs-primary:#ffcc00' + ink);
  });

  it('sets the tokens on every view root and on the close button', () => {
    const r = make({ primaryColor: '#2563EB' });
    const roots = [
      FRAME(r), r.homeHtml({}), r.conversationListHtml({}), r.kbHtml({}), r.kbHtml({ state: 'article', article: {} }),
      r.kbHtml({ state: 'category', category: { id: 'c', name: 'x' } }),
      r.prechatFormHtml(IDENTITY(['email']), {}, 'fa'), r.contactFallbackHtml(IDENTITY([]), {}, 'fa', {}),
      ...['home', 'chat', 'list', 'help', 'article', 'prechat'].map((v) => r.skeletonHtml(v, {})),
    ];
    for (const html of roots) expect(parse(html).firstElementChild!.getAttribute('style'), html.slice(0, 60)).toContain('--a:#2563eb;');
    expect(parse(r.shellHtml({})).querySelector('[data-panel-close]')!.getAttribute('style')).toContain('--a:#2563eb;');
  });

  it('derives every other shade in the stylesheet, with fallbacks for browsers without color-mix()', () => {
    expect(T1_CSS).toMatch(/@supports not \(color: color-mix\(in oklab, red, red\)\)/);
    expect(T1_CSS).toMatch(/color-mix\(in oklab, var\(--a\)/);
    expect(T1_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    // Faces come from the document-level fonts stylesheet; nothing remote.
    expect(T1_CSS).not.toMatch(/@font-face|@import|https?:\/\//);
  });
});

describe('t1: direction, people, the workspace', () => {
  it('writes dir on every view root (rtl for fa, ltr otherwise)', () => {
    expect(parse(make().homeHtml({ rtl: true })).firstElementChild!.getAttribute('dir')).toBe('rtl');
    expect(parse(make({ locale: 'en' }).kbHtml({ rtl: false })).firstElementChild!.getAttribute('dir')).toBe('ltr');
    expect(parse(make({ locale: 'tr' }).chatFrameHtml({ chatEnabled: true, locale: 'tr', config: BASE_CONFIG })).firstElementChild!.getAttribute('dir')).toBe('ltr');
  });

  it('draws a person as a photo when there is one, else their initial; the workspace as its logo or initial', () => {
    const r = make({ config: { logoUrl: 'https://cdn.test/logo.png' } });
    const h = parse(r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
    expect(h.querySelector('.hx-top .logo img')!.getAttribute('src')).toBe('https://cdn.test/logo.png');
    // The team card: who is online first (or everyone), one colour each.
    expect(Array.from(h.querySelectorAll('.team .avs .av')).map((a) => a.textContent)).toEqual(['س']);
    const all = parse(make({ config: { teamMembers: [{ name: 'سارا' }, { name: 'مهدی' }, { name: 'رضا' }] } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
    expect(Array.from(all.querySelectorAll('.team .avs .av')).map((a) => a.className.split(' ')[2])).toEqual(['c1', 'c2', 'c3']);
    const noLogo = parse(make({ config: { showLogo: false, logoUrl: 'https://cdn.test/logo.png' } }).homeHtml({ rtl: true, isOnline: true }));
    expect(noLogo.querySelector('.logo')).toBeNull();
    expect(parse(make().homeHtml({ rtl: true, isOnline: true })).querySelector('.hx-top .logo')!.textContent).toBe('ف');
    const photo = parse(make().chatHeaderHtml({ online: true, operator: { name: 'سارا', avatar: 'https://cdn.test/s.png', online: true } }));
    expect(photo.querySelector('.who .av img')!.getAttribute('src')).toBe('https://cdn.test/s.png');
    expect(make({ config: { teamMembers: [{ name: 'سارا', online: true }] } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true, showTeamAvatars: false }))
      .not.toContain('class="avs');
    // The same person keeps one colour on every surface.
    const thread = parse(make().messagesHtml({ messages: [msg({ senderName: 'سارا' })] }, '', {}));
    expect(thread.querySelector('.msg-avatar')!.classList.contains('c1')).toBe(true);
    expect(thread.querySelector('.msg-sender-label')!.textContent).toBe('سارا');
  });

  it('labels the first row of a person\'s run only, and gives every run its avatar and receipts', () => {
    const t = parse(make().messagesHtml({ messages: [
      msg({ senderName: 'سارا', body: '1' }), msg({ senderName: 'سارا', body: '2' }),
      msg({ sender: 'visitor', senderType: 'contact', body: '3', status: 'seen' }),
      msg({ senderType: 'ai', senderName: 'دستیار', body: '4' }),
      msg({ sender: 'visitor', senderType: 'contact', body: '5', status: 'failed', localId: 'l9' }),
    ] }, '', {}));
    expect(t.querySelectorAll('.msg-sender-label').length).toBe(1);
    expect(t.querySelectorAll('.msg-row.operator .msg-avatar:not(.msg-avatar-spacer)').length).toBe(2);
    expect(t.querySelectorAll('.msg-avatar-spacer').length).toBe(1);
    expect(t.querySelector('.msg-row.visitor .msg-ticks.is-seen')).not.toBeNull();
    const failed = t.querySelector('.msg-row.visitor.is-failed')!;
    expect(failed.querySelector('.msg-ticks.is-failed')!.textContent).toBe('ارسال نشد');
    expect(failed.querySelector('[data-msg-retry="l9"]')!.textContent).toBe('تلاش دوباره');
    expect(t.innerHTML).not.toMatch(/style="background/);
  });

  it('shows a quoted reply with its author', () => {
    const t = parse(make().messagesHtml({ messages: [msg({ sender: 'visitor', senderType: 'contact', body: '> سارا: کد رهگیری TR-1\n\nعالیه' })] }, '', {}));
    expect(t.querySelector('.msg-quote b')!.textContent).toBe('سارا');
    expect(t.querySelector('.msg-quote')!.textContent).toBe('ساراکد رهگیری TR-1');
    expect(t.querySelector('.msg-text')!.textContent).toBe('عالیه');
  });

  it('keeps the away banner in the thread for the stylesheet to show while the team is away', () => {
    const t = parse(make({ config: { availability: { state: 'offline' } } }).messagesHtml({ messages: [msg({})] }, '', {}));
    const ban = t.querySelector('.messages > .ban.ban-row:first-child')!;
    expect(ban.querySelector('b')!.textContent).toBe('تیم ما الان آفلاین است');
    expect(T1_CSS).toMatch(/\.messages > \.ban-row \{ display: none;/);
  });
});

describe('t1: its own copy', () => {
  const keys = (/var COPY_KEYS = '([^']+)'/.exec(T1_SRC) || [])[1]!.split(' ');
  const dict = (lang: string) => (new RegExp(`\\n    ${lang}: '([^']*)',`).exec(T1_SRC) || [])[1];

  it('has every string in fa, en and tr, in key order', () => {
    expect(keys.length).toBeGreaterThan(40);
    expect(new Set(keys).size).toBe(keys.length);
    for (const lang of ['fa', 'en', 'tr']) {
      const parts = dict(lang)!.split('|');
      expect(parts.length, lang).toBe(keys.length);
      expect(parts.every((p) => p.trim().length > 0), lang).toBe(true);
      // The emoji groups' names, one per group.
      expect(parts[keys.indexOf('cats')].split(',').length, lang).toBe(6);
    }
  });

  it('speaks the visitor\'s language', () => {
    const en = parse(make({ locale: 'en' }).homeHtml({ rtl: false, isOnline: true, chatEnabled: true }));
    expect(en.querySelector('.hx-q')!.textContent).toBe('How can we help you?');
    const tr = parse(make({ locale: 'tr' }).homeHtml({ rtl: false, isOnline: true, chatEnabled: true }));
    expect(tr.querySelector('.hx-q')!.textContent).toBe('Size nasıl yardımcı olabiliriz?');
    // Any other language reads English.
    expect(parse(make({ locale: 'de' }).homeHtml({ rtl: false })).querySelector('.hx-q')!.textContent).toBe('How can we help you?');
  });
});

describe('t1: the platform\'s marks stay in the Iranian edition\'s build', () => {
  it('lives only inside the @iran-kit block, which the RESPOK build removes', () => {
    // esbuild refuses to run inside jsdom: the transform runs in its own
    // node process, as widgetBrandBuild.test.ts does.
    const shipped = (brand: string) => execFileSync(process.execPath,
      [resolve(process.cwd(), 'scripts/build/widgetBrand.mjs'), brand, resolve(process.cwd(), 'public/widget/presentation-t1.js')],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const mark = 'M42.28 27.95A12.4';
    expect(T1_SRC).toContain(mark);
    expect(shipped('iran')).toContain(mark);
    const respok = shipped('respok');
    expect(respok).not.toContain(mark);
    expect(respok).toContain('__gs_presentation_t1');
    expect(T1_CSS).not.toMatch(/M42\.28/);
  });

  it('draws no mark at all without it (the RESPOK build), only the credit text', () => {
    const src = T1_SRC.replace(/\/\* @iran-kit:begin \*\/[\s\S]*?\/\* @iran-kit:end \*\//g, '');
    const w = window as unknown as Record<string, { create: (env: Vm) => Renderer }>;
    const keep = w.__gs_presentation_t1;
    try {
      new Function(src).call(window);
      const r = w.__gs_presentation_t1.create({ t: (k: string) => FA[k] ?? k, escapeHtml, config: BASE_CONFIG, locale: 'fa', primaryColor: '' });
      const home = parse(r.homeHtml({ rtl: true, isOnline: true }));
      expect(home.querySelector('.hx-mk, .pw-mk')).toBeNull();
      expect(home.querySelector('.wy-powered')!.textContent).toBe('قدرت گرفته از Platform');
    } finally {
      w.__gs_presentation_t1 = keep;
    }
  });
});
