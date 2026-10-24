/**
 * Screenshot harness for the chat widget's templates (scratch-friendly).
 *
 * Renders the SHIPPED runtime.js with a template's renderer and stylesheet in
 * a real Chromium, every request answered by an in-memory fake of the widget
 * API (the e2e/harness/widgetHarness.ts approach), and writes one PNG per
 * named state, so a template under construction can be compared with the
 * design's panels (handoff `webyar/<template>/screens/panels`).
 *
 *   npx tsx e2e/harness/templateScreens.ts --template t1 --out /tmp/shots
 *   npx tsx e2e/harness/templateScreens.ts --template t2 --out /tmp/shots \
 *     --states home-first-visit,thread-typing --locale fa --accent '#0B7D6C' \
 *     --options '{"topics":[{"label":"زمان ارسال","icon":"truck"}]}'
 *
 * Flags: --template (a chat template id, default `default`), --out (folder,
 * created), --states (comma list, default all; --list prints them),
 * --locale (fa | en | tr, default fa), --accent (the workspace colour;
 * default the seeded #3B82F6, i.e. the brand look), --options (JSON for
 * config.templateOptions), --native-size (keep the template's own panel box
 * instead of 400×720), --classic-scrollbars (space-taking scrollbars; default
 * overlay ones, as macOS / iOS / Android draw them and the designs show),
 * --safe-area (phone states: `top,bottom` insets in CSS px, e.g. `0,34` for
 * a home indicator), --motion (keep animations; default reduced motion so every shot is
 * stable), --late-after (the live widget's order: the late pack is not put
 * on the page first, runtime-ext.js asks for it after the first paint),
 * --edition international (the International edition, RESPOK: the
 * bootstrap's edition, Gregorian dates in the visitor's zone, the RESPOK
 * lockup as the credit, the launcher kit's classes, the shell's logo
 * direction `lg-thread` / `lg-open` from --options logoDirection, and in
 * English or Turkish the fixture in English, as the handoff's RESPOK panels
 * draw it: Nilufar Store, Sara / Mehdi / Reza, its articles),
 * --chromium (path; default PLAYWRIGHT_CHROMIUM_PATH, then
 * /opt/pw-browsers or /opt/ms-playwright).
 *
 * Desktop states shoot the panel at 400×720 CSS px, phone states the whole
 * 390×844 screen; both at deviceScaleFactor 2. The page runs in Asia/Tehran
 * so message times read like the designs' (۱۹:۴۲). Fixture copy mirrors the
 * handoff's demo store (فروشگاه نیلوفر, سارا / مهدی / رضا, its articles).
 *
 *   npx tsx e2e/harness/templateScreens.ts --template t1-intl --edition international \
 *     --locale en --out /tmp/shots --options '{"logoDirection":"open"}'
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FAKE_MEDIA_ARGS, templateAssets } from './widgetHarness';

const root = process.cwd();
const ORIGIN = 'https://widget.test';
const WORKSPACE = 'ws-screens';

// ─── Time: the designs' clock (Asia/Tehran, today) ──────────────────────
function tehranToday(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
/** ISO of HH:MM in Tehran (UTC+03:30), `days` before today. */
function at(hh: number, mm: number, days = 0): string {
  const { y, m, d } = tehranToday();
  return new Date(Date.UTC(y, m - 1, d - days, hh, mm) - 210 * 60_000).toISOString();
}
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// ─── Fixture data (the handoff's demo store) ────────────────────────────
const TEAM_ONLINE = [
  { name: 'سارا', avatar: null, online: true },
  { name: 'مهدی', avatar: null, online: true },
  { name: 'رضا', avatar: null, online: true },
];
const TEAM_AWAY = TEAM_ONLINE.map((m) => ({ ...m, online: false }));

const CATEGORIES = [
  { id: 'cat-orders', name: 'سفارش و ارسال', slug: 'orders', description: 'پیگیری، زمان و هزینه ارسال', icon: 'box', sort_order: 1 },
  { id: 'cat-pay', name: 'پرداخت و بازگشت وجه', slug: 'payments', description: 'روش‌های پرداخت و مرجوعی', icon: 'card', sort_order: 2 },
  { id: 'cat-size', name: 'محصولات و سایزبندی', slug: 'products', description: 'راهنمای سایز و جنس', icon: 'tag', sort_order: 3 },
];
const art = (slug: string, title: string, category: string, excerpt = '') =>
  ({ id: `a-${slug}`, slug, title, excerpt, category_id: category, sort_order: 0, locale: 'fa' });
const ARTICLES = [
  art('track-order', 'چطور سفارشم را پیگیری کنم؟', 'cat-orders', 'کد رهگیری را پیامک می‌کنیم؛ وضعیت را در حساب کاربری هم می‌بینید…'),
  art('shipping-time', 'زمان و هزینه ارسال', 'cat-orders', 'هزینه‌ی ارسال برای خریدهای بالای ۲ میلیون تومان رایگان است…'),
  art('returns', 'شرایط مرجوعی و بازگشت وجه', 'cat-pay', 'تا ۷ روز بعد از تحویل می‌توانید کالا را مرجوع کنید…'),
  art('size-guide', 'راهنمای انتخاب سایز', 'cat-size', 'جدول سایز هر محصول در صفحه‌ی همان محصول است…'),
  art('provinces', 'ارسال به شهرستان‌ها', 'cat-orders', 'سفارش‌های شهرستان با پست پیشتاز ۳ تا ۵ روزه می‌رسند…'),
  art('change-address', 'تغییر آدرس تحویل', 'cat-orders'),
  art('express', 'ارسال فوری در تهران', 'cat-orders'),
  art('pay-methods', 'روش‌های پرداخت', 'cat-pay'),
  art('refund-time', 'بازگشت وجه چقدر طول می‌کشد؟', 'cat-pay'),
  art('installments', 'خرید اقساطی', 'cat-pay'),
  art('materials', 'جنس و نگهداری محصولات', 'cat-size'),
  art('shoe-size', 'سایز کفش رانینگ', 'cat-size'),
];
const ARTICLE_BODY =
  '<p>بعد از ارسال سفارش، کد رهگیری برایتان پیامک و ایمیل می‌شود. همیشه می‌توانید آن را در <strong>حساب کاربری › سفارش‌ها</strong> هم ببینید.</p>' +
  '<h3>کد رهگیری کجاست؟</h3>' +
  '<ol><li>پیامک «سفارش شما ارسال شد» را باز کنید.</li><li>یا در حساب کاربری، روی سفارش بزنید و «پیگیری» را انتخاب کنید.</li></ol>' +
  '<blockquote>به‌روزرسانی وضعیت مرسوله ممکن است تا ۲۴ ساعت طول بکشد.</blockquote>' +
  '<p>' + 'اگر کد رهگیری تا یک روز کاری بعد از ارسال به دستتان نرسید، از همین‌جا با ما گفتگو کنید تا بررسی کنیم. '.repeat(6) + '</p>';
const SEARCH: Record<string, unknown[]> = {
  ارسال: [ARTICLES[1], { ...ARTICLES[0], title: 'پیگیری مرسوله بعد از ارسال' }, ARTICLES[4]],
};

const MEDIA = {
  image: { id: 'att-img', kind: 'image', mime_type: 'image/svg+xml', file_name: 'عکس-محصول.jpg', size_bytes: 860_160 },
  pdf: { id: 'att-pdf', kind: 'file', mime_type: 'application/pdf', file_name: 'فاکتور-۴۸۲۱۳.pdf', size_bytes: 245_760 },
  voice: { id: 'att-voice', kind: 'audio', mime_type: 'audio/wav', file_name: 'پیام صوتی.wav', size_bytes: 112_044 },
};

type Msg = Record<string, unknown>;
const sara = (id: string, text: string, time: string, extra: Msg = {}): Msg =>
  ({ id, role: 'agent', sender_type: 'agent', sender_name: 'سارا', sender_avatar: null, text, time, ...extra });
const visitor = (id: string, text: string, time: string, extra: Msg = {}): Msg =>
  ({ id, role: 'visitor', sender_type: 'contact', text, time, seen_at: time, ...extra });

const THREAD: Msg[] = [
  visitor('m1', 'سلام، کد رهگیری سفارشم هنوز نیومده.', at(19, 42)),
  sara('m2', 'سلام علی جان! سفارش‌تون امروز صبح ارسال شد. کد رهگیری: TR-2290-5531\nhttps://post.ir', at(19, 54)),
  visitor('m3', '> سارا: کد رهگیری: TR-2290-5531\n\nعالیه، خیلی ممنون', at(19, 58)),
];
const ATTACHMENTS_THREAD: Msg[] = [
  sara('n1', '', at(20, 4), { attachment: MEDIA.image }),
  sara('n2', 'این هم فاکتور سفارشتان.', at(20, 6), { attachment: MEDIA.pdf }),
  visitor('n3', '', at(20, 7), { attachment: MEDIA.voice }),
];

interface Conversation {
  id: string; status: string; preview: string; unreadCount: number; outbound?: boolean;
  lastMessageAt: string; operatorName?: string | null; operatorOnline?: boolean;
}
const RECENT: Conversation = {
  id: 'c-sara', status: 'open', preview: 'خواهش می‌کنم! کار دیگه‌ای هست که بتونم کمکتون کنم؟',
  unreadCount: 2, lastMessageAt: ago(10), operatorName: 'سارا', operatorOnline: true,
};
const ALL_CONVERSATIONS: Conversation[] = [
  RECENT,
  { id: 'c-mahdi', status: 'resolved', preview: 'مبلغ بازگشتی به حساب‌تون واریز شد.', unreadCount: 0, lastMessageAt: at(15, 20, 1), operatorName: 'مهدی' },
  { id: 'c-reza', status: 'resolved', preview: 'ممنون از راهنمایی سریع‌تون!', unreadCount: 0, outbound: true, lastMessageAt: at(11, 5, 5), operatorName: 'رضا' },
];

interface Fixture {
  config: Record<string, unknown>;
  identity: Record<string, unknown>;
  conversations: Conversation[];
  threads: Record<string, Msg[]>;
  assignedOperator: Record<string, unknown> | null;
  /** A thread's own assigned operator (history), by conversation; else `assignedOperator`. */
  operators?: Record<string, Record<string, unknown> | null>;
  qna: string[];
  /** POST /api/widget/message answers 500 (a send that fails). */
  messageFails?: boolean;
  /** GET /api/widget/conversations answers 500 (the list failed). */
  conversationsFail?: boolean;
  /** GET /api/widget/conversations never answers (the list loading). */
  conversationsHang?: boolean;
  /**
   * A state's own help center (categories, articles, search answers, article
   * body, the articles' author with meta=1); default the shared one.
   */
  kb?: { categories: unknown[]; articles: Array<Record<string, unknown>>; search: Record<string, unknown[]>; body?: string; author?: string };
  /** GET /api/widget/kb-suggest: the articles offered for a draft, by the draft (runtime-late.js, t2). */
  suggest?: Record<string, unknown[]>;
  /** GET /api/widget/conversations/:id/csat (the rating card, the transcript); default: nothing to rate, no transcript. */
  csat?: Record<string, unknown>;
  /** GET /api/widget/conversations/:id/reactions, by conversation: message id -> [{ emoji, count, mine }]. */
  reactions?: Record<string, Record<string, Array<{ emoji: string; count: number; mine: boolean }>>>;
  /** GET /api/widget/queue: the visitor's place (default: not queued). */
  queue?: { position: number | null; wait_minutes: number | null };
}

function baseFixture(): Fixture {
  return {
    config: {
      workspaceName: 'فروشگاه نیلوفر',
      brandName: 'فروشگاه نیلوفر',
      welcomeMessage: 'سلام! چطور می‌تونیم کمکتون کنیم؟',
      teamMembers: TEAM_ONLINE,
      showTeamAvatars: true,
      showLogo: true,
      poweredBy: { text: 'قدرت گرفته از', brand: 'وب‌یار', url: 'https://webyar.ai' },
      availability: { state: 'online', liveChatEnabled: true, next_open_at: null },
      edition: 'iran',
      timeZone: 'Asia/Tehran',
      calendar: 'persian',
      features: { chat: true, knowledgeBase: true },
      attachments: { enabled: true, maxSizeMb: 10, allowedMimes: ['image/png', 'image/jpeg', 'application/pdf'], voiceNotesEnabled: true },
      composer: { emojiEnabled: true },
      aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
      prechatEnabled: false,
      readReceipts: { enabled: true },
    },
    identity: { identity_state: 'anonymous', contact: null },
    conversations: [],
    threads: { 'c-sara': THREAD, 'c-files': ATTACHMENTS_THREAD },
    assignedOperator: { name: 'سارا', avatar: null, online: true },
    qna: ['پیگیری سفارش', 'مشاوره خرید', 'مرجوعی و بازگشت وجه', 'پشتیبانی فنی'],
  };
}

const RETURNING = { identity_state: 'identified', contact: { name: 'علی رضایی', email: 'ali@example.com' } };
const AWAY = (f: Fixture) => {
  f.config.teamMembers = TEAM_AWAY;
  const nineAm = at(9, 0, -1);
  f.config.availability = { state: 'offline', liveChatEnabled: true, offlineMode: 'capture_message', next_open_at: nineAm };
};
const PRECHAT = (require: boolean) => ({
  identity_state: 'anonymous',
  contact: null,
  prechat: {
    ask_name: true, require_name: require, ask_email: true, require_email: require, ask_phone: require, require_phone: false,
    timing: 'after_handoff',
  },
});

// ─── States ─────────────────────────────────────────────────────────────
interface Ctx { page: Page; fixture: Fixture }
interface StateSpec {
  /** Phone screen (390×844, the panel IS the screen). */
  mobile?: boolean;
  /** Land on home even when a live thread exists (the per-tab hint). */
  home?: boolean;
  setup?: (f: Fixture) => void;
  drive?: (c: Ctx) => Promise<void>;
  /** Shoot with the focus the drive left (a design drawn focused); default blurred. */
  keepFocus?: boolean;
  /** The page's clock starts here (ISO) and runs on: relative times and live lines agree with the fixture. */
  clock?: string;
}

