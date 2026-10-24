/**
 * Round 4 end to end (issue #340 g3, g5-2a): the SHIPPED widget (runtime.js,
 * runtime-ext.js, runtime-late.js, runtime-kb.js, the real default / t1 /
 * t2 renderers and extras, coreFeaturesHarness.ts) talking to the REAL
 * widget API over HTTP in one process: server/routes/widget.ts (its own
 * token and origin checks with a real session token, /history, /poll and
 * GET /kb-suggest with its `kb_suggest` bucket) and server/routes/kb.ts
 * (/kb/search, /kb/article), mounted in server/index.ts's order. The AI
 * row is written by the real responder (insertAiMessage) from cards the
 * real builders (commerce-tools/orderCard.ts) make, and published by the
 * real publishConversationEvent to a recording transport. The data layer is
 * the in-memory one of the server tests (src/test/conversations/
 * fakeServiceDb.ts), here also applying the KB routes' `or=(…ilike…)`
 * filters and column lists.
 *
 * What it proves is that the two sides agree, field by field:
 *  - instant answers: runtime-late.js's draft reaches GET /kb-suggest as
 *    {workspace_id, locale, q, limit} with the session token; the answer's
 *    {slug, title, snippet, matches, readingMinutes} is what the tray draws
 *    (snippet: not drawn by t2); a row opens /kb/article?…&meta=1; the
 *    server's 429 {code, retry_after} stops the asking;
 *  - the help search: runtime-ext.js's match=words request, the server's
 *    snippet + matches drawn by t2 (runtime-late.js copies them); the help
 *    center (no match=words) answers as before;
 *  - an article's author: meta=1 from t1 and t2 only, `author_name` (never
 *    the uuid) drawn; default asks without it and gets today's answer;
 *  - reading minutes: the server's kbReadingMinutes, GET /kb-suggest's
 *    readingMinutes and the widget's article view give the same numbers on
 *    one fixture (pinned);
 *  - the order card: the metadata insertAiMessage stores is what /history,
 *    /poll and the visitor's channel carry, and what t2's card draws, for
 *    every status; default and t1 show the text only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';
import { boot, click, flush, resetWindow, typeInto, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';
import { avatarFace } from './avatarFace';

type Next = () => void;
type Envelope = { type: string; payload: Record<string, unknown> };
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  visitor: 'visitor-1' as string | null,
  /** Every publish, as the real realtime helpers made it. */
  published: [] as Array<{ channel: string; envelope: Envelope }>,
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-commerce-kb';

/** Case folded as PostgreSQL's ILIKE folds it (kbWidgetSearch.pg.test.ts): «İ» is «i». */
const fold = (text: string) => text.toLowerCase().replace(/i\u0307/g, 'i');
/** A PostgREST `ilike` pattern as a test of folded text: `%` any run, `_` one character. */
function likeTest(pattern: string): { test: (text: string) => boolean } {
  const body = fold(pattern).split('').map((c) => (c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  const re = new RegExp(`^${body}$`, 's');
  return { test: (text) => re.test(fold(text)) };
}
/**
 * The KB routes' reads as PostgREST runs them: their `or=(col.ilike.…,…)`
 * filter applied before `limit`, and only the selected columns returned
 * (fakeServiceDb ignores `or` and returns every column).
 */
function kbReads(builder: Record<string, unknown>): Record<string, unknown> {
  let any: Array<[string, { test: (text: string) => boolean }]> | null = null;
  let max = Infinity;
  let columns: string[] | null = null;
  const settle = (r: { data: unknown; error: unknown }) => {
    if (!Array.isArray(r.data)) return r;
    let rows = r.data as Row[];
    if (any) rows = rows.filter((row) => any!.some(([col, re]) => re.test(String(row[col] ?? ''))));
    rows = rows.slice(0, max);
    if (columns) rows = rows.map((row) => Object.fromEntries(columns!.map((c) => [c, row[c] ?? null])));
    return { ...r, data: rows };
  };
  const proxy: Record<string, unknown> = new Proxy(builder, {
    get(target, prop) {
      if (prop === 'or') {
        return (filter: string) => {
          any = filter.split(',').map((term) => /^(\w+)\.ilike\.(.*)$/.exec(term)).filter((m): m is RegExpExecArray => !!m)
            .map((m) => [m[1], likeTest(m[2])] as [string, { test: (text: string) => boolean }]);
          return proxy;
        };
      }
      if (prop === 'limit') return (n: number) => { max = n; return proxy; };
      if (prop === 'select') {
        return (cols?: string, opts?: unknown) => {
          const list = String(cols || '*').split(',').map((c) => c.trim()).filter(Boolean);
          columns = list.includes('*') ? null : list;
          (target.select as (c?: string, o?: unknown) => unknown)(cols, opts);
          return proxy;
        };
      }
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          (target.then as (a: (v: { data: unknown; error: unknown }) => unknown) => Promise<unknown>)((r) => settle(r)).then(resolve, reject);
      }
      const value = target[prop as string];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { const out = (value as (...a: unknown[]) => unknown)(...args); return out === target ? proxy : out; };
    },
  });
  return proxy;
}
function serviceClient(db: FakeServiceDb) {
  const client = fakeServiceClient(db);
  return { ...client, from: (t: string) => (t === 'knowledge_base_articles' ? kbReads(client.from(t) as Record<string, unknown>) : client.from(t)) };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => serviceClient(state.db) }));
