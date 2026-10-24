/**
 * After a chat end to end (issue #340 g1): the SHIPPED widget (runtime.js,
 * runtime-ext.js, runtime-late.js, the real t1 / t2 renderers and extras,
 * coreFeaturesHarness.ts) talking to the REAL widget API (server/routes/
 * widget.ts with the real ownership check, rate limits, rating and
 * transcript services) over HTTP, in one process. The data layer is the
 * in-memory one of the server tests (src/test/conversations/fakeServiceDb.ts);
 * the effective template, the email service, the timeline and the realtime
 * publisher are stand-ins, as there.
 *
 * What it proves is that the two sides agree, field by field:
 *  - the inbox's close (recordConversationClosed) writes the row whose
 *    envelope (realtime), /history and /poll rows runtime.js keeps for t2 and
 *    runtime-late.js recognises (metadata.kind, operator_name, agent_name);
 *  - runtime-late.js's requests (GET …/csat?workspace_id=, POST …/csat
 *    {workspace_id, closed_id, rating, comment}, POST …/transcript
 *    {workspace_id, locale, tz}) are what the routes read, and every answer
 *    the routes give (200, 409 already_rated / not_ratable, 403, 429
 *    rate_limited / limit_reached) is read as the state the card or the
 *    menu then shows;
 *  - both sides pick the same closure: the newest closed line with only
 *    system rows after it (conversationClosedNotice.ts latestClosedRow);
 *  - a 403 the widget cannot cure names its code, so fetchWith does not
 *    take it for an expired token (no refresh, no second request).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';
import { boot, click, flush, resetWindow, typeInto, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

type Next = () => void;
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  template: 't2',
  options: {} as Record<string, unknown>,
  sent: [] as Array<Record<string, unknown>>,
  published: [] as Array<{ type: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
// The transcript by email as it comes back once visitor email is switched on
// (shared/visitorEmail.ts; off since 2026-10-21, see visitorEmailSwitch.test.ts).
vi.mock('../../../shared/visitorEmail.js', () => ({ VISITOR_EMAIL_FEATURES_ENABLED: true, VISITOR_EMAIL_TEMPLATE_OPTIONS: ['transcriptEmail'] }));
// The visitor's signed cookie: always visitor-1's (the widget's own browser).
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-1' }),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/configSnapshot.js')>();
  const { chatWidgetTemplate } = await import('../../../shared/widgetTemplates.js');
  const { chatTemplateOptionDefaults, readTemplateOptions, chatTemplateOptionKeys } = await import('../../../shared/chatTemplateCatalog.js');
  return {
    ...real,
    workspaceChatTemplate: async () => ({
      id: state.template,
      descriptor: chatWidgetTemplate(state.template),
      options: { ...chatTemplateOptionDefaults(state.template), ...readTemplateOptions(state.options, chatTemplateOptionKeys(state.template)) },
    }),
    getWorkspaceWidgetSnapshot: async () => ({
      settings: { brand_name: 'فروشگاه نیلوفر' },
      workspace: { id: 'ws', name: 'Niloofar' },
      availabilityPrefs: { memberIds: [], prefsByUser: new Map() },
    }),
  };
});
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = null; delete r.avatar_storage_key; }
    return rows;
  },
}));
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  isEmailProviderConfigured: async () => true,
  resolveEmailScope: async () => ({ edition: 'iran', locales: ['fa', 'en'] }),
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => {
    state.sent.push(request);
    return { success: true, provider: 'resend' };
  },
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, _ws: string, _cid: string, envelope: { type: string; payload: Record<string, unknown> }) => {
    state.published.push(envelope);
    return { ok: true };
  },
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/settings.js')>()),
  resolveAgentLogoUrl: async () => null,
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({ resolveKbLock: async () => null, applyKbUnlockedFilter: (q: unknown) => q }));
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { recordConversationClosed } = await import('../../../server/services/conversationClosedNotice.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');

/** Every request the API received: method, path with its query, and the parsed body. */
const received: Array<{ method: string; path: string; body: unknown }> = [];
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
// A copy as it arrived: the router's own middleware adds to req.body.
app.use((req, _res, next) => {
  received.push({ method: req.method, path: req.originalUrl, body: req.method === 'POST' ? JSON.parse(JSON.stringify(req.body ?? null)) : undefined });
  next();
});
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

const CONFIG = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';