const inst = (page: Page, js: string) => page.evaluate(`(function(i){ ${js} })(window.__inst)`);
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const online = (page: Page) => inst(page, "i.__test.setConnectionState('online');");
async function openThread(page: Page, cid: string) {
  await inst(page, `i.__test.openConversation(${JSON.stringify(cid)});`);
  await pause(page, 400);
  await online(page);
}
async function newConversation(page: Page) {
  await inst(page, 'i.__test.startNew();');
  await pause(page, 300);
  await online(page);
}
async function typing(page: Page, payload?: Record<string, unknown>) {
  await page.evaluate((p) => (window as unknown as { __gsTyping?: (p?: unknown) => void }).__gsTyping?.(p), payload);
}

// ─── Template 1's panels, with each panel's own demo content ────────────
// (handoff webyar/template-1-classic/screens/panels). States `t1-*`.
/** An attachment whose bytes never arrive: the image's loading look (04·05 draws its placeholder). */
const T1_SLOW_MEDIA = 'att-t1-slow';
const T1_THREADS: Record<string, Msg[]> = {
  // 04·05: a photo, the invoice, a voice note (sent, not yet seen).
  'c-t1-files': [
    visitor('g1', '', at(20, 4), { attachment: { id: T1_SLOW_MEDIA, kind: 'image', mime_type: 'image/jpeg', file_name: 'IMG_2041.jpg', size_bytes: 860_160 } }),
    sara('g2', '', at(20, 6), { attachment: MEDIA.pdf }),
    visitor('g3', '', at(20, 7), { attachment: MEDIA.voice, seen_at: null }),
  ],
  // 05·1, 05·2: the operator asks for a voice note.
  'c-t1-voice': [
    visitor('h1', 'سلام، کفشی که گرفتم یه ایراد کوچیک داره.', at(23, 55)),
    sara('h2', 'متأسفم! بررسی می‌کنیم.', at(23, 58)),
    sara('h3', 'اگه راحت‌ترید، می‌تونید مشکل رو صوتی توضیح بدید.', at(23, 58)),
  ],
  // 06·1–3: 04·04's first two messages (the reply without its link).
  'c-t1-emoji': [THREAD[0], sara('m2', 'سلام علی جان! سفارش‌تون امروز صبح ارسال شد. کد رهگیری: TR-2290-5531', at(19, 54))],
  // 08·a–c: the visitor's first message (Core draws the card inline once a
  // thread has one; an empty thread gets the full-screen form).
  'c-t1-card': [visitor('p1', 'سلام، درباره سفارشم سؤال دارم.', at(23, 40), { seen_at: null })],
  // 08·c: the team's answer, the queued row, the visitor's question.
  'c-t1-queue': [
    sara('q1', 'ممنون علی! یکی از همکارهام تا چند دقیقه دیگه جواب می‌ده. سؤال‌تون رو بنویسید.', at(23, 47)),
    {
      id: 'q2', role: 'system', sender_type: 'system', text: 'Your message is in the support queue.', time: at(23, 47),
      metadata: { kind: 'routing_in_queue' },
    },
    visitor('q3', 'سلام، سفارش ۴۸۲۱۳ هنوز کد رهگیری نداره.', at(23, 48), { seen_at: null }),
  ],
  // 12·15: the phone's conversation.
  'c-t1-phone': [
    visitor('k1', 'سلام، دوشنبه یه کفش سفارش دادم ولی هنوز کد رهگیری برام نیومده.', at(19, 42)),
    sara('k2', 'سلام علی جان، ممنون که پیام دادید.', at(19, 46)),
    sara('k3', 'لطفاً شماره سفارش‌تون رو بفرستید.', at(19, 46)),
    visitor('k4', 'حتماً، شماره سفارش ۴۸۲۱۳ هست', at(19, 50)),
    sara('k5', 'ممنون! سفارش‌تون امروز صبح ارسال شد.', at(19, 54)),
    sara('k6', 'کد رهگیری: TR-2290-5531', at(19, 54)),
    visitor('k7', 'عالیه، خیلی ممنون', at(19, 58)),
  ],
};
/** 09·12's article: a link, a heading, two steps and a tip. */
const T1_ARTICLE_BODY =
  '<p>بعد از ارسال سفارش، کد رهگیری برایتان پیامک و ایمیل می‌شود. همیشه می‌توانید آن را در ' +
  '<a href="https://example.com/account/orders">حساب کاربری › سفارش‌ها</a> هم ببینید.</p>' +
  '<h2>کد رهگیری کجاست؟</h2>' +
  '<ol><li>پیامک «سفارش شما ارسال شد» را باز کنید.</li><li>یا در حساب کاربری، روی سفارش بزنید و «پیگیری» را انتخاب کنید.</li></ol>' +
  '<blockquote>به‌روزرسانی وضعیت مرسوله ممکن است تا ۲۴ ساعت طول بکشد.</blockquote>';
const t1Thread = (f: Fixture, cid: string) => {
  f.identity = RETURNING;
  f.conversations = [{ ...RECENT, id: cid }];
  f.threads = { ...f.threads, ...T1_THREADS };
};
/** 08·a: name and e-mail required (the card marks only the optional phone), its own subtitle; nobody assigned yet. */
const t1PrechatCard = (f: Fixture) => {
  f.identity = {
    identity_state: 'anonymous', contact: null,
    prechat: { ask_name: true, require_name: true, ask_email: true, require_email: true, ask_phone: true, require_phone: false, timing: 'after_handoff' },
  };
  f.conversations = [{ ...RECENT, id: 'c-t1-card', preview: '', unreadCount: 0, operatorName: null, operatorOnline: false }];
  f.assignedOperator = null;
  f.threads = { ...f.threads, ...T1_THREADS };
  f.config.aiAgent = {
    ...(f.config.aiAgent as Record<string, unknown>),
    handoffPrechatMessageLocalized: { fa: 'سلام! خوش اومدید. قبل از شروع خودتون رو معرفی کنید تا اگه از سایت رفتید هم جواب‌تون برسه.' },
  };
};
/** 08·b: the pre-chat asked one question at a time, name and e-mail required, the phone optional. */
const t1Steps = (f: Fixture) => {
  f.identity = {
    identity_state: 'anonymous', contact: null,
    prechat: { ask_name: true, require_name: true, ask_email: true, require_email: true, ask_phone: true, require_phone: false, timing: 'always' },
  };
  f.config.templateOptions = { ...((f.config.templateOptions as Record<string, unknown>) || {}), prechatMode: 'steps' };
};
async function startSteps(page: Page) {
  await online(page);
  await page.locator('[data-home-action="chat"]').first().click();
  await pause(page, 400);
}
async function step(page: Page, value: string) {
  const input = page.locator('[data-prechat-step-input]');
  await input.fill(value);
  await input.press('Enter');
  await pause(page, 300);
}
const T1_TOPICS = [
  { label: 'پیگیری سفارش', icon: 'truck' }, { label: 'مشاوره خرید', icon: 'chat' },
  { label: 'مرجوعی و بازگشت وجه', icon: 'return' }, { label: 'پشتیبانی فنی', icon: 'help' },
];
async function recordFor(page: Page, ms: number) {
  await page.locator('[data-mic-btn]').click();
  await pause(page, ms);
}

// ─── Template 2's panels, with each panel's own demo content ────────────
// (handoff webyar/template-2-simple-home/screens/panels). States `t2-*`.
const T2_REPLY = 'معمولاً در ۲ دقیقه پاسخ می‌دهیم';
const t2Art = (slug: string, title: string, category: string, excerpt = '') =>
  ({ id: `t2-${slug}`, slug, title, excerpt, category_id: category, sort_order: 0, locale: 'fa' });
const t2Many = (n: number, category: string, prefix: string) =>
  Array.from({ length: n }, (_, i) => t2Art(`${prefix}-${i + 1}`, `${prefix} ${i + 1}`, category));
/** Home (01–03, 13): ۲۴ مقاله درباره سفارش، ارسال و مرجوعی. */
const T2_HOME_KB = {
  categories: [
    { id: 'h-orders', name: 'سفارش', slug: 'orders', description: '', icon: 'box', sort_order: 1 },
    { id: 'h-ship', name: 'ارسال', slug: 'shipping', description: '', icon: 'truck', sort_order: 2 },
    { id: 'h-returns', name: 'مرجوعی', slug: 'returns', description: '', icon: 'return', sort_order: 3 },
  ],
  articles: [...t2Many(10, 'h-orders', 'o'), ...t2Many(8, 'h-ship', 's'), ...t2Many(6, 'h-returns', 'r')],
  search: {},
};
/** Help (07, 08): four categories, three results for «ارسال», the article. */
const T2_HELP_KB = {
  categories: [
    { id: 'k-orders', name: 'سفارش و ارسال', slug: 'orders', description: '', icon: 'box', sort_order: 1 },
    { id: 'k-pay', name: 'پرداخت', slug: 'payments', description: '', icon: 'card', sort_order: 2 },
    { id: 'k-returns', name: 'مرجوعی', slug: 'returns', description: '', icon: 'return', sort_order: 3 },
    { id: 'k-account', name: 'حساب کاربری', slug: 'account', description: '', icon: 'person', sort_order: 4 },
  ],
  articles: [
    t2Art('track-order', 'چطور سفارشم را پیگیری کنم؟', 'k-orders'),
    ...t2Many(4, 'k-orders', 'o'), ...t2Many(4, 'k-pay', 'p'), ...t2Many(3, 'k-returns', 'r'), ...t2Many(6, 'k-account', 'a'),
  ],
  // With match=words the server cuts a snippet round the words it matched (03·07).
  search: {
    ارسال: [
      { ...t2Art('shipping-cost', 'زمان و هزینه ارسال', 'k-orders', 'زمان ارسال، هزینه‌ها و ارسال رایگان'), snippet: 'هزینه‌ی ارسال برای خریدهای بالای ۲ میلیون تومان رایگان است…', matches: ['ارسال'] },
      { ...t2Art('after-shipping', 'پیگیری مرسوله بعد از ارسال', 'k-orders', 'کد رهگیری و وضعیت مرسوله'), snippet: 'کد رهگیری را پیامک می‌کنیم؛ وضعیت را در حساب کاربری هم می‌بینید…', matches: ['ارسال'] },
      { ...t2Art('provinces', 'ارسال به شهرستان‌ها', 'k-orders', 'پست پیشتاز و زمان رسیدن'), snippet: 'سفارش‌های شهرستان با پست پیشتاز ۳ تا ۵ روزه می‌رسند…', matches: ['ارسال'] },
    ],
  },
  author: 'سارا',
  body:
    '<p>بعد از ارسال سفارش، کد رهگیری را برایتان پیامک و ایمیل می‌کنیم. همیشه می‌توانید آن را در ' +
    '<a href="https://example.com/account/orders">حساب کاربری، بخش سفارش‌ها</a> هم ببینید.</p>' +
    '<h2>کد رهگیری کجاست؟</h2>' +
    '<ol><li>پیامک «سفارش شما ارسال شد» را باز کنید.</li><li>یا در حساب کاربری روی سفارش بزنید.</li>' +
    '<li>دکمه‌ی «پیگیری مرسوله» را بزنید.</li></ol>' +
    '<blockquote>به‌روزرسانی وضعیت مرسوله ممکن است تا ۲۴ ساعت طول بکشد.</blockquote>',
};
const T2_OPEN: Conversation = {
  id: 'c-live', status: 'open', preview: 'خواهش می‌کنم! کار دیگری هست که کمک کنم؟',
  unreadCount: 2, lastMessageAt: ago(10), operatorName: 'سارا', operatorOnline: true,
};
/** The live one, then two closed ones (history: one conversation per visitor, a close ends one). */
const T2_CONVERSATIONS: Conversation[] = [
  T2_OPEN,
  { id: 'c-mahdi', status: 'closed', preview: 'مبلغ به حسابتان برگشت داده شد.', unreadCount: 0, lastMessageAt: at(15, 20, 1), operatorName: 'مهدی' },
  { id: 'c-reza', status: 'closed', preview: 'ممنون از راهنمایی سریعتان!', unreadCount: 0, outbound: true, lastMessageAt: at(11, 5, 5), operatorName: 'رضا' },
];
const T2_THREADS: Record<string, Msg[]> = {
  'c-live': [
    visitor('d1', 'سلام، سفارشم را دوشنبه ثبت کردم ولی هنوز کد رهگیری نیامده.', at(19, 42)),
    sara('d2', 'سلام علی! بررسی کردم؛ سفارشتان امروز صبح ارسال شد.', at(19, 44)),
    visitor('d3', 'عالیه، ممنون!', at(19, 46)),
  ],
  'c-media': [
    visitor('e1', '', at(20, 4), { attachment: { id: 'att-photo', kind: 'image', mime_type: 'image/jpeg', file_name: 'IMG_2041.jpg', size_bytes: 1_240_000 } }),
    sara('e2', '', at(20, 6), { attachment: MEDIA.pdf }),
    sara('e3', 'این هم فاکتور سفارشتان.', at(20, 6)),
    visitor('e4', '', at(20, 7), { attachment: MEDIA.voice }),
  ],
  'c-email': [visitor('f1', 'سلام، برای خرید عمده تخفیف دارید؟', at(19, 42))],
};
/** 05 (reactions): a thread whose operator lines the server stores (uuids: the heart is offered). */
const T2_REACT_ID = 'b1b1b1b1-0000-4000-8000-000000000002';
const T2_REACT_THREAD: Msg[] = [
  visitor('b1b1b1b1-0000-4000-8000-000000000001', 'سلام، فاکتور سفارش ۴۸۲۱۳ را می‌خواستم.', at(20, 4)),
  sara(T2_REACT_ID, 'این هم فاکتور سفارشتان.', at(20, 6)),
  sara('b1b1b1b1-0000-4000-8000-000000000003', 'کار دیگری هست که کمک کنم؟', at(20, 6)),
];
/** The design's workspace settings: reply time, topics, ask examples. */
function t2Workspace(f: Fixture, topics?: Array<{ label: string; icon: string }>) {
  f.config.replyTimeText = T2_REPLY;
  const opts = (f.config.templateOptions as Record<string, unknown>) || {};
  f.config.templateOptions = {
    ...opts,
    topics: opts.topics || topics || [
      { label: 'زمان ارسال', icon: 'truck' }, { label: 'مرجوعی کالا', icon: 'return' }, { label: 'راهنمای سایز', icon: 'ruler' },
    ],
    askExamples: opts.askExamples || ['سفارشم کی می‌رسد؟', 'سایز ۴۲ موجود است؟'],
  };
  f.threads = { ...f.threads, ...T2_THREADS };
}
/** Home (01–03): a store that answers order questions (the track-order row, `config.commerce`). */
const t2Home = (f: Fixture) => { t2Workspace(f); f.kb = T2_HOME_KB; f.config.commerce = { trackOrder: true }; };
const t2Help = (f: Fixture) => { t2Workspace(f); f.kb = T2_HELP_KB; };
/** 04 (the order card): Sara's answer carries the order (`metadata.kind` 'order_status'). */
const order = (o: Record<string, unknown>) => ({
  source: 'ai_agent', kind: 'order_status',
  order: { v: 1, number: '48213', summary: 'کفش رانینگ، سایز ۴۲', more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null, trackingUrl: 'https://tracking.post.ir/?id=48213', ...o },
});
/** A local calendar day `days` from today, as the store sends `arrives`. */
const dayAhead = (days: number) => {
  const { y, m, d } = tehranToday();
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
};
/** The weekday after today that is a Thursday (02·04 «تحویل: پنجشنبه»), within six days. */
const thursday = () => {
  const { y, m, d } = tehranToday();
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dayAhead(((4 - dow + 7) % 7) || 7);
};
const t2Order = (o: Record<string, unknown>, text = 'سلام علی! بررسی کردم؛ سفارشتان امروز صبح ارسال شد.') => (f: Fixture) => {
  t2Live(f);
  f.threads = {
    ...f.threads,
    'c-live': [
      visitor('d1', 'سلام، سفارشم را دوشنبه ثبت کردم ولی هنوز کد رهگیری نیامده.', at(19, 42)),
      sara('d2', text, at(19, 44), { metadata: order(o) }),
      visitor('d3', 'عالیه، ممنون!', at(19, 46)),
    ],
  };
};
/** 06: the articles offered for «مرجوعی کفش» (two of them, the word marked). */
const T2_SUGGEST = {
  'مرجوعی کفش': [
    { slug: 'returns', title: 'شرایط مرجوعی کالا', snippet: '', matches: ['مرجوعی'], readingMinutes: 2 },
    { slug: 'refund-time', title: 'بازگشت وجه بعد از مرجوعی چقدر طول می‌کشد؟', snippet: '', matches: ['مرجوعی'], readingMinutes: 1 },
  ],
};
/** An attachment whose bytes stop two thirds of the way (its download's progress). */
const SLOW_DOWNLOAD = 'att-dl';
/** 05: the operator's line under the invoice got the visitor's heart. */
const T2_MEDIA_REACTIONS = { 'c-media': { e3: [{ emoji: '\u2764\uFE0F', count: 1, mine: true }] } };
const t2Live = (f: Fixture) => { t2Workspace(f); f.identity = RETURNING; f.conversations = [T2_OPEN]; };
/** 12: the thread an operator closed, its line, and the rating card (the transcript offered). */
const T2_CLOSED: Msg[] = [
  visitor('r1', 'مرسی، مشکلم حل شد!', at(21, 12)),
  sara('r2', 'خوشحالم که حل شد! روز خوبی داشته باشید.', at(21, 13)),
  {
    id: 'r3', role: 'system', sender_type: 'system', text: 'سارا closed the conversation', time: at(21, 14),
    metadata: { kind: 'conversation_closed', by: 'agent', agent_name: 'سارا', operator_name: 'سارا', status: 'closed' },
  },
];
const AFTER_CHAT = {
  closed_id: 'r3', rateable: true, rating: null, operator: { name: 'سارا', avatar: null },
  transcript: { available: true, to: 'a•••@example.com' },
};
/** Closed while the visitor was away, Sara's last line unseen: their current conversation (one conversation, rule 2). */
const t2Closed = (f: Fixture) => {
  t2Live(f);
  f.conversations = [{ ...T2_OPEN, id: 'c-closed', status: 'closed', preview: 'خوشحالم که حل شد!', unreadCount: 1 }];
  f.threads = { ...f.threads, 'c-closed': T2_CLOSED };
  f.csat = AFTER_CHAT;
};
/** The chat bar's ⋯ pressed: its menu open (the transcript offered, the sounds on). */
async function openMenu(page: Page) {
  await page.locator('[data-chat-menu-toggle]').click();
  await pause(page, 400);
}