// The visitor's signed cookie (the widget's own browser).
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => (state.visitor ? { v: state.visitor } : null),
  resolveVisitorIdentity: () => ({ visitorId: state.visitor || 'minted', isNew: !state.visitor }),
}));
// The real publish helpers, a recording transport.
vi.mock('../../../server/services/realtime/resolvePublisher.js', () => ({
  resolvePublisher: async () => ({
    vendor: 'centrifugo',
    publish: async (channel: string, envelope: Envelope) => {
      state.published.push({ channel, envelope: JSON.parse(JSON.stringify(envelope)) });
      return { ok: true };
    },
  }),
  invalidatePublisherCache: () => undefined,
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = null; delete r.avatar_storage_key; }
    return rows;
  },
  resolveContactAvatarUrl: async () => null,
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/settings.js')>()),
  resolveAgentLogoUrl: async () => null,
  resolveWorkspaceAgentLogoUrl: async () => null,
}));
// The AI row's channel reconciliation (the trigger's backstop): no channel here.
vi.mock('../../../server/services/channels/outbound.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/channels/outbound.js')>()),
  ensureOutboundIntent: async () => undefined,
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  locksEnabled: async () => false,
}));
// Nothing locked (kbLocks.pg.test.ts covers a lock through these routes).
vi.mock('../../../server/services/knowledge-base/locks.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/knowledge-base/locks.js')>();
  return { ...real, resolveKbLock: async () => real.noKbLock() };
});
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { widgetKbRouter } = await import('../../../server/routes/kb.js');
const { createSessionToken, __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
const suggest = await import('../../../server/services/knowledge-base/widgetSuggest.js');
const { insertAiMessage } = await import('../../../server/services/ai-agent/responder.js');
const { orderCardFromStore, orderCardFromDirect } = await import('../../../server/services/ai-agent/commerce-tools/orderCard.js');
type Card = NonNullable<ReturnType<typeof orderCardFromStore>>;

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = 'ffffffff-0000-4000-8000-000000000000';
const SARA = '22222222-2222-4222-8222-222222222222';
const GONE = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://shop.example';
const CONFIG = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
const TOKEN = createSessionToken(WS, ORIGIN);

/** Every request the API received: method, path with its query, its widget token. */
const received: Array<{ method: string; path: string; token: string | null }> = [];
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: CONFIG }); next(); });
app.use(express.json());
app.use((req, _res, next) => {
  received.push({ method: req.method, path: req.originalUrl, token: (req.headers['x-widget-token'] as string) || null });
  next();
});
// server/index.ts's order: the help center's mount first (it does not catch /kb-suggest).
app.use('/api/widget/kb', widgetKbRouter);
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

/** A request to the in-process API, as the browser's fetch makes it from the shop's page. */
function request(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Row }> {
  return new Promise((done, fail) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: { Origin: ORIGIN, ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => done({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }));
    });
    req.on('error', fail);
    req.end();
  });
}
const get = async (path: string) => (await request('GET', path, { 'X-Widget-Token': TOKEN })).body;

/** The real API's answers to the widget's requests, in order (what Core and runtime-late.js then parse). */
const answers: Array<{ path: string; status: number; body: Row }> = [];
const answered = (re: RegExp) => answers.filter((a) => re.test(a.path.split('?')[0]));
const sentTo = (re: RegExp) => received.filter((r) => re.test(r.path.split('?')[0]));
const query = (path: string) => Object.fromEntries(new URL(path, 'https://api.test').searchParams);
/** The widget's KB requests go to the real API, with the headers its fetch sent. */
const api: BootOptions['api'] = (url, init) => {
  const u = new URL(url);
  if (!/^\/api\/widget\/(kb\/|kb-suggest$)/.test(u.pathname)) return undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers || {}) as Record<string, string>)) headers[k] = String(v);
  return request(init?.method || 'GET', u.pathname + u.search, headers).then((a) => {
    answers.push({ path: u.pathname + u.search, status: a.status, body: a.body });
    return { status: a.status, body: a.body } as ApiAnswer;
  });
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
  await flush(5);
}

