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
 *     accent tokens it computes (on-accent ink; the brand default is the
 *     stylesheet's, by class, so a skin can give its own);
 *   - its own copy exists in fa, en and tr; the platform's mark stays out of
 *     the RESPOK build;
 *   - its extras (presentation-t1-x.js, markup no first paint needs: the
 *     emoji grid) are taken only when they are its own (id, version), and
 *     draw through the renderer exactly what they draw on their own.
 * Geometry against the design's PNGs is checked with the screenshot harness
 * (e2e/harness/templateScreens.ts --template t1), not here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { avatarFace, avatarFaces } from './avatarFace';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const REGISTRY_SRC = read('public/widget/presentation-registry.js');
const T1_SRC = read('public/widget/presentation-t1.js');
const T1_X_SRC = read('public/widget/presentation-t1-x.js');
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
  homeReplyFast: 'معمولاً در چند دقیقه پاسخ می‌دهیم', convLoadError: 'گفتگوها بارگذاری نشد', convRetry: 'تلاش دوباره',
  csBackToChat: 'بازگشت به گفتگو',
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
/** What Core serves today (runtime.js env.capabilities). */
const SERVED = {
  kbNeutral: true, csat: true, reactions: true, orderCard: true, prechatSteps: true, instantAnswers: true, chatMenu: true, awayThread: true,
  queuePosition: true, emojiSearch: true, dlProgress: true, kbAuthor: true,
};

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
  new Function(T1_X_SRC).call(window);
}
/** The renderer's extras module (presentation-t1-x.js), as Core hands it over. */
const EXTRAS = () => (window as unknown as { __gs_mod_extras: { id: string; v: number; create: (h: unknown) => Record<string, Fn> } }).__gs_mod_extras;
/** A renderer that took its extras. */
const extended = (r: Renderer) => { expect((r.extend as unknown as (m: unknown) => number)(EXTRAS())).toBe(1); return r; };

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
/** A bottom-menu tab's accessible name: the text of what its aria-labelledby names (hidden nodes included). */
const tabName = (root: Element, view: string) => {
  const tab = root.querySelector(`.wy-tab[data-view="${view}"]`)!;
  expect(tab.hasAttribute('aria-label'), 'a frozen aria-label overrides the live badge').toBe(false);
  return tab.getAttribute('aria-labelledby')!.split(' ')
    .map((id) => root.querySelector('#' + id)!.textContent).filter(Boolean).join(' ');
};

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

  it('per export and per element: what each default function draws, the same function here draws on the same element', () => {
    const d = (window as unknown as Record<string, { create: (env: Vm) => Renderer }>).__gs_presentation_default.create({
      t: (k: string) => k, escapeHtml, config: BASE_CONFIG, locale: 'fa', primaryColor: '#3B82F6',
    });
    // With its extras, as Core hands them over after the first paint (the past bar is theirs).
    const r = extended(make());
    const id = IDENTITY(['name', 'email', 'phone'], ['email']);
    const conv = { id: 'c', status: 'open', preview: 'p', unreadCount: 2, timeLabel: 't' };
    const qna = { questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }, { question: 'd' }], collapsedCount: 3 };
    const inv = msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: 'pending', channel: 'audio', invitation_id: 'x',
      expires_at: new Date(Date.now() + 60_000).toISOString() } });
    const thread = { aiThinking: true, messages: [
      msg({ attachment: { id: 'i', kind: 'image', file_name: 'a.png' } }), msg({ attachment: { id: 'v', kind: 'audio' } }),
      msg({ attachment: { id: 'f', kind: 'file', file_name: 'a.pdf' } }), msg({ senderType: 'ai', metadata: { source: 'ai_agent_intro' } }),
      msg({ sender: 'visitor', senderType: 'contact', status: 'failed', localId: 'l1' }), inv,
      msg({ senderType: 'system', metadata: { kind: 'call_ended', duration_seconds: 30 } }),
      msg({ senderType: 'system', metadata: { kind: 'routing_agent_joined', agent_name: 'A' } }),
      msg({ sender: 'visitor', senderType: 'contact', status: 'sending' }),
    ] };
    const calls: Record<string, unknown[][]> = {
      shellHtml: [[{}]],
      chatFrameHtml: [[{ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }], [{ chatEnabled: false, locale: 'fa', config: BASE_CONFIG }]],
      homeHtml: [[{ rtl: true, isOnline: true, kbEnabled: true, chatEnabled: true, articles: [{ slug: 'a', title: 'A' }], conversations: [conv],
        smartSurface: { mode: 'home_card', title: 't', body: 'b', ctaLabel: 'c' } }],
      [{ rtl: true, isOnline: false, chatEnabled: true, kbEnabled: true, conversations: [], conversationsError: true }]],
      emptyHtml: [[{ qna }], [{}]],
      messagesHtml: [[thread, '', { qna, typewriter: { id: 'tw', tokens: ['a', 'b'], revealedCount: 1 } }]],
      aiThinkingRowHtml: [[]],
      qnaChipsHtml: [[qna]],
      messageAttachmentHtml: [[{ id: 'i', kind: 'image', file_name: 'a.png' }], [{ id: 'v', kind: 'audio' }], [{ id: 'f', kind: 'file', file_name: 'x.zip' }]],
      callInvitationCardHtml: [[inv], [msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: 'joined', channel: 'video', invitation_id: 'y' } })]],
      callEndedRowHtml: [[thread.messages[6]]],
      routingOutcomeRowHtml: [[thread.messages[7]]],
      prechatFieldRowHtml: [[id, 'email', 'email', 'a@b.c'], [id, 'name', 'text', ''], [id, 'phone', 'tel', '']],
      prechatFormHtml: [[id, {}, 'fa']],
      handoffPrechatCardHtml: [[id, {}, 'fa', 'sub', true], [id, {}, 'fa', 'sub', false]],
      contactFallbackHtml: [[id, {}, 'fa', {}]],
      smartSurfaceHtml: [[{ title: 't', body: 'b', ctaLabel: 'c' }]],
      conversationListHtml: [[{ conversations: [conv], chatEnabled: true }], [{ conversations: [], error: true, chatEnabled: true }], [{ loading: true }]],
      conversationRowHtml: [[conv, true], [conv, false]],
      kbHtml: [[{ state: 'article', article: { title: 'A', contentHtml: '<p>x</p>' }, feedback: { enabled: true } }],
        [{ state: 'list', articles: [{ slug: 'a', title: 'A' }], categories: [] }], [{ state: 'results', query: 'x', results: [{ slug: 'r', title: 'R' }] }],
        [{ state: 'results', query: 'x', results: [] }], [{ state: 'searching' }]],
      kbSearchBarHtml: [[{ query: 'q' }]],
      kbHomeHtml: [[{ articles: [{ slug: 'a', title: 'A' }] }], [{ articles: [] }]],
      kbSearchResultsHtml: [[{ results: [{ slug: 'a', title: 'A' }] }], [{ results: [] }]],
      kbArticleHtml: [[{ article: { title: 'A', contentHtml: '' } }]],
      kbEmptyHtml: [[{}]],
      kbLoadingHtml: [[{}]],
      kbArticleFeedbackHtml: [[{ enabled: true, rating: null }]],
      skeletonHtml: ['home', 'chat', 'list', 'help', 'article', 'prechat', 'articles']
        .map((v) => [v, { chatEnabled: true, composer: { voiceNotes: true, attachments: true, emoji: true } }]),
      connIndicatorHtml: [[]],
      // One conversation: a past conversation's bar, with a current one and without (online, away).
      pastBarHtml: [[{ current: true, online: true }], [{ current: false, online: true }], [{ current: false, online: false }]],
    };
    const drawn = (x: Renderer, name: string) => {
      const out = new Set<string>();
      for (const args of calls[name] || [[]]) {
        for (const el of Array.from(parse(x[name](...args)).querySelectorAll('*'))) {
          for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) out.add(`${el.tagName.toLowerCase()}[${a.name}]`);
        }
      }
      return out;
    };
    const exported = Object.keys(d).filter((k) => typeof d[k] === 'function');
    // Every export is exercised here (a new one in default must be added).
    expect(exported.filter((k) => !calls[k])).toEqual([]);
    const missing: string[] = [];
    for (const name of exported) {
      const ours = drawn(r, name);
      for (const h of drawn(d, name)) if (!ours.has(h)) missing.push(`${name}: ${h}`);
    }
    expect(missing).toEqual([]);
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

  it('puts a name into Core\'s sentences literally (no $& / $\' replacement patterns)', () => {
    const own: Record<string, string> = { routingAgentJoined: '{name} پیوست', ciHeadlineAudioFrom: '{op} تماس می‌گیرد' };
    const r = make({ t: (k: string) => own[k] ?? FA[k] ?? k });
    const name = "A$'B$&C$`";
    const joined = parse(r.routingOutcomeRowHtml(msg({ senderType: 'system', metadata: { kind: 'routing_agent_joined', agent_name: name } })));
    expect(joined.querySelector('.msg-system-pill')!.textContent).toBe(name + ' پیوست');
    const call = parse(r.callInvitationCardHtml(msg({ senderType: 'system', metadata: { kind: 'call_invitation', status: 'joined', channel: 'audio', operator_name: name } })));
    expect(call.querySelector('.ci-title')!.textContent).toBe(name + ' تماس می‌گیرد');
  });

  it('a category icon or call status named after an Object.prototype key draws the fallback, never prototype text', () => {
    const r = make();
    const tile = (icon: string) => parse(r.kbHtml({ state: 'list', articles: [], categories: [{ id: 'c', name: 'N', icon, count: 1 }] }))
      .querySelector('[data-kb-category] svg')!.outerHTML;
    const book = tile('no-such-icon');
    for (const icon of ['constructor', '__proto__', 'Constructor']) {
      expect(tile(icon), icon).toBe(book);
    }
    expect(tile('box')).not.toBe(book);
    for (const status of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const card = parse(r.callInvitationCardHtml(msg({ senderType: 'system', metadata: { kind: 'call_invitation', status, channel: 'audio', invitation_id: 'x' } })));
      expect(card.querySelector('.ci-status')!.textContent, status).toBe('');
    }
    // The same for a locale: its own copy falls back to English, nothing throws.
    const english = make({ locale: 'en' }).homeHtml({ rtl: false });
    for (const locale of ['constructor', '__proto__']) {
      expect(make({ locale }).homeHtml({ rtl: false }), locale).toBe(english);
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
  const r = () => make({ capabilities: SERVED });
  const checks: Record<string, () => void> = {
    tabs: () => {
      const home = parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, unreadTotal: 3 }));
      const tabs = Array.from(home.querySelectorAll('nav.wy-tabs > button.wy-tab[data-view]'));
      // One conversation per visitor: the middle tab is the door to it («گفتگو»), its badge the answer waiting.
      expect(tabs.map((b) => b.getAttribute('data-view'))).toEqual(['home', 'chat', 'help']);
      expect(tabs.map((b) => b.getAttribute('aria-current'))).toEqual(['page', 'false', 'false']);
      const badge = home.querySelector('[data-view="chat"] [data-tab-badge]')!;
      expect(badge.textContent).toBe('۳');
      expect(badge.hasAttribute('hidden')).toBe(false);
      expect(parse(r().homeHtml({ rtl: true })).querySelector('[data-tab-badge]')!.hasAttribute('hidden')).toBe(true);
      // Each tab is named by its label (hidden in some modes) and, for
      // the conversation, the badge Core patches in place (runtime-ext.js paintTabBadges):
      // the name follows the patch, it is not frozen at render time.
      expect(['home', 'chat', 'help'].map((v) => tabName(home, v))).toEqual(['خانه', 'گفتگو ۳', 'راهنما']);
      badge.textContent = '';
      badge.setAttribute('hidden', '');
      expect(tabName(home, 'chat')).toBe('گفتگو');
      badge.textContent = '۹۹+';
      expect(tabName(home, 'chat')).toBe('گفتگو ۹۹+');
      const ids = Array.from(home.querySelectorAll('[id]')).map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      // History («گفتگوهای قبلی») is a pushed screen: no bar, its back where the visitor came from.
      const hist = parse(r().conversationListHtml({}));
      expect(hist.querySelector('nav')).toBeNull();
      expect(hist.querySelector('.ttl.wy-head-list [data-view-back="home"]')).not.toBeNull();
      expect(hist.querySelector('.ttl h2')!.textContent).toBe('گفتگوهای قبلی');
      expect(parse(r().conversationListHtml({ back: 'chat' })).querySelector('[data-view-back="chat"]')).not.toBeNull();
      expect(parse(r().kbHtml({ state: 'list' })).querySelector('[data-view="help"]')!.getAttribute('aria-current')).toBe('page');
      // Style and label mode come from the workspace's template options.
      const vd = parse(make({ config: { templateOptions: { navStyle: 'vd', navMode: 'icon' } } }).homeHtml({ rtl: true }));
      expect(vd.querySelector('nav.wy-tabs.vd')).not.toBeNull();
      expect(vd.firstElementChild!.classList.contains('nv-icon')).toBe(true);
      // Home links to the earlier conversations (any menu mode, only when there are some).
      const none = parse(make({ config: { templateOptions: { navMode: 'none' } } })
        .homeHtml({ rtl: true, isOnline: true, chatEnabled: true, conversations: [{ id: 'c', preview: 'p' }], pastCount: 2 }));
      expect(none.querySelector('nav')).toBeNull();
      expect(none.querySelector('.wy-home-scroll .more[data-view="list"]')!.textContent).toBe('گفتگوهای قبلی');
      expect(parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, pastCount: 1 })).querySelector('.team ~ .more[data-view="list"]')).not.toBeNull();
      // An answer unseen there: its count on the link, none without one.
      expect(none.querySelector('.more[data-view="list"] .nb')).toBeNull();
      const unseen = parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, pastCount: 2, pastUnread: 3 }));
      expect(unseen.querySelector('.more[data-view="list"] .nb')!.textContent).toBe('۳');
      // A resolved conversation is still the visitor's (its live dot with the team online); a closed one has none.
      const capOf = (status: string) => parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, conversations: [{ id: 'c', status, preview: 'p' }] })).querySelector('.rc .cap .live');
      expect(capOf('resolved')).not.toBeNull();
      expect(capOf('closed')).toBeNull();
      expect(parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, conversations: [{ id: 'c', preview: 'p' }] })).querySelector('[data-view="list"]:not(.wy-tab)')).toBeNull();
      // One door to the conversation: the card, never a second «new message» one.
      const cur = parse(r().homeHtml({ rtl: true, isOnline: true, chatEnabled: true, conversations: [{ id: 'c', preview: 'p' }] }));
      expect(cur.querySelector('.rc .cap')!.textContent).toBe('گفتگوی شما');
      expect(cur.querySelectorAll('[data-home-action="chat"], .cd.cta').length).toBe(0);
    },
    kbSearch: () => {
      const h = parse(r().kbHtml({ state: 'list', query: '', articles: [] }));
      expect(h.querySelector('input.kb-search[data-kb-search]')!.getAttribute('aria-label')).toBe('جستجو در راهنما');
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
      expect(avatarFace(row.querySelector('.msg-avatar'))).toBe('person');
      expect(row.querySelector('.msg-meta')!.textContent).toBe('سارا در حال نوشتن…');
      expect(parse(r().emptyHtml({ operatorTyping: { name: 'سارا' } })).querySelector('.typing-row')).not.toBeNull();
      expect(parse(r().messagesHtml({ messages: [msg({})] }, '', {})).querySelector('.typing-row')).toBeNull();
    },
    chatHeader: () => {
      const h = parse(r().chatHeaderHtml({ online: true, typing: false, operator: { name: 'سارا', online: true }, isNew: false }));
      expect(h.querySelector('[data-presence] [data-presence-label]')).not.toBeNull();
      // The workspace on top, the operator answering small under it (owner, 2026-10-18).
      expect(h.querySelector('.hn')!.textContent).toBe('فروشگاه نیلوفر');
      expect(h.querySelector('.hs')!.textContent).toBe('سارا');
      expect(h.querySelector('.who .av .pr:not(.off)')).not.toBeNull();
      // No workspace name, or the same name twice: the operator and the status line, as before.
      for (const workspaceName of ['', 'سارا']) {
        const one = parse(make({ config: { workspaceName } }).chatHeaderHtml({ online: true, operator: { name: 'سارا', online: true }, isNew: false }));
        expect([one.querySelector('.hn')!.textContent, one.querySelector('.hs')!.textContent], workspaceName).toEqual(['سارا', 'آنلاین · پاسخ در چند دقیقه']);
      }
      // Nobody assigned: the workspace and its status line.
      const ws = parse(r().chatHeaderHtml({ online: true, operator: null, isNew: false }));
      expect([ws.querySelector('.hn')!.textContent, ws.querySelector('.hs')!.textContent]).toEqual(['فروشگاه نیلوفر', 'آنلاین · پاسخ در چند دقیقه']);
      const en = parse(make({ locale: 'en', t: (k) => k, config: { workspaceName: 'Nilufar Store' } })
        .chatHeaderHtml({ online: true, operator: { name: 'Sara', online: true }, isNew: false }));
      expect([en.querySelector('.hn')!.textContent, en.querySelector('.hs')!.textContent]).toEqual(['Nilufar Store', 'Sara']);
      expect(h.querySelector('.away')).toBeNull();
      // Away: the email line, and the marker the thread's away banner keys on.
      const away = parse(r().chatHeaderHtml({ online: false, operator: null, isNew: false }));
      expect(away.querySelector('.hs')!.textContent).toBe('آفلاین · پاسخ همین‌جا');
      expect(away.querySelector('.away[hidden]')).not.toBeNull();
      expect(avatarFace(away.querySelector('.who .av.c4'))).toBe('workspace');
      // A fresh thread shows the team as any thread before an operator joins (no «گفتگوی جدید» title).
      expect(parse(r().chatHeaderHtml({ online: true, isNew: true })).querySelector('.hn')!.textContent).toBe('فروشگاه نیلوفر');
      // Back goes where Core says the visitor came from (home, help; history for a past thread).
      expect(parse(r().chatHeaderHtml({ online: true })).querySelector('[data-view-back="home"]')).not.toBeNull();
      expect(parse(r().chatHeaderHtml({ online: true, back: 'list' })).querySelector('[data-view-back="list"]')).not.toBeNull();
      // Core rewrites the header: nothing it binds once may live in there.
      for (const html of [h.innerHTML, away.innerHTML]) {
        expect(parse(html).querySelector('[data-chat-jump],[data-escalate-btn],[data-msg-input],[data-chat-messages]')).toBeNull();
      }
      const frame = parse(FRAME(r()));
      expect(frame.querySelector('[data-chat-header] [data-chat-jump]')).toBeNull();
      expect(frame.querySelector('[data-chat-header] [data-presence]')).not.toBeNull();
      expect(T1_CSS).toMatch(/\.wy-view-chat:has\(\.away\) \.ban-row \{ display: flex; \}/);
    },
    prechatHeader: () => {
      // Asking for the visitor's details, or in the conversation they were
      // given in (08·a-c): the store with its lead's face and presence, on a
      // new conversation too; away, the store's own tile.
      const pre = parse(r().chatHeaderHtml({ online: true, prechat: true, isNew: true }));
      expect(pre.querySelector('.hn')!.textContent).toBe('فروشگاه نیلوفر');
      expect(pre.querySelector('.hs')!.textContent).toBe('آنلاین · پاسخ در چند دقیقه');
      expect(avatarFace(pre.querySelector('.who .av.c1'))).toBe('person');
      expect(pre.querySelector('.who .av .pr:not(.off)')).not.toBeNull();
      const preAway = parse(r().chatHeaderHtml({ online: false, prechat: true, isNew: true }));
      expect(avatarFace(preAway.querySelector('.who .av.c4'))).toBe('workspace');
      expect(preAway.querySelector('.hs')!.textContent).toBe('آفلاین · پاسخ همین‌جا');
      // An assigned operator is the header's still: the store, the operator small under it.
      const op = parse(r().chatHeaderHtml({ online: true, prechat: true, operator: { name: 'مهدی', online: true } }));
      expect(op.querySelector('.hn')!.textContent).toBe('فروشگاه نیلوفر');
      expect(op.querySelector('.hs')!.textContent).toBe('مهدی');
      expect(avatarFace(op.querySelector('.who .av'))).toBe('person');
      // Nobody listed online (the workspace is): the store's tile, never an
      // offline face with a green dot.
      const none = parse(make({ capabilities: SERVED, config: { teamMembers: [{ name: 'رضا', online: false }] } })
        .chatHeaderHtml({ online: true, prechat: true, isNew: true }));
      expect(avatarFace(none.querySelector('.who .av.c4'))).toBe('workspace');
      expect(none.querySelector('.who .av .pr:not(.off)')).not.toBeNull();
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
      // The card names the phone shortly (08·a «موبایل»); the full form keeps «شماره موبایل».
      const phone = (html: string) => parse(html).querySelector('label[for="prechat-phone"]')!.firstChild!.textContent!.trim();
      expect(phone(r().handoffPrechatCardHtml(IDENTITY(['phone']), {}, 'fa', 'sub', false))).toBe('موبایل');
      expect(phone(r().prechatFormHtml(IDENTITY(['phone']), {}, 'fa'))).toBe('شماره موبایل');
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
      // The grid comes with the extras: until they are in, only a hidden
      // mark (Core then keeps the renderer's own grid, not its plain list).
      const bare = parse(FRAME(r())).querySelector('.input-wrap > [data-emoji-picker][hidden]')!;
      expect(bare.innerHTML).toBe('<i data-emoji="" hidden=""></i>');
      expect(bare.querySelector('[data-emoji-tab]')).toBeNull();
      const x = extended(r());
      const h = parse(FRAME(x));
      // The picker opens inside the composer's box.
      const picker = h.querySelector('.input-wrap > [data-emoji-picker][hidden]')!;
      // Core puts in the same grid when the extras come after the frame (runtime-ext.js).
      expect(picker.innerHTML).toBe(parse(x.emojiPickerHtml()).innerHTML);
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
      expect(avatarFace(row.querySelector('.av'))).toBe('person');
      // No operator yet: the workspace, its storefront on the reserved tile.
      const ws = parse(r().conversationRowHtml({ id: 'c', status: 'resolved', preview: 'x' }, false));
      expect(ws.querySelector('.l1 .nm')!.textContent).toBe('فروشگاه نیلوفر');
      expect(avatarFace(ws.querySelector('.av.c4'))).toBe('workspace');
      // History rows are all finished: no open / resolved pill.
      expect(ws.querySelector('.tg')).toBeNull();
    },
    chatMenu: () => {
      // The ⋯ comes with the extras and only for a list Core passes (`vm.menu`).
      const vm = { online: true, isNew: false, operator: { name: 'سارا', online: true } };
      const menu = { open: false, items: [{ action: 'sound', on: true }] };
      expect(parse(r().chatHeaderHtml({ ...vm, menu })).querySelector('[data-chat-menu-toggle]')).toBeNull();
      expect(parse(extended(r()).chatHeaderHtml(vm)).querySelector('[data-chat-menu-toggle]')).toBeNull();
      const h = parse(extended(r()).chatHeaderHtml({ ...vm, menu }));
      expect(h.querySelector('.cm > [data-chat-menu-toggle][aria-haspopup="menu"]')).not.toBeNull();
      expect(h.querySelector('[data-chat-menu][role="menu"] [data-chat-menu-action="sound"]')).not.toBeNull();
    },
    prechatSteps: () => {
      // The steps come with the extras, through the renderer's own surfaces.
      expect(r().prechatStepBoxHtml({ key: 'name', n: 1, total: 1 })).toBe('');
      const box = parse(extended(r()).prechatStepBoxHtml({ key: 'name', n: 1, total: 2, optional: false, value: '' }));
      expect(box.querySelector('[data-prechat-step="name"] [data-prechat-step-input]')).not.toBeNull();
      expect(parse(extended(r()).prechatStepsHtml({ key: 'name', log: [] })).querySelector('#pq-name')).not.toBeNull();
    },
    queuePosition: () => {
      const q = { metadata: { kind: 'routing_in_queue' }, senderType: 'system', sender: 'operator' };
      const html = extended(r()).messagesHtml({ messages: [msg(q)] }, '', { queue: { at: 0, position: 2, waitMinutes: 3 } });
      expect(parse(html).querySelector('.msg-system-pill')!.textContent).toBe('نفر ۲ در صف · حدود ۳ دقیقه');
    },
    awayThread: () => {
      const html = extended(r()).messagesHtml({ messages: [msg({ sender: 'visitor', senderType: 'contact' })] }, '', { awayReply: { at: 0, status: 'ask' } });
      expect(parse(html).querySelector('.away-reply form [data-fb="email"]')).not.toBeNull();
    },
    // Tested below: the picker's field (extras), the arc (stylesheet), the byline.
    emojiSearch: () => {
      expect(parse(extended(r()).emojiPickerHtml()).querySelector('label.ep-sr[hidden] input[data-emoji-search]')).not.toBeNull();
    },
    dlProgress: () => {
      expect(T1_CSS).toContain('.dl-on .wy-ap-play::after');
      expect(T1_CSS).toContain('.dl-on.msg-att-action::after');
    },
    kbAuthor: () => {
      const h = parse(r().kbArticleHtml({ article: { title: 't', author: 'سارا', readingMinutes: 2, contentHtml: '' } }));
      expect(h.querySelector('.am')!.textContent).toBe('سارا·۲ دقیقه مطالعه');
      expect(avatarFace(h.querySelector('.am .av'))).toBe('person');
    },
    // A close or a resolve (one wording), drawn as t1's day divider with a tick, and the hint under it.
    closedNotice: () => {
      const closed = (md: Record<string, unknown>) => msg({ sender: 'operator', senderType: 'system', body: '', metadata: { kind: 'conversation_closed', ...md } });
      const line = (md: Record<string, unknown>) => parse(extended(r()).messagesHtml({ messages: [closed(md)] }, '', {}));
      const named = line({ agent_name: 'سارا', status: 'closed' });
      expect(named.querySelector('.msg-day.cl span')!.textContent).toBe('سارا گفتگو را به پایان رساند');
      expect(named.querySelector('.msg-day.cl + p.cl-h')!.textContent).toBe('سؤال دیگری دارید؟ همین‌جا بنویسید.');
      expect(line({ agent_name: 'مهدی', status: 'resolved' }).querySelector('.cl span')!.textContent).toBe('مهدی گفتگو را به پایان رساند');
      expect(line({ status: 'closed' }).querySelector('.cl span')!.textContent).toBe('گفتگو به پایان رسید');
      expect(line({ status: 'resolved' }).querySelector('.cl span')!.textContent).toBe('گفتگو به پایان رسید');
      // A long name wraps inside the hairlines, which keep a minimum.
      expect(T1_CSS).toContain('min-width: 16px; height: 1px;');
      // Never a bubble; the next conversation under it gets no second marker.
      const next = parse(extended(r()).messagesHtml({ messages: [closed({ agent_name: 'سارا' }), msg({ sender: 'visitor', senderType: 'contact', threadStart: true })] }, '', {}));
      expect(next.querySelectorAll('.msg-day.cl').length).toBe(1);
      expect(next.textContent).not.toContain('گفتگوی جدید');
      expect(T1_CSS).toContain('.messages > .cl-h:last-child { display: block; }');
    },
    // One conversation: history is read-only, its bar (the composer locked, in its shape) leads
    // to the current one; the ⋯ offers history; a past thread's header shows who and when, no presence.
    pastChats: () => {
      expect(r().pastBarHtml({ current: true })).toBe('');
      const bar = (vm: Record<string, unknown>) => parse(extended(r()).pastBarHtml(vm));
      const go = bar({ current: true, online: true });
      expect(go.querySelector('[data-past-bar].ro > .cbox > .cmp-lock > span')!.textContent).toBe('این گفتگو به پایان رسیده و فقط خواندنی است');
      // A link where send sits, never the send glyph; no button while a conversation is current.
      const link = go.querySelector('.cbox > button.more[data-chat-current]')!;
      expect(link.textContent).toBe('گفتگوی فعلی');
      expect(link.querySelector('svg.mir')).not.toBeNull();
      expect(go.querySelector('.btn')).toBeNull();
      const start = bar({ current: false, online: true });
      expect(start.querySelector('.cbox [data-chat-current]')).toBeNull();
      expect(start.querySelector('[data-past-bar] > button.btn.btn-p[data-chat-current]')!.textContent).toBe('شروع گفتگو');
      expect(bar({ current: false, online: false }).querySelector('[data-chat-current]')!.textContent).toBe(FA.homeLeaveMessage);
      const h = parse(extended(r()).chatHeaderHtml({ online: true, menu: { open: true, items: [{ action: 'history' }, { action: 'sound', on: true }] } }));
      const item = h.querySelector('[data-chat-menu] > [data-chat-menu-action="history"][role="menuitem"]')!;
      expect(item.textContent).toBe('گفتگوهای قبلی');
      expect(item.querySelector('.nb')).toBeNull();
      // Unseen answers there: their count on the item.
      const counted = parse(extended(r()).chatHeaderHtml({ online: true, menu: { open: true, items: [{ action: 'history', n: 120 }] } }));
      expect(counted.querySelector('[data-chat-menu-action="history"] .nb')!.textContent).toBe('۹۹+');
      expect(T1_CSS).toContain('.menu .nb { flex: none; min-width: 20px; }');
      const past = parse(r().chatHeaderHtml({ online: true, past: true, when: 'دیروز', operator: { name: 'مهدی', online: true } }));
      expect(past.querySelector('.who .pr')).toBeNull();
      expect(past.querySelector('.hs')!.textContent).toBe('مهدی · دیروز');
      expect(parse(r().chatHeaderHtml({ online: true, operator: { name: 'مهدی', online: true } })).querySelector('.who .pr')).not.toBeNull();
    },
  };

  it('declares exactly the behaviours it implements', () => {
    expect(Object.keys(r().features).sort()).toEqual(Object.keys(checks).sort());
    expect(Object.values(r().features).every((v) => v === true)).toBe(true);
    // A Core that does not serve them gets none of the late pre-chat, queue and away behaviours.
    const off = make({ capabilities: NO_CAPS }).features;
    for (const f of ['prechatSteps', 'queuePosition', 'awayThread', 'emojiSearch', 'dlProgress', 'kbAuthor']) expect(off[f], f).toBe(false);
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
    // Even a Core that says yes gets nothing: this renderer implements none of
    // them (an AI answer about an order is its text, nothing else).
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
      expect(root.querySelector('.card, .steps, .react, .csat, .faces, [data-csat-rate], [data-react], [data-msg-react], .tray, [data-kb-suggest], [data-prechat-step]')).toBeNull();
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
    // Its own late surfaces are in its extras, never in the renderer itself.
    expect(T1_SRC).not.toMatch(/data-csat|data-react|data-msg-react|data-order|data-kb-suggest|data-prechat-step|data-fb-skip/);
    expect(T1_X_SRC).not.toMatch(/data-csat|data-react|data-msg-react|data-order|data-kb-suggest/);
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
      ['wy-view-list', 'ttl', 'wy-head-list', 'bk', 'wy-list-scroll', 'pw']],
    ['help', () => r().skeletonHtml('help', { rtl: true }), () => r().kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }] }),
      ['wy-view-kb', 'kb-top', 'ttl', 'kb-search', 'wy-kb-scroll', 'kb-res', 'cd', 'ls', 'li', 'wy-tabs', 'pw']],
    ['article', () => r().skeletonHtml('article', { rtl: true }),
      () => r().kbHtml({ state: 'article', article: { title: 'A', contentHtml: '' }, feedback: { enabled: true } }),
      ['wy-view-kb', 'kb-art', 'hd', 'wy-head-article', 'art', 'kb-article-body', 'kb-feedback', 'kb-rate', 'ask', 'pw']],
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
      // The uncustomised accent: the stylesheet's brand colour, by class.
      expect(root.classList.contains('gs-accent-brand')).toBe(true);
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

  it('keep the article\'s ask card exactly when the real view draws it (the feedback bar does not jump)', () => {
    const real = (x: Renderer) => parse(x.kbHtml({ state: 'article', article: { title: 'A', contentHtml: '' }, feedback: { enabled: true } }));
    expect(parse(r().skeletonHtml('article', {})).querySelector('.cd.ask')).not.toBeNull();
    expect(real(r()).querySelector('.cd.ask')).not.toBeNull();
    const off = make({ config: { features: { chat: false, knowledgeBase: true } } });
    expect(parse(off.skeletonHtml('article', {})).querySelector('.cd.ask')).toBeNull();
    expect(real(off).querySelector('.cd.ask')).toBeNull();
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
    expect(tabName(home, 'chat')).toBe('گفتگو ۱۲');
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

  it('counts articles in English without a wrong plural ("1 articles")', () => {
    const count = (n: number) => parse(make({ locale: 'en' }).kbHtml({ state: 'list', articles: [], categories: [{ id: 'c', name: 'N', count: n }] }))
      .querySelector('.l3')!.textContent;
    expect(count(1)).toBe('Articles: 1');
    expect(count(3)).toBe('Articles: 3');
  });
});