// ─── The International edition's fixture: the same store in English ──────
// (handoff respok/*/screens/panels). Every Persian string of the fixture and
// of the drives has its English line here: `tx()` reads a drive's typed
// text, `english()` swaps a whole fixture (keys too: the search answers by
// query).
/** On for one shot: --edition international in English or Turkish. */
let EN_FIXTURE = false;
const EN_ARTICLE_BODY =
  '<p>Once your order ships, we text and email you the tracking code. You can always find it in <strong>Account › Orders</strong> too.</p>' +
  '<h3>Where’s my tracking code?</h3>' +
  '<ol><li>Open the “Your order has shipped” text.</li><li>Or open the order in your account and choose “Track”.</li></ol>' +
  '<blockquote>Tracking can take up to 24 hours to update.</blockquote>' +
  '<p>' + 'If the tracking code has not reached you one working day after shipping, chat with us here and we will look into it. '.repeat(6) + '</p>';
const EN_T1_ARTICLE_BODY =
  '<p>Once your order ships, we text and email you the tracking code. You can always find it in ' +
  '<a href="https://example.com/account/orders">Account › Orders</a> too.</p>' +
  '<h2>Where’s my tracking code?</h2>' +
  '<ol><li>Open the “Your order has shipped” text.</li><li>Or open the order in your account and choose “Track”.</li></ol>' +
  '<blockquote>Tracking can take up to 24 hours to update.</blockquote>';
const EN_T2_ARTICLE_BODY =
  '<p>Once your order ships, we text and email you a tracking code. You can always find it under ' +
  '<a href="https://example.com/account/orders">Your account, Orders</a> too.</p>' +
  '<h2>Where is my tracking code?</h2>' +
  '<ol><li>Open the “Your order has shipped” text or email.</li><li>Or open the order in your account.</li>' +
  '<li>Choose “Track package”.</li></ol>' +
  '<blockquote>Tracking can take up to 24 hours to show the first update.</blockquote>';
const EN = new Map<string, string>([
  ['سارا', 'Sara'], ['مهدی', 'Mehdi'], ['رضا', 'Reza'], ['علی', 'Ali'], ['علی رضایی', 'Ali Rezaei'], ['فروشگاه نیلوفر', 'Nilufar Store'],
  ['سلام! چطور می‌تونیم کمکتون کنیم؟', 'Hi! How can we help?'], ['سفارش و ارسال', 'Orders and shipping'],
  ['پیگیری، زمان و هزینه ارسال', 'Tracking, times and costs'], ['پرداخت و بازگشت وجه', 'Payments and refunds'],
  ['روش‌های پرداخت و مرجوعی', 'Ways to pay, and returns'], ['محصولات و سایزبندی', 'Products and sizing'],
  ['راهنمای سایز و جنس', 'Sizes and materials'], ['چطور سفارشم را پیگیری کنم؟', 'How do I track my order?'],
  ['کد رهگیری را پیامک می‌کنیم؛ وضعیت را در حساب کاربری هم می‌بینید…', 'We text you a tracking code; you can also follow it from your account…'],
  ['زمان و هزینه ارسال', 'Shipping times and costs'],
  ['هزینه‌ی ارسال برای خریدهای بالای ۲ میلیون تومان رایگان است…', 'Free delivery on orders over $50; most parcels arrive in 2 to 3 days…'],
  ['شرایط مرجوعی و بازگشت وجه', 'Returns and refunds'],
  ['تا ۷ روز بعد از تحویل می‌توانید کالا را مرجوع کنید…', 'You can return an item up to 7 days after delivery…'],
  ['راهنمای انتخاب سایز', 'Size guide'], ['جدول سایز هر محصول در صفحه‌ی همان محصول است…', 'Every product page has its own size chart…'],
  ['ارسال به شهرستان‌ها', 'Delivery outside the city'],
  ['سفارش‌های شهرستان با پست پیشتاز ۳ تا ۵ روزه می‌رسند…', 'Orders outside the city arrive by courier in 3 to 5 days…'],
  ['تغییر آدرس تحویل', 'Changing the delivery address'], ['ارسال فوری در تهران', 'Same-day delivery'], ['روش‌های پرداخت', 'Payment methods'],
  ['بازگشت وجه چقدر طول می‌کشد؟', 'How long does a refund take?'], ['خرید اقساطی', 'Paying in instalments'],
  ['جنس و نگهداری محصولات', 'Materials and care'], ['سایز کفش رانینگ', 'Running shoe sizes'], [ARTICLE_BODY, EN_ARTICLE_BODY],
  [T1_ARTICLE_BODY, EN_T1_ARTICLE_BODY], [T2_HELP_KB.body, EN_T2_ARTICLE_BODY],
  ['پیگیری مرسوله بعد از ارسال', 'Tracking a parcel after delivery starts'], ['عکس-محصول.jpg', 'product-photo.jpg'],
  ['فاکتور-۴۸۲۱۳.pdf', 'invoice-48213.pdf'], ['پیام صوتی.wav', 'voice-message.wav'], ['رسید-پرداخت.jpg', 'payment-receipt.jpg'],
  ['سلام، کد رهگیری سفارشم هنوز نیومده.', 'Hi! My tracking code still hasn’t arrived.'],
  ['سلام علی جان! سفارش‌تون امروز صبح ارسال شد. کد رهگیری: TR-2290-5531\nhttps://post.ir', 'Hi Ali! Your order shipped this morning. Tracking code: TR-2290-5531\nhttps://nilufar.store'],
  ['> سارا: کد رهگیری: TR-2290-5531\n\nعالیه، خیلی ممنون', '> Sara: Tracking code: TR-2290-5531\n\nPerfect, thank you!'],
  ['این هم فاکتور سفارشتان.', 'Here’s the invoice for your order.'],
  ['خواهش می‌کنم! کار دیگه‌ای هست که بتونم کمکتون کنم؟', 'You’re welcome! Anything else I can help with?'],
  ['مبلغ بازگشتی به حساب‌تون واریز شد.', 'Your refund has been sent to your account.'], ['ممنون از راهنمایی سریع‌تون!', 'Thanks for the quick help!'],
  ['پیگیری سفارش', 'Track an order'], ['مشاوره خرید', 'Help choosing'], ['مرجوعی و بازگشت وجه', 'Returns and refunds'],
  ['پشتیبانی فنی', 'Technical support'], ['سلام، کفشی که گرفتم یه ایراد کوچیک داره.', 'Hi, the shoes I got have a small defect.'],
  ['متأسفم! بررسی می‌کنیم.', 'Sorry about that! We’ll look into it.'],
  ['اگه راحت‌ترید، می‌تونید مشکل رو صوتی توضیح بدید.', 'If it’s easier, you can describe it in a voice message.'],
  ['سلام علی جان! سفارش‌تون امروز صبح ارسال شد. کد رهگیری: TR-2290-5531', 'Hi Ali! Your order shipped this morning. Tracking code: TR-2290-5531'],
  ['سلام، درباره سفارشم سؤال دارم.', 'Hi, I have a question about my order.'],
  ['ممنون علی! یکی از همکارهام تا چند دقیقه دیگه جواب می‌ده. سؤال‌تون رو بنویسید.', 'Thanks, Ali! A teammate will reply in a few minutes. Go ahead and ask your question.'],
  ['سلام، سفارش ۴۸۲۱۳ هنوز کد رهگیری نداره.', 'Hi, order 48213 still has no tracking code.'],
  ['سلام، دوشنبه یه کفش سفارش دادم ولی هنوز کد رهگیری برام نیومده.', 'Hi, I ordered shoes on Monday but still don’t have a tracking code.'],
  ['سلام علی جان، ممنون که پیام دادید.', 'Hi Ali, thanks for your message.'],
  ['لطفاً شماره سفارش‌تون رو بفرستید.', 'Could you send me your order number?'], ['حتماً، شماره سفارش ۴۸۲۱۳ هست', 'Sure, it’s order 48213'],
  ['ممنون! سفارش‌تون امروز صبح ارسال شد.', 'Thanks! Your order shipped this morning.'], ['کد رهگیری: TR-2290-5531', 'Tracking code: TR-2290-5531'],
  ['عالیه، خیلی ممنون', 'Perfect, thank you!'],
  ['سلام! خوش اومدید. قبل از شروع خودتون رو معرفی کنید تا اگه از سایت رفتید هم جواب‌تون برسه.', 'Hi, welcome! Before we start, tell us who you are so the reply reaches you even if you leave.'],
  ['معمولاً در ۲ دقیقه پاسخ می‌دهیم', 'usually replies in 2 minutes'], ['سفارش', 'Orders'], ['ارسال', 'Delivery'], ['مرجوعی', 'Returns'],
  ['پرداخت', 'Payments'], ['حساب کاربری', 'Your account'], ['زمان ارسال، هزینه‌ها و ارسال رایگان', 'Delivery times, costs and free delivery'],
  ['کد رهگیری و وضعیت مرسوله', 'Tracking code and parcel status'], ['پست پیشتاز و زمان رسیدن', 'Courier and arrival times'],
  ['خواهش می‌کنم! کار دیگری هست که کمک کنم؟', 'You’re welcome! Anything else I can help with?'],
  ['مبلغ به حسابتان برگشت داده شد.', 'Your refund is on its way to your card.'], ['ممنون از راهنمایی سریعتان!', 'Thanks for the quick help!'],
  ['سلام، سفارشم را دوشنبه ثبت کردم ولی هنوز کد رهگیری نیامده.', 'Hi, I ordered on Monday but still don’t have a tracking code.'],
  ['سلام علی! بررسی کردم؛ سفارشتان امروز صبح ارسال شد.', 'Hi Ali! I checked: your order shipped this morning.'], ['عالیه، ممنون!', 'Great, thanks!'],
  ['سلام، برای خرید عمده تخفیف دارید؟', 'Hi, do you offer discounts on bulk orders?'], ['سلام، برای سفارش عمده تخفیف دارید؟', 'Hi, do you offer discounts on bulk orders?'],
  ['سلام، فاکتور سفارش ۴۸۲۱۳ را می‌خواستم.', 'Hi, could I have the invoice for order 48213?'],
  ['کار دیگری هست که کمک کنم؟', 'Anything else I can help with?'], ['زمان ارسال', 'Delivery'], ['مرجوعی کالا', 'Returns'], ['راهنمای سایز', 'Sizing'],
  ['سفارشم کی می‌رسد؟', 'When will my order arrive?'], ['سایز ۴۲ موجود است؟', 'Is size 42 in stock?'],
  ['کفش رانینگ، سایز ۴۲', 'Running shoes, size 42'], ['مرجوعی کفش', 'return shoes'], ['مرسی، مشکلم حل شد!', 'Thanks, that sorted it!'],
  ['خوشحالم که حل شد! روز خوبی داشته باشید.', 'Glad that’s sorted! Have a great day.'],
  ['سارا closed the conversation', 'Sara closed the conversation'], ['خوشحالم که حل شد!', 'Glad that’s sorted!'],
  ['سارا joined the conversation.', 'Sara joined the conversation.'], ['مهدی joined the conversation.', 'Mehdi joined the conversation.'],
  ['آدرس جدید: تهران، خیابان ولیعصر، پلاک ۱۲', 'New address: 12 Rosewood Ave, Apt 4'],
  ['می‌تونم آدرس تحویل رو تغییر بدم؟', 'Can I change the delivery address?'],
  ['سلام! چطور می‌تونیم کمکتون کنیم؟\nبرای اینکه سریع‌تر به نفر درست وصل بشید، موضوع رو انتخاب کنید:', 'Hi! How can we help?\nPick a topic so we can connect you with the right person faster:'],
  ['عالیه، خیلی ممنون 😍', 'Perfect, thank you! 😍'], ['معمولاً تا ۲ ساعت', 'usually replies within 2 hours'], ['قلب', 'heart'], ['زرافه', 'giraffe'],
  ['موضوع دیگر', 'Something else'],
  ['سلام! سؤالتان را بنویسید یا یکی از موضوع‌ها را انتخاب کنید.', 'Hi! Type your question, or pick a topic to get started.'],
  ['سؤالتان به تیم رسید؛ معمولاً در چند دقیقه پاسخ می‌دهیم.', 'Got it, the team has your question and usually replies within minutes.'],
  ['سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟', 'Hi, when will size 42 of these shoes be back in stock?'],
  ['سفارشتان تحویل داده شده است.', 'Your order has been delivered.'], ['این سفارش لغو شده است.', 'This order has been cancelled.'],
  // One conversation per visitor (states one-*).
  ['عالیه، خیلی ممنون 🙏', 'Perfect, thank you! 🙏'], ['سلام، کفش رو مرجوع کردم. مبلغش کی برمی‌گرده؟', 'Hi, I returned the shoes. When will I get my refund?'],
  ['سلام! بسته به انبار رسید و بررسی شد.', 'Hi! The parcel reached our warehouse and has been checked.'],
  ['سایز ۴۲ این مدل موجود است و فردا ارسال می‌شود.', 'Size 42 of this model is in stock and ships tomorrow.'],
  ['لینک پیگیری مرسوله رو براتون فرستادم. روز خوبی داشته باشید!', 'I’ve sent you the tracking link. Have a great day!'],
  ['نه، ممنون. همه‌چیز عالی بود.', 'No, thanks. Everything was great.'],
  ['خوشحالم که کمک کردم. روز خوبی داشته باشید! 🌸', 'Happy to help. Have a great day! 🌸'],
  ['مهدی closed the conversation', 'Mehdi closed the conversation'],
  ['راستی، فاکتور سفارش رو هم می‌خواستم.', 'Oh, and could I have the invoice for my order too?'],
]);
/** Objects swapped whole: their words are marked, so a word-for-word swap would not match them. */
const EN_SWAPS = new Map<unknown, unknown>([
  [T2_SUGGEST, {
    'return shoes': [
      { slug: 'returns', title: 'Return conditions', snippet: '', matches: ['return'], readingMinutes: 2 },
      { slug: 'refund-time', title: 'How long does a refund take after a return?', snippet: '', matches: ['return'], readingMinutes: 1 },
    ],
  }],
]);
/** A drive's typed text, in the shot's language. */
const tx = (s: string) => (EN_FIXTURE ? EN.get(s) ?? s : s);
function english<T>(v: T): T {
  if (EN_SWAPS.has(v)) return EN_SWAPS.get(v) as T;
  if (typeof v === 'string') return (EN.get(v) ?? v) as T;
  if (Array.isArray(v)) return v.map(english) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [EN.get(k) ?? k, english(x)])) as T;
  return v;
}
/**
 * The International edition as its bootstrap names it (config.edition,
 * Gregorian dates in the visitor's zone, the platform's logo as the credit:
 * the direction's lockup), and in English or Turkish the store in English.
 */