const UPDATED = '2026-10-10T00:00:00Z';
function article(slug: string, title: string, excerpt: string, extra: Row = {}): Row {
  return {
    id: `id-${slug}`, workspace_id: WS, slug, title, excerpt, content: '<p>متن کوتاه</p>', locale: 'fa', category_id: null,
    status: 'published', visible_in_widget: true, author_user_id: null, updated_at: UPDATED, created_at: '2026-01-01T00:00:00Z', ...extra,
  };
}
const words = (n: number) => `<p>${'کلمه '.repeat(n)}</p>`;
const ARTICLES: Row[] = [
  article('returns', 'شرایط مرجوعی کفش', 'تا ۷ روز می‌توانید کفش را برگردانید', { content: words(450), author_user_id: SARA }),
  article('sizes', 'راهنمای سایز', 'جدول سایز کفش و لباس', { updated_at: '2026-10-12T00:00:00Z' }),
  article('shipping', 'زمان و هزینه ارسال', `${'توضیح '.repeat(30)}هزینه‌ی ارسال برای خریدهای بالای ۲ میلیون تومان رایگان است و ${'پایان '.repeat(30)}`, { updated_at: '2026-10-11T00:00:00Z', author_user_id: GONE }),
  article('hidden', 'مرجوعی کفش (داخلی)', '', { visible_in_widget: false }),
  article('draft', 'مرجوعی کفش پیش‌نویس', '', { status: 'draft' }),
  article('other-ws', 'مرجوعی کفش', '', { workspace_id: OTHER_WS }),
];

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  try { localStorage.clear(); } catch { /* jsdom */ }
  state.db = createFakeServiceDb();
  let last = 0;
  state.db.now = () => { last = Math.max(Date.now(), last + 1); return new Date(last).toISOString(); };
  state.db.tables.knowledge_base_articles = ARTICLES.map((a) => ({ ...a }));
  state.db.tables.knowledge_base_categories = [];
  state.db.tables.profiles = [
    { id: SARA, full_name: 'سارا', avatar_storage_key: null },
    { id: GONE, full_name: 'رفته', avatar_storage_key: null },
  ];
  // GONE wrote an article and has since left the workspace.
  state.db.tables.workspace_members = [{ workspace_id: WS, user_id: SARA, role: 'owner' }];
  state.visitor = 'visitor-1';
  state.published.length = 0;
  received.length = 0;
  answers.length = 0;
  suggest.__resetKbSuggestCachesForTests();
  __resetWidgetRateLimitsForTests();
});

/** The shipped widget of a template, signed in with a real session token, the late pack in. */
function widget(renderer: 'default' | 't1' | 't2', opts: BootOptions = {}) {
  return boot({ renderer, ...opts, config: { workspaceId: WS, _sessionToken: TOKEN, ...(opts.config || {}) }, api });
}
async function toChat(h: ReturnType<typeof boot>) {
  await flush(30);
  h.runtime.setTab('chat');
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
}
const composer = (h: ReturnType<typeof boot>) => h.q<HTMLTextAreaElement>('[data-msg-input]')!;
const tray = (h: ReturnType<typeof boot>) => h.q('[data-composer-zone] > [data-kb-suggest]');
const SUGGEST_KEYS = ['matches', 'readingMinutes', 'slug', 'snippet', 'title'];