describe('t1: accent tokens', () => {
  const styleOf = (r: Renderer) => parse(r.homeHtml({ rtl: true, isOnline: true })).firstElementChild!.getAttribute('style')!;

  it('leaves an uncustomised or unparseable colour to the stylesheet: no inline accent, the class gs-accent-brand', () => {
    for (const c of ['', '#3B82F6', '#3b82f6', 'not-a-colour', 'red;background:url(x)', '#12345']) {
      const r = make({ primaryColor: c });
      const home = parse(r.homeHtml({ rtl: true, isOnline: true })).firstElementChild!;
      expect(home.getAttribute('style'), c).toBe('');
      expect(home.classList.contains('gs-accent-brand'), c).toBe(true);
      const close = parse(r.shellHtml({})).querySelector('[data-panel-close]')!;
      expect(close.getAttribute('style'), c).toBe('');
      expect(close.classList.contains('gs-accent-brand'), c).toBe(true);
    }
    // The brand's own colour and hand-tuned hero, in the stylesheet (and so
    // in a skin over it); the hero also for the brand colour picked
    // explicitly, found by the inline `--a` the renderer writes first.
    expect(T1_CSS).toContain(".wy-view.gs-accent-brand, .panel-close.gs-accent-brand { --a: #0B7D6C; --a-rgb: 11, 125, 108; --gs-primary: #0B7D6C; }");
    expect(T1_CSS).toContain(".wy-view.gs-accent-brand, .wy-view[style*='--a:#0b7d6c;' i] { --hero: linear-gradient(155deg, #1DB99D 0%, #0F927D 46%, #0B7D6C 100%); }");
  });

  it('writes a chosen colour inline, `--a` first with its `;` (what the stylesheets match), and no class', () => {
    for (const [c, a] of [['#0B7D6C', '#0b7d6c'], ['#16142B', '#16142b'], ['#2F5BFF', '#2f5bff']]) {
      const html = make({ primaryColor: c }).homeHtml({ rtl: true, isOnline: true });
      const root = parse(html).firstElementChild!;
      expect(root.getAttribute('style')!.startsWith(`--a:${a};`), c).toBe(true);
      expect(root.classList.contains('gs-accent-brand'), c).toBe(false);
      expect(root.getAttribute('style'), c).not.toContain('--hero');
    }
    // No brand colour or hero in the renderer's code: its stylesheet (or a skin) has them.
    const code = T1_SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/0b7d6c|1db99d|0f927d/i);
  });

  it('uses the workspace colour, with white or ink on it by contrast', () => {
    expect(styleOf(make({ primaryColor: '#7c3aed' }))).toBe('--a:#7c3aed;--a-rgb:124,58,237;--gs-primary:#7c3aed');
    expect(styleOf(make({ primaryColor: '#111827' }))).not.toContain('--on-a');
    // A light accent also darkens itself where it is text or an icon on white (`--dk`).
    const ink = ';--on-a:#16142B;--on-a-2:rgba(22,20,43,.78);--on-a-sf:rgba(22,20,43,.08);--dk:50%';
    expect(styleOf(make({ primaryColor: '#FFEB3B' }))).toBe('--a:#ffeb3b;--a-rgb:255,235,59;--gs-primary:#ffeb3b' + ink);
    expect(styleOf(make({ primaryColor: '#fc0' }))).toBe('--a:#ffcc00;--a-rgb:255,204,0;--gs-primary:#ffcc00' + ink);
  });

  it('puts white on a mid-tone accent, darkened until white reads on it (owner, 2026-10-18: webyar.ai, respok.app)', () => {
    // Ink on #8B5CF6 was 4.24:1 and on #EF4444 4.77:1, and neither read; white on them is 4.23 / 3.76:1.
    expect(styleOf(make({ primaryColor: '#8B5CF6' }))).toBe('--a:#7d53df;--a-rgb:125,83,223;--gs-primary:#7d53df');
    expect(styleOf(make({ primaryColor: '#EF4444' }))).toBe('--a:#cb3939;--a-rgb:203,57,57;--gs-primary:#cb3939');
    // A light accent past L 0.30 keeps itself and Ink (#F97316, L 0.325).
    expect(styleOf(make({ primaryColor: '#F97316' }))).toMatch(/^--a:#f97316;--a-rgb:249,115,22;--gs-primary:#f97316;--on-a:#16142B;/);
  });

  it('over the colour space: white ≥ 5:1 on `--a`, Ink about 6:1, and `--a` the chosen colour unless it is a mid tone', () => {
    const lum = (hex: string) => {
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const ratio = (x: string, y: string) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
    const steps = [0, 36, 73, 109, 146, 182, 219, 255];
    let seen = 0;
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const c = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
      const [, a, rgb, rest] = /^--a:(#[0-9a-f]{6});--a-rgb:(\d+,\d+,\d+);--gs-primary:\1(.*)$/.exec(styleOf(make({ primaryColor: c })))!;
      expect(rgb, c).toBe([1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)).join(','));
      if (!rest) expect(ratio('#ffffff', a), c).toBeGreaterThanOrEqual(5);
      // Ink only past L 0.30: 0.35 / (0.0085 + 0.05) = 5.99:1 at the edge.
      else expect([rest.slice(0, 15), ratio('#16142b', a) > 5.98], c).toEqual([';--on-a:#16142B', true]);
      const L = lum(c);
      if (L <= 0.16 || L > 0.3) expect(a, c).toBe(c);
      seen++;
    }
    expect(seen).toBe(512);
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
  it('the workspace tile wears the brand tint, and its storefront stays a mask in the tile\'s ink', () => {
    // Both halves, so a later merge cannot drop either (t1 polish, approved 2026-10-24; the avatar rule).
    expect(T1_CSS).toContain('.c4 { background: var(--a-2); color: var(--a-ink); }');
    expect(T1_CSS).toMatch(/\.av\.c4:not\(\.has-img\)::before,\s*\.logo:not\(\.has-img\)::before \{[^}]*mask-image: var\(--wy-workspace\)/);
  });

  it('writes dir on every view root (rtl for fa, ltr otherwise)', () => {
    expect(parse(make().homeHtml({ rtl: true })).firstElementChild!.getAttribute('dir')).toBe('rtl');
    expect(parse(make({ locale: 'en' }).kbHtml({ rtl: false })).firstElementChild!.getAttribute('dir')).toBe('ltr');
    expect(parse(make({ locale: 'tr' }).chatFrameHtml({ chatEnabled: true, locale: 'tr', config: BASE_CONFIG })).firstElementChild!.getAttribute('dir')).toBe('ltr');
  });

  it('draws a person as a photo when there is one, else the silhouette; the workspace as its logo or storefront, never a letter', () => {
    const r = make({ config: { logoUrl: 'https://cdn.test/logo.png' } });
    const h = parse(r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
    expect(h.querySelector('.hx-top .logo img')!.getAttribute('src')).toBe('https://cdn.test/logo.png');
    // The team card: who is online first (or everyone), one colour each.
    expect(avatarFaces(h.querySelectorAll('.team .avs .av'))).toEqual(['person']);
    const all = parse(make({ config: { teamMembers: [{ name: 'سارا' }, { name: 'مهدی' }, { name: 'رضا' }] } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
    expect(Array.from(all.querySelectorAll('.team .avs .av')).map((a) => a.className.split(' ')[2])).toEqual(['c1', 'c2', 'c3']);
    const noLogo = parse(make({ config: { showLogo: false, logoUrl: 'https://cdn.test/logo.png' } }).homeHtml({ rtl: true, isOnline: true }));
    expect(noLogo.querySelector('.logo')).toBeNull();
    expect(avatarFace(parse(make().homeHtml({ rtl: true, isOnline: true })).querySelector('.hx-top .logo[aria-hidden="true"]'))).toBe('workspace');
    const photo = parse(make().chatHeaderHtml({ online: true, operator: { name: 'سارا', avatar: 'https://cdn.test/s.png', online: true } }));
    expect(photo.querySelector('.who .av img')!.getAttribute('src')).toBe('https://cdn.test/s.png');
    expect(make({ config: { teamMembers: [{ name: 'سارا', online: true }] } }).homeHtml({ rtl: true, isOnline: true, chatEnabled: true, showTeamAvatars: false }))
      .not.toContain('class="avs');
    // The same person keeps one colour on every surface.
    const thread = parse(make().messagesHtml({ messages: [msg({ senderName: 'سارا' })] }, '', {}));
    expect(thread.querySelector('.msg-avatar')!.classList.contains('c1')).toBe(true);
    // The bar names who answers: the thread's first run carries no name.
    expect(thread.querySelector('.msg-sender-label')).toBeNull();
  });

  it('never draws a letter for a person or the workspace, whatever the name holds (owner, 2026-10-24)', () => {
    // An RLM pasted before a Persian name, a ZWNJ, a lone combining mark, a
    // BOM: once the tile's letter; now every one is the silhouette.
    const names = ['\u200Fسارا', '\u200C\u200Fمهدی', '\u0651رضا'];
    const team = parse(make({ config: { teamMembers: names.map((name) => ({ name, online: true })) } })
      .homeHtml({ rtl: true, isOnline: true, chatEnabled: true }));
    expect(avatarFaces(team.querySelectorAll('.team .avs .av'))).toEqual(['person', 'person', 'person']);
    const head = parse(make().chatHeaderHtml({ online: true, operator: { name: ' \uFEFFali', online: true } }));
    expect(avatarFace(head.querySelector('.who .av'))).toBe('person');
    // A name of marks only, or none: the workspace's storefront all the same.
    for (const workspaceName of ['\u200F\u200C', '', 'Nilufar']) {
      const home = parse(make({ config: { workspaceName } }).homeHtml({ rtl: true, isOnline: true }));
      expect(avatarFace(home.querySelector('.hx-top .logo')), workspaceName).toBe('workspace');
    }
  });

  it('never labels a run (the server\'s join line names who comes in), and gives every run its avatar and receipts', () => {
    const joinWords = (k: string) => (k === 'routingAgentJoined' ? '{name} به گفتگو پیوست' : FA[k] ?? k);
    const draw = (messages: Vm[]) => parse(make({ t: joinWords }).messagesHtml({ messages }, '', {}));
    const labels = (messages: Vm[]) => {
      const t = draw(messages);
      expect(t.innerHTML).not.toContain('msg-sender-label');
      return Array.from(t.querySelectorAll('.msg-sender-label')).map((l) => l.textContent);
    };
    const sara = (body: string, over: Vm = {}) => msg({ senderName: 'سارا', body, ...over });
    const mehdi = (body: string) => msg({ senderName: 'مهدی', body });
    const visitor = (body: string) => msg({ sender: 'visitor', senderType: 'contact', body, status: 'seen' });
    const ai = (body: string) => msg({ senderType: 'ai', senderName: 'دستیار', body });
    const joined = (name: string) => msg({ senderType: 'system', senderName: null, body: name + ' joined the conversation.',
      metadata: { kind: 'routing_agent_joined', agent_name: name } });
    // One operator all along.
    expect(labels([sara('1'), sara('2'), visitor('3'), sara('4')])).toEqual([]);
    // The AI hands over to a person, and a person to another (owner,
    // 2026-10-23: no name over a run in any template), with or without the
    // join line before them.
    expect(labels([ai('1'), visitor('2'), sara('3'), visitor('4'), sara('5')])).toEqual([]);
    expect(labels([ai('1'), visitor('2'), joined('سارا'), sara('3'), visitor('4'), sara('5')])).toEqual([]);
    expect(labels([sara('1'), visitor('2'), mehdi('3'), mehdi('4')])).toEqual([]);
    expect(labels([sara('1'), visitor('2'), joined('مهدی'), mehdi('3'), mehdi('4')])).toEqual([]);
    // A day break or a system row changes nothing.
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    expect(labels([sara('1', { time: yesterday }), visitor('2'), sara('3')])).toEqual([]);
    expect(labels([sara('1'), msg({ senderType: 'system', senderName: null, body: 'x', metadata: { kind: 'routing_agent_joined' } }), sara('2')])).toEqual([]);
    // The join line is what names the newcomer, right above their first bubble.
    const handover = draw([ai('1'), visitor('2'), joined('سارا'), sara('3'), visitor('4'), joined('مهدی'), mehdi('5')]);
    const pills = Array.from(handover.querySelectorAll('.msg-row.system'));
    expect(pills.map((p) => p.textContent)).toEqual(['سارا به گفتگو پیوست', 'مهدی به گفتگو پیوست']);
    expect(pills.map((p) => p.nextElementSibling!.querySelector('.msg-text')!.textContent)).toEqual(['3', '5']);

    const t = parse(make().messagesHtml({ messages: [
      sara('1'), sara('2'), msg({ sender: 'visitor', senderType: 'contact', body: '3', status: 'seen' }),
      msg({ senderType: 'ai', senderName: 'دستیار', body: '4' }),
      msg({ sender: 'visitor', senderType: 'contact', body: '5', status: 'failed', localId: 'l9' }),
    ] }, '', {}));
    expect(t.querySelectorAll('.msg-sender-label').length).toBe(0);
    expect(t.querySelectorAll('.msg-row.operator .msg-avatar:not(.msg-avatar-spacer)').length).toBe(2);
    expect(t.querySelectorAll('.msg-avatar-spacer').length).toBe(1);
    expect(t.querySelector('.msg-row.visitor .msg-ticks.is-seen')).not.toBeNull();
    const failed = t.querySelector('.msg-row.visitor.is-failed')!;
    expect(failed.querySelector('.msg-ticks.is-failed')!.textContent).toBe('ارسال نشد');
    expect(failed.querySelector('[data-msg-retry="l9"]')!.textContent).toBe('تلاش دوباره');
    expect(t.innerHTML).not.toMatch(/style="background/);
  });

  it('marks an AI reply with the sparkle, read as the word for the AI, then its own name and the time', () => {
    const meta = (senderName: string | null, t?: (k: string) => string) => parse(make({ t })
      .messagesHtml({ messages: [msg({ senderType: 'ai', senderName, body: 'سلام' })] }, '', {})).querySelector('.msg-meta')!;
    // The owner, 2026-10-23: the icon instead of the text «هوش مصنوعی».
    const fa = meta('هوشمند', (k) => (k === 'wyAiShort' ? 'هوش مصنوعی' : FA[k] ?? k));
    const badge = fa.querySelector('.msg-ai-badge[role="img"]')!;
    expect(badge.getAttribute('aria-label')).toBe('هوش مصنوعی');
    expect(badge.textContent).toBe('');
    expect(badge.querySelectorAll('svg')).toHaveLength(1);
    expect(badge.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(badge.nextElementSibling!.className).toBe('msg-sender');
    expect(badge.nextElementSibling!.textContent).toBe('هوشمند');
    expect(badge.nextElementSibling!.nextElementSibling!.className).toBe('msg-time');
    expect(fa.textContent).not.toContain('هوش مصنوعی');
    // No word in the dictionary: the English one. No name: the time comes next.
    const bare = meta(null);
    expect(bare.querySelector('.msg-ai-badge')!.getAttribute('aria-label')).toBe('AI');
    expect(bare.querySelector('.msg-sender')).toBeNull();
    expect(bare.querySelector('.msg-ai-badge')!.nextElementSibling!.className).toBe('msg-time');
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
    // A sent message reads «… · ارسال شد» while away.
    // The thread starts at the top, under the banner when it shows (owner,
    // 2026-10-23): nothing pushes it, or its skeleton, to the bottom.
    expect(T1_CSS).not.toMatch(/margin-top: auto/);
    expect(T1_CSS).not.toMatch(/\.wy-sk-msgs \{[^}]*flex-end/);
    expect(T1_CSS).toContain(".wy-view-chat:has(.away) .msg-ticks[role='img']:not(.is-seen)::before { content: '· ' attr(aria-label); }");
  });

  it('says when the team is back as the design does: the hour and the part of the day, minutes only when not :00; its day past today', () => {
    // Sunday 18 October 2026, 05:30 in Tehran (and early that day for the visitor's own clock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 2, 0)));
    const tehran = (hh: number, mm: number, day = 18) => new Date(Date.UTC(2026, 9, day, hh, mm) - 210 * 60_000).toISOString();
    const status = (iso: string, locale = 'fa') => parse(make({ locale, config: { availability: { state: 'offline', next_open_at: iso } } })
      .homeHtml({ rtl: locale === 'fa', isOnline: false, chatEnabled: true })).querySelector('.team .cs')!.textContent;
    expect(status(tehran(9, 0))).toBe('از ساعت ۹ صبح پاسخ می‌دهیم');
    expect(status(tehran(9, 30))).toBe('از ساعت ۹:۳۰ صبح پاسخ می‌دهیم');
    // Tomorrow, and further away its weekday (a Thursday evening's «from Saturday»).
    expect(status(tehran(9, 0, 19))).toBe('از فردا ساعت ۹ صبح پاسخ می‌دهیم');
    expect(status(tehran(9, 0, 24))).toBe('از شنبه ساعت ۹ صبح پاسخ می‌دهیم');
    // Other languages read the visitor's own clock.
    vi.setSystemTime(new Date(2026, 9, 18, 1, 0));
    expect(status(new Date(2026, 9, 18, 9, 0).toISOString(), 'en')).toBe('We reply from 9 in the morning');
    expect(status(new Date(2026, 9, 19, 9, 0).toISOString(), 'en')).toBe('We reply from 9 in the morning tomorrow');
  });
});

afterEach(() => { vi.useRealTimers(); });

describe('t1: the workspace\'s reply-time note', () => {
  const lines = (replyTimeText: unknown) => {
    const r = make({ config: { replyTimeText } });
    const text = (html: string, sel: string) => parse(html).querySelector(sel)!.textContent;
    return {
      header: text(r.chatHeaderHtml({ online: true, operator: null, isNew: false }), '.hs'),
      team: text(r.homeHtml({ rtl: true, isOnline: true, chatEnabled: true }), '.team .cs'),
      welcome: text(r.emptyHtml({}), '.wel p.on'),
    };
  };

  it('the empty thread carries both status lines; the chat header\'s live presence picks one (Core repaints only the header)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 2, 0)));
    const next = new Date(Date.UTC(2026, 9, 18, 5, 30)).toISOString();
    const wel = parse(make({ config: { availability: { state: 'online', next_open_at: next } } }).emptyHtml({})).querySelector('.wel')!;
    expect(wel.querySelector('p.on .live:not(.off)')).not.toBeNull();
    expect(wel.querySelector('p.off .live.off')).not.toBeNull();
    expect(wel.querySelector('p.off')!.textContent).toBe('از ساعت ۹ صبح پاسخ می‌دهیم');
    // Each rule of its own: a browser without :has() keeps `.wel > .off` hidden (templateRules.test.ts).
    expect(T1_CSS).toContain('.wel > .off { display: none; }');
    expect(T1_CSS).toContain('.wy-view-chat:has(.away) .wel > .on { display: none; }');
    expect(T1_CSS).toContain('.wy-view-chat:has(.away) .wel > .off { display: flex; }');
  });

  it('a written note replaces the template\'s own everywhere', () => {
    const n = 'معمولاً تا ۲ ساعت';
    expect(lines(n)).toEqual({ header: 'آنلاین · ' + n, team: 'آنلاین · ' + n, welcome: n });
  });

  it('a cleared note (\'\') is left out, never replaced by a default (migration 069: \'\' hides the line)', () => {
    const online = { header: 'آنلاین', team: 'آنلاین', welcome: 'آنلاین' };
    expect(lines('')).toEqual(online);
    expect(lines('   ')).toEqual(online);
  });

  it('the thread\'s away banner adds the note the workspace wrote after when the team is back (07·09), never the template\'s own', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 2, 0)));
    const nine = new Date(Date.UTC(2026, 9, 18, 9, 0) - 210 * 60_000).toISOString();
    const ban = (replyTimeText: unknown, next: string | null = nine) => parse(make({ config: { replyTimeText, availability: { state: 'offline', next_open_at: next } } })
      .messagesHtml({ messages: [msg({})] }, '', {})).querySelector('.ban-row small')!.textContent;
    expect(ban('معمولاً تا ۲ ساعت')).toBe('از ساعت ۹ صبح پاسخ می‌دهیم · معمولاً تا ۲ ساعت');
    expect(ban('')).toBe('از ساعت ۹ صبح پاسخ می‌دهیم');
    expect(ban(null)).toBe('از ساعت ۹ صبح پاسخ می‌دهیم');
    expect(ban('معمولاً تا ۲ ساعت', null)).toBe('به‌محض بازگشت پاسخ می‌دهیم · معمولاً تا ۲ ساعت');
  });

  it('a note never written reads the template\'s copy (Core\'s longer one in the welcome)', () => {
    expect(lines(null)).toEqual({
      header: 'آنلاین · پاسخ در چند دقیقه', team: 'آنلاین · پاسخ در چند دقیقه', welcome: 'معمولاً در چند دقیقه پاسخ می‌دهیم',
    });
  });
});

describe('t1: the leave-a-message form', () => {
  const ID = IDENTITY(['name', 'email']);
  const next = new Date(Date.now() + 9 * 3600_000).toISOString();

  it('says the team is away only when it is (Core also opens it when the monthly chat quota is full)', () => {
    const r = make({ config: { availability: { state: 'offline', next_open_at: next } } });
    const away = parse(r.contactFallbackHtml(ID, {}, 'fa', { status: 'offline', liveChatEnabled: true }));
    expect(away.querySelector('.hs')!.textContent).toBe('آفلاین · پاسخ همین‌جا');
    expect(away.querySelector('.ban b')!.textContent).toBe('تیم ما الان آفلاین است');
    expect(away.querySelector('.who .pr.off')).not.toBeNull();
    // Quota full while the team is online: Core's quota wording, no offline claim.
    const quota = parse(make().contactFallbackHtml(ID, {}, 'fa', { status: 'online', liveChatEnabled: true, introLabel: 'سقف گفتگوهای این ماه پر شده' }));
    expect(quota.querySelector('.ban')).toBeNull();
    expect(quota.querySelector('.hs')!.textContent).toBe('پیام بگذارید');
    expect(quota.querySelector('.who .pr:not(.off)')).not.toBeNull();
    expect(quota.querySelector('.prechat-intro')!.textContent).toBe('سقف گفتگوهای این ماه پر شده');
    expect(quota.textContent).not.toContain('آفلاین');
    // Live chat switched off by the team reads as away; no presence at all (older callers) too.
    expect(parse(make().contactFallbackHtml(ID, {}, 'fa', { status: 'online', liveChatEnabled: false })).querySelector('.ban')).not.toBeNull();
    expect(parse(make().contactFallbackHtml(ID, {}, 'fa')).querySelector('.ban')).not.toBeNull();
  });
});

describe('t1: chat switched off', () => {
  const ART = { state: 'article', article: { title: 'A', contentHtml: '' }, feedback: { enabled: true } };

  it('draws no "switch to chat" control in the help views: Core ignores it there (runtime.js onSwitchToChat)', () => {
    const off = make({ config: { features: { chat: false, knowledgeBase: true } } });
    for (const html of [off.kbHtml(ART), off.kbEmptyHtml({}), off.kbHtml({ state: 'results', query: 'x', results: [] }), off.kbHtml({ state: 'list' })]) {
      expect(parse(html).querySelector('[data-kb-action="switch-chat"]')).toBeNull();
    }
    // On, or never said (the dashboard preview sends no features): drawn.
    for (const features of [{ chat: true }, {}, undefined]) {
      const on = make({ config: { features } });
      expect(parse(on.kbHtml(ART)).querySelector('.cd.ask[data-kb-action="switch-chat"]'), JSON.stringify(features)).not.toBeNull();
      expect(parse(on.kbEmptyHtml({})).querySelector('[data-kb-action="switch-chat"]')).not.toBeNull();
    }
  });

  it('home, messages and the chat view draw no chat control when Core says chat is off', () => {
    const r = make({ config: { features: { chat: false } } });
    const home = parse(r.homeHtml({ rtl: true, isOnline: true, chatEnabled: false, kbEnabled: true, conversations: [{ id: 'c', preview: 'p' }] }));
    expect(home.querySelector('[data-home-action="chat"]')).toBeNull();
    expect(home.querySelector('[data-conversation-open="c"]')).not.toBeNull();
    expect(parse(r.conversationListHtml({ conversations: [], chatEnabled: false })).querySelector('[data-home-action="chat"]')).toBeNull();
    const frame = parse(r.chatFrameHtml({ chatEnabled: false, locale: 'fa', config: BASE_CONFIG }));
    expect(frame.querySelector('[data-msg-input], [data-send-btn], [data-chat-jump], [data-composer-zone]')).toBeNull();
    expect(frame.querySelector('[data-chat-messages]')).not.toBeNull();
    expect(parse(r.skeletonHtml('chat', { chatEnabled: false })).querySelector('.composer-zone')).toBeNull();
  });
});

describe('t1: a sparse or odd configuration never throws', () => {
  const configs: Array<Vm | undefined> = [
    undefined, {}, { workspaceName: '', teamMembers: null }, { teamMembers: 'x' }, { teamMembers: [null, 1, 'a', {}, { name: 5 }, { name: '' }] },
    { templateOptions: 'x' }, { templateOptions: { navStyle: 5, navMode: {}, topics: 'x' } }, { availability: { state: 'offline', next_open_at: 'garbage' } },
    { aiAgent: { suppressGreeting: true } }, { welcomeMessage: 5, replyTimeText: 5 }, { poweredBy: { brand: 5, text: 5, url: 5, logo: 5 } },
    { attachments: null, composer: null, readReceipts: null, features: null }, { logoUrl: 5 }, { calendar: 'gregorian', timeZone: 'Bad/Zone' },
    { showLogo: false, showPoweredBy: false, features: { chat: false, knowledgeBase: false } },
  ];
  const ID = IDENTITY(['name', 'email', 'phone']);
  const surfaces = (r: Renderer) => [
    r.shellHtml(), r.chatFrameHtml(), r.chatFrameHtml({ chatEnabled: true, config: {} }), r.chatHeaderHtml(), r.chatHeaderHtml({ operator: {} }),
    r.homeHtml(), r.homeHtml({ conversations: [{}], chatEnabled: true, kbEnabled: true, teamMembers: 'x', smartSurface: { mode: 'home_card' } }),
    r.homeHtml({ chatEnabled: true, isOnline: false }), r.emptyHtml(), r.emptyHtml({ topics: [null, 'x', { label: 5 }], qna: {}, operatorTyping: {} }),
    r.messagesHtml({}), r.messagesHtml({ messages: [{}, { sender: 'visitor' }, { senderType: 'system', metadata: { kind: 'call_invitation' } },
      { senderType: 'system', metadata: { kind: 'call_ended' } }, { attachment: {} }, { attachment: { id: 'x' } }, { body: 5 }, { time: 'bad' }] }, '', {}),
    r.aiThinkingRowHtml(), r.qnaChipsHtml(), r.messageAttachmentHtml(), r.callInvitationCardHtml({}), r.callEndedRowHtml({}),
    r.routingOutcomeRowHtml({}), r.prechatFieldRowHtml(ID, 'name', 'text', undefined), r.prechatFormHtml(ID), r.handoffPrechatCardHtml(ID),
    r.prechatSummaryHtml(), r.contactFallbackHtml(ID), r.smartSurfaceHtml({}), r.conversationListHtml(), r.conversationRowHtml(),
    r.kbHtml(), ...['article', 'category', 'results', 'searching', 'list', 'zzz'].map((state) => r.kbHtml({ state })),
    r.kbHtml({ state: 'list', categories: [null, {}, { id: 'a', count: 2 }] }), r.kbHtml({ state: 'article', article: { updatedAt: 'x' } }),
    r.kbSearchBarHtml(), r.kbHomeHtml(), r.kbSearchResultsHtml(), r.kbArticleHtml(), r.kbEmptyHtml(), r.kbLoadingHtml(), r.kbArticleFeedbackHtml(),
    ...['home', 'chat', 'list', 'help', 'article', 'prechat', 'x'].map((v) => r.skeletonHtml(v)), r.connIndicatorHtml(),
  ];

  for (const config of configs) {
    it(JSON.stringify(config) ?? 'no config', () => {
      for (const locale of ['fa', 'en', 'tr', undefined, 'FA-ir']) {
        const w = window as unknown as Record<string, { create: (env?: Vm) => Renderer }>;
        const r = w.__gs_presentation_t1.create({ config, locale });
        for (const html of surfaces(r)) {
          expect(typeof html).toBe('string');
          expect(parse(html).textContent).not.toMatch(/undefined|NaN|\[object Object\]/);
        }
      }
    });
  }

  it('without any environment at all', () => {
    const w = window as unknown as Record<string, { create: (env?: Vm) => Renderer }>;
    expect(() => surfaces(w.__gs_presentation_t1.create())).not.toThrow();
  });
});

describe('t1: stylesheet details', () => {
  it('mirrors in LTR: no physical side for an inline margin or padding', () => {
    expect(T1_CSS).not.toMatch(/(margin|padding)-(left|right)\s*:/);
    expect(T1_CSS).toContain('.msg.att-file { padding: 10px; padding-inline-end: 12px; }');
  });

  it('painted without Core\'s module (`.ext-off`), sets the home search aside and keeps the articles', () => {
    expect(T1_CSS).toContain('.ext-off .cd.hc .sr { display: none; }');
    expect(T1_CSS).toContain('.ext-off .cd.hc:not(:has(.ls)) { display: none; }');
  });

  it('sets the emoji button aside without Core\'s module or once its extras failed (its grid is in them)', () => {
    expect(T1_CSS).toContain('.ext-off .emoji-btn, .emoji-btn[hidden] { display: none; }');
  });

  it('rings a focused text field in the darkened accent (a light accent such as #F5D90A is ~1.4:1 on white)', () => {
    for (const sel of ['.sr:focus-within', '.cbox:focus-within', '.inp:focus']) {
      const rule = T1_CSS.split('\n').find((l) => l.startsWith(sel + ' {'))!;
      expect(rule).toMatch(/1\.5px var\(--a-tx\)/);
    }
  });

  it('keeps a readable, shaped focus ring outside the views (no accent tokens there)', () => {
    expect(T1_CSS).toContain('.att-lightbox :focus-visible, .gs-call-host :focus-visible { outline-color: #fff; }');
    expect(T1_CSS).toMatch(/\.att-lightbox-close:focus-visible, \.gs-call-btn:focus-visible, \.gs-call-size:focus-visible \{ border-radius: 50%; \}/);
    expect(T1_CSS).toContain('.smart-nudge :focus-visible { outline-color: var(--a-tx); }');
  });

  it('keeps reply and copy (Core\'s quote-reply) reachable on touch screens: shown for the tapped bubble, taps pass through until then', () => {
    expect(T1_CSS).not.toMatch(/\.msg-actions \{ display: none/);
    expect(T1_CSS).toMatch(/@media \(hover: none\) \{\s*\.msg-actions \{ pointer-events: none; \}\s*\.msg-line:hover \.msg-actions, \.msg-actions:focus-within \{ pointer-events: auto; \}/);
    expect(T1_CSS).toContain('.msg-line:hover .msg-actions, .msg-actions:focus-within { opacity: 1; }');
    // Not for a tap on a link or button in the bubble: revealed by it, they
    // made iOS Safari drop its click (the link opened on the second tap).
    expect(T1_CSS).toMatch(/@media \(hover: none\) \{[^}]*\}[^}]*\}[^@]*\.msg-line:has\(> \.msg :is\(a, button\):hover\) \.msg-actions:not\(:focus-within\) \{ opacity: 0; pointer-events: none; \}/);
  });

  it('draws the played part of a voice track without container units too', () => {
    expect(T1_CSS).toContain('.wy-ap-progress::before { width: 100px; width: 100cqw; }');
    expect(T1_CSS).toContain('.vn-progress::before { width: 92px; width: 100cqw; }');
  });

  it('sits the thinking row\'s avatar on its bubble\'s bottom (no time line under it; owner, 2026-10-18)', () => {
    expect(T1_CSS).toContain('.ai-thinking-row .msg-avatar { margin-bottom: 0; }');
  });

  it('draws text on the accent on the accent itself: the sheen ends above the first line', () => {
    for (const sel of ['.btn-p', '.msg.visitor']) {
      const body = T1_CSS.match(new RegExp('^' + sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}', 'm'))![1];
      expect(body, sel).toContain('color: var(--on-a); background: linear-gradient(180deg, var(--a-hi), var(--a) 30%);');
    }
    expect(T1_CSS).not.toContain('var(--a-hi), var(--a) 70%)');
  });

  it('keeps the visitor\'s quote, file and voice lines readable in their bubble: its ink at full strength, a quote on a deeper panel', () => {
    // A white tint under white ink, grey (`--ink-3`) or .92 on the accent fell below 4.5:1.
    expect(T1_CSS).toContain('.msg.visitor .msg-quote { background: rgba(15, 18, 23, .12); }');
    expect(T1_CSS).toMatch(/^\.msg-quote b \{ display: block; font-size: 11\.5px; font-weight: 700; \}$/m);
    expect(T1_CSS).toContain('.msg.visitor .msg-att-sub, .msg.visitor .wy-ap-time { color: inherit; opacity: 1; }');
    // The quote is the bubble's first line, where the sheen is.
    expect(T1_CSS).toContain('.msg.visitor:has(> .msg-quote) { background: var(--a); }');
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
    }
  });

  it('the extras carry their own copy in fa, en and tr, in key order: one name per emoji group', () => {
    const xkeys = (/var COPY_KEYS = '([^']+)'/.exec(T1_X_SRC) || [])[1]!.split(' ');
    expect(xkeys).toEqual([
      'cats', 'emojiSearch', 'emojiNoResults', 'moreOptions', 'menuSound', 'csatTranscript', 'csatTranscriptSent', 'csatTranscriptFailed', 'csatFailed',
      'prechatAskName', 'prechatAskEmail', 'prechatAskEmailNoName', 'prechatAskPhone', 'prechatStep', 'prechatStepSaved',
      'prechatStepEmailInvalid', 'prechatStepEmailExample', 'prechatPhonePhLocal', 'prechatPhoneHint', 'prechatStepSubmit',
      'routingInQueue', 'routingInQueuePosition', 'awayAutoReply', 'fallbackEmailLabel', 'fallbackEmailFormLabel', 'saveEmail',
      'msgAutomated', 'awayRecorded', 'awayReplyTo', 'awayHere',
      'convEndedBy', 'convEnded', 'closedHint', 'pastClosed', 'pastCurrent',
    ]);
    for (const lang of ['fa', 'en', 'tr']) {
      const parts = (new RegExp(`\\n    ${lang}: '([^']*)',`).exec(T1_X_SRC) || [])[1]!.split('|');
      expect(parts.length, lang).toBe(xkeys.length);
      expect(parts[0].split(',').length, lang).toBe(6);
      expect(parts.every((p) => p.trim().length > 0), lang).toBe(true);
      const names = Array.from(parse(extended(make({ locale: lang })).emojiPickerHtml()).querySelectorAll('.ep-h')).map((n) => n.textContent);
      expect(names, lang).toEqual(parts[0].split(','));
    }
    // Any other language reads English.
    expect(parse(extended(make({ locale: 'de' })).emojiPickerHtml()).querySelector('.ep-h')!.textContent).toBe('Frequent');
    expect(parse(extended(make({ locale: 'constructor' })).emojiPickerHtml()).querySelector('.ep-h')!.textContent).toBe('Frequent');
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

describe('t1: its extras (presentation-t1-x.js)', () => {
  it('registers as the renderer\'s extras, with the renderer\'s id and contract version', () => {
    expect(T1_X_SRC).toContain("window.__gs_mod_extras = { id: 't1', v: 3, create: create };");
    expect(T1_SRC).toContain("mod.id !== 't1' || mod.v !== 3");
  });

  it('takes only its own file: another template\'s, another version or no module is refused', () => {
    const r = make();
    const extend = r.extend as unknown as (m: unknown, dry?: boolean) => number;
    const mod = EXTRAS();
    for (const bad of [null, {}, { ...mod, id: 't2' }, { ...mod, v: 2 }, { ...mod, v: 4 }, { id: 't1', v: 3 }]) expect(extend(bad)).toBe(0);
    // Nothing taken: the grid is still the mark.
    expect(r.emojiPickerHtml()).toBe('<i data-emoji hidden></i>');
    // A dry run says yes and takes nothing.
    expect(extend(mod, true)).toBe(1);
    expect(r.emojiPickerHtml()).toBe('<i data-emoji hidden></i>');
    // Taken once (nothing was asked for before: no repaint), and again: still one.
    expect(extend(mod)).toBe(1);
    expect(extend(mod)).toBe(1);
    expect(parse(r.emojiPickerHtml()).querySelectorAll('[data-emoji-tab]')).toHaveLength(6);
  });

  it('draws through the renderer exactly what it draws on its own, with the renderer\'s helpers', () => {
    const r = extended(make());
    let H: Record<string, unknown> | null = null;
    const spy = make();
    (spy.extend as unknown as (m: unknown) => number)({ ...EXTRAS(), create: (h: Record<string, unknown>) => { H = h; return EXTRAS().create(h); } });
    expect(Object.keys(H!).sort()).toEqual(['D', 'L', 'P', 'SEND', 'avatarHtml', 'config', 'digits', 'esc', 'fa', 'fill', 'fmtNum', 'lang', 'svg', 'systemPillHtml', 't', 'tf'].sort());
    expect(spy.emojiPickerHtml()).toBe(r.emojiPickerHtml());
    expect(EXTRAS().create(H!).emojiPickerHtml()).toBe(r.emojiPickerHtml());
  });

  it('escapes every name it prints', () => {
    const r = extended(make({ t: (k: string) => (k === 'emojiPicker' ? '"><img src=x onerror=alert(1)>' : k) }));
    const h = parse(r.chatFrameHtml({ chatEnabled: true, locale: 'fa', config: BASE_CONFIG }));
    expect(h.querySelector('img[onerror]')).toBeNull();
    expect(h.querySelector('[data-emoji-picker] .ep-cats')!.getAttribute('aria-label')).toBe('"><img src=x onerror=alert(1)>');
  });
});

describe('t1: the chat bar\'s menu (extras, feature `chatMenu`)', () => {
  const VM = { online: true, isNew: false, operator: { name: 'سارا', online: true } };
  const SOUND = { action: 'sound', on: true };
  const head = (r: Renderer, menu: unknown) => parse(r.chatHeaderHtml({ ...VM, menu }));

  it('draws nothing without a list from Core, and nothing before the extras (Core repaints when they come)', () => {
    expect(head(extended(make()), null).querySelector('.cm, [data-chat-menu-toggle]')).toBeNull();
    expect(head(extended(make()), { open: true, items: [] }).querySelector('.cm, [data-chat-menu-toggle]')).toBeNull();
    const bare = make();
    expect(head(bare, { open: false, items: [SOUND] }).querySelector('[data-chat-menu-toggle]')).toBeNull();
    // A surface was asked for before the extras: taking them asks Core for a repaint.
    expect((bare.extend as unknown as (m: unknown) => number)(EXTRAS())).toBe(2);
  });

  it('the ⋯ sits after the person and before the shell\'s close, with its menu under it', () => {
    const h = head(extended(make()), { open: false, items: [{ action: 'transcript', state: 'idle', to: 'a•••@example.com' }, SOUND] });
    const kids = Array.from(h.children).map((el) => el.className.split(' ')[0] || el.tagName);
    expect(kids.indexOf('cm')).toBe(kids.indexOf('who') + 1);
    const toggle = h.querySelector('.cm > button.ib[data-chat-menu-toggle]')!;
    expect(toggle.getAttribute('aria-haspopup')).toBe('menu');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('گزینه‌های بیشتر');
    const menu = h.querySelector('.cm > [data-chat-menu]')!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.hasAttribute('hidden')).toBe(true);
    const items = Array.from(menu.querySelectorAll('[data-chat-menu-action]'));
    expect(items.map((b) => b.getAttribute('data-chat-menu-action'))).toEqual(['transcript', 'sound']);
    expect(items.map((b) => b.getAttribute('role'))).toEqual(['menuitem', 'menuitemcheckbox']);
    // Core moves the focus through the items (arrows): none is a tab stop.
    expect(items.every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
    expect(items[0].textContent).toBe('ارسال متن گفتگو به ایمیل');
    expect(items[1].textContent).toBe('صدای اعلان‌ها');
    expect(items[1].getAttribute('aria-checked')).toBe('true');
  });

  it('open: expanded and shown; the sound item says off', () => {
    const h = head(extended(make()), { open: true, items: [{ action: 'sound', on: false }] });
    expect(h.querySelector('[data-chat-menu-toggle]')!.getAttribute('aria-expanded')).toBe('true');
    expect(h.querySelector('[data-chat-menu]')!.hasAttribute('hidden')).toBe(false);
    expect(h.querySelector('[data-chat-menu-action="sound"]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('the transcript item in each state: sending, sent (the masked address, an isolated run), a retry, no more', () => {
    const item = (state: string, to = 'a•••@example.com') =>
      head(extended(make()), { open: true, items: [{ action: 'transcript', state, to }] }).querySelector('[data-chat-menu-action="transcript"]')!;
    expect(item('idle').hasAttribute('aria-disabled')).toBe(false);
    expect(item('sending').getAttribute('aria-disabled')).toBe('true');
    const sent = item('sent');
    expect(sent.getAttribute('aria-disabled')).toBe('true');
    expect(sent.textContent).toBe('متن گفتگو به a•••@example.com فرستاده شد');
    expect(sent.querySelector('b[dir="ltr"]')!.textContent).toBe('a•••@example.com');
    expect(item('failed').textContent).toBe('ارسال نشد · تلاش دوباره');
    expect(item('failed').hasAttribute('aria-disabled')).toBe(false);
    expect(item('no').textContent).toBe('ارسال متن گفتگو ممکن نشد');
    expect(item('no').getAttribute('aria-disabled')).toBe('true');
    // The address is the server's, escaped like any value.
    const evil = item('sent', '<img src=x onerror=alert(1)>');
    expect(evil.querySelector('img')).toBeNull();
    expect(evil.querySelector('b')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('speaks en and tr', () => {
    const en = head(extended(make({ locale: 'en' })), { open: true, items: [{ action: 'transcript', state: 'sent', to: 'a•••@x.io' }, SOUND] });
    expect(en.querySelector('[data-chat-menu-toggle]')!.getAttribute('aria-label')).toBe('More options');
    expect(Array.from(en.querySelectorAll('[data-chat-menu-action]')).map((b) => b.textContent))
      .toEqual(['We sent the transcript to a•••@x.io', 'Notification sounds']);
    const tr = head(extended(make({ locale: 'tr' })), { open: true, items: [{ action: 'transcript', state: 'idle' }, SOUND] });
    expect(tr.querySelector('[data-chat-menu-toggle]')!.getAttribute('aria-label')).toBe('Diğer seçenekler');
    expect(Array.from(tr.querySelectorAll('[data-chat-menu-action]')).map((b) => b.textContent))
      .toEqual(['Sohbet dökümünü e-postama gönder', 'Bildirim sesleri']);
  });

  it('its stylesheet hangs the menu under the ⋯ at the bar\'s end, in both directions', () => {
    expect(T1_CSS).toMatch(/\.cm \{ position: relative;/);
    expect(T1_CSS).toMatch(/\.menu \{ position: absolute; top: calc\(100% \+ 6px\); inset-inline-end: 0;/);
    expect(T1_CSS).toContain('.menu[hidden] { display: none; }');
    expect(T1_CSS).not.toMatch(/\.menu[^{]*\{[^}]*\b(left|right):/);
  });
});

describe('t1: the pre-chat one question at a time (extras, feature `prechatSteps`)', () => {
  const r = (locale = 'fa') => extended(make({ locale, capabilities: SERVED }));
  const LOG = [
    { key: 'name', value: 'علی رضایی', ok: true },
    { key: 'email', value: 'ali@example', ok: false, why: 'invalid' },
    { key: 'email', value: 'ali@example.com', ok: true },
  ];
  const rows = (html: string) => Array.from(parse(html).querySelectorAll('.msg-row'));

  it('asks each question once, beside the team\'s lead, and draws each answer with what became of it', () => {
    const html = r().prechatStepsHtml({ key: 'phone', log: LOG, firstName: 'علی' });
    const list = rows(html);
    expect(list.map((x) => (x.classList.contains('visitor') ? 'v:' : 'q:') + x.querySelector('.msg')!.textContent)).toEqual([
      'q:سلام! برای شروع، نامتان را بنویسید.',
      'v:علی رضایی',
      'q:ممنون علی. ایمیلتان را هم بنویسید.',
      'v:ali@example',
      'v:ali@example.com',
      'q:اگر مایلید، شماره موبایلتان را هم بنویسید.',
    ]);
    const root = parse(html);
    // The questions are named for the step's field (aria-describedby).
    expect(['pq-name', 'pq-email', 'pq-phone'].map((id) => !!root.querySelector('#' + id))).toEqual([true, true, true]);
    expect(avatarFace(root.querySelector('#pq-name')!.closest('.msg-row')!.querySelector('.av'))).toBe('person');
    // The newest answer taken: a tick and «ثبت شد» (an older one says nothing,
    // as 08·b draws the name); refused: faded, the reason and an example.
    expect(list[4].querySelector('.st-ok')!.textContent).toBe('ثبت شد');
    expect(list[1].querySelector('.msg-footline')).toBeNull();
    expect(root.querySelectorAll('.st-ok')).toHaveLength(1);
    expect(list[3].querySelector('.msg.fail')).not.toBeNull();
    expect(list[3].querySelector('.st-err')!.textContent).toBe('ایمیل کامل نیست · مثلاً name@example.com');
    // Only the newest answer's refusal is read out (it is not the newest here).
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(list[1].querySelector('.msg')!.getAttribute('dir')).toBe('auto');
    expect(list[3].querySelector('.msg')!.getAttribute('dir')).toBe('ltr');
  });

  it('reads out a refusal that is the newest answer; a phone refusal and a server one say theirs', () => {
    const phone = parse(r().prechatStepsHtml({ key: 'phone', log: [{ key: 'phone', value: '12', ok: false, why: 'invalid' }] }));
    expect(phone.querySelector('.st-err[role="alert"]')!.textContent).toBe('invalidPhone');
    const req = parse(r().prechatStepsHtml({ key: 'email', log: [{ key: 'email', value: '', ok: false, why: 'required' }] }));
    expect(req.querySelector('.st-err[role="alert"]')!.textContent).toBe('fieldRequired');
  });

  it('asks for the email without a name when there is none, and skips no question for a skipped step', () => {
    const html = r().prechatStepsHtml({ key: 'email', log: [{ key: 'name', skip: true }], firstName: '' });
    expect(rows(html).map((x) => x.querySelector('.msg')!.textContent)).toEqual([
      'سلام! برای شروع، نامتان را بنویسید.', 'ایمیلتان را بنویسید.',
    ]);
  });

  it('opens a handoff with its reason, typed out on its first show as the card does', () => {
    const typed = parse(r().prechatStepsHtml({ key: 'name', log: [], introAnimate: true, intro: 'برای ادامه مشخصاتتان را بگویید' }));
    expect(typed.querySelector('[data-typing-host][data-typing-active="1"][data-typing-id="hc-subtitle"]')!.textContent).toBe('');
    const plain = parse(r().prechatStepsHtml({ key: 'name', log: [], intro: 'برای ادامه مشخصاتتان را بگویید' }));
    expect(plain.querySelector('.msg-row .msg')!.textContent).toBe('برای ادامه مشخصاتتان را بگویید');
    expect(plain.querySelector('[data-typing-id]')).toBeNull();
  });

  it('escapes what the visitor typed and the name it repeats', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = r().prechatStepsHtml({ key: 'email', log: [{ key: 'name', value: evil, ok: true }], firstName: evil, intro: evil });
    const root = parse(html);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('#pq-email')!.textContent).toContain(evil);
  });

  it('draws the step in the composer\'s place: progress, the field, its prefix, skip and submit', () => {
    const box = parse(r().prechatStepBoxHtml({ key: 'phone', n: 3, total: 3, optional: true, value: '', prefix: '+98' }));
    const root = box.querySelector('.cbox.steps[data-prechat-step="phone"]')!;
    expect(root.querySelector('.prog > span')!.textContent).toBe('مرحله ۳ از ۳ · اختیاری');
    expect(Array.from(root.querySelectorAll('.prog .bar i')).map((i) => i.classList.contains('on'))).toEqual([true, true, true]);
    expect(root.querySelector('[data-prechat-step-skip]')!.textContent).toBe('رد کردن');
    const pre = root.querySelector('label.ex > .pre')!;
    expect(pre.getAttribute('dir')).toBe('ltr');
    expect(pre.textContent).toBe('+۹۸');
    const input = root.querySelector('input[data-prechat-step-input]') as HTMLInputElement;
    expect([input.type, input.getAttribute('dir'), input.getAttribute('autocomplete'), input.getAttribute('enterkeyhint')]).toEqual(['tel', 'ltr', 'tel-national', 'done']);
    expect(input.getAttribute('placeholder')).toBe('۹۱۲ ۳۴۵ ۶۷۸۹');
    expect(input.getAttribute('aria-describedby')).toBe('pq-phone');
    expect(input.getAttribute('aria-label')).toBe('شماره موبایل');
    expect(root.querySelector('.tools .hint')!.textContent).toBe('شمارهٔ موبایل');
    const send = root.querySelector('[data-prechat-step-submit]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-label')).toBe('ثبت');
  });

  it('a required step has no skip; the first of three fills one bar; a value enables submit; busy locks both', () => {
    const name = parse(r().prechatStepBoxHtml({ key: 'name', n: 1, total: 3, optional: false, value: 'علی' }));
    expect(name.querySelector('.prog > span')!.textContent).toBe('مرحله ۱ از ۳');
    expect(name.querySelector('[data-prechat-step-skip]')).toBeNull();
    expect(Array.from(name.querySelectorAll('.prog .bar i')).map((i) => i.classList.contains('on'))).toEqual([true, false, false]);
    const input = name.querySelector('input') as HTMLInputElement;
    expect([input.type, input.hasAttribute('dir'), input.getAttribute('autocomplete'), input.getAttribute('enterkeyhint'), input.value])
      .toEqual(['text', false, 'name', 'next', 'علی']);
    expect(name.querySelector('.pre, .hint')).toBeNull();
    expect((name.querySelector('[data-prechat-step-submit]') as HTMLButtonElement).disabled).toBe(false);
    const busy = parse(r().prechatStepBoxHtml({ key: 'name', n: 1, total: 3, value: 'علی', busy: true }));
    expect(busy.querySelector('input')!.hasAttribute('readonly')).toBe(true);
    expect((busy.querySelector('[data-prechat-step-submit]') as HTMLButtonElement).disabled).toBe(true);
    // A network failure: Core's error line, read out.
    const failed = parse(r().prechatStepBoxHtml({ key: 'name', n: 1, total: 1, value: 'علی', error: true }));
    expect(failed.querySelector('.err[role="alert"]')!.textContent).toBe('fallbackError');
  });

  it('without the edition\'s prefix the phone step takes a number with its country code', () => {
    const box = parse(r().prechatStepBoxHtml({ key: 'phone', n: 1, total: 1, optional: true, value: '', prefix: '' }));
    expect(box.querySelector('.pre')).toBeNull();
    const input = box.querySelector('input')!;
    expect([input.getAttribute('autocomplete'), input.getAttribute('placeholder')]).toEqual(['tel', 'prechatPhonePh']);
  });

  it('speaks en (left to right, Latin digits) and tr', () => {
    const en = parse(r('en').prechatStepBoxHtml({ key: 'email', n: 2, total: 3, optional: true, value: '' }));
    // (Core's own words come from its `t`, Persian in these tests.)
    expect(en.querySelector('.prog > span')!.textContent).toBe('Step 2 of 3 · اختیاری');
    expect(en.querySelector('input')!.getAttribute('placeholder')).toBe('name@example.com');
    expect(parse(r('en').prechatStepsHtml({ key: 'email', log: [], firstName: 'Ali' })).querySelector('#pq-email')!.textContent)
      .toBe('Thanks, Ali. What’s your email?');
    expect(parse(r('en').prechatStepBoxHtml({ key: 'phone', n: 3, total: 3, prefix: '+98' })).querySelector('.pre')!.textContent).toBe('+98');
    expect(parse(r('tr').prechatStepBoxHtml({ key: 'name', n: 1, total: 2 })).querySelector('.prog > span')!.textContent).toBe('Adım 1/2');
  });

  it('its stylesheet: the step looks focused, the prefix keeps its own direction, logical sides only', () => {
    expect(T1_CSS).toMatch(/\.cbox\.steps \{[^}]*box-shadow: 0 0 0 1\.5px var\(--a-tx\), 0 0 0 4px var\(--a-3\)/);
    expect(T1_CSS).toMatch(/\.ex \.pre \{ direction: ltr;[^}]*border-inline-end: 1px solid var\(--line-2\)/);
    expect(T1_CSS).toMatch(/\.prog \.bar \.on \{ background: var\(--a\); \}/);
    expect(T1_CSS).toMatch(/\.msg\.fail \{ opacity: \.55; \}/);
    for (const sel of ['.prog', '.ex', '.steps .tools']) {
      const rule = new RegExp(sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}').exec(T1_CSS)![1];
      expect(rule, sel).not.toMatch(/\b(left|right):|margin-(left|right)|padding-(left|right)/);
    }
  });
});

describe('t1: the visitor\'s place in the queue (extras, feature `queuePosition`)', () => {
  const r = (locale = 'fa') => extended(make({ locale, capabilities: SERVED }));
  const QUEUED = { senderType: 'system', sender: 'operator', metadata: { kind: 'routing_in_queue' } };
  const pills = (html: string) => Array.from(parse(html).querySelectorAll('.msg-system-pill')).map((p) => p.textContent);

  it('numbers the row Core points at, with Persian digits and the green dot; the place alone without a wait', () => {
    const msgs = [msg(QUEUED), msg({ body: 'سلام' }), msg(QUEUED)];
    const html = r().messagesHtml({ messages: msgs }, '', { queue: { at: 2, position: 2, waitMinutes: 3 } });
    expect(pills(html)).toEqual(['routingInQueue', 'نفر ۲ در صف · حدود ۳ دقیقه']);
    expect(parse(html).querySelectorAll('.msg-system-pill .live:not(.off)')).toHaveLength(1);
    const only = r().messagesHtml({ messages: [msg(QUEUED)] }, '', { queue: { at: 0, position: 12, waitMinutes: null } });
    expect(pills(only)).toEqual(['نفر ۱۲ در صف']);
  });

  it('keeps Core\'s text without a place, and before its extras', () => {
    expect(pills(r().messagesHtml({ messages: [msg(QUEUED)] }, '', {}))).toEqual(['routingInQueue']);
    expect(parse(r().messagesHtml({ messages: [msg(QUEUED)] }, '', {})).querySelector('.live.off')).not.toBeNull();
  });

  it('speaks English ordinals and Turkish', () => {
    const en = (n: number, w: number | null) => pills(r('en').messagesHtml({ messages: [msg(QUEUED)] }, '', { queue: { at: 0, position: n, waitMinutes: w } }))[0];
    expect(en(2, 3)).toBe('2nd in line · about 3 min');
    expect([1, 3, 4, 11, 12, 13, 21, 22, 101, 111, 112].map((n) => en(n, null)))
      .toEqual(['1st', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th', '112th'].map((o) => o + ' in line'));
    expect(pills(r('tr').messagesHtml({ messages: [msg(QUEUED)] }, '', { queue: { at: 0, position: 2, waitMinutes: 3 } }))[0])
      .toBe('Sırada 2. · yaklaşık 3 dk');
  });
});

describe('t1: the message left while the team is away (extras, feature `awayThread`)', () => {
  const r = (locale = 'fa') => extended(make({ locale, capabilities: SERVED }));
  const VISITOR = () => msg({ sender: 'visitor', senderType: 'contact', body: 'سلام، برای سفارش عمده تخفیف دارید؟', status: 'sent' });
  const reply = (vm: Vm, locale?: string) =>
    parse(r(locale).messagesHtml({ messages: [VISITOR(), msg({ body: 'بعدی' })] }, '', { awayReply: { at: 0, ...vm } })).querySelector('.away-reply')!;

  it('answers under the message it follows, asking for an email with the contact-fallback hooks', () => {
    const html = r().messagesHtml({ messages: [VISITOR(), msg({ body: 'بعدی' })] }, '', { awayReply: { at: 0, status: 'ask', value: '' } });
    const list = Array.from(parse(html).querySelectorAll('.messages > .msg-row'));
    expect(list.map((x) => x.className.includes('away-reply'))).toEqual([false, true, false]);
    const row = list[1];
    expect(row.querySelector('.msg.operator.joined')!.textContent).toBe('پیامتان ثبت شد. اگر مایلید، ایمیلتان را هم بگذارید.');
    expect(avatarFace(row.querySelector('.av'))).toBe('workspace');
    const form = row.querySelector('form.fcard.ec')!;
    expect(form.getAttribute('aria-label')).toBe('ایمیل شما');
    expect(form.hasAttribute('novalidate')).toBe(true);
    expect(form.querySelector('label[for="fb-email"]')!.textContent).toBe('ایمیل شما');
    const input = form.querySelector('#fb-email[data-fb="email"]') as HTMLInputElement;
    expect([input.type, input.getAttribute('dir'), input.getAttribute('autocomplete'), input.getAttribute('aria-describedby')]).toEqual(['email', 'ltr', 'email', 'fb-status']);
    const go = form.querySelector('button[type="submit"][data-fb-submit]')!;
    expect(go.getAttribute('aria-label')).toBe('ثبت ایمیل');
    expect(form.querySelector('#fb-status[data-fb-status][role="status"]')!.textContent).toBe('');
    expect(row.querySelector('.msg-meta')!.textContent).toBe('پیام خودکار');
  });

  it('saving locks the field; an error is Core\'s string; the value is kept and escaped', () => {
    const saving = reply({ status: 'saving', value: 'ali@example.com' });
    expect(saving.querySelector('input')!.hasAttribute('readonly')).toBe(true);
    expect((saving.querySelector('[data-fb-submit]') as HTMLButtonElement).disabled).toBe(true);
    const bad = reply({ status: 'ask', value: '"><img src=x onerror=1>', error: 'invalidEmail' });
    expect(bad.querySelector('img')).toBeNull();
    expect((bad.querySelector('input') as HTMLInputElement).value).toBe('"><img src=x onerror=1>');
    expect(bad.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
    expect(bad.querySelector('[data-fb-status]')!.textContent).toBe('invalidEmail');
  });

  it('saved: where the reply goes, the address an isolated left-to-right run', () => {
    const saved = reply({ status: 'saved', email: 'ali@example.com' });
    expect(saved.querySelector('form, [data-fb]')).toBeNull();
    expect(saved.querySelector('.msg.operator')!.textContent).toBe('پیامتان ثبت شد.');
    const done = saved.querySelector('.ec.done[role="status"]')!;
    expect(done.textContent).toBe('ثبت شد: ali@example.com');
    expect(done.querySelector('b[dir="ltr"]')!.textContent).toBe('ali@example.com');
    expect(reply({ status: 'saved', email: '<b>x</b>' }).querySelector('.ec.done b b')).toBeNull();
    expect(reply({ status: 'saved', email: 'a@b.io' }, 'en').querySelector('.ec.done')!.textContent).toBe('Saved: a@b.io');
  });

  it('draws nothing without Core\'s view-model (the template\'s own away banner is the stylesheet\'s)', () => {
    expect(parse(r().messagesHtml({ messages: [VISITOR()] }, '', {})).querySelector('.away-reply')).toBeNull();
    expect(parse(make({ capabilities: SERVED }).messagesHtml({ messages: [VISITOR()] }, '', { awayReply: { at: 0, status: 'ask' } })).querySelector('.away-reply')).toBeNull();
  });
});

describe('t1: the emoji picker\'s search (extras, feature `emojiSearch`)', () => {
  const picker = (locale = 'fa') => parse(extended(make({ locale, capabilities: SERVED })).emojiPickerHtml());

  it('puts the field on top, its label hidden until Core shows it, never focused by itself', () => {
    const p = picker();
    const label = p.firstElementChild!;
    expect(label.matches('label.ep-sr[hidden]')).toBe(true);
    const input = label.querySelector('input[data-emoji-search]') as HTMLInputElement;
    expect([input.type, input.getAttribute('enterkeyhint'), input.getAttribute('autocomplete'), input.getAttribute('spellcheck')])
      .toEqual(['search', 'search', 'off', 'false']);
    expect(input.getAttribute('aria-label')).toBe('جستجوی شکلک');
    expect(input.getAttribute('placeholder')).toBe('جستجوی شکلک');
    expect(input.hasAttribute('autofocus')).toBe(false);
    expect(label.nextElementSibling!.classList.contains('ep-cats')).toBe(true);
  });

  it('ends the grid with the "no emoji found" line, hidden, in every language', () => {
    expect(picker().querySelector('.ep-grid > p.ep-none[data-emoji-none][role="status"][hidden]')!.textContent).toBe('شکلکی پیدا نشد');
    expect(picker('en').querySelector('[data-emoji-none]')!.textContent).toBe('No emoji found');
    expect(picker('tr').querySelector('[data-emoji-none]')!.textContent).toBe('Emoji bulunamadı');
    expect(picker('en').querySelector('[data-emoji-search]')!.getAttribute('placeholder')).toBe('Search emoji');
    expect(picker('tr').querySelector('[data-emoji-search]')!.getAttribute('placeholder')).toBe('Emoji ara');
    // Core's insert finds emoji by [data-emoji]: the field and the line are not one.
    expect(picker().querySelectorAll('[data-emoji]').length).toBe(picker().querySelectorAll('button.ep-e[data-emoji]').length);
  });

  it('has its look in the stylesheet: the field, a taller picker, what Core hides really gone, no tabs while searching', () => {
    expect(T1_CSS).toMatch(/\.ep-sr \{ display: flex;/);
    expect(T1_CSS).toContain('.ep-sr[hidden], .epk.is-searching .ep-cats, .ep-e[hidden] { display: none; }');
    // Taller only while open: a closed picker (hidden) keeps no height, the
    // search field revealed or not (`.epk[hidden]` sets 0; this must not win).
    expect(T1_CSS).toContain('.epk:not([hidden]):has(.ep-sr:not([hidden])) { height: 290px; }');
    expect(T1_CSS).not.toMatch(/(^|\n)\.epk:has\(/);
  });
});

describe('t1: an article\'s author (feature `kbAuthor`)', () => {
  const r = (locale = 'fa') => make({ locale, capabilities: SERVED });
  const am = (article: Vm, locale?: string) => parse(r(locale).kbArticleHtml({ article: { title: 'چطور', contentHtml: '', ...article } })).querySelector('.am');

  it('leads the meta line with the name on its silhouette\'s tile (09·12), then the reading time and the update', () => {
    const updatedAt = new Date(Date.now() - 3 * 864e5).toISOString();
    const line = am({ author: ' سارا رضایی ', readingMinutes: 20, updatedAt })!;
    expect(line.firstElementChild!.matches('.av.s24[aria-hidden="true"]')).toBe(true);
    expect(avatarFace(line.firstElementChild)).toBe('person');
    const parts = Array.from(line.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent);
    expect(parts[0]).toBe('سارا رضایی');
    expect(parts[1]).toBe('۲۰ دقیقه مطالعه');
    expect(parts[2]).toContain('به‌روز شده');
  });

  it('draws nothing of it without a name, and escapes it', () => {
    expect(am({ author: '  ', readingMinutes: 2 })!.querySelector('.av')).toBeNull();
    expect(am({ author: null })).toBeNull();
    const evil = am({ author: '<img src=x onerror=1>' })!;
    expect(evil.querySelector('img')).toBeNull();
    expect(evil.textContent).toContain('<img src=x onerror=1>');
    expect(am({ author: 'Sara', readingMinutes: 3 }, 'en')!.textContent).toBe('Sara·3 min read');
  });
});

describe('t1: a sent message while the team is away (07·09, `view.away`)', () => {
  const r = () => make({ capabilities: SERVED });
  const V = (status: string) => msg({ sender: 'visitor', senderType: 'contact', body: 'سلام', status, time: '2026-10-18T19:40:00.000Z' });
  const meta = (status: string, view: Vm) => parse(r().messagesHtml({ messages: [V(status)] }, '', view)).querySelector('.msg-meta')!;

  it('reads «{time} · ارسال شد» in words, instead of the tick', () => {
    const m = meta('sent', { away: true });
    expect(m.querySelector('.msg-ticks')).toBeNull();
    expect(m.querySelector('.msg-sent')!.textContent).toBe('ارسال شد');
    expect(m.textContent).toMatch(/^[۰-۹]{2}:[۰-۹]{2}·ارسال شد$/);
    expect(m.querySelector('.msg-time')!.nextElementSibling!.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the ticks when not away, once delivered or seen, and while sending', () => {
    expect(meta('sent', {}).querySelector('.msg-ticks[role="img"]')).not.toBeNull();
    expect(meta('seen', { away: true }).querySelector('.msg-ticks.is-seen')).not.toBeNull();
    expect(meta('delivered', { away: true }).querySelector('.msg-sent')).toBeNull();
    expect(meta('sending', { away: true }).querySelector('.msg-ticks.is-sending')).not.toBeNull();
  });
});

describe('t1-intl: the International edition\'s skin over t1 (presentation-t1-intl.css)', () => {
  const SKIN = read('public/widget/presentation-t1-intl.css');

  it('the brand accent is Ink, by the renderer\'s class (and its hero for Ink picked explicitly)', () => {
    expect(SKIN).toContain('.wy-view.gs-accent-brand, .panel-close.gs-accent-brand { --a: #16142B; --a-rgb: 22, 20, 43; --gs-primary: #16142B; }');
    expect(SKIN).toMatch(/\.wy-view\.gs-accent-brand, \.wy-view\[style\*='--a:#16142b;' i\] \{ --hero: /);
  });

  it('brand art: Thread by default, Open under the shell\'s lg-open; drawn only from data: masks', () => {
    for (const v of ['--mk', '--gav', '--tm', '--tq', '--ta']) {
      expect(SKIN.match(new RegExp(`${v}: url\\("data:image/svg\\+xml,`, 'g'))?.length, v).toBe(2);
    }
    expect(SKIN).toContain('.lg-open .wy-view, .lg-open .smart-nudge {');
    for (const m of SKIN.matchAll(/url\(\s*["']?([^"')\s]+)/g)) expect(m[1].startsWith('data:'), m[1]).toBe(true);
    // The watermark only while the platform is credited.
    expect(SKIN).toContain('.wy-view:has(.wy-powered) .hx::before');
  });

  it('the Open greeting beside the launcher narrows on a narrow phone, so it never leaves the screen', () => {
    const open = SKIN.match(/^\.lg-open \.smart-nudge \{([^}]*)\}/m)![1];
    expect(open).toContain('bottom: calc(var(--gs-fab-size, 60px) + 5px)');
    expect(open).toContain('max-width: calc(100vw - 53px - var(--gs-fab-size, 60px))');
    expect(SKIN).toContain('.lg-open .smart-nudge.bottom-right { right: calc(var(--gs-fab-size, 60px) + 5px); }');
  });

  it('Persian keeps IRANSans first; left-to-right text leads with Figtree', () => {
    expect(SKIN).toContain(".panel { color: #16142B; font-family: 'IRANSans', 'Figtree',");
    expect(SKIN).toContain(".panel[dir='ltr'], .smart-nudge[dir='ltr'] { font-family: 'Figtree', 'IRANSans',");
    expect(SKIN).not.toMatch(/@font-face|@import/);
  });

  it('the renderer stays t1\'s: no RESPOK word, Signal colour or logo direction in presentation-t1.js', () => {
    const code = T1_SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/respok|ff5a3c|lg-open|lg-thread|logoDirection/i);
  });
});