function international(f: Fixture, locale: string, direction: 'thread' | 'open') {
  if (locale !== 'fa') {
    if (!f.kb) f.kb = { categories: CATEGORIES, articles: ARTICLES, search: SEARCH, body: ARTICLE_BODY };
    for (const key of ['config', 'identity', 'conversations', 'threads', 'assignedOperator', 'operators', 'qna', 'kb', 'suggest', 'csat', 'reactions'] as const) {
      (f as unknown as Record<string, unknown>)[key] = english(f[key]);
    }
    // A localized line the runtime reads in the visitor's language.
    const ai = f.config.aiAgent as { handoffPrechatMessageLocalized?: Record<string, string> } | undefined;
    if (ai?.handoffPrechatMessageLocalized?.fa) ai.handoffPrechatMessageLocalized = { [locale]: english(ai.handoffPrechatMessageLocalized.fa) };
  }
  Object.assign(f.config, {
    edition: 'international', calendar: 'gregorian', timeZone: null,
    poweredBy: {
      text: locale === 'fa' ? 'قدرت گرفته از' : 'Powered by', brand: 'Respok', url: 'https://respok.app',
      logo: `${ORIGIN}/brand/intl/respok-${direction}-horizontal-color.svg`,
    },
  });
}

// ─── The owner's RESPOK screenshots (2026-10-18): the thread's people ───
/** An operator's photo, served by routeApi (a file under public/ would ship). */
const HARNESS_AVATAR = `${ORIGIN}/harness/avatar.svg`;
const AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#D9C7B4"/>' +
  '<circle cx="48" cy="40" r="19" fill="#6B4E3A"/><path d="M12 96c4-24 19-34 36-34s32 10 36 34z" fill="#23222B"/></svg>';