// ═══ Instant answers (t2) ═════════════════════════════════════════════════
describe('instant answers: the draft, GET /kb-suggest and the tray agree', () => {
  it('the request runtime-late.js makes is what the route reads; its answer is what the tray draws', async () => {
    const h = widget('t2');
    await toChat(h);
    typeInto(composer(h), 'سلام میخوام  کفش مرجوعی کنم');
    await until(() => tray(h));

    // One request: the token's workspace, the conversation's language, the draft as asked about, two at most.
    expect(sentTo(/\/kb-suggest$/).map((r) => [r.method, query(r.path), r.token])).toEqual([
      ['GET', { workspace_id: WS, locale: 'fa', q: 'سلام میخوام کفش مرجوعی کنم', limit: '2' }, TOKEN],
    ]);
    const [{ status, body }] = answered(/\/kb-suggest$/);
    expect(status).toBe(200);
    // Not the hidden one, the draft or another workspace's; not «راهنمای سایز» (one summary word).
    expect(body).toEqual({ results: [{
      slug: 'returns', title: 'شرایط مرجوعی کفش', snippet: 'تا ۷ روز می‌توانید کفش را برگردانید',
      matches: ['کفش', 'مرجوعی'], readingMinutes: 2,
    }] });

    // The tray: every field it reads, from that answer.
    const rows = Array.from(tray(h)!.querySelectorAll<HTMLElement>('[data-kb-action="open"]'));
    expect(rows.map((b) => b.getAttribute('data-kb-slug'))).toEqual(['returns']);
    expect(rows[0].querySelector('.tt')!.innerHTML).toBe('شرایط <mark>مرجوعی</mark> <mark>کفش</mark>');
    expect(rows[0].querySelector('small')!.textContent).toBe('۲ دقیقه مطالعه');
    // The snippet is the help results' (t2's tray does not draw it).
    expect(tray(h)!.textContent).not.toContain('برگردانید');
  });

  it('each field of an answer row is one the tray reads (slug, title, matches, readingMinutes) or, snippet, the help results do', async () => {
    const h = widget('t2');
    await toChat(h);
    typeInto(composer(h), 'کفش لباس');
    await until(() => tray(h));
    const [{ body }] = answered(/\/kb-suggest$/);
    const results = body.results as Row[];
    expect(results.map((r) => r.slug)).toEqual(['returns', 'sizes']);
    for (const r of results) expect(Object.keys(r).sort()).toEqual(SUGGEST_KEYS);
    const rows = Array.from(tray(h)!.querySelectorAll<HTMLElement>('[data-kb-action="open"]'));
    expect(rows.map((b) => [b.getAttribute('data-kb-slug'), b.querySelector('.tt')!.textContent, b.querySelectorAll('mark').length, b.querySelector('small')!.textContent]))
      .toEqual([['returns', 'شرایط مرجوعی کفش', 1, '۲ دقیقه مطالعه'], ['sizes', 'راهنمای سایز', 0, '۱ دقیقه مطالعه']]);
  });

  it('a row opens its article with meta=1 (author, and the reading time the tray promised); back returns to the draft', async () => {
    const h = widget('t2');
    await toChat(h);
    typeInto(composer(h), 'مرجوعی کفش');
    await until(() => tray(h));
    const promised = (answered(/\/kb-suggest$/)[0].body.results as Row[])[0].readingMinutes;
    click(tray(h)!.querySelector('[data-kb-slug="returns"]'));
    await until(() => h.q('.kb-article-root .am'));

    expect(sentTo(/\/kb\/article$/).map((r) => query(r.path))).toEqual([{ workspace_id: WS, locale: 'fa', slug: 'returns', meta: '1' }]);
    const art = answered(/\/kb\/article$/)[0].body.article as Row;
    expect(Object.keys(art).sort()).toEqual(['author_name', 'category_id', 'content', 'excerpt', 'id', 'locale', 'slug', 'title', 'updated_at']);
    expect(art.author_name).toBe('سارا');
    const vm = h.lastCall('kbHtml')![0] as { article: Row };
    expect(vm.article).toMatchObject({ author: 'سارا', readingMinutes: promised });
    expect(h.q('.kb-article-root .am')!.textContent).toBe('سارا۲ دقیقه مطالعه');

    click(h.q('.kb-article-root [data-view-back]'));
    await flush(30);
    expect(h.q('.wy-view-chat')).not.toBeNull();
    expect(composer(h).value).toBe('مرجوعی کفش');
    expect(tray(h)).not.toBeNull();
    expect(sentTo(/\/kb-suggest$/)).toHaveLength(1);
  });

  it('the route\'s refusal (429 {code, retry_after}) hides the tray and stops the asking', async () => {
    const h = widget('t2');
    await toChat(h);
    // This visitor already asked 30 times this minute (the `kb_suggest` bucket).
    for (let i = 0; i < 30; i += 1) expect((await request('GET', `/api/widget/kb-suggest?workspace_id=${WS}&q=x${i}`, { 'X-Widget-Token': TOKEN })).status).toBe(200);
    answers.length = 0;
    typeInto(composer(h), 'مرجوعی کفش');
    await until(() => answered(/\/kb-suggest$/).length === 1);
    expect(answered(/\/kb-suggest$/)[0]).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED', retry_after: expect.any(Number) } });
    expect(tray(h)).toBeNull();
    typeInto(composer(h), 'راهنمای سایز');
    await wait(470);
    await flush(10);
    expect(answered(/\/kb-suggest$/)).toHaveLength(1);
    expect(tray(h)).toBeNull();
  });

  it('Turkish: a draft «İade» is the server\'s folded word «iade», and the tray marks the title\'s «İade»', async () => {
    state.db.tables.knowledge_base_articles.push(article('tr-returns', 'İade politikası', 'İptal ve iade koşulları', { locale: 'tr' }));
    const h = widget('t2', { config: { locale: 'tr' } });
    await toChat(h);
    typeInto(composer(h), 'İade');
    await until(() => tray(h));
    // The widget lower-cases as JavaScript does (an «i» and a combining dot); the server folds it.
    expect(query(sentTo(/\/kb-suggest$/)[0].path)).toMatchObject({ locale: 'tr', q: 'İade'.toLowerCase() });
    expect((answered(/\/kb-suggest$/)[0].body.results as Row[]).map((r) => [r.slug, r.matches])).toEqual([['tr-returns', ['iade']]]);
    const title = tray(h)!.querySelector('[data-kb-slug="tr-returns"] .tt')!;
    expect(title.innerHTML).toBe('<mark>İade</mark> politikası');
  });

  it('a draft the server has nothing for (only greetings) is answered [] and no tray is drawn', async () => {
    const h = widget('t2');
    await toChat(h);
    typeInto(composer(h), 'سلام ممنون');
    await until(() => answered(/\/kb-suggest$/).length === 1);
    expect(answered(/\/kb-suggest$/)[0]).toEqual({ path: expect.any(String), status: 200, body: { results: [] } });
    expect(tray(h)).toBeNull();
  });

  it('ends with the team\'s first answer: an AI reply the responder wrote, arriving live', async () => {
    const cid = randomUUID();
    state.db.tables.conversations = [{ id: cid, workspace_id: WS, status: 'open', metadata: { visitor_id: 'visitor-1' }, created_at: UPDATED, updated_at: UPDATED }];
    const h = widget('t2', { realtime: true, hint: { tab: 'chat', conversationId: cid }, conversations: [{ id: cid }], history: { [cid]: [] } });
    await toChat(h);
    typeInto(composer(h), 'مرجوعی کفش');
    await until(() => tray(h));
    await insertAiMessage(CONFIG as never, { workspaceId: WS, conversationId: cid, body: 'تا ۷ روز می‌توانید کفش را برگردانید.', source: 'ai_agent', agentName: 'Nova' });
    const live = state.published.find((p) => p.channel === `ws:${WS}:conv:${cid}` && p.envelope.type === 'message')!;
    h.emitMessages([live.envelope.payload]);
    await flush(20);
    expect(h.runtime.__test.chatState().messages).toHaveLength(1);
    expect(tray(h)).toBeNull();
  });
});