/** A request to the in-process API, as the browser's fetch would make it. */
function request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<ApiAnswer> {
  return new Promise((done, fail) => {
    const h: Record<string, string> = body ? { 'Content-Type': 'application/json', ...headers } : { ...headers };
    if (body) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => done({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}
const get = async (path: string) => (await request('GET', path)).body as Record<string, unknown>;

let refreshes = 0;
/**
 * The widget's own after-chat requests go to the real API exactly as
 * runtime-late.js made them (URL, method, headers, body); a token refresh
 * answers a new token, as the real one would for a live session.
 */
const api: BootOptions['api'] = (url, init) => {
  const u = new URL(url);
  if (u.pathname === '/api/widget/session/refresh') { refreshes += 1; return { body: { session_token: 'tok-2' } }; }
  if (!/^\/api\/widget\/conversations\/[^/]+\/(csat|transcript)$/.test(u.pathname)) return undefined;
  return request(init?.method || 'GET', u.pathname + u.search, init?.body ? String(init.body) : undefined, (init?.headers || {}) as Record<string, string>);
};

/** A widget conversation of visitor-1's that Sara answered (the contact has an email). */
function answered(): string {
  const cid = randomUUID();
  const contactId = randomUUID();
  (state.db.tables.contacts ||= []).push({ id: contactId, workspace_id: WS, email: 'ali.r@example.com', metadata: { visitor_id: 'visitor-1' } });
  (state.db.tables.conversations ||= []).push({
    id: cid, workspace_id: WS, status: 'open', assigned_to: SARA, contact_id: contactId, visitor_session_id: null, metadata: { visitor_id: 'visitor-1' },
  });
  message(cid, 'contact', 'سلام، سفارشم نرسیده');
  message(cid, 'agent', 'سلام، همین الان پیگیری کردم: فردا می‌رسد.');
  return cid;
}
function message(cid: string, sender_type: string, body: string, metadata: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({
    id, conversation_id: cid, sender_type, sender_id: sender_type === 'agent' ? SARA : null, body, metadata, created_at: state.db.now(),
  });
  return id;
}
/** The inbox's close: what PATCH /api/conversations/:id runs when a widget conversation is closed. */
async function closeFromInbox(cid: string): Promise<{ id: string; payload: Record<string, unknown> }> {
  const row = await recordConversationClosed(CONFIG, { workspaceId: WS, conversationId: cid, actorId: SARA, status: 'closed' });
  expect(row).not.toBeNull();
  const envelope = state.published[state.published.length - 1];
  expect(envelope.type).toBe('message');
  return { id: row!.id, payload: envelope.payload };
}
/** /history's rows for the thread, as runtime-chat.js hands them to Core. */
async function history(cid: string) {
  const res = await get(`/api/widget/history?workspace_id=${WS}&conversation_id=${cid}`);
  return res.messages as Array<Record<string, unknown>>;
}

async function until(cond: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
  await flush(5);
}

/** The shipped widget on thread `cid` (t2 unless said), its history loaded, the late pack in. */
async function widget(cid: string, opts: BootOptions & { messages?: Array<Record<string, unknown>> } = {}) {
  const h = boot({
    renderer: 't2',
    realtime: true,
    config: { workspaceId: WS },
    conversations: [{ id: cid, status: 'closed', operatorName: 'سارا', operatorOnline: true }],
    history: { [cid]: opts.messages || await history(cid) },
    identity: { identity_state: 'identified', contact: { name: 'علی', email: 'ali.r@example.com' } },
    api,
    ...opts,
  });
  await flush(20);
  h.runtime.__test.openConversation(cid);
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(5);
  return h;
}
const sentTo = (path: string) => received.filter((r) => r.path.split('?')[0].endsWith(path));
const card = (h: ReturnType<typeof boot>) => h.q('[data-csat]');

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  try { localStorage.clear(); } catch { /* jsdom */ }
  state.db = createFakeServiceDb();
  // Rows a millisecond apart at least, on the real clock (the 7-day window
  // and the transcript's 10 minutes are measured against it).
  let last = 0;
  state.db.now = () => { last = Math.max(Date.now(), last + 1); return new Date(last).toISOString(); };
  state.db.tables.profiles = [{ id: SARA, full_name: 'سارا', avatar_storage_key: null }];
  state.template = 't2';
  state.options = {};
  state.sent.length = 0;
  state.published.length = 0;
  received.length = 0;
  refreshes = 0;
  __resetWidgetRateLimitsForTests();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the closed line: the inbox\'s close reaches the widget as the row it draws and rates', () => {
  it('live: the published envelope is kept, drawn, asked about with the exact GET, rated with the exact POST; the server stores that closure\'s rating', async () => {
    const cid = answered();
    const h = await widget(cid);
    expect(card(h)).toBeNull();

    const closed = await closeFromInbox(cid);
    // The envelope carries what the widget reads: the kind, who closed it, who it rates.
    expect(closed.payload).toMatchObject({
      id: closed.id, conversation_id: cid, role: 'system', sender_type: 'system',
      metadata: { kind: 'conversation_closed', by: 'agent', agent_name: 'سارا', operator_id: SARA, operator_name: 'سارا', status: 'closed' },
    });
    h.emitMessages([closed.payload]);
    await until(() => card(h));

    expect(h.q('.msg-system-pill')!.textContent).toBe('سارا گفتگو را بست');
    expect(sentTo('/csat').map((r) => [r.method, r.path])).toEqual([['GET', `/api/widget/conversations/${cid}/csat?workspace_id=${WS}`]]);
    expect(card(h)!.querySelector('h3')!.textContent).toBe('گفتگو با سارا چطور بود؟');
    expect(card(h)!.querySelector('[data-csat-transcript]')).not.toBeNull();
    // Never an unread message (the thread is on screen, and it is a system line).
    expect(h.unread.filter((n) => n > 0)).toEqual([]);

    click(h.q('[data-csat-rate="5"]'));
    typeInto(h.q<HTMLTextAreaElement>('[data-csat-comment]')!, '  خیلی سریع جواب دادید  ');
    click(h.q('[data-csat-submit]'));
    await until(() => h.q('[data-csat] [role="status"]'));

    const posted = sentTo('/csat').filter((r) => r.method === 'POST');
    expect(posted).toEqual([{
      method: 'POST', path: `/api/widget/conversations/${cid}/csat`,
      body: { workspace_id: WS, closed_id: closed.id, rating: 5, comment: 'خیلی سریع جواب دادید' },
    }]);
    expect(state.db.tables.conversation_ratings).toEqual([expect.objectContaining({
      workspace_id: WS, conversation_id: cid, closed_message_id: closed.id, operator_id: SARA, score: 5, comment: 'خیلی سریع جواب دادید',
    })]);
    expect(h.q('[data-csat] [role="status"] h3')!.textContent).toBe('از نظرتان سپاسگزاریم!');
    expect(h.q('[data-csat] [role="status"] p')!.textContent).toBe('امتیاز شما: عالی');
    expect(h.q('[data-csat-submit], [data-csat-rate]')).toBeNull();
  });

  it('a reload: /history\'s row, then GET\'s stored rating: the thanks with its score and nothing to post', async () => {
    const cid = answered();
    const closed = await closeFromInbox(cid);
    // Rated earlier, by this widget's own request.
    const first = await request('POST', `/api/widget/conversations/${cid}/csat`, JSON.stringify({ workspace_id: WS, closed_id: closed.id, rating: 4, comment: null }));
    expect(first).toMatchObject({ status: 200, body: { ok: true, rating: { score: 4, comment: null } } });
    received.length = 0;

    const rows = await history(cid);
    expect(rows[rows.length - 1]).toMatchObject({ id: closed.id, sender_type: 'system', metadata: { kind: 'conversation_closed', agent_name: 'سارا' } });
    const h = await widget(cid, { messages: rows });
    await until(() => h.q('[data-csat] [role="status"]'));
    expect(h.q('[data-csat] [role="status"] p')!.textContent).toBe('امتیاز شما: خوب');
    expect(sentTo('/csat').map((r) => r.method)).toEqual(['GET']);
  });

  it('/poll\'s row (no realtime): the same line and card', async () => {
    const cid = answered();
    const h = await widget(cid, { realtime: false });
    const closed = await closeFromInbox(cid);
    const polled = await get(`/api/widget/poll?workspace_id=${WS}&conversation_id=${cid}`);
    const rows = polled.messages as Array<Record<string, unknown>>;
    expect(rows.filter((m) => (m.metadata as Row | null)?.kind === 'conversation_closed').map((m) => m.id)).toEqual([closed.id]);
    h.emitPoll(rows);
    await until(() => card(h));
    expect(h.q('.msg-system-pill')!.textContent).toBe('سارا گفتگو را بست');
  });

  it('a system notice after the line (a transfer, a join): the server still rates that closure, and the widget draws its card', async () => {
    const cid = answered();
    const closed = await closeFromInbox(cid);
    message(cid, 'system', 'سارا transferred the conversation to رضا', { kind: 'conversation_transferred', to_name: 'رضا' });
    const rows = await history(cid);
    expect(rows.map((m) => (m.metadata as Row | null)?.kind || m.sender_type)).toEqual(['contact', 'agent', 'conversation_closed', 'conversation_transferred']);
    expect(await get(`/api/widget/conversations/${cid}/csat?workspace_id=${WS}`)).toMatchObject({ closed_id: closed.id, rateable: true });

    const h = await widget(cid, { messages: rows });
    await until(() => card(h));
    click(h.q('[data-csat-rate="3"]'));
    click(h.q('[data-csat-submit]'));
    await until(() => h.q('[data-csat] [role="status"]'));
    expect(state.db.tables.conversation_ratings).toEqual([expect.objectContaining({ closed_message_id: closed.id, score: 3 })]);
  });

  it('an AI-only chat: the line, a GET that says not rateable, no card', async () => {
    const cid = randomUUID();
    (state.db.tables.conversations ||= []).push({
      id: cid, workspace_id: WS, status: 'open', assigned_to: null, contact_id: null, visitor_session_id: null, metadata: { visitor_id: 'visitor-1' },
    });
    message(cid, 'contact', 'ساعت کاری؟');
    message(cid, 'ai', 'از ۹ تا ۱۸.');
    const closed = await closeFromInbox(cid);
    expect(await get(`/api/widget/conversations/${cid}/csat?workspace_id=${WS}`)).toMatchObject({ closed_id: closed.id, rateable: false });
    received.length = 0;
    const h = await widget(cid);
    await until(() => sentTo('/csat').length === 1);
    await flush(20);
    expect(h.q('.msg-system-pill')!.textContent).toBe('سارا گفتگو را بست');
    expect(card(h)).toBeNull();
  });

  it('a default workspace: its close writes nothing, so its widget has nothing to draw or ask', async () => {
    state.template = 'default';
    const cid = answered();
    expect(await recordConversationClosed(CONFIG, { workspaceId: WS, conversationId: cid, actorId: SARA, status: 'closed' })).toBeNull();
    expect((await history(cid)).map((m) => m.sender_type)).toEqual(['contact', 'agent']);
    expect(state.published).toEqual([]);
  });
});

describe('the server\'s refusals, as the card shows them', () => {
  it('another tab rated first: 409 already_rated with that rating: the thanks with ITS score', async () => {
    const cid = answered();
    const closed = await closeFromInbox(cid);
    const h = await widget(cid);
    await until(() => card(h));
    // The other tab, with the same request runtime-late.js makes.
    await request('POST', `/api/widget/conversations/${cid}/csat`, JSON.stringify({ workspace_id: WS, closed_id: closed.id, rating: 2, comment: null }));

    click(h.q('[data-csat-rate="5"]'));
    click(h.q('[data-csat-submit]'));
    await until(() => h.q('[data-csat] [role="status"]'));
    expect(h.q('[data-csat] [role="status"] p')!.textContent).toBe('امتیاز شما: بد');
    expect(state.db.tables.conversation_ratings).toHaveLength(1);
  });

  it('the thread moved on in another tab (a message after the line): 409 not_ratable: said, nothing left to press', async () => {
    const cid = answered();
    await closeFromInbox(cid);
    const h = await widget(cid);
    await until(() => card(h));
    message(cid, 'contact', 'یک سؤال دیگر');

    click(h.q('[data-csat-rate="4"]'));
    click(h.q('[data-csat-submit]'));
    await until(() => h.q('[data-csat] .er'));
    expect(h.q('[data-csat] .er')!.textContent).toBe('دیگر نمی‌شود به این گفتگو امتیاز داد.');
    expect(h.q('[data-csat-submit], [data-csat-rate]')).toBeNull();
    expect(state.db.tables.conversation_ratings || []).toEqual([]);
  });

  it('the rating turned off meanwhile: 403 csat_disabled, with its code: one request, no token refresh', async () => {
    const cid = answered();
    await closeFromInbox(cid);
    const h = await widget(cid);
    await until(() => card(h));
    state.options = { csat: false };

    click(h.q('[data-csat-rate="4"]'));
    click(h.q('[data-csat-submit]'));
    await until(() => h.q('[data-csat] .er'));
    expect(h.q('[data-csat] .er')!.textContent).toBe('دیگر نمی‌شود به این گفتگو امتیاز داد.');
    expect(sentTo('/csat').filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(refreshes).toBe(0);
  });
});

describe('the transcript by email, from the card and from the menu', () => {
  it('the card\'s link: POST {workspace_id, locale, tz}; the mail to the contact\'s own address; the masked address on the card', async () => {
    const cid = answered();
    await closeFromInbox(cid);
    const h = await widget(cid);
    await until(() => h.q('[data-csat-transcript]'));
    click(h.q('[data-csat-transcript]'));
    await until(() => h.q('[data-csat] p.lnk2[role="status"]'));

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(sentTo('/transcript')).toEqual([{
      method: 'POST', path: `/api/widget/conversations/${cid}/transcript`, body: { workspace_id: WS, locale: 'fa', tz },
    }]);
    expect(state.sent).toEqual([expect.objectContaining({ to: 'ali.r@example.com', templateSlug: 'visitor_conversation_transcript', locale: 'fa' })]);
    expect(h.q('[data-csat] p.lnk2[role="status"]')!.textContent).toBe('متن گفتگو به a•••@example.com فرستاده شد');
    expect(h.q('[data-csat] p.lnk2 b[dir="ltr"]')!.textContent).toBe('a•••@example.com');
  });

  it('asked again within 10 minutes (a reload): 429 rate_limited: not sent, try again; the limit reached in another tab: the final line', async () => {
    const cid = answered();
    await closeFromInbox(cid);
    const send = () => request('POST', `/api/widget/conversations/${cid}/transcript`, JSON.stringify({ workspace_id: WS, locale: 'fa', tz: 'Asia/Tehran' }));
    expect((await send()).status).toBe(200);

    const h = await widget(cid);
    await until(() => h.q('[data-csat-transcript]'));
    click(h.q('[data-csat-transcript]'));
    await until(() => sentTo('/transcript').length === 2 && h.q('[data-csat-transcript]:not([disabled])'));
    expect(h.q('[data-csat-transcript]')!.textContent).toBe('ارسال نشد · تلاش دوباره');

    // Two more were sent meanwhile (the 10 minutes are long past for them):
    // the third one was the last.
    const ledger = state.db.tables.conversation_transcript_emails!;
    for (const r of ledger) r.created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    ledger.push({ id: randomUUID(), workspace_id: WS, conversation_id: cid, status: 'sent', created_at: new Date(Date.now() - 30 * 60_000).toISOString() });
    ledger.push({ id: randomUUID(), workspace_id: WS, conversation_id: cid, status: 'sent', created_at: new Date(Date.now() - 20 * 60_000).toISOString() });
    __resetWidgetRateLimitsForTests();
    click(h.q('[data-csat-transcript]'));
    await until(() => h.q('[data-csat] p.lnk2[role="status"]'));
    expect(h.q('[data-csat] p.lnk2[role="status"]')!.textContent).toBe('ارسال متن گفتگو ممکن نشد');
    // Three requests (the first one sent; 429 rate_limited; 429 limit_reached), one mail.
    expect(sentTo('/transcript')).toHaveLength(3);
    expect(state.sent).toHaveLength(1);
  });

  it('t1\'s menu: GET offers the item, POST sends it; 403 transcript_disabled names its code (no token refresh)', async () => {
    state.template = 't1';
    const cid = answered();
    message(cid, 'agent', 'خواهش می‌کنم!');
    const h = await widget(cid, { renderer: 't1' });
    await until(() => h.q('[data-chat-menu-toggle]'));
    click(h.q('[data-chat-menu-toggle]'));
    await until(() => h.q('[data-chat-menu-action="transcript"]'));
    expect(sentTo('/csat').map((r) => r.path)).toEqual([`/api/widget/conversations/${cid}/csat?workspace_id=${WS}`]);

    // The owner turned it off after the menu offered it.
    state.options = { transcriptEmail: false };
    click(h.q('[data-chat-menu-action="transcript"]'));
    await until(() => h.q('[data-chat-menu-action="transcript"][aria-disabled="true"]'));
    expect(sentTo('/transcript')).toHaveLength(1);
    expect(refreshes).toBe(0);
    expect(state.sent).toEqual([]);
  });
});