/** Ids the server stores (uuids), so each operator line offers the heart too. */
const p4Id = (n: number) => `c0c0c0c0-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const withPhoto = (m: Msg): Msg => ({ ...m, sender_avatar: HARNESS_AVATAR });
/** Sara (with her photo) answering: two runs of two lines. */
const OPERATOR_THREAD: Msg[] = [
  visitor(p4Id(1), 'سلام، دوشنبه یه کفش سفارش دادم ولی هنوز کد رهگیری برام نیومده.', at(19, 40)),
  withPhoto(sara(p4Id(2), 'سلام علی جان، ممنون که پیام دادید.', at(19, 41))),
  withPhoto(sara(p4Id(3), 'لطفاً شماره سفارش‌تون رو بفرستید.', at(19, 41))),
  visitor(p4Id(4), 'حتماً، شماره سفارش ۴۸۲۱۳ هست', at(19, 43)),
  withPhoto(sara(p4Id(5), 'ممنون! سفارش‌تون امروز صبح ارسال شد.', at(19, 44))),
  withPhoto(sara(p4Id(6), 'کد رهگیری: TR-2290-5531', at(19, 44))),
];
/** The server's line right before a person's first message after the AI or a colleague (2026-10-23). */
const joined = (id: string, name: string, time: string): Msg => ({
  id, role: 'system', sender_type: 'system', text: `${name} joined the conversation.`, time,
  metadata: { kind: 'routing_agent_joined', agent_name: name },
});
/** The AI, then Sara (two runs), then Mehdi: who answers changes hands twice, each newcomer introduced by the join line. */
const handoverThread = (): Msg[] => [
  visitor(p4Id(11), 'سلام، سفارش ۴۸۲۱۳ هنوز کد رهگیری نداره.', at(19, 30)),
  {
    id: p4Id(12), role: 'agent', sender_type: 'ai', sender_name: EN_FIXTURE ? 'Assistant' : 'دستیار', sender_avatar: null,
    text: 'ممنون علی! یکی از همکارهام تا چند دقیقه دیگه جواب می‌ده. سؤال‌تون رو بنویسید.', time: at(19, 30),
  },
  joined(p4Id(18), 'سارا', at(19, 31)),
  sara(p4Id(13), 'سلام علی جان، ممنون که پیام دادید.', at(19, 31)),
  sara(p4Id(14), 'لطفاً شماره سفارش‌تون رو بفرستید.', at(19, 31)),
  visitor(p4Id(15), 'حتماً، شماره سفارش ۴۸۲۱۳ هست', at(19, 32)),
  sara(p4Id(16), 'ممنون! سفارش‌تون امروز صبح ارسال شد.', at(19, 33)),
  joined(p4Id(19), 'مهدی', at(19, 40)),
  { ...sara(p4Id(17), 'کد رهگیری: TR-2290-5531', at(19, 40)), sender_name: 'مهدی' },
];
const P4_OPEN: Conversation = {
  id: 'c-op', status: 'open', preview: 'کد رهگیری: TR-2290-5531', unreadCount: 0, lastMessageAt: at(19, 44),
  operatorName: 'سارا', operatorOnline: true,
};
/** A returning visitor with an open conversation, Sara (online, with her photo) answering. */
function chatOperator(f: Fixture) {
  f.identity = RETURNING;
  f.conversations = [P4_OPEN];
  f.threads = { ...f.threads, 'c-op': OPERATOR_THREAD, 'c-handover': handoverThread() };
  f.assignedOperator = { name: 'سارا', avatar: HARNESS_AVATAR, online: true };
  f.config.teamMembers = [{ name: 'سارا', avatar: HARNESS_AVATAR, online: true }, ...TEAM_ONLINE.slice(1)];
}
function chatHandover(f: Fixture) {
  chatOperator(f);
  f.conversations = [{ ...P4_OPEN, id: 'c-handover', operatorName: 'مهدی' }];
  f.assignedOperator = { name: 'مهدی', avatar: null, online: true };
}
/** The AI answering alone (its "thinking" row follows the visitor's next message). */
function chatAi(f: Fixture) {
  chatOperator(f);
  f.config.aiAgent = { ...(f.config.aiAgent as Record<string, unknown>), suppressGreeting: true };
  f.conversations = [{ ...P4_OPEN, id: 'c-ai', operatorName: null }];
  f.threads = { ...f.threads, 'c-ai': handoverThread().slice(0, 2) };
  f.assignedOperator = null;
}
/** The AI's answer alone in the thread, as its greeting is before the visitor writes. */
function chatAiIntro(f: Fixture) {
  chatAi(f);
  f.threads = { ...f.threads, 'c-ai': handoverThread().slice(1, 2) };
}
/** Opens a thread once its rows are drawn and the line is up (no fixed wait). */
async function openRows(page: Page, cid: string) {
  await inst(page, `i.__test.openConversation(${JSON.stringify(cid)});`);
  await page.locator('[data-chat-messages] .msg-row').first().waitFor();
  await online(page);
}

// ─── One conversation per visitor (the owner's decision, 2026-10-23) ─────
// A renderer drawing the past bar (t1, t2, default): home shows the
// current conversation (t1: or the team card, the bar's middle tab opens it;
// t2: its continue row; default: its one button), the others are history
// («گفتگوهای قبلی»), a closed one opened read-only. A resolved one is still
// the visitor's (2026-10-24): only a close ends it. States `one-*` (the ⋯
// ones are t1's and t2's; t2's own: `t2-one-*`).
// They run on the designs' clock (`clock`): today 20:05 in Tehran, so the
// thread's 19:42-20:03 has passed, a row from yesterday reads «دیروز» and
// a line sent during the drive comes after the close, at 20:05.
const ONE_NOW = at(20, 5);
const ONE_LIVE_THREAD: Msg[] = [
  visitor('o1', 'سلام، کد رهگیری سفارشم هنوز نیومده.', at(19, 42)),
  sara('o2', 'سلام علی جان! سفارش‌تون امروز صبح ارسال شد. کد رهگیری: TR-2290-5531', at(19, 54)),
  visitor('o3', 'عالیه، خیلی ممنون 🙏', at(19, 58)),
  sara('o4', 'خواهش می‌کنم! کار دیگه‌ای هست که بتونم کمکتون کنم؟', at(20, 0)),
];
const mahdi = (id: string, text: string, time: string, extra: Msg = {}): Msg => ({ ...sara(id, text, time, extra), sender_name: 'مهدی' });
const reza = (id: string, text: string, time: string, extra: Msg = {}): Msg => ({ ...sara(id, text, time, extra), sender_name: 'رضا' });
const closedLine = (id: string, name: string | null, status: 'closed' | 'resolved', time: string, cid?: string): Msg => ({
  id, role: 'system', sender_type: 'system', text: `${name || 'Someone'} closed the conversation`, time,
  metadata: { kind: 'conversation_closed', by: name ? 'agent' : 'system', agent_name: name, operator_name: name, status },
  ...(cid ? { conversation_id: cid } : {}),
});
/** Mehdi's closed conversation (yesterday), its close recorded. */
const ONE_PAST_THREAD: Msg[] = [
  visitor('p1', 'سلام، کفش رو مرجوع کردم. مبلغش کی برمی‌گرده؟', at(15, 2, 1)),
  mahdi('p2', 'سلام! بسته به انبار رسید و بررسی شد.', at(15, 18, 1)),
  mahdi('p3', 'مبلغ بازگشتی به حساب‌تون واریز شد.', at(15, 20, 1)),
  closedLine('p4', 'مهدی', 'closed', at(15, 21, 1)),
];
/** Reza's (five days ago), closed before t1 drew closes: no line. */
const ONE_OLD_THREAD: Msg[] = [
  visitor('q1', 'سلام، فاکتور سفارش ۴۸۲۱۳ را می‌خواستم.', at(10, 52, 5)),
  reza('q2', 'این هم فاکتور سفارشتان.', at(11, 2, 5), { attachment: MEDIA.pdf }),
  visitor('q3', 'ممنون از راهنمایی سریع‌تون!', at(11, 5, 5)),
];
const ONE_PAST: Conversation[] = [
  { id: 'c-mahdi', status: 'closed', preview: 'مبلغ بازگشتی به حساب‌تون واریز شد.', unreadCount: 0, lastMessageAt: at(15, 20, 1), operatorName: 'مهدی' },
  { id: 'c-reza', status: 'closed', preview: 'ممنون از راهنمایی سریع‌تون!', unreadCount: 0, outbound: true, lastMessageAt: at(11, 5, 5), operatorName: 'رضا' },
  { id: 'c-ai-old', status: 'closed', preview: 'سایز ۴۲ این مدل موجود است و فردا ارسال می‌شود.', unreadCount: 0, lastMessageAt: at(18, 40, 12), operatorName: null },
];
/** A returning visitor (علی): the live conversation with Sara (2 unread), three finished ones. */
function oneLive(f: Fixture) {
  f.identity = RETURNING;
  f.conversations = [{ ...RECENT, lastMessageAt: at(20, 0) }, ...ONE_PAST];
  f.threads = { ...f.threads, 'c-sara': ONE_LIVE_THREAD, 'c-mahdi': ONE_PAST_THREAD, 'c-reza': ONE_OLD_THREAD };
  f.operators = { 'c-mahdi': { name: 'مهدی', avatar: null, online: true }, 'c-reza': { name: 'رضا', avatar: null, online: true } };
  // The ⋯ offers the transcript (a conversation the server can mail).
  f.csat = { closed_id: null, rateable: false, rating: null, operator: null, transcript: { available: true, to: 'a•••@example.com' } };
}
/** Only finished conversations: the next chat starts fresh, history is a tap away. */
function oneReturning(f: Fixture) {
  oneLive(f);
  f.conversations = [...ONE_PAST];
}
/** The conversation Sara closed while the visitor was away, her last reply unseen. */
function oneUnreadClosed(f: Fixture) {
  oneLive(f);
  f.conversations = [
    { ...RECENT, status: 'closed', unreadCount: 1, operatorOnline: false, lastMessageAt: at(17, 55),
      preview: 'لینک پیگیری مرسوله رو براتون فرستادم. روز خوبی داشته باشید!' },
    ...ONE_PAST,
  ];
}
async function oneHistory(page: Page) {
  // Home's way into history, whatever the template draws it as (never a tab).
  await page.locator('[data-body] [data-view="list"]:not(.wy-tab)').first().click();
  await page.locator('[data-conversation-open]').first().waitFor();
  await pause(page, 200);
}
/** History straight from Core (states the doors cannot reach in a fixture: empty, loading, failed). */
async function oneHistoryView(page: Page) {
  await inst(page, "i.setTab('list');");
  await pause(page, 500);
}
async function onePast(page: Page, cid: string) {
  await oneHistory(page);
  await page.locator(`[data-conversation-open="${cid}"]`).click();
  await page.locator('[data-chat-messages] .msg-row').first().waitFor();
  await page.locator('[data-past-bar]').waitFor();
  await pause(page, 300);
}
/** Sara closes while the visitor reads (06): the line arrives live, the composer stays. */
function oneClosing(f: Fixture) {
  oneLive(f);
  f.threads['c-sara'] = [
    ...ONE_LIVE_THREAD,
    visitor('o5', 'نه، ممنون. همه‌چیز عالی بود.', at(20, 1)),
    sara('o6', 'خوشحالم که کمک کردم. روز خوبی داشته باشید! 🌸', at(20, 2)),
  ];
}
async function oneClose(page: Page) {
  await openRows(page, 'c-sara');
  // The line, as each template draws it: t1's `.cl`, t2's system pill, default's quiet divider (`.msg-day`).
  const lines = page.locator('[data-chat-messages] .cl, [data-chat-messages] .msg-system-pill, [data-chat-messages] .msg-day');
  const before = await lines.count();
  await page.evaluate((row) => (window as unknown as { __gsMessage: (r: unknown[]) => void }).__gsMessage([row]),
    closedLine('o7', tx('سارا'), 'closed', at(20, 3), 'c-sara'));
  for (let i = 0; i < 60 && (await lines.count()) <= before; i++) await pause(page, 50);
  await pause(page, 300);
}

export const SCREEN_STATES: Record<string, StateSpec> = {
  'home-first-visit': { home: true },
  'home-recent-chat': {
    home: true,
    setup: (f) => { f.identity = RETURNING; f.conversations = [RECENT]; },
  },
  'team-away': { home: true, setup: AWAY },
  'thread-typing': {
    setup: (f) => { f.identity = RETURNING; f.conversations = [RECENT]; },
    drive: async ({ page }) => { await openThread(page, 'c-sara'); await typing(page); },
  },
  'attachments-failed': {
    setup: (f) => {
      f.identity = RETURNING;
      f.conversations = [{ ...RECENT, id: 'c-files' }];
      f.messageFails = true;
    },
    drive: async ({ page }) => {
      await openThread(page, 'c-files');
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('آدرس جدید: تهران، خیابان ولیعصر، پلاک ۱۲'));
      await input.press('Enter');
      await pause(page, 600);
      await typing(page);
    },
  },
  'new-conversation-topics': {
    setup: (f) => {
      const opts = (f.config.templateOptions as Record<string, unknown>) || {};
      if (!opts.topics) {
        f.config.templateOptions = {
          ...opts,
          topics: [
            { label: 'پیگیری سفارش', icon: 'truck' }, { label: 'مشاوره خرید', icon: 'chat' },
            { label: 'مرجوعی و بازگشت وجه', icon: 'return' }, { label: 'پشتیبانی فنی', icon: 'help' },
          ],
        };
      }
    },
    drive: async ({ page }) => { await newConversation(page); },
  },
  recording: {
    drive: async ({ page }) => {
      await newConversation(page);
      await page.locator('[data-mic-btn]').click();
      await pause(page, 1300);
    },
  },
  'voice-preview': {
    drive: async ({ page }) => {
      await newConversation(page);
      await page.locator('[data-mic-btn]').click();
      await pause(page, 1600);
      // A renderer that sends straight from the recorder (`recSend`) keeps
      // `data-rec-stop` hidden: there is no preview to show, so it is shot
      // while recording instead of timing out on a hidden button.
      const stop = page.locator('[data-rec-stop]');
      if (await stop.isVisible()) await stop.click();
      await pause(page, 900);
    },
  },
  'emoji-open': {
    drive: async ({ page }) => {
      await newConversation(page);
      await page.locator('[data-emoji-btn]').click();
      await pause(page, 200);
    },
  },
  'prechat-form-error': {
    home: true,
    setup: (f) => { f.identity = PRECHAT(true); },
    drive: async ({ page }) => {
      await online(page);
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      await page.locator('[data-prechat="name"]').fill(tx('علی'));
      await page.locator('[data-prechat="email"]').fill('ali@example');
      await page.locator('[data-prechat-submit]').click();
      await pause(page, 200);
    },
  },
  'away-message': {
    home: true,
    setup: AWAY,
    drive: async ({ page }) => {
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      const text = tx('سلام، برای سفارش عمده تخفیف دارید؟');
      // The leave-a-message form when the workspace asks for one; else the
      // thread accepts the message while the team is away.
      const form = page.locator('[data-fb="message"]');
      if (await form.count()) { await form.fill(text); return; }
      await online(page);
      const input = page.locator('[data-msg-input]');
      await input.fill(text);
      await input.press('Enter');
      await pause(page, 500);
    },
  },
  'messages-list': {
    home: true,
    setup: (f) => { f.identity = RETURNING; f.conversations = ALL_CONVERSATIONS; },
    drive: async ({ page }) => { await inst(page, "i.setTab('list');"); await pause(page, 300); },
  },
  'prechat-card-in-thread': {
    setup: (f) => { f.identity = PRECHAT(false); f.conversations = [RECENT]; },
    drive: async ({ page }) => { await openThread(page, 'c-sara'); },
  },
  // The same card submitted: the saved details (a template's summary card).
  'prechat-summary': {
    setup: (f) => { f.identity = PRECHAT(false); f.conversations = [RECENT]; },
    drive: async ({ page }) => {
      await openThread(page, 'c-sara');
      await page.locator('[data-prechat="name"]').fill(tx('علی رضایی'));
      await page.locator('[data-prechat="email"]').fill('ali@example.com');
      await page.locator('[data-prechat-submit]').click();
      await pause(page, 500);
    },
  },
  'help-list': {
    home: true,
    drive: async ({ page }) => { await inst(page, "i.setTab('help');"); await pause(page, 500); },
  },
  'help-search': {
    home: true,
    drive: async ({ page }) => {
      await inst(page, "i.setTab('help');");
      await pause(page, 500);
      // A template with search as you type (feature `kbSearch`) answers the
      // field; one without a field shows the plain list.
      const field = page.locator('[data-kb-search], .kb-search');
      if (await field.count()) {
        await field.first().fill(tx('ارسال'));
        await pause(page, 900);
      }
    },
  },
  article: {
    home: true,
    drive: async ({ page }) => { await inst(page, "i.setTab('help', 'track-order');"); await pause(page, 600); },
  },
  'mobile-home': { mobile: true, home: true, setup: (f) => { f.identity = RETURNING; f.conversations = [RECENT]; } },
  'mobile-thread': {
    mobile: true,
    setup: (f) => { f.identity = RETURNING; f.conversations = [RECENT]; },
    drive: async ({ page }) => { await openThread(page, 'c-sara'); },
  },
  // Template 1's panels with their own demo content (the bottom menu's
  // modes are home-recent-chat with --options '{"navMode":"both"}' etc.).
  't1-attachments': {
    keepFocus: true,
    setup: (f) => { t1Thread(f, 'c-t1-files'); f.messageFails = true; },
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-files');
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('آدرس جدید: تهران، خیابان ولیعصر، پلاک ۱۲'));
      await input.press('Enter');
      await pause(page, 600);
      // A real (tiny) JPEG padded to 1.2 MB: the thumbnail decodes, the size reads like the design's.
      const jpeg = Buffer.from(await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d')!;
        g.fillStyle = '#DCEBE7'; g.fillRect(0, 0, 32, 32);
        return c.toDataURL('image/jpeg').split(',')[1];
      }), 'base64');
      await page.locator('[data-attach-input]').setInputFiles({
        name: tx('رسید-پرداخت.jpg'), mimeType: 'image/jpeg', buffer: Buffer.concat([jpeg, Buffer.alloc(1_258_291 - jpeg.length, 0)]),
      });
      await pause(page, 500);
      await input.fill(tx('می‌تونم آدرس تحویل رو تغییر بدم؟'));
      await input.focus();
    },
  },
  't1-new-conversation': {
    setup: (f) => {
      f.config.welcomeMessage = 'سلام! چطور می‌تونیم کمکتون کنیم؟\nبرای اینکه سریع‌تر به نفر درست وصل بشید، موضوع رو انتخاب کنید:';
      const opts = (f.config.templateOptions as Record<string, unknown>) || {};
      f.config.templateOptions = { ...opts, topics: opts.topics || T1_TOPICS };
    },
    drive: async ({ page }) => { await newConversation(page); },
  },
  't1-recording': {
    setup: (f) => t1Thread(f, 'c-t1-voice'),
    drive: async ({ page }) => { await openThread(page, 'c-t1-voice'); await recordFor(page, 8300); },
  },
  't1-voice-preview': {
    setup: (f) => t1Thread(f, 'c-t1-voice'),
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-voice');
      await recordFor(page, 1600);
      await page.locator('[data-rec-stop]').click();
      await pause(page, 900);
    },
  },
  't1-emoji': {
    keepFocus: true,
    setup: (f) => t1Thread(f, 'c-t1-emoji'),
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-emoji');
      await page.locator('[data-msg-input]').fill(tx('عالیه، خیلی ممنون 😍'));
      await page.locator('[data-emoji-btn]').click();
      await pause(page, 300);
    },
  },
  // 06·1 / 06·3: the draft typed, the box focused, the picker still closed.
  't1-emoji-draft': {
    keepFocus: true,
    setup: (f) => t1Thread(f, 'c-t1-emoji'),
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-emoji');
      await page.locator('[data-msg-input]').fill(tx('عالیه، خیلی ممنون'));
      await page.locator('[data-msg-input]').focus();
    },
  },
  't1-prechat-error': {
    home: true,
    keepFocus: true,
    setup: (f) => { f.identity = PRECHAT(true); },
    drive: async ({ page }) => {
      await online(page);
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      await page.locator('[data-prechat="name"]').fill(tx('علی رضایی'));
      await page.locator('[data-prechat="email"]').fill('ali@example');
      await page.locator('[data-prechat-submit]').click();
      await pause(page, 200);
      await page.locator('[data-prechat="phone"]').focus();
    },
  },
  't1-prechat-card': {
    keepFocus: true,
    setup: t1PrechatCard,
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-card');
      await page.locator('[data-prechat="name"]').fill(tx('علی رضایی'));
      await page.locator('[data-prechat="email"]').focus();
    },
  },
  't1-prechat-summary': {
    setup: t1PrechatCard,
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-card');
      await page.locator('[data-prechat="name"]').fill(tx('علی رضایی'));
      await page.locator('[data-prechat="email"]').fill('ali@example.com');
      await page.locator('[data-prechat-submit]').click();
      await pause(page, 500);
    },
  },
  // 08·b: the pre-chat one question at a time (template option prechatMode
  // 'steps'): the name taken, an e-mail refused then taken, the phone step.
  't1-prechat-steps': {
    home: true,
    keepFocus: true,
    setup: t1Steps,
    drive: async ({ page }) => {
      await startSteps(page);
      await step(page, tx('علی رضایی'));
      await step(page, 'ali@example');
      await step(page, 'ali@example.com');
    },
  },
  't1-prechat-step-name': {
    home: true,
    keepFocus: true,
    setup: t1Steps,
    drive: async ({ page }) => { await startSteps(page); },
  },
  't1-prechat-step-error': {
    home: true,
    keepFocus: true,
    setup: t1Steps,
    drive: async ({ page }) => {
      await startSteps(page);
      await step(page, tx('علی رضایی'));
      await step(page, 'ali@example');
    },
  },
  // 08·c (top): the details sent, the saved summary with its "edit".
  't1-prechat-steps-saved': {
    home: true,
    setup: t1Steps,
    drive: async ({ page }) => {
      await startSteps(page);
      await step(page, tx('علی رضایی'));
      await step(page, 'ali@example.com');
      await page.locator('[data-prechat-step-skip]').click();
      await pause(page, 600);
    },
  },
  // 08·c: the details sent, then the visitor's first message (nobody assigned yet).
  't1-prechat-steps-sent': {
    home: true,
    setup: t1Steps,
    drive: async ({ page }) => {
      await startSteps(page);
      await step(page, tx('علی رضایی'));
      await step(page, 'ali@example.com');
      await page.locator('[data-prechat-step-skip]').click();
      await pause(page, 600);
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('سلام، سفارش ۴۸۲۱۳ هنوز کد رهگیری نداره.'));
      await input.press('Enter');
      await pause(page, 500);
    },
  },
  // 08·c: the queued row with the visitor's place.
  't1-queue': {
    setup: (f) => {
      t1Thread(f, 'c-t1-queue');
      f.identity = { identity_state: 'identified', contact: { name: 'علی رضایی', email: 'ali@example.com' } };
      f.queue = { position: 2, wait_minutes: 3 };
    },
    drive: async ({ page }) => { await openThread(page, 'c-t1-queue'); await pause(page, 400); },
  },
  't1-away-message': {
    home: true,
    setup: (f) => { AWAY(f); f.config.replyTimeText = 'معمولاً تا ۲ ساعت'; },
    drive: async ({ page }) => {
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      await online(page);
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('سلام، برای سفارش عمده تخفیف دارید؟'));
      await input.press('Enter');
      await pause(page, 500);
    },
  },
  // 07·09 answered: the e-mail saved, where the reply goes.
  't1-away-saved': {
    home: true,
    setup: (f) => { AWAY(f); f.config.replyTimeText = 'معمولاً تا ۲ ساعت'; },
    drive: async ({ page }) => {
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      await online(page);
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('سلام، برای سفارش عمده تخفیف دارید؟'));
      await input.press('Enter');
      await pause(page, 500);
      await page.locator('.away-reply [data-fb="email"]').fill('ali@example.com');
      await page.locator('.away-reply [data-fb-submit]').click();
      await pause(page, 500);
    },
  },
  // 06 with the search: «قلب» found, then a word nothing answers.
  't1-emoji-search': {
    keepFocus: true,
    setup: (f) => t1Thread(f, 'c-t1-emoji'),
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-emoji');
      await page.locator('[data-msg-input]').fill(tx('عالیه، خیلی ممنون'));
      await page.locator('[data-emoji-btn]').click();
      await pause(page, 300);
      await page.locator('[data-emoji-search]').fill(tx('قلب'));
      await pause(page, 600);
    },
  },
  't1-emoji-none': {
    keepFocus: true,
    setup: (f) => t1Thread(f, 'c-t1-emoji'),
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-emoji');
      await page.locator('[data-emoji-btn]').click();
      await pause(page, 300);
      await page.locator('[data-emoji-search]').fill(tx('زرافه'));
      await pause(page, 600);
    },
  },
  // 04·05's voice note still loading and the invoice downloading (each two thirds there).
  't1-downloading': {
    setup: (f) => {
      t1Thread(f, 'c-t1-files');
      f.threads = {
        ...f.threads,
        'c-t1-files': [
          sara('g2', '', at(20, 6), { attachment: { ...MEDIA.pdf, id: SLOW_DOWNLOAD } }),
          visitor('g3', '', at(20, 7), { attachment: { ...MEDIA.voice, id: SLOW_DOWNLOAD + '-voice' }, seen_at: null }),
        ],
      };
    },
    drive: async ({ page }) => {
      await openThread(page, 'c-t1-files');
      await page.locator(`[data-att-download="${SLOW_DOWNLOAD}"]`).first().click();
      await pause(page, 600);
      await page.mouse.move(0, 0);
    },
  },
  't1-help': {
    home: true,
    keepFocus: true,
    drive: async ({ page }) => {
      await inst(page, "i.setTab('help');");
      await pause(page, 500);
      await page.locator('[data-kb-search]').focus();
    },
  },
  't1-article': {
    home: true,
    setup: (f) => { f.kb = { categories: CATEGORIES, articles: ARTICLES, search: SEARCH, body: T1_ARTICLE_BODY, author: 'سارا' }; },
    drive: async ({ page }) => { await inst(page, "i.setTab('help', 'track-order');"); await pause(page, 600); },
  },
  't1-mobile-home': { mobile: true, home: true },
  't1-mobile-thread': {
    mobile: true,
    setup: (f) => t1Thread(f, 'c-t1-phone'),
    drive: async ({ page }) => { await openThread(page, 'c-t1-phone'); },
  },
  // Review checks (no panel): chat switched off (the article draws no ask
  // card), the monthly chat quota full while the team is online (the form
  // makes no "offline" claim), a reply-time note the workspace cleared.
  't1-chat-off-article': {
    home: true,
    setup: (f) => {
      f.config.features = { chat: false, knowledgeBase: true };
      f.kb = { categories: CATEGORIES, articles: ARTICLES, search: SEARCH, body: T1_ARTICLE_BODY };
    },
    drive: async ({ page }) => { await inst(page, "i.setTab('help', 'track-order');"); await pause(page, 600); },
  },
  't1-quota-full': {
    home: true,
    setup: (f) => { f.config.availability = { state: 'online', liveChatEnabled: true, quota_full: true, next_open_at: null }; },
    drive: async ({ page }) => {
      await online(page);
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 400);
    },
  },
  't1-reply-cleared': { home: true, setup: (f) => { f.config.replyTimeText = ''; } },
  // Template 2's panels (01–14) with their own demo content.
  't2-home-first-visit': { home: true, setup: t2Home },
  't2-home-returning': {
    home: true,
    setup: (f) => { t2Home(f); f.identity = RETURNING; f.conversations = T2_CONVERSATIONS; },
  },
  't2-home-away': { home: true, setup: (f) => { t2Home(f); AWAY(f); } },
  't2-live-chat': {
    setup: t2Live,
    drive: async ({ page }) => { await openThread(page, 'c-live'); await typing(page); },
  },
  't2-files-voice': {
    setup: (f) => { t2Live(f); f.conversations = [{ ...T2_OPEN, id: 'c-media' }]; f.messageFails = true; f.reactions = T2_MEDIA_REACTIONS; },
    drive: async ({ page }) => {
      await openThread(page, 'c-media');
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('آدرس جدید: تهران، خیابان ولیعصر، پلاک ۱۲'));
      await input.press('Enter');
      await pause(page, 600);
      await page.locator('[data-mic-btn]').click();
      await pause(page, 1300);
    },
  },
  't2-new-conversation': {
    keepFocus: true,
    setup: (f) => {
      t2Workspace(f, [
        { label: 'پیگیری سفارش', icon: 'box' }, { label: 'مشاوره خرید', icon: 'ruler' },
        { label: 'مرجوعی و بازگشت وجه', icon: 'return' }, { label: 'موضوع دیگر', icon: 'chat' },
      ]);
      f.config.welcomeMessage = 'سلام! سؤالتان را بنویسید یا یکی از موضوع‌ها را انتخاب کنید.';
      f.suggest = T2_SUGGEST;
    },
    drive: async ({ page }) => {
      await newConversation(page);
      await page.locator('[data-msg-input]').fill(tx('مرجوعی کفش'));
      // The articles offered for the draft (instant answers: 400 ms, then the answer).
      await pause(page, 900);
    },
  },
  't2-help-search': {
    home: true,
    keepFocus: true,
    setup: t2Help,
    drive: async ({ page }) => {
      await inst(page, "i.setTab('help');");
      await pause(page, 500);
      await page.locator('[data-kb-search]').fill(tx('ارسال'));
      await pause(page, 900);
    },
  },
  't2-article': {
    home: true,
    setup: t2Help,
    drive: async ({ page }) => { await inst(page, "i.setTab('help', 'track-order');"); await pause(page, 600); },
  },
  't2-conversations': {
    home: true,
    setup: (f) => { t2Live(f); f.conversations = T2_CONVERSATIONS; },
    drive: async ({ page }) => { await inst(page, "i.setTab('list');"); await pause(page, 300); },
  },
  't2-ask-email': {
    setup: (f) => {
      t2Live(f);
      f.identity = {
        identity_state: 'anonymous', contact: null,
        prechat: { ask_name: false, require_name: false, ask_email: true, require_email: false, ask_phone: false, require_phone: false, timing: 'after_handoff' },
      };
      f.conversations = [{ ...T2_OPEN, id: 'c-email', preview: 'سلام، برای خرید عمده تخفیف دارید؟', unreadCount: 0 }];
      f.config.aiAgent = { ...(f.config.aiAgent as Record<string, unknown>), handoffPrechatMessageLocalized: { fa: 'سؤالتان به تیم رسید؛ معمولاً در چند دقیقه پاسخ می‌دهیم.' } };
    },
    drive: async ({ page }) => { await openThread(page, 'c-email'); },
  },
  // 05: the heart the visitor gave the operator's line (the badge, and the
  // heart pressed among the line's actions).
  't2-reactions': {
    setup: (f) => {
      t2Live(f);
      f.conversations = [{ ...T2_OPEN, id: 'c-react' }];
      f.threads = { ...f.threads, 'c-react': T2_REACT_THREAD };
      f.reactions = { 'c-react': { [T2_REACT_ID]: [{ emoji: '\u2764\uFE0F', count: 1, mine: true }, { emoji: '👍', count: 1, mine: false }] } };
    },
    drive: async ({ page }) => {
      await openThread(page, 'c-react');
      await pause(page, 300);
      // The pointer on the reacted line: its actions show the heart pressed.
      await page.locator('.msg-line.rel > .msg').first().hover();
    },
  },
  't2-away-message': {
    home: true,
    setup: (f) => { t2Workspace(f); AWAY(f); },
    drive: async ({ page }) => {
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      const text = tx('سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟');
      const form = page.locator('[data-fb="message"]');
      if (await form.count()) { await form.fill(text); return; }
      await online(page);
      const input = page.locator('[data-msg-input]');
      await input.fill(text);
      await input.press('Enter');
      await pause(page, 500);
    },
  },
  // 04·11: the message left away by a visitor whose e-mail is known: where the reply goes.
  't2-away-saved': {
    home: true,
    setup: (f) => { t2Workspace(f); AWAY(f); f.identity = RETURNING; },
    drive: async ({ page }) => {
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 300);
      await online(page);
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟'));
      await input.press('Enter');
      await pause(page, 600);
    },
  },
  // 12: rating after a chat («عالی» picked), then sent; the bar's menu open (t1 and t2).
  't2-rating': {
    setup: t2Closed,
    drive: async ({ page }) => {
      await openThread(page, 'c-closed');
      await pause(page, 300);
      await page.locator('[data-csat-rate="5"]').click();
      // The pointer leaves (no hover lift in the shot).
      await page.mouse.move(0, 0);
    },
  },
  't2-rating-done': {
    setup: t2Closed,
    drive: async ({ page }) => {
      await openThread(page, 'c-closed');
      await pause(page, 300);
      await page.locator('[data-csat-rate="5"]').click();
      await page.locator('[data-csat-submit]').click();
      await pause(page, 500);
      await page.locator('[data-csat-transcript]').click();
      await pause(page, 500);
    },
  },
  't2-menu': {
    keepFocus: true,
    setup: (f) => { t2Live(f); f.csat = { ...AFTER_CHAT, closed_id: null, rateable: false }; },
    drive: async ({ page }) => { await openThread(page, 'c-live'); await openMenu(page); },
  },
  't1-menu': {
    keepFocus: true,
    setup: (f) => { f.identity = RETURNING; f.conversations = [RECENT]; f.csat = { ...AFTER_CHAT, closed_id: null, rateable: false }; },
    drive: async ({ page }) => { await openThread(page, 'c-sara'); await openMenu(page); },
  },
  // 04: an answer about an order and its card (shipped, a delivery day, the tracking link).
  't2-order-shipped': {
    setup: t2Order({ arrives: thursday() }),
    drive: async ({ page }) => { await openThread(page, 'c-live'); await typing(page); },
  },
  't2-order-completed': {
    setup: t2Order({ status: 'completed', step: 3, trackingUrl: null, summary: 'کفش رانینگ، سایز ۴۲', more: 2 }, 'سفارشتان تحویل داده شده است.'),
    drive: async ({ page }) => { await openThread(page, 'c-live'); },
  },
  't2-order-cancelled': {
    setup: t2Order({ status: 'cancelled', step: null, trackingUrl: null }, 'این سفارش لغو شده است.'),
    drive: async ({ page }) => { await openThread(page, 'c-live'); },
  },
  // 05: the invoice downloading (the arc two thirds round).
  't2-downloading': {
    setup: (f) => {
      t2Live(f);
      f.conversations = [{ ...T2_OPEN, id: 'c-media' }];
      f.threads = { ...f.threads, 'c-media': T2_THREADS['c-media'].map((m) => (m.id === 'e2' ? { ...m, attachment: { ...MEDIA.pdf, id: SLOW_DOWNLOAD } } : m)) };
    },
    drive: async ({ page }) => {
      await openThread(page, 'c-media');
      await page.locator(`[data-att-download="${SLOW_DOWNLOAD}"]`).click();
      await pause(page, 600);
      await page.mouse.move(0, 0);
    },
  },
  't2-mobile-home': { mobile: true, home: true, setup: t2Home },
  't2-mobile-chat': {
    mobile: true,
    setup: t2Live,
    drive: async ({ page }) => { await openThread(page, 'c-live'); await typing(page); },
  },
  // The phone's full-screen panel: the bar's menu open, and the rating card.
  't2-mobile-menu': {
    mobile: true,
    keepFocus: true,
    setup: (f) => { t2Live(f); f.csat = { ...AFTER_CHAT, closed_id: null, rateable: false }; },
    drive: async ({ page }) => { await openThread(page, 'c-live'); await openMenu(page); },
  },
  't2-mobile-rating': {
    mobile: true,
    setup: t2Closed,
    drive: async ({ page }) => { await openThread(page, 'c-closed'); await pause(page, 300); },
  },
  // The owner's RESPOK screenshots (2026-10-18): the operator answering
  // (the bar, the runs, their actions), a hand-over AI → Sara → Mehdi (the
  // names), the AI thinking, the help center with an open conversation and
  // no articles (its bar); the panel and the phone.
  'chat-operator': { setup: chatOperator, drive: async ({ page }) => { await openRows(page, 'c-op'); } },
  'chat-handover': { setup: chatHandover, drive: async ({ page }) => { await openRows(page, 'c-handover'); } },
  'chat-ai-thinking': {
    setup: chatAi,
    drive: async ({ page }) => {
      await openRows(page, 'c-ai');
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('عالیه، خیلی ممنون'));
      await input.press('Enter');
      await page.locator('.ai-thinking-row').waitFor();
    },
  },
  // A short thread (the visitor's first message and the AI's answer): it
  // starts at the top of the panel in every template (owner, 2026-10-23).
  'chat-ai-reply': { setup: chatAi, drive: async ({ page }) => { await openRows(page, 'c-ai'); } },
  // The AI's greeting alone, before the visitor writes.
  'chat-ai-intro': { setup: chatAiIntro, drive: async ({ page }) => { await openRows(page, 'c-ai'); } },
  'help-open-empty': {
    home: true,
    setup: (f) => { chatOperator(f); f.kb = { categories: [], articles: [], search: {} }; },
    drive: async ({ page }) => { await inst(page, "i.setTab('help');"); await page.locator('.wy-view-kb:not(.wy-skeleton)').waitFor(); },
  },
  'mobile-chat-ai-reply': { mobile: true, setup: chatAi, drive: async ({ page }) => { await openRows(page, 'c-ai'); } },
  'mobile-chat-ai-intro': { mobile: true, setup: chatAiIntro, drive: async ({ page }) => { await openRows(page, 'c-ai'); } },
  'mobile-chat-operator': { mobile: true, setup: chatOperator, drive: async ({ page }) => { await openRows(page, 'c-op'); } },
  'mobile-chat-handover': { mobile: true, setup: chatHandover, drive: async ({ page }) => { await openRows(page, 'c-handover'); } },
  'mobile-chat-ai-thinking': {
    mobile: true,
    setup: chatAi,
    drive: async ({ page }) => {
      await openRows(page, 'c-ai');
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('عالیه، خیلی ممنون'));
      await input.press('Enter');
      await page.locator('.ai-thinking-row').waitFor();
    },
  },
  'mobile-help-open-empty': {
    mobile: true,
    home: true,
    setup: (f) => { chatOperator(f); f.kb = { categories: [], articles: [], search: {} }; },
    drive: async ({ page }) => { await inst(page, "i.setTab('help');"); await page.locator('.wy-view-kb:not(.wy-skeleton)').waitFor(); },
  },
  // A long workspace name over a long operator name: each line of the bar ends in an ellipsis.
  'mobile-chat-long-names': {
    mobile: true,
    setup: (f) => {
      chatOperator(f);
      f.config.workspaceName = EN_FIXTURE ? 'Nilufar Handmade Leather Shoes and Accessories' : 'فروشگاه کفش و اکسسوری چرم دست‌دوز نیلوفر';
      f.assignedOperator = { name: EN_FIXTURE ? 'Mojtaba Davoudi-Kermanshahi Abolfazli' : 'مجتبی داوودی کرمانشاهی ابوالفضلی نژاد', avatar: HARNESS_AVATAR, online: true };
    },
    drive: async ({ page }) => { await openRows(page, 'c-op'); },
  },
  // One conversation per visitor (t1): the screens of the 2026-10-23 decision.
  'one-01-home-first-visit': { mobile: true, home: true, clock: ONE_NOW },
  'one-02-home-live': { mobile: true, home: true, clock: ONE_NOW, setup: oneLive },
  'one-03-home-returning': { mobile: true, home: true, clock: ONE_NOW, setup: oneReturning },
  'one-04-home-unread-closed': { mobile: true, home: true, clock: ONE_NOW, setup: oneUnreadClosed },
  'one-05-thread-menu-open': {
    mobile: true,
    keepFocus: true,
    clock: ONE_NOW,
    setup: oneLive,
    drive: async ({ page }) => { await openRows(page, 'c-sara'); await openMenu(page); },
  },
  'one-06-thread-closed-line': { mobile: true, clock: ONE_NOW, setup: oneClosing, drive: async ({ page }) => { await oneClose(page); } },
  'one-07-history': { mobile: true, home: true, clock: ONE_NOW, setup: oneLive, drive: async ({ page }) => { await oneHistory(page); } },
  'one-08-past-thread': { mobile: true, home: true, clock: ONE_NOW, setup: oneLive, drive: async ({ page }) => { await onePast(page, 'c-mahdi'); } },
  'one-09-fresh-thread': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: oneReturning,
    drive: async ({ page }) => {
      await online(page);
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 500);
    },
  },
  'one-10-home-live-desktop': { home: true, clock: ONE_NOW, setup: oneLive },
  // The visitor writes under the close: the next conversation, right there.
  'one-11-thread-write-after-close': {
    mobile: true,
    clock: ONE_NOW,
    setup: oneClosing,
    drive: async ({ page }) => {
      await oneClose(page);
      const input = page.locator('[data-msg-input]');
      await input.fill(tx('راستی، فاکتور سفارش رو هم می‌خواستم.'));
      await input.press('Enter');
      await pause(page, 900);
    },
  },
  'one-12-home-live-away': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); AWAY(f); f.conversations[0] = { ...f.conversations[0], operatorOnline: false }; },
  },
  'one-13-history-empty': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversations = []; },
    drive: async ({ page }) => { await oneHistoryView(page); },
  },
  'one-14-history-error': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversationsFail = true; },
    drive: async ({ page }) => { await oneHistoryView(page); },
  },
  'one-15-history-loading': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversationsHang = true; },
    drive: async ({ page }) => { await oneHistoryView(page); },
  },
  // Closed before t1 drew closes: no line; the bar alone says it.
  'one-16-past-thread-no-line': { mobile: true, home: true, clock: ONE_NOW, setup: oneLive, drive: async ({ page }) => { await onePast(page, 'c-reza'); } },
  // Nothing current: the bar offers to start one.
  'one-17-past-thread-nothing-current': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: oneReturning,
    drive: async ({ page }) => { await online(page); await onePast(page, 'c-mahdi'); },
  },
  // Nothing current and the team away: the bar offers to leave a message.
  'one-23-past-thread-away': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneReturning(f); AWAY(f); },
    drive: async ({ page }) => { await onePast(page, 'c-mahdi'); },
  },
  // A live conversation the visitor has read: the card's chevron says where it goes.
  'one-19-home-live-read': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversations[0] = { ...f.conversations[0], unreadCount: 0 }; },
  },
  // A resolved conversation is still the visitor's current one: the card, no line.
  'one-20-home-resolved': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversations[0] = { ...f.conversations[0], status: 'resolved' }; },
  },
  // An answer in an earlier conversation (Reza's), unseen: the history link
  // and the ⋯ item carry its count.
  'one-21-home-history-unread': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversations[2] = { ...f.conversations[2], unreadCount: 1 }; },
  },
  'one-22-thread-menu-history-unread': {
    mobile: true,
    keepFocus: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.conversations[2] = { ...f.conversations[2], unreadCount: 1 }; },
    drive: async ({ page }) => { await openRows(page, 'c-sara'); await openMenu(page); },
  },
  // t2: a past thread within the rating window keeps its card (usable), the bar under it.
  't2-one-past-thread-csat': {
    mobile: true,
    home: true,
    clock: ONE_NOW,
    setup: (f) => { oneLive(f); f.csat = { closed_id: 'p4', rateable: true, rating: null, operator: { name: 'مهدی', avatar: null }, transcript: { available: true, to: 'a•••@example.com' } }; },
    drive: async ({ page }) => { await onePast(page, 'c-mahdi'); await page.locator('[data-csat]').waitFor(); await pause(page, 900); },
  },
  // t2: a past thread's ⋯ (the transcript only).
  't2-one-past-thread-menu': {
    mobile: true,
    home: true,
    keepFocus: true,
    clock: ONE_NOW,
    setup: oneLive,
    drive: async ({ page }) => { await onePast(page, 'c-mahdi'); await openMenu(page); },
  },
  // A fresh thread's ⋯: history and the sound (no transcript before a message).
  'one-18-fresh-thread-menu': {
    mobile: true,
    home: true,
    keepFocus: true,
    clock: ONE_NOW,
    setup: oneReturning,
    drive: async ({ page }) => {
      await online(page);
      await page.locator('[data-home-action="chat"]').first().click();
      await pause(page, 500);
      await openMenu(page);
    },
  },
};

// ─── The fake widget API ────────────────────────────────────────────────
const IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#9BD8CC"/><stop offset="1" stop-color="#2F8F7E"/></linearGradient></defs>' +
  '<rect width="480" height="360" fill="url(#g)"/><circle cx="360" cy="110" r="46" fill="#F5D37A"/>' +
  '<path d="M0 300 L140 170 L260 280 L340 210 L480 330 L480 360 L0 360Z" fill="#1E6B5D"/></svg>';

/** 14 s of silence, 8 kHz 8-bit mono (a voice note's player needs a duration). */
function silentWav(seconds = 14): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}

/** A realtime driver that only exists to emit the operator's typing. */
const FAKE_DRIVER = `window.__gs_mod_rt_centrifugo = { create: function (ctx, resolved, hooks) {
  window.__gsTyping = function (p) { hooks.onTyping({ payload: p || { actor: 'agent' } }); };
  window.__gsMessage = function (rows) { hooks.onMessage({ messages: rows }); };
  return {
    connect: function () { hooks.onConnectionState('online'); },
    disconnect: function () {},
    subscribeConversation: function (cid) { setTimeout(function () { hooks.onSubscribed && hooks.onSubscribed({ conversationId: cid }); }, 0); },
    unsubscribeConversation: function () {},
    sendTyping: function () {},
    getCapabilities: function () { return { supportsTyping: true, supportsRealtime: true }; },
    hasCapability: function (k) { return k === 'supportsTyping' || k === 'supportsRealtime'; },
    getDriverName: function () { return 'centrifugo'; }
  };
} };`;

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

function hostPage(fontsFile: string | null, locale: string): string {
  const rtl = locale === 'fa';
  return `<!doctype html><html lang="${locale}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    (fontsFile ? `<link rel="stylesheet" id="gs-presentation-fonts" href="/widget/${fontsFile}">` : '') +
    '<style>html,body{margin:0;height:100%;background:#E7ECEF}</style></head><body><gs-widget id="gs-host"></gs-widget></body></html>';
}