// ═══ The help search (t2) ═════════════════════════════════════════════════
describe('the help search: match=words, its snippet and matches', () => {
  it('runtime-ext.js asks word by word; the server\'s snippet and matched words are what t2 draws', async () => {
    const h = widget('t2');
    await flush(30);
    h.runtime.setTab('help');
    await flush(30);
    typeInto(h.q<HTMLInputElement>('[data-kb-search]')!, 'هزینه ارسال');
    await until(() => answered(/\/kb\/search$/).length === 1);
    await flush(20);

    expect(sentTo(/\/kb\/search$/).map((r) => query(r.path))).toEqual([{ workspace_id: WS, locale: 'fa', q: 'هزینه ارسال', limit: '8', match: 'words' }]);
    const results = answered(/\/kb\/search$/)[0].body.results as Row[];
    expect(results.map((r) => r.slug)).toEqual(['shipping']);
    expect(Object.keys(results[0]).sort()).toEqual(['excerpt', 'id', 'locale', 'matches', 'slug', 'snippet', 'title']);
    expect(results[0].matches).toEqual(['هزینه', 'ارسال']);
    const snippet = String(results[0].snippet);
    expect(snippet.startsWith('…') && snippet.endsWith('…')).toBe(true);

    const item = h.q('[data-kb-results] [data-kb-slug="shipping"]')!;
    expect(item.querySelector('.tt')!.innerHTML).toBe('زمان و <mark>هزینه</mark> <mark>ارسال</mark>');
    // The server's window of the summary, its words marked (‌«هزینه‌ی» holds «هزینه»).
    expect(item.querySelector('small')!.textContent).toBe(snippet);
    expect(Array.from(item.querySelectorAll('small mark')).map((m) => m.textContent)).toEqual(['هزینه', 'ارسال']);
  });

  it('the help center\'s own search (no match=words) answers as before: the rows, no snippet, no matches', async () => {
    const { body } = await request('GET', `/api/widget/kb/search?workspace_id=${WS}&q=${encodeURIComponent('کفش')}`);
    // As before, `visible_in_widget` is not the help center's filter (only the tray's).
    expect((body.results as Row[]).map((r) => r.slug).sort()).toEqual(['hidden', 'returns', 'sizes']);
    for (const r of body.results as Row[]) expect(Object.keys(r).sort()).toEqual(['excerpt', 'id', 'locale', 'slug', 'title']);
  });
});

// ═══ An article's author (t1, t2; default unchanged) ═══════════════════════
describe('an article\'s author: meta=1', () => {
  for (const t of ['t1', 't2'] as const) {
    it(`${t}: meta=1 on the request, author_name (never the uuid) in the answer, drawn under the title`, async () => {
      const h = widget(t);
      await flush(30);
      h.runtime.setTab('help', 'returns');
      await until(() => h.q('.am'));
      expect(sentTo(/\/kb\/article$/).map((r) => query(r.path))).toEqual([{ workspace_id: WS, locale: 'fa', slug: 'returns', meta: '1' }]);
      const art = answered(/\/kb\/article$/)[0].body.article as Row;
      expect(art.author_name).toBe('سارا');
      expect(JSON.stringify(art)).not.toContain(SARA);
      expect((h.lastCall('kbHtml')![0] as { article: Row }).article.author).toBe('سارا');
      expect(avatarFace(h.q('.am .av'))).toBe('person');
      expect(h.q('.am')!.textContent).toContain('سارا');
    });
  }

  it('an author who left the workspace: author_name null, nothing drawn', async () => {
    const h = widget('t2');
    await flush(30);
    h.runtime.setTab('help', 'shipping');
    await until(() => answered(/\/kb\/article$/).length === 1);
    await flush(10);
    expect((answered(/\/kb\/article$/)[0].body.article as Row).author_name).toBeNull();
    expect((h.lastCall('kbHtml')![0] as { article: Row }).article.author).toBeNull();
    expect(h.q('.am .av')).toBeNull();
  });

  it('default: no meta on the request, today\'s answer (no author_name), no byline', async () => {
    const h = widget('default');
    await flush(30);
    h.runtime.setTab('help', 'returns');
    await until(() => answered(/\/kb\/article$/).length === 1);
    await flush(10);
    expect(sentTo(/\/kb\/article$/).map((r) => query(r.path))).toEqual([{ workspace_id: WS, locale: 'fa', slug: 'returns' }]);
    const art = answered(/\/kb\/article$/)[0].body.article as Row;
    expect(Object.keys(art).sort()).toEqual(['category_id', 'content', 'excerpt', 'id', 'locale', 'slug', 'title', 'updated_at']);
    expect(h.panel.textContent).not.toContain('سارا');
  });
});

