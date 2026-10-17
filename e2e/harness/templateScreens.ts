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
 * --motion (keep animations; default reduced motion so every shot is
 * stable), --chromium (path; default PLAYWRIGHT_CHROMIUM_PATH, then
 * /opt/pw-browsers or /opt/ms-playwright).
 *
 * Desktop states shoot the panel at 400×720 CSS px, phone states the whole
 * 390×844 screen; both at deviceScaleFactor 2. The page runs in Asia/Tehran
 * so message times read like the designs' (۱۹:۴۲). Fixture copy mirrors the
 * handoff's demo store (فروشگاه نیلوفر, سارا / مهدی / رضا, its articles).
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
  qna: string[];
  /** POST /api/widget/message answers 500 (a send that fails). */
  messageFails?: boolean;
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
async function typing(page: Page) {
  await page.evaluate(() => (window as unknown as { __gsTyping?: () => void }).__gsTyping?.());
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
      await input.fill('آدرس جدید: تهران، خیابان ولیعصر، پلاک ۱۲');
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
      await page.locator('[data-rec-stop]').click();
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
      await page.locator('[data-prechat="name"]').fill('علی');
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
      const text = 'سلام، برای سفارش عمده تخفیف دارید؟';
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
        await field.first().fill('ارسال');
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
  window.__gsTyping = function () { hooks.onTyping({ payload: { actor: 'agent' } }); };
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
    if (p.startsWith('/widget/')) {
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
      if (id === MEDIA.voice.id || id === 'att-new') return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE_SVG });
    }
    if (p.includes('/api/widget/conversations') && p.endsWith('/read')) return json({ ok: true });
    if (p.includes('/api/widget/conversations')) {
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
      return json({ messages: fixture.threads[cid] || [], assigned_operator: fixture.assignedOperator });
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
    if (p.includes('/api/widget/kb/categories')) return json({ locale, categories: CATEGORIES, articles: ARTICLES });
    if (p.includes('/api/widget/kb/article')) {
      const slug = url.searchParams.get('slug');
      const a = ARTICLES.find((x) => x.slug === slug);
      return a
        ? json({ article: { ...a, content: ARTICLE_BODY, updated_at: at(10, 0, 3) } })
        : json({ error: 'not_found' }, 404);
    }
    if (p.includes('/api/widget/kb/search')) {
      const q = (url.searchParams.get('q') || '').trim();
      return json({ locale, q, results: SEARCH[q] || [] });
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
  const fixture = baseFixture();
  fixture.config.templateId = tpl.id;
  fixture.config.locale = locale;
  fixture.config.primaryColor = opts.accent || '#3B82F6';
  if (opts.templateOptions) fixture.config.templateOptions = { ...opts.templateOptions };
  if (spec.setup) spec.setup(fixture);

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
    if (process.env.SCREENS_DEBUG) {
      page.on('console', (m) => console.log(`[${name}] console.${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
      page.on('request', (r) => { if (r.url().includes('/api/')) console.log(`[${name}] ${r.method()} ${r.url()}`); });
    }
    await routeApi(page, fixture, tpl.fonts, locale);
    await page.addInitScript(([ws, home]) => {
      const w = window as unknown as Record<string, unknown>;
      w.__GS_WIDGET_TEST_HOOKS__ = true;
      if (home) sessionStorage.setItem(`gs:view:${ws}`, JSON.stringify({ tab: 'home', conversationId: null }));
    }, [WORKSPACE, !!spec.home] as const);
    await page.goto(`${ORIGIN}/host`);
    for (const f of ['presentation-registry.js', tpl.script, 'runtime-chat.js', 'runtime.js']) {
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
    await page.evaluate(({ config, css, mobile, rtl }) => {
      const host = document.getElementById('gs-host')!;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = css;
      shadow.appendChild(style);
      const shell = document.createElement('div');
      shell.className = 'shell pos-bottom-right' + (mobile ? ' gs-mobile-open' : '');
      shell.setAttribute('dir', rtl ? 'rtl' : 'ltr');
      shell.style.setProperty('--gs-primary', String(config.primaryColor));
      shadow.appendChild(shell);
      const launcher = document.createElement('button');
      launcher.className = 'launcher bottom-right';
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
    }, { config: { ...fixture.config }, css, mobile, rtl: locale === 'fa' });
    await page.waitForTimeout(700);
    if (spec.drive) await spec.drive({ page, fixture });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // No focus ring from open()'s own focus (the designs show none).
    await page.evaluate(() => {
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
  const browser = await chromium.launch({
    executablePath: resolveScreensChromium(opts.chromiumPath),
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
      console.error('usage: npx tsx e2e/harness/templateScreens.ts --template <id> --out <folder> [--states a,b] [--locale fa] [--accent #hex] [--options JSON] [--native-size] [--classic-scrollbars] [--motion] [--chromium path] | --list');
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
      onShot: (f) => console.log(f),
    }).catch((e) => { console.error(e); process.exit(1); });
  }
}