async function routeApi(page: Page, fixture: Fixture, fontsFile: string | null, locale: string) {
  const wav = silentWav();
  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/widget/runtime-rt-centrifugo.js') {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_DRIVER });
    }
    if (p === '/harness/avatar.svg') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: AVATAR_SVG });
    if (p.startsWith('/widget/') || p.startsWith('/brand/')) {
      const file = path.join(root, 'public', p);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
        status: 200,
        contentType: CONTENT_TYPES[path.extname(p)] || 'application/octet-stream',
        body: readFileSync(file),
      });
    }
    if (p.endsWith('/api/widget/attachments/init')) return json({ attachment_id: 'att-new' });
    if (p.includes('/api/widget/attachments/') && p.endsWith('/upload')) return json({ ok: true });
    if (p.includes('/api/widget/attachments/')) {
      const id = p.split('/').pop();
      // Never answered: the image keeps its loading look (the context's close drops the request).
      if (id === T1_SLOW_MEDIA) return new Promise<void>(() => undefined);
      if (id === MEDIA.voice.id || id === 'att-new') return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE_SVG });
    }
    if (p.includes('/api/widget/conversations') && p.endsWith('/read')) return json({ ok: true });
    // A message's reactions (runtime-late.js, t2): the fixture's, and a toggle echoed.
    if (p.includes('/api/widget/conversations') && p.endsWith('/reactions')) {
      const cid = p.split('/').slice(-2)[0];
      if (method === 'POST') {
        const b = (route.request().postDataJSON() || {}) as Record<string, unknown>;
        return json({ ok: true, message_id: b.message_id, reactions: b.on ? [{ emoji: b.emoji, count: 1, mine: true }] : [], at: Date.now() });
      }
      return json({ reactions: (fixture.reactions || {})[cid] || {}, at: 1 });
    }
    // The place in the queue, the message left away and its email (runtime-late.js).
    if (p.endsWith('/api/widget/queue')) return json(fixture.queue || { position: null, wait_minutes: null });
    if (p.endsWith('/api/widget/offline-messages') && method === 'POST') {
      return json({ ok: true, captured: true, conversation_id: 'c-away', message_id: 'a9a9a9a9-0000-4000-8000-000000000001', transitioning: false });
    }
    if (p.endsWith('/api/widget/identity/offline-email') && method === 'POST') return json({ ok: true, contact_id: 'contact-1' });
    // The rating card and the transcript (runtime-late.js).
    if (p.includes('/api/widget/conversations') && p.endsWith('/csat')) {
      if (method === 'POST') {
        const b = (route.request().postDataJSON() || {}) as Record<string, unknown>;
        return json({ ok: true, rating: { score: b.rating, comment: b.comment ?? null, rated_at: new Date().toISOString() } });
      }
      return json(fixture.csat || { closed_id: null, rateable: false, rating: null, operator: null, transcript: { available: false, to: null } });
    }
    if (p.includes('/api/widget/conversations') && p.endsWith('/transcript')) {
      return json({ ok: true, to: (fixture.csat as { transcript?: { to?: string } } | undefined)?.transcript?.to || 'a•••@example.com' });
    }
    if (p.includes('/api/widget/conversations')) {
      if (fixture.conversationsFail) return json({ error: 'Internal error' }, 500);
      if (fixture.conversationsHang) return new Promise<void>(() => undefined);
      return json({
        conversations: fixture.conversations.map((c) => ({
          id: c.id, status: c.status, preview: c.preview, unreadCount: c.unreadCount, outbound: !!c.outbound,
          updatedAt: c.lastMessageAt, lastMessageAt: c.lastMessageAt, attachmentKind: null,
          operatorName: c.operatorName ?? null, operatorAvatar: null, operatorOnline: !!c.operatorOnline,
        })),
      });
    }
    if (p.includes('/api/widget/identity/history')) return json({ conversation_id: null, messages: [] });
    if (p.includes('/api/widget/identity/me')) return json(fixture.identity);
    if (p.includes('/api/widget/identity/prechat')) return json({ ok: true, contact_id: 'contact-1' });
    if (p.includes('/api/widget/history')) {
      const cid = url.searchParams.get('conversation_id') || '';
      const ops = fixture.operators || {};
      return json({ messages: fixture.threads[cid] || [], assigned_operator: cid in ops ? ops[cid] : fixture.assignedOperator });
    }
    if (p.includes('/api/widget/poll')) return json({ conversation_id: null, messages: [] });
    if (p.endsWith('/api/widget/message') && method === 'POST') {
      if (fixture.messageFails) return json({ error: 'Internal error' }, 500);
      return json({ ok: true, conversation_id: 'c-new', message_id: `m-${Date.now()}` });
    }
    if (p.includes('/api/realtime/connect')) {
      return json({ vendor: 'centrifugo', token: 't', ws_url: 'wss://realtime.test', capabilities: { supportsTyping: true, supportsRealtime: true } });
    }
    if (p.includes('/api/widget/ai-agent/qna-suggestions')) {
      return json({ questions: fixture.qna.map((question, i) => ({ id: `q${i}`, question })) });
    }
    const kb: NonNullable<Fixture['kb']> = fixture.kb || { categories: CATEGORIES, articles: ARTICLES, search: SEARCH, body: ARTICLE_BODY };
    if (p.includes('/api/widget/kb/categories')) return json({ locale, categories: kb.categories, articles: kb.articles });
    if (p.includes('/api/widget/kb/article')) {
      const slug = url.searchParams.get('slug');
      const a = kb.articles.find((x) => x.slug === slug);
      // Its author only with meta=1, as the server (a renderer that draws it asks).
      const meta = url.searchParams.get('meta') === '1' && kb.author ? { author_name: kb.author } : {};
      return a
        ? json({ article: { ...a, content: kb.body || ARTICLE_BODY, updated_at: at(10, 0, 3), ...meta } })
        : json({ error: 'not_found' }, 404);
    }
    if (p.includes('/api/widget/kb/search')) {
      const q = (url.searchParams.get('q') || '').trim();
      // The snippet and the matched words only for match=words (runtime-ext.js), as the server.
      const words = url.searchParams.get('match') === 'words';
      return json({ locale, q, results: (kb.search[q] || []).map((r) => {
        if (words) return r;
        const { snippet: _s, matches: _m, ...rest } = r as Record<string, unknown>;
        return rest;
      }) });
    }
    if (p.endsWith('/api/widget/kb-suggest')) {
      return json({ results: (fixture.suggest || {})[(url.searchParams.get('q') || '').trim()] || [] });
    }
    if (p.includes('/api/')) return json({});
    return route.fulfill({ status: 200, contentType: 'text/html', body: hostPage(fontsFile, locale) });
  });
}