// ═══ Reading minutes: one fixture, both formulas ══════════════════════════
describe('reading minutes: the server and the widget give the same numbers', () => {
  // Words → minutes, pinned: content with tags (tags become spaces), runs of
  // white space, Persian with ZWNJ (one word), the 100/300 rounding edges.
  const FIXTURE: Array<[string, string, number]> = [
    ['alpha', '<p>یک</p>', 1],
    ['bravo', `<p>${'کلمه '.repeat(99)}</p>`, 1],
    ['charlie', `${'<b>کلمه</b>\n'.repeat(299)}`, 1],
    ['delta', `<h2>${'کلمه '.repeat(150)}</h2><p>${'کلمه\t'.repeat(150)}</p>`, 2],
    ['echo', `<ul>${'<li>متن‌ها</li>'.repeat(450)}</ul>`, 2],
    ['foxtrot', `${'word '.repeat(501)}<img src="x">`, 3],
    ['golf', `<p>${'کلمه '.repeat(1000)}</p>`, 5],
  ];
  // Each article's title holds its own word (the draft that finds it).
  beforeEach(() => {
    state.db.tables.knowledge_base_articles = FIXTURE.map(([slug, content]) => article(slug, `زمان مطالعه ${slug}`, '', { content }));
  });

  it('kbReadingMinutes, GET /kb-suggest\'s readingMinutes and the article view\'s, on every fixture', async () => {
    for (const [, content, minutes] of FIXTURE) expect(suggest.kbReadingMinutes(content)).toBe(minutes);
    const fromRoute = new Map<string, unknown>();
    for (const [slug] of FIXTURE) {
      const { body } = await request('GET', `/api/widget/kb-suggest?workspace_id=${WS}&locale=fa&limit=1&q=${slug}`, { 'X-Widget-Token': TOKEN });
      const [top] = body.results as Row[];
      fromRoute.set(String(top.slug), top.readingMinutes);
    }
    const h = widget('t2');
    await flush(30);
    const fromWidget = new Map<string, unknown>();
    for (const [slug] of FIXTURE) {
      h.runtime.setTab('help', slug);
      await until(() => (h.lastCall('kbHtml')?.[0] as { article?: Row } | undefined)?.article?.title && answered(/\/kb\/article$/).some((a) => a.path.includes(`slug=${slug}`)));
      await flush(10);
      fromWidget.set(slug, (h.lastCall('kbHtml')![0] as { article: Row }).article.readingMinutes);
      click(h.q('.kb-article-root [data-view-back]'));
      await flush(20);
    }
    const pinned = new Map(FIXTURE.map(([slug, , minutes]) => [slug, minutes]));
    expect(fromRoute).toEqual(pinned);
    expect(fromWidget).toEqual(pinned);
  });
});

// ═══ The order card (t2; default and t1 show the text) ════════════════════
describe('the order card: what the responder stores, the three paths carry and t2 draws', () => {
  const money = { amountMinor: '1000', currency: 'IRT' };
  const line = (title: string) => ({ productExternalId: '1', title, quantity: 1, total: money });
  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const tracking = (extra: Row = {}) => ({
    externalOrderId: '48213', carrier: 'پست', trackingNumber: 'RR123', trackingUrl: 'https://tracking.post.ir/?id=RR123', status: 'in transit', updatedAt: null, ...extra,
  });
  const display = { amount: '1', currency: 'USD', formatted: '$1' };
  const detail = (category: 'processing' | 'complete' | 'other', name: string) => ({
    externalId: '5002', createdAt: null, updatedAt: null, status: { name, category }, total: display, itemCount: 2, currency: 'USD',
    items: [{ productExternalId: '7', name: 'MacBook Air', model: null, quantity: 1, options: [], total: display }, { productExternalId: '8', name: 'Case', model: null, quantity: 1, options: [], total: display }],
    itemsTruncated: false, totals: [], shippingMethod: null, paymentMethod: null, paymentStatus: 'not_reported_by_store', history: [], viewUrl: null,
  });
  const STEPS = ['ثبت', 'آماده‌سازی', 'ارسال', 'تحویل'];

  /**
   * Each fixture: the card the builder makes from what a store answered, and
   * what t2 draws of it: the pill (text, and whether it is the quiet one),
   * each step's state ('ok' done, 'now' current, '' to do; null: no steps),
   * the fill, the item line, the arrival day, the link.
   */
  interface Drawn { pill: string | null; done: boolean; steps: string[] | null; fill: string | null; summary: string | null; day: boolean; link: string | null }
  const FIXTURES: Array<{ name: string; card: Card | null; drawn: Drawn }> = [
    { name: 'woo pending', card: orderCardFromStore({ externalId: 48213, status: 'pending', lineItems: [line('کفش رانینگ، سایز ۴۲')] }, null),
      drawn: { pill: 'در انتظار پرداخت', done: false, steps: ['now', '', '', ''], fill: '0.000', summary: 'کفش رانینگ، سایز ۴۲', day: false, link: null } },
    { name: 'woo on_hold', card: orderCardFromStore({ externalId: '48213', status: 'on_hold' }, null),
      drawn: { pill: 'در انتظار بررسی', done: false, steps: ['now', '', '', ''], fill: '0.000', summary: null, day: false, link: null } },
    { name: 'woo processing', card: orderCardFromStore({ externalId: '48213', status: 'processing', lineItems: [line('کفش'), line('جوراب'), line('بند')] }, null),
      drawn: { pill: 'در حال آماده‌سازی', done: false, steps: ['ok', 'now', '', ''], fill: '0.333', summary: 'کفش +۲', day: false, link: null } },
    { name: 'woo processing + tracking (shipped)', card: orderCardFromStore({ externalId: '48213', status: 'processing', itemSummary: 'کفش رانینگ', itemCount: 2 }, tracking({ estimatedDelivery: inDays(2) })),
      drawn: { pill: 'ارسال شد', done: false, steps: ['ok', 'ok', 'now', ''], fill: '0.667', summary: 'کفش رانینگ +۱', day: true, link: 'https://tracking.post.ir/?id=RR123' } },
    { name: 'woo completed', card: orderCardFromStore({ externalId: '48213', status: 'completed' }, tracking()),
      drawn: { pill: 'تکمیل شد', done: true, steps: ['ok', 'ok', 'ok', 'ok'], fill: '1', summary: null, day: false, link: 'https://tracking.post.ir/?id=RR123' } },
    { name: 'woo cancelled', card: orderCardFromStore({ externalId: '48213', status: 'cancelled' }, null),
      drawn: { pill: 'لغو شد', done: true, steps: null, fill: null, summary: null, day: false, link: null } },
    { name: 'woo refunded', card: orderCardFromStore({ externalId: '48213', status: 'refunded' }, null),
      drawn: { pill: 'مسترد شد', done: true, steps: null, fill: null, summary: null, day: false, link: null } },
    { name: 'woo failed', card: orderCardFromStore({ externalId: '48213', status: 'failed' }, null),
      drawn: { pill: 'ناموفق', done: true, steps: null, fill: null, summary: null, day: false, link: null } },
    { name: 'woo unknown (a custom status)', card: orderCardFromStore({ externalId: '48213', status: 'wc-awaiting-pickup' }, null),
      drawn: { pill: null, done: false, steps: null, fill: null, summary: null, day: false, link: null } },
    { name: 'woo unknown + tracking (shipped)', card: orderCardFromStore({ externalId: '48213', status: 'unknown' }, tracking({ trackingUrl: null })),
      drawn: { pill: 'ارسال شد', done: false, steps: ['ok', 'ok', 'now', ''], fill: '0.667', summary: null, day: false, link: null } },
    { name: 'opencart processing (the store\'s own label)', card: orderCardFromDirect(detail('processing', 'در حال پردازش') as never, null),
      drawn: { pill: 'در حال پردازش', done: false, steps: ['ok', 'now', '', ''], fill: '0.333', summary: 'MacBook Air +۱', day: false, link: null } },
    { name: 'opencart complete', card: orderCardFromDirect(detail('complete', 'Complete') as never, { available: true, shipments: [{ trackingNumber: '1Z', trackingUrl: 'https://ups.example/1Z', carrier: 'UPS' }] } as never),
      drawn: { pill: 'Complete', done: true, steps: ['ok', 'ok', 'ok', 'ok'], fill: '1', summary: 'MacBook Air +۱', day: false, link: 'https://ups.example/1Z' } },
    { name: 'a link the URL keeps an apostrophe in: no link sent, none drawn', card: orderCardFromStore({ externalId: '48213', status: 'processing' }, tracking({ trackingUrl: "https://tracking.post.ir/#it's" })),
      drawn: { pill: 'ارسال شد', done: false, steps: ['ok', 'ok', 'now', ''], fill: '0.667', summary: null, day: false, link: null } },
  ];

  /** A conversation with the visitor's question and the AI's answer carrying `card`, as the responder writes it. */
  async function answeredWith(card: Card | null) {
    const cid = randomUUID();
    (state.db.tables.conversations ||= []).push({ id: cid, workspace_id: WS, status: 'open', assigned_to: null, metadata: { visitor_id: 'visitor-1' }, created_at: UPDATED, updated_at: UPDATED });
    (state.db.tables.conversation_messages ||= []).push({ id: randomUUID(), conversation_id: cid, sender_type: 'contact', sender_id: null, body: 'سفارشم کجاست؟', metadata: {}, created_at: state.db.now() });
    const inserted = await insertAiMessage(CONFIG as never, {
      workspaceId: WS, conversationId: cid, body: 'سفارش ۴۸۲۱۳ شما در راه است.', source: 'ai_agent', runId: 'run-1', mode: 'auto_reply_always',
      confidence: 0.9, provider: 'openai', model: 'gpt', handoff: false, agentName: 'Nova', decisionType: 'answer', orderCard: card,
    });
    const stored = state.db.tables.conversation_messages.find((m) => m.id === inserted.id)!;
    return { cid, id: inserted.id!, stored };
  }
  const historyOf = async (cid: string) => (await get(`/api/widget/history?workspace_id=${WS}&conversation_id=${cid}`)).messages as Row[];
  const pollOf = async (cid: string) => (await get(`/api/widget/poll?workspace_id=${WS}&conversation_id=${cid}`)).messages as Row[];
  const liveOf = (cid: string) => state.published.filter((p) => p.channel === `ws:${WS}:conv:${cid}` && p.envelope.type === 'message').map((p) => p.envelope.payload);

  /** What t2's card shows, read back from the DOM (null: no card). */
  function drawnCard(root: ParentNode): Drawn | null {
    const card = root.querySelector('[data-chat-messages] .card');
    if (!card) return null;
    const pill = card.querySelector('.pill');
    const steps = card.querySelector('ol.steps') as HTMLElement | null;
    const lis = steps ? Array.from(steps.querySelectorAll('li')) : null;
    if (lis) {
      expect(lis.map((li) => li.textContent)).toEqual(STEPS);
      expect(lis.filter((li) => li.getAttribute('aria-current') === 'step')).toEqual(lis.filter((li) => li.className === 'now'));
    }
    const link = card.querySelector('a.trk');
    if (link) expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer']);
    return {
      pill: pill ? pill.textContent : null,
      done: !!pill && pill.classList.contains('done'),
      steps: lis ? lis.map((li) => li.className) : null,
      fill: steps ? steps.style.getPropertyValue('--f') : null,
      summary: card.querySelector('.tt small') ? card.querySelector('.tt small')!.textContent : null,
      day: !!card.querySelector('.ft b'),
      link: link ? link.getAttribute('href') : null,
    };
  }
  /** t2 on thread `cid` with these rows (as runtime-chat.js hands /history's to Core), the late pack in. */
  async function t2Thread(cid: string, rows: Row[], opts: BootOptions = {}) {
    const h = widget('t2', { hint: { tab: 'chat', conversationId: cid }, conversations: [{ id: cid }], history: { [cid]: rows }, ...opts });
    await flush(40);
    return h;
  }

  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', async (_name, f) => {
    expect(f.card).not.toBeNull();
    const { cid, id, stored } = await answeredWith(f.card);
    // The responder: the card as built, under `kind` / `order`.
    expect(stored.sender_type).toBe('ai');
    expect(stored.metadata).toMatchObject({ kind: 'order_status', order: f.card });
    // The three ways the visitor gets the row carry it whole.
    const [hist, poll, live] = [(await historyOf(cid)).find((m) => m.id === id)!, (await pollOf(cid)).find((m) => m.id === id)!, liveOf(cid).find((m) => m.id === id)!];
    for (const row of [hist, poll, live]) {
      expect(row.sender_type).toBe('ai');
      expect((row.metadata as Row).kind).toBe('order_status');
      expect((row.metadata as Row).order).toEqual(f.card);
    }
    // t2's card reads every field of it.
    const h = await t2Thread(cid, await historyOf(cid));
    expect(h.q('[data-chat-messages]')!.textContent).toContain('سفارش ۴۸۲۱۳ شما در راه است.');
    expect(h.q('[data-chat-messages] .card .tt b')!.textContent).toBe(`سفارش ${f.card!.number.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])}`);
    expect(drawnCard(h.shadow)).toEqual(f.drawn);
    // A link exactly when the server sent one.
    expect(!!h.q('[data-chat-messages] .card a.trk')).toBe(f.card!.trackingUrl !== null);
  });

  it('the day it arrives: a weekday within the week, a day and month later, nothing once past', async () => {
    const label = (iso: string, opts: Intl.DateTimeFormatOptions) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Intl.DateTimeFormat('fa-IR-u-ca-persian', opts).format(new Date(y, m - 1, d, 12));
    };
    for (const [days, expected] of [[2, (iso: string) => label(iso, { weekday: 'long' })], [20, (iso: string) => label(iso, { day: 'numeric', month: 'long' })], [-1, () => null]] as const) {
      const iso = inDays(days);
      const card = orderCardFromStore({ externalId: '48213', status: 'processing' }, tracking({ estimatedDelivery: `${iso}T10:00:00+03:30` }))!;
      expect(card.arrives).toBe(iso);
      resetWindow();
      const { cid } = await answeredWith(card);
      const h = await t2Thread(cid, await historyOf(cid));
      const b = h.q('[data-chat-messages] .card .ft b');
      expect(b ? b.textContent : null).toBe(expected(iso));
    }
  });

  it('live and by /poll: the card arrives with the row', async () => {
    const card = FIXTURES[3].card!;
    // Realtime: the envelope the responder published, through the driver.
    const first = await answeredWith(card);
    const live = await t2Thread(first.cid, [], { realtime: true });
    live.runtime.__test.setConnectionState('online');
    live.emitMessages(liveOf(first.cid));
    await flush(30);
    expect(drawnCard(live.shadow)).toEqual(FIXTURES[3].drawn);
    // Polling: /poll's rows, through the polling transport.
    resetWindow();
    const second = await answeredWith(card);
    const polled = await t2Thread(second.cid, []);
    polled.emitPoll(await pollOf(second.cid));
    await flush(30);
    expect(drawnCard(polled.shadow)).toEqual(FIXTURES[3].drawn);
  });

  it('without a card the row is today\'s; default and t1 draw any row as its text', async () => {
    const plain = await answeredWith(null);
    expect(plain.stored.metadata).not.toHaveProperty('kind');
    expect(plain.stored.metadata).not.toHaveProperty('order');
    const h = await t2Thread(plain.cid, await historyOf(plain.cid));
    expect(h.q('[data-chat-messages] .card')).toBeNull();

    const carded = await answeredWith(FIXTURES[3].card);
    const rows = await historyOf(carded.cid);
    for (const renderer of ['default', 't1'] as const) {
      resetWindow();
      const w = widget(renderer, { hint: { tab: 'chat', conversationId: carded.cid }, conversations: [{ id: carded.cid }], history: { [carded.cid]: rows } });
      await flush(40);
      const thread = w.q('[data-chat-messages]')!;
      expect(thread.textContent).toContain('سفارش ۴۸۲۱۳ شما در راه است.');
      expect(thread.querySelector('.card, .steps, .pill, a.trk')).toBeNull();
      expect(thread.textContent).not.toContain('ارسال شد');
    }
  });
});