/**
 * The loader's shell, reduced to what a screenshot needs (loader.js
 * SHELL_CSS): a zero-size corner anchor, or the whole screen on a phone.
 */
const SHELL_CSS = [
  ':host{all:initial;contain:layout style;}',
  '*,*::before,*::after{box-sizing:border-box;}',
  ".shell{font-family:var(--gs-presentation-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif);",
  'color:#1F2937;position:fixed;z-index:2147483646;width:0;height:0;}',
  '.shell.pos-bottom-right{bottom:24px;right:24px;}',
  '.shell.gs-mobile-open{top:0;left:0;right:0;bottom:auto;width:100vw;height:100dvh;}',
].join('');

// ─── Rendering ──────────────────────────────────────────────────────────
export interface ScreenOptions {
  templateId?: string;
  templateOptions?: Record<string, unknown>;
  locale?: 'fa' | 'en' | 'tr';
  /** The workspace colour; the seeded #3B82F6 means "uncustomised" (brand look). */
  accent?: string;
  states?: string[];
  outDir: string;
  chromiumPath?: string;
  /** Keep animations (default: reduced motion, so every shot is stable). */
  motion?: boolean;
  /** Keep the template's own panel size instead of 400×720. */
  nativeSize?: boolean;
  /** Classic (space-taking) scrollbars instead of overlay ones. */
  classicScrollbars?: boolean;
  /** Phone states: the screen's safe-area insets in CSS px (status bar, home indicator), e.g. { top: 0, bottom: 34 }. */
  safeArea?: { top: number; bottom: number };
  /** The late pack as the live widget gets it: asked for by runtime-ext.js after the first paint, not put on the page first. */
  lateAfter?: boolean;
  /** The edition the bootstrap names (default `iran`); `international` is RESPOK (the English fixture in en / tr). */
  edition?: 'iran' | 'international';
  /** Called after each PNG is written. */
  onShot?: (file: string) => void;
  /** Runs right before each shot (scratch inspection: measure, log, tweak). */
  beforeShot?: (page: Page, state: string) => Promise<void>;
}

export function resolveScreensChromium(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  for (const dir of ['/opt/pw-browsers', '/opt/ms-playwright']) {
    if (!existsSync(dir)) continue;
    for (const sub of readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const candidate = path.join(dir, sub, 'chrome-linux', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function shoot(browser: Browser, name: string, spec: StateSpec, opts: ScreenOptions): Promise<string> {
  const templateId = opts.templateId || 'default';
  const locale = opts.locale || 'fa';
  const tpl = templateAssets(templateId);
  const intl = opts.edition === 'international';
  EN_FIXTURE = intl && locale !== 'fa';
  const fixture = baseFixture();
  fixture.config.templateId = tpl.id;
  fixture.config.locale = locale;
  fixture.config.primaryColor = opts.accent || '#3B82F6';
  if (opts.templateOptions) fixture.config.templateOptions = { ...opts.templateOptions };
  if (spec.setup) spec.setup(fixture);
  // The International edition: its logo direction on the shell (the loader
  // puts lg-thread / lg-open there), the RESPOK kit on the launcher.
  const direction = (opts.templateOptions || {}).logoDirection === 'open' ? 'open' : 'thread';
  if (intl) international(fixture, locale, direction);
  const accent = String(fixture.config.primaryColor).trim();
  const uncustomised = !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent) || /^#3b82f6$/i.test(accent);
  const shellClass = intl ? ` lg-${direction}` : '';
  const launcherClass = intl ? ` rpk-kit${uncustomised ? ' rpk-kit-brand' : ''}` : '';

  const mobile = !!spec.mobile;
  const context: BrowserContext = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 460, height: 800 },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    locale: locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US',
    timezoneId: 'Asia/Tehran',
    reducedMotion: opts.motion ? 'no-preference' : 'reduce',
    permissions: ['microphone'],
  });
  try {
    const page = await context.newPage();
    if (mobile && opts.safeArea) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { left: 0, right: 0, ...opts.safeArea } } as never);
    }
    if (process.env.SCREENS_DEBUG) {
      page.on('console', (m) => console.log(`[${name}] console.${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
      page.on('request', (r) => { if (r.url().includes('/api/')) console.log(`[${name}] ${r.method()} ${r.url()}`); });
    }
    if (spec.clock) await page.clock.install({ time: spec.clock });
    await routeApi(page, fixture, tpl.fonts, locale);
    await page.addInitScript(([ws, home]) => {
      const w = window as unknown as Record<string, unknown>;
      w.__GS_WIDGET_TEST_HOOKS__ = true;
      if (home) sessionStorage.setItem(`gs:view:${ws}`, JSON.stringify({ tab: 'home', conversationId: null }));
      // An attachment whose bytes stop two thirds of the way (a route cannot
      // stream): its body a stream that never ends, with its whole length.
      const realFetch = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input instanceof Request ? input.url : input);
        if (!/\/api\/widget\/attachments\/att-dl/.test(u)) return realFetch(input, init);
        const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(163_840)); } });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '245760' } }));
      };
    }, [WORKSPACE, !!spec.home] as const);
    await page.goto(`${ORIGIN}/host`);
    // The renderer's extras and Core's late module are on the page before
    // runtime.js: runtime-ext.js then applies them before the first paint
    // (the live widget gets them after it), so every shot has them.
    // --late-after leaves them to runtime-ext.js, as the live widget.
    const late = tpl.extras && !opts.lateAfter ? [tpl.extras, 'runtime-late.js'] : [];
    for (const f of ['presentation-registry.js', tpl.script, ...late, 'runtime-chat.js', 'runtime.js']) {
      await page.addScriptTag({ url: `${ORIGIN}/widget/${f}` });
    }
    const css = [
      SHELL_CSS,
      readFileSync(path.join(root, 'public/widget/runtime.css'), 'utf8'),
      ...tpl.styles.map((f) => readFileSync(path.join(root, 'public/widget', f), 'utf8')),
      // Shots, not motion: the panel is simply open; desktop at the design's box.
      '.panel{transition:none!important;}',
      // Overlay scrollbars, as the designs were drawn and as macOS, iOS and
      // Android show them (they take no room). Headless Linux Chromium has
      // classic ones, which `scrollbar-gutter: stable` turns into 10px bands
      // on both edges of every scroller (--classic-scrollbars keeps them).
      opts.classicScrollbars ? '' : '*{scrollbar-gutter:auto!important;scrollbar-width:none!important;}',
      opts.nativeSize || mobile ? '' : '.panel{width:400px!important;height:720px!important;max-width:none!important;max-height:none!important;}',
    ].join('\n');
    await page.evaluate(({ config, css, mobile, rtl, shellClass, launcherClass }) => {
      const host = document.getElementById('gs-host')!;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = css;
      shadow.appendChild(style);
      const shell = document.createElement('div');
      shell.className = 'shell pos-bottom-right' + shellClass + (mobile ? ' gs-mobile-open' : '');
      shell.setAttribute('dir', rtl ? 'rtl' : 'ltr');
      shell.style.setProperty('--gs-primary', String(config.primaryColor));
      shadow.appendChild(shell);
      const launcher = document.createElement('button');
      launcher.className = 'launcher bottom-right' + launcherClass;
      launcher.hidden = true;
      shell.appendChild(launcher);
      const w = window as unknown as {
        __gs_runtime: { init: (c: Record<string, unknown>, shell: Record<string, unknown>) => { open: () => void } };
        __inst?: unknown;
      };
      const inst = w.__gs_runtime.init(
        // A real API base: Core skips identity and history reads without one.
        { workspaceId: 'ws-screens', _apiBase: location.origin, _assetBase: location.origin, _sessionToken: 't', ...config },
        { shadowRoot: shadow, shellEl: shell, launcher, setUnread() {}, setOperatorTyping() {} },
      );
      w.__inst = inst;
      inst.open();
    }, { config: { ...fixture.config }, css, mobile, rtl: locale === 'fa', shellClass, launcherClass });
    await page.waitForTimeout(700);
    if (spec.drive) await spec.drive({ page, fixture });
    // A text still typing itself out (an AI reply, the pre-chat card's
    // subtitle) is shot once it is whole, so two runs give the same picture.
    await page.waitForFunction(() => {
      const shadow = document.getElementById('gs-host')?.shadowRoot;
      return !shadow || !shadow.querySelector('[data-typing-active]');
    }, undefined, { timeout: 10_000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // No focus ring from open()'s own focus (the designs show none).
    if (!spec.keepFocus) await page.evaluate(() => {
      const shadow = document.getElementById('gs-host')?.shadowRoot;
      const active = shadow && (shadow.activeElement as HTMLElement | null);
      if (active && typeof active.blur === 'function') active.blur();
    });
    await page.waitForTimeout(opts.motion ? 900 : 400);
    if (opts.beforeShot) await opts.beforeShot(page, name);
    const file = path.join(opts.outDir, `${templateId}--${name}.png`);
    if (mobile) await page.screenshot({ path: file });
    else await page.locator('.panel').screenshot({ path: file });
    return file;
  } finally {
    await context.close();
  }
}

export async function renderTemplateScreens(opts: ScreenOptions): Promise<string[]> {
  const names = opts.states && opts.states.length ? opts.states : Object.keys(SCREEN_STATES);
  const unknown = names.filter((n) => !SCREEN_STATES[n]);
  if (unknown.length) throw new Error(`unknown state(s): ${unknown.join(', ')} (known: ${Object.keys(SCREEN_STATES).join(', ')})`);
  mkdirSync(opts.outDir, { recursive: true });
  // With no Chromium of its own found (CI: the one `playwright install
  // chromium` put in Playwright's cache), the full build in the new headless
  // mode, not the headless shell Playwright picks by default: after a tap the
  // shell moves the hover back to its own mouse position (0,0), so a phone's
  // sticky hover on the tapped line (widgetChatThread's tap checks) never
  // lasts there, unlike on any phone or in Chrome.
  const executablePath = resolveScreensChromium(opts.chromiumPath);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    args: FAKE_MEDIA_ARGS,
  });
  const files: string[] = [];
  try {
    for (const name of names) {
      const file = await shoot(browser, name, SCREEN_STATES[name], opts);
      files.push(file);
      if (opts.onShot) opts.onShot(file);
    }
  } finally {
    await browser.close();
  }
  return files;
}

// ─── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('harness', 'templateScreens.ts')); } catch { return false; }
})();

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log(Object.keys(SCREEN_STATES).join('\n'));
  } else {
    const outDir = String(args.out || '');
    if (!outDir) {
      console.error('usage: npx tsx e2e/harness/templateScreens.ts --template <id> --out <folder> [--states a,b] [--locale fa] [--accent #hex] [--options JSON] [--edition iran|international] [--native-size] [--classic-scrollbars] [--safe-area top,bottom] [--motion] [--late-after] [--chromium path] | --list');
      process.exit(2);
    }
    renderTemplateScreens({
      templateId: typeof args.template === 'string' ? args.template : 'default',
      templateOptions: typeof args.options === 'string' ? JSON.parse(args.options) : undefined,
      locale: (typeof args.locale === 'string' ? args.locale : 'fa') as 'fa' | 'en' | 'tr',
      accent: typeof args.accent === 'string' ? args.accent : undefined,
      states: typeof args.states === 'string' ? args.states.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      outDir: path.resolve(outDir),
      chromiumPath: typeof args.chromium === 'string' ? args.chromium : undefined,
      motion: !!args.motion,
      nativeSize: !!args['native-size'],
      classicScrollbars: !!args['classic-scrollbars'],
      safeArea: typeof args['safe-area'] === 'string'
        ? (([top, bottom]) => ({ top: Number(top) || 0, bottom: Number(bottom) || 0 }))(String(args['safe-area']).split(','))
        : undefined,
      lateAfter: !!args['late-after'],
      edition: args.edition === 'international' ? 'international' : 'iran',
      onShot: (f) => console.log(f),
    }).catch((e) => { console.error(e); process.exit(1); });
  }
}
