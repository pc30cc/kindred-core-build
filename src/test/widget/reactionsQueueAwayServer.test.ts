/**
 * Round 3 end to end (issue #340 g2, g4): the SHIPPED widget (runtime.js,
 * runtime-ext.js, runtime-late.js, the real t1 / t2 renderers and extras,
 * coreFeaturesHarness.ts) talking to the REAL widget API (server/routes/
 * widget.ts with server/routes/widgetIdentity.ts mounted in it, the real
 * ownership check, rate limits, reaction, queue and away services) and the
 * REAL operator route (server/routes/conversations.ts) over HTTP, in one
 * process. The data layer is the in-memory one of the server tests
 * (src/test/conversations/fakeServiceDb.ts); membership, the effective
 * template, the identity merge, push, mail and the timeline are stand-ins.
 * The realtime publisher records what the real publishConversationEvent /
 * publishOperatorEvent send, channel by channel.
 *
 * What it proves is that the two sides agree, field by field:
 *  - reactions: runtime-late.js's GET …/reactions?workspace_id= and POST
 *    …/reactions {workspace_id, message_id, emoji, on} are what the routes
 *    read, their answers are what it draws; the live `message_reactions`
 *    event is published with exactly WIDGET_EVENT_FIELDS on the visitor's
 *    channel, passes both drivers unchanged and is what runtime-late.js
 *    reads; the inbox's whole copy refreshes its thread, which then carries
 *    the visitor's reaction;
 *  - the queue: routing's queue row and `queued_at` are what GET /queue and
 *    the widget's poll need; the operator's join ends it;
 *  - the away thread: POST /offline-messages with the bubble's
 *    `client_message_id` (a retry finds the same capture), the email card's
 *    POST /identity/offline-email, a reload's /history finding the reply
 *    again (the privacy strip keeps `source`);
 *  - the step pre-chat: the flags /identity/me serves, ONE POST
 *    /identity/prechat with what the server keeps, the server's refusals
 *    sent back to their step;
 *  - the privacy strip: messages of two operators, as /history and the
 *    conversation channel now give them (no operator ids), still group and
 *    label by operator in default, t1 and t2.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RealtimeHandlers } from '@/realtime/types';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';
import { boot, click, flush, key, resetWindow, typeInto, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

type Next = () => void;
type Envelope = { type: string; payload: Record<string, unknown> };
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  template: 't2',
  options: {} as Record<string, unknown>,
  visitor: 'visitor-1' as string | null,
  /** Every publish, as the real realtime helpers made it. */
  published: [] as Array<{ channel: string; envelope: Envelope }>,
  merges: [] as Array<Record<string, unknown>>,
  known: null as Record<string, unknown> | null,
  pushes: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  /** The inbox's signed-in operator. */
  user: '' as string,
  /** The dashboard's realtime subscriptions (useInboxRealtime). */
  subs: [] as Array<{ channel: string; handlers: RealtimeHandlers }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
// The away email step as it comes back once visitor email is switched on
// (shared/visitorEmail.ts, config.visitorEmail; off since 2026-10-21: awayThread.test.ts).
vi.mock('../../../shared/visitorEmail.js', () => ({ VISITOR_EMAIL_FEATURES_ENABLED: true, VISITOR_EMAIL_TEMPLATE_OPTIONS: ['transcriptEmail'] }));
// The visitor's signed cookie (the widget's own browser).
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => (state.visitor ? { v: state.visitor } : null),
  resolveVisitorIdentity: () => ({ visitorId: state.visitor || 'minted', isNew: !state.visitor }),
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
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/widget/availability.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/availability.js')>()),
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));
// The operator who claims a queued chat is here: routing says "X joined" only then.
vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.map((id) => [id, { state: 'active', lastActivityAt: Date.now() }])),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  locksEnabled: async () => false,
}));
vi.mock('../../../server/services/billing/conversationLimit.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/conversationLimit.js')>()),
  enforceMaxConversationsLimit: async () => true,
  checkMaxConversationsAllowance: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyInboundMessage: async (_c: unknown, p: Record<string, unknown>) => { state.pushes.push(p); },
  notifyHandoff: async () => undefined,
  notifyAssignment: async () => undefined,
}));
vi.mock('../../../server/services/platformSupport/changes.js', () => ({ onSupportConversationChanged: async () => undefined }));
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => { state.sent.push(request); return { success: true, provider: 'resend' }; },
}));
vi.mock('../../../server/services/auth-email.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/auth-email.js')>()),
  resolveWorkspaceAppUrl: async (_c: unknown, _ws: string, path: string) => `https://app.test${path}`,
}));
// The merge (its own tests cover it) does what the real one does to this
// visitor's conversations: links those without a contact to it.
vi.mock('../../../server/services/widget/identityMerge.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/identityMerge.js')>()),
  mergeVisitorIdentity: async (_c: unknown, _sb: unknown, input: Record<string, unknown>) => {
    state.merges.push(input);
    for (const c of state.db.tables.conversations || []) {
      if ((c.metadata as Row | null)?.visitor_id === input.visitorId && !c.contact_id) c.contact_id = CONTACT;
    }
    return { contactId: CONTACT, isNewContact: true, conversationsMerged: 0 };
  },
}));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async () => null,
  issueContinuityCookieForContact: async () => undefined,
  resolveKnownContact: async () => state.known,
}));
// The inbox's operator: a member of the workspace (seat and plan as they are).
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (!state.user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return { userId: state.user, isAdmin: false, role: 'agent' };
  },
}));
vi.mock('../../../server/services/contactChatLocks.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/contactChatLocks.js')>()),
  conversationLockedNow: async () => ({ locked: false, state: { retentionDays: 30 } }),
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/settings.js')>()),
  resolveAgentLogoUrl: async () => null,
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({ resolveKbLock: async () => null, applyKbUnlockedFilter: (q: unknown) => q }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
}));
// The dashboard's realtime (useInboxRealtime): the subscriptions it makes.
vi.mock('@/realtime', () => ({
  resolveClientRealtimeProvider: async () => ({
    vendor: 'centrifugo',
    async subscribe(channel: string, handlers: RealtimeHandlers) {
      state.subs.push({ channel, handlers });
      return { unsubscribe: () => undefined };
    },
  }),
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { conversationsRouter } = await import('../../../server/routes/conversations.js');
const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
const { WIDGET_EVENT_FIELDS } = await import('../../../server/services/realtime/publish.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
const { useInboxRealtime } = await import('@/hooks/useInboxRealtime');

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Every request the API received: method, path with its query, and the parsed body. */
const received: Array<{ method: string; path: string; body: unknown }> = [];
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
// A copy as it arrived: the routers' own middleware adds to req.body.
app.use((req, _res, next) => {
  received.push({ method: req.method, path: req.originalUrl, body: req.method === 'POST' ? JSON.parse(JSON.stringify(req.body ?? null)) : undefined });
  next();
});
app.use('/api/widget', widgetRouter);
app.use('/api/conversations', conversationsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

const CONFIG = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const MEHDI = '33333333-3333-4333-8333-333333333333';
const CONTACT = '77777777-7777-4777-8777-777777777777';
const HEART = '❤️';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
const get = async (path: string) => (await request('GET', path)).body as Record<string, any>;

/** The late features' routes go to the real API (and, for the pre-chat, the identity it reads: `realIdentity`). */
const REAL = /^\/api\/widget\/(conversations\/[^/]+\/reactions|queue|offline-messages|identity\/(offline-email|prechat))$/;
let realIdentity = false;
let refreshes = 0;
/** The real API's answers to the widget's requests, in order (what runtime-late.js and Core then parse). */
const answers: Array<{ method: string; path: string; status: number; body: Row }> = [];
const answered = (method: string, re: RegExp) => answers.filter((a) => a.method === method && re.test(a.path));
/** When set, an answer the server gave is lost on its way back (the widget sees a network failure). */
let lose: ((path: string) => boolean) | null = null;
const api: BootOptions['api'] = (url, init) => {
  const u = new URL(url);
  if (u.pathname === '/api/widget/session/refresh') { refreshes += 1; return { body: { session_token: 'tok-2' } }; }
  if (!REAL.test(u.pathname) && !(realIdentity && u.pathname === '/api/widget/identity/me')) return undefined;
  const method = init?.method || 'GET';
  const sent = request(method, u.pathname + u.search, init?.body ? String(init.body) : undefined, (init?.headers || {}) as Record<string, string>)
    .then((a) => { answers.push({ method, path: u.pathname, status: a.status ?? 200, body: a.body as Row }); return a; });
  if (lose && lose(u.pathname)) {
    lose = null;
    return sent.then(() => Promise.reject(new Error('connection reset'))) as unknown as Promise<ApiAnswer>;
  }
  return sent;
};
const sentTo = (re: RegExp) => received.filter((r) => re.test(r.path.split('?')[0]));
const conversationChannel = (cid: string) => `ws:${WS}:conv:${cid}`;
const INBOX = `ws:${WS}:inbox`;

async function until(cond: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
  await flush(5);
}

function conversation(fields: Row = {}, meta: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'open', assigned_to: null, contact_id: null, visitor_session_id: null, tags: [],
    created_at: state.db.now(), updated_at: state.db.now(), metadata: { visitor_id: 'visitor-1', ...meta }, ...fields,
  });
  return id;
}
function message(cid: string, sender_type: string, body: string, fields: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({
    id, conversation_id: cid, sender_type, sender_id: sender_type === 'agent' ? SARA : null, body, metadata: {},
    created_at: state.db.now(), ...fields,
  });
  return id;
}
/** /history's rows for the thread, as runtime-chat.js hands them to Core. */
async function history(cid: string) {
  const res = await get(`/api/widget/history?workspace_id=${WS}&conversation_id=${cid}`);
  return res.messages as Array<Record<string, unknown>>;
}
/** The visitor's channel's envelopes for a conversation, of a type. */
const onConversationChannel = (cid: string, type: string) => state.published
  .filter((p) => p.channel === conversationChannel(cid) && p.envelope.type === type).map((p) => p.envelope.payload);

/** The shipped widget on thread `cid` (t2 unless said), its history loaded, the late pack in. */
async function widget(cid: string, opts: BootOptions & { messages?: Array<Record<string, unknown>> } = {}) {
  const h = boot({
    renderer: 't2',
    realtime: true,
    config: { workspaceId: WS },
    conversations: [{ id: cid, status: 'open', operatorName: 'سارا', operatorOnline: true }],
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

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  try { localStorage.clear(); } catch { /* jsdom */ }
  state.db = createFakeServiceDb();
  let last = 0;
  state.db.now = () => { last = Math.max(Date.now(), last + 1); return new Date(last).toISOString(); };
  state.db.tables.profiles = [
    { id: SARA, full_name: 'سارا', avatar_storage_key: null, email: 'sara@example.com' },
    { id: MEHDI, full_name: 'مهدی', avatar_storage_key: null, email: 'mehdi@example.com' },
  ];
  state.db.tables.workspace_members = [{ workspace_id: WS, user_id: SARA, role: 'owner' }];
  state.template = 't2';
  state.options = {};
  state.visitor = 'visitor-1';
  state.published.length = 0;
  state.merges.length = 0;
  state.known = null;
  state.pushes.length = 0;
  state.sent.length = 0;
  state.user = SARA;
  state.subs.length = 0;
  received.length = 0;
  answers.length = 0;
  refreshes = 0;
  realIdentity = false;
  lose = null;
  __resetWidgetRateLimitsForTests();
});
afterEach(() => { vi.restoreAllMocks(); });

// ═══ Reactions (t2) ═══════════════════════════════════════════════════════
describe('reactions: the widget, the server and the inbox agree', () => {
  /** A t2 thread: the visitor's question, Sara's two answers. */
  function thread() {
    const cid = conversation();
    const ask = message(cid, 'contact', 'فاکتور سفارشم رو می‌خوام');
    const invoice = message(cid, 'agent', 'این هم فاکتور سفارشتان.');
    const more = message(cid, 'agent', 'چیز دیگری هست؟');
    return { cid, ask, invoice, more };
  }
  const badge = (h: ReturnType<typeof boot>, id: string) => h.q(`.react[data-msg-id="${id}"]`);
  const heart = (h: ReturnType<typeof boot>, id: string) => h.q<HTMLButtonElement>(`[data-msg-react][data-msg-id="${id}"]`);

  it('the GET the thread asks with, and its answer drawn: the visitor\'s own heart (mine), an operator\'s 👍 on the visitor\'s message', async () => {
    const { cid, ask, invoice, more } = thread();
    state.db.tables.conversation_message_reactions = [
      { id: randomUUID(), workspace_id: WS, conversation_id: cid, message_id: invoice, actor_type: 'visitor', actor_id: null, emoji: HEART, created_at: state.db.now() },
      { id: randomUUID(), workspace_id: WS, conversation_id: cid, message_id: ask, actor_type: 'operator', actor_id: SARA, emoji: '👍', created_at: state.db.now() },
    ];
    const h = await widget(cid);
    await until(() => badge(h, ask));

    expect(sentTo(/\/reactions$/).map((r) => [r.method, r.path])).toEqual([['GET', `/api/widget/conversations/${cid}/reactions?workspace_id=${WS}`]]);
    expect(answered('GET', /\/reactions$/).map((a) => [a.status, a.body])).toEqual([[200, {
      reactions: { [invoice]: [{ emoji: HEART, count: 1, mine: true }], [ask]: [{ emoji: '👍', count: 1, mine: false }] }, at: expect.any(Number),
    }]]);
    expect(badge(h, invoice)!.getAttribute('aria-label')).toBe('واکنش‌ها: ❤️ ۱');
    expect(badge(h, ask)!.getAttribute('aria-label')).toBe('واکنش‌ها: 👍 ۱');
    expect(heart(h, invoice)!.getAttribute('aria-pressed')).toBe('true');
    expect(heart(h, more)!.getAttribute('aria-pressed')).toBe('false');
    // Nothing to heart on the visitor's own message (the server would refuse it: 422).
    expect(heart(h, ask)).toBeNull();
  });

  it('the heart: the exact POST, the row stored, one live event (the visitor\'s fields on its channel, the inbox\'s whole), and back off again', async () => {
    const { cid, more } = thread();
    const h = await widget(cid);
    await until(() => sentTo(/\/reactions$/).length === 1);
    state.published.length = 0;

    click(heart(h, more));
    await until(() => sentTo(/\/reactions$/).length === 2 && state.published.length === 2);
    expect(sentTo(/\/reactions$/)[1]).toEqual({
      method: 'POST', path: `/api/widget/conversations/${cid}/reactions`,
      body: { workspace_id: WS, message_id: more, emoji: HEART, on: true },
    });
    expect(state.db.tables.conversation_message_reactions).toEqual([expect.objectContaining({
      workspace_id: WS, conversation_id: cid, message_id: more, actor_type: 'visitor', actor_id: null, emoji: HEART,
    })]);
    expect(badge(h, more)!.getAttribute('aria-label')).toBe('واکنش‌ها: ❤️ ۱');
    expect(heart(h, more)!.getAttribute('aria-pressed')).toBe('true');

    // The visitor's channel: exactly the fields the widget reads; the inbox: the whole event.
    const [visitorCopy] = onConversationChannel(cid, 'event');
    expect(Object.keys(visitorCopy).sort()).toEqual([...WIDGET_EVENT_FIELDS.message_reactions].sort());
    expect(visitorCopy).toEqual({ kind: 'message_reactions', conversation_id: cid, message_id: more, reactions: [{ emoji: HEART, count: 1, visitor: true }], at: expect.any(Number) });
    // The answer the widget settles on, read at the same moment as the event.
    expect(answered('POST', /\/reactions$/).map((a) => [a.status, a.body])).toEqual([[200, {
      ok: true, message_id: more, reactions: [{ emoji: HEART, count: 1, mine: true }], at: visitorCopy.at,
    }]]);
    const inbox = state.published.filter((p) => p.channel === INBOX).map((p) => p.envelope);
    expect(inbox).toEqual([{ type: 'event', payload: { ...visitorCopy, workspace_id: WS } }]);

    click(heart(h, more));
    await until(() => sentTo(/\/reactions$/).length === 3 && !badge(h, more));
    expect((sentTo(/\/reactions$/)[2].body as Row).on).toBe(false);
    expect(state.db.tables.conversation_message_reactions).toEqual([]);
    expect(heart(h, more)!.getAttribute('aria-pressed')).toBe('false');
  });

  it('an operator reacts in the inbox: the real route\'s event passes both real drivers to the widget, which draws it; the inbox\'s copy re-reads its thread', async () => {
    const { cid, ask } = thread();
    const h = await widget(cid);
    await until(() => sentTo(/\/reactions$/).length === 1);
    state.published.length = 0;

    // The inbox's request (src/lib/conversations-api.ts setReaction).
    const res = await request('POST', `/api/conversations/${cid}/messages/${ask}/reactions`, JSON.stringify({ workspace_id: WS, emoji: '🙏', on: true }));
    expect(res).toMatchObject({ status: 200, body: { ok: true, message_id: ask, reactions: [{ emoji: '🙏', count: 1, mine: true, visitor: false }] } });
    await until(() => state.published.length === 2);
    const [visitorCopy] = onConversationChannel(cid, 'event');
    expect(Object.keys(visitorCopy).sort()).toEqual([...WIDGET_EVENT_FIELDS.message_reactions].sort());

    // Centrifugo delivers the envelope as published ({ type, payload }); its
    // driver's `event` branch, run as the driver runs it.
    const src = read('public/widget/runtime-rt-centrifugo.js');
    const branch = src.slice(src.indexOf("if (data && data.type === 'event') {"), src.indexOf("} else if (data && data.type === 'message' && hooks.onMessage)"));
    const viaCentrifugo: unknown[] = [];
    new Function('data', 'hooks', 'window', branch + '}')({ type: 'event', payload: visitorCopy }, { onReaction: (p: unknown) => viaCentrifugo.push(p) }, {});
    // Supabase broadcasts { event: envelope.type, payload: envelope.payload }
    // (server publishers/supabase.ts); its driver's `event` handler.
    const viaSupabase = await supabaseDriverHands({ type: 'broadcast', event: 'event', payload: visitorCopy });
    expect(viaCentrifugo).toEqual([visitorCopy]);
    expect(viaSupabase).toEqual([visitorCopy]);

    h.emitReaction(viaCentrifugo[0] as Record<string, unknown>);
    await until(() => badge(h, ask));
    expect(badge(h, ask)!.getAttribute('aria-label')).toBe('واکنش‌ها: 🙏 ۱');

    // The dashboard's open thread hears the inbox channel's copy and re-reads
    // its messages, which carry the reaction as this operator sees it.
    const qc = new QueryClient();
    const invalidated: string[] = [];
    vi.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters?: { queryKey?: readonly unknown[] }) => { invalidated.push(JSON.stringify(filters?.queryKey)); });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useInboxRealtime({ workspaceId: WS, conversationId: cid }), { wrapper });
    await waitFor(() => expect(state.subs.find((s) => s.channel === INBOX)).toBeTruthy());
    const inboxEnvelope = state.published.find((p) => p.channel === INBOX)!.envelope;
    expect(inboxEnvelope.type).toBe('event');
    state.subs.find((s) => s.channel === INBOX)!.handlers.onEvent!(inboxEnvelope.payload as never);
    await waitFor(() => expect(invalidated).toContain(JSON.stringify(['messages', cid])));
    const thread2 = await get(`/api/conversations/${cid}/messages?workspace_id=${WS}`);
    const rows = (thread2.messages || thread2.data || thread2) as Array<Record<string, unknown>>;
    expect(rows.find((m) => m.id === ask)).toMatchObject({ reactions: [{ emoji: '🙏', count: 1, mine: true, visitor: false }], can_react: true });
  });

  it('the visitor\'s heart reaches the inbox: GET /:id/messages shows it as the visitor\'s, React offered on the visitor\'s message only', async () => {
    const { cid, ask, invoice } = thread();
    const h = await widget(cid);
    await until(() => heart(h, invoice));
    click(heart(h, invoice));
    await until(() => (state.db.tables.conversation_message_reactions || []).length === 1);
    const res = await get(`/api/conversations/${cid}/messages?workspace_id=${WS}`);
    const rows = (res.messages || res.data || res) as Array<Record<string, unknown>>;
    expect(rows.find((m) => m.id === invoice)).toMatchObject({ reactions: [{ emoji: HEART, count: 1, visitor: true, mine: false }] });
    expect(rows.find((m) => m.id === invoice)!.can_react).toBeUndefined();
    expect(rows.find((m) => m.id === ask)!.can_react).toBe(true);
  });

  it('before migration 276: GET answers none (no badge), the heart\'s POST 503 puts the state back', async () => {
    state.db.missing.add('conversation_message_reactions');
    const { cid, more } = thread();
    const h = await widget(cid);
    await until(() => sentTo(/\/reactions$/).length === 1);
    expect(h.q('.react')).toBeNull();
    click(heart(h, more));
    await until(() => sentTo(/\/reactions$/).length === 2);
    await until(() => heart(h, more)!.getAttribute('aria-pressed') === 'false');
    expect(answers.map((a) => [a.method, a.status, a.body])).toEqual([
      ['GET', 200, { reactions: {}, at: expect.any(Number) }],
      ['POST', 503, { error: expect.any(String), code: 'migration_required' }],
    ]);
    expect(h.q('.react')).toBeNull();
    expect(state.published).toEqual([]);
    expect(refreshes).toBe(0);
  });

  it('the fields runtime-late.js reads from the event are exactly WIDGET_EVENT_FIELDS\' (the drivers read `kind`)', () => {
    const late = read('public/widget/runtime-late.js');
    const hook = late.slice(late.indexOf("api.on('reaction', function (p) {"), late.indexOf("api.on('wired'", late.indexOf("api.on('reaction'")));
    const fields = new Set(Array.from(hook.matchAll(/\bp\.(\w+)/g), (m) => m[1]));
    expect([...fields].sort()).toEqual(WIDGET_EVENT_FIELDS.message_reactions.filter((f) => f !== 'kind').slice().sort());
    // Each reaction: emoji, count and `visitor` (norm(p.reactions, 'visitor')).
    expect(hook).toContain("norm(p.reactions, 'visitor')");
    expect(late).toMatch(/emoji: String\(r && r\.emoji \|\| ''\), count: Math\.floor\(Number\(r && r\.count\)\) \|\| 0, mine: !!\(r && r\[mineKey\]\)/);
  });
});

/** What the Supabase driver hands the runtime's onReaction for one broadcast of its `event` binding. */
async function supabaseDriverHands(msg: unknown): Promise<unknown[]> {
  const handlers: Record<string, (msg: unknown) => void> = {};
  const fakeClient = {
    channel() {
      const ch = {
        on(_type: string, filter: { event: string }, fn: (m: unknown) => void) { handlers[filter.event] = fn; return ch; },
        subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; },
      };
      return ch;
    },
    removeChannel() {},
    realtime: { disconnect() {} },
  };
  const seen: unknown[] = [];
  const CID = '44444444-4444-4444-8444-444444444444';
  const sandbox: Record<string, unknown> = {
    fetch: async () => ({ ok: true, json: async () => ({ vendor: 'supabase', channel: `ws:${WS}:conv:${CID}`, topic: `ws:${WS}:conv:${CID}:MAC0123456789abcdefghijklmnopqrstu` }) }),
    __gs_supabase_client_factory: () => fakeClient,
    __gs_token: { get: () => 'wt' },
    setTimeout, clearTimeout, Promise,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(read('public/widget/runtime-rt-supabase.js'), sandbox);
  const drv = (sandbox.__gs_mod_rt_supabase as { create: (...a: unknown[]) => Record<string, (...a: unknown[]) => void> }).create(
    { workspaceId: WS, apiBase: 'https://api.test' }, { vendor: 'supabase', supabase_url: 'https://x.supabase.co', anon_key: 'anon' },
    { onConnectionState() {}, onMessage() {}, onTyping() {}, onPresence() {}, onReconnect() {}, onSubscribed() {}, fallbackToPolling() {}, onReaction: (p: unknown) => seen.push(p) });
  drv.subscribeConversation(CID);
  drv.connect();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  handlers.event(msg);
  return seen;
}

// ═══ The queue (t1) ═══════════════════════════════════════════════════════
describe('the place in the queue: routing, GET /queue and the pill agree', () => {
  /** patch_conversation_metadata (migration 057) and 276's chat_queue_status, as the database answers them. */
  function database(queue: () => { queue_position: number | null; wait_minutes: number | null }) {
    state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'manual', round_robin_cursor_user_id: null }];
    state.db.rpc = (fn, args) => {
      if (fn === 'patch_conversation_metadata') {
        const row = (state.db.tables.conversations || []).find((c) => c.id === args.p_conversation_id);
        if (!row) return { data: false, error: null };
        row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
        return { data: true, error: null };
      }
      if (fn === 'chat_queue_status') return { data: [queue()], error: null };
      return { data: null, error: null };
    };
  }
  const pill = (h: ReturnType<typeof boot>) => Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-system-pill')).map((p) => p.textContent);

  it('routing queues it (the row the widget recognises, queued_at saved first); the pill asks GET /queue and says the place, then the wait; the join ends it', async () => {
    state.template = 't1';
    let answer = { queue_position: 2 as number | null, wait_minutes: null as number | null };
    database(() => answer);
    const cid = conversation({}, { ai_state: 'needs_human' });
    message(cid, 'contact', 'سلام، سفارش ۴۸۲۱۳ هنوز کد رهگیری نداره.');
    const h = await widget(cid, { renderer: 't1' });

    expect(await routeConversationToOperator(CONFIG, { workspaceId: WS, conversationId: cid })).toMatchObject({ outcome: 'manual_queue' });
    const conv = state.db.tables.conversations!.find((c) => c.id === cid)!;
    expect(conv.metadata).toMatchObject({ routing_outcome: 'manual_queue', queued_at: expect.any(String), queue_entry_position: 2 });
    // The queue row reaches the visitor live, as the widget's driver hands it over.
    const [row] = onConversationChannel(cid, 'message');
    expect(row).toMatchObject({ role: 'system', sender_type: 'system', metadata: { kind: 'routing_in_queue' } });
    h.emitMessages([row]);
    await until(() => sentTo(/\/api\/widget\/queue$/).length === 1 && pill(h).some((p) => /صف/.test(p || '')));
    expect(sentTo(/\/api\/widget\/queue$/).map((r) => r.path)).toEqual([`/api/widget/queue?workspace_id=${WS}&conversation_id=${cid}`]);
    expect(pill(h)).toEqual(['نفر ۲ در صف']);

    // Three claims measured: the server knows a wait. The panel shown again asks at once.
    answer = { queue_position: 1, wait_minutes: 4 };
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await until(() => sentTo(/\/api\/widget\/queue$/).length === 2 && pill(h)[0] !== 'نفر ۲ در صف');
    expect(pill(h)).toEqual(['نفر ۱ در صف · حدود ۴ دقیقه']);
    expect(answered('GET', /\/queue$/).map((a) => [a.status, a.body])).toEqual([
      [200, { position: 2, wait_minutes: null }], [200, { position: 1, wait_minutes: 4 }],
    ]);

    // Mehdi claims it; routing tells the visitor who joined (the visitor's
    // copy without his id). GET /queue now says not waiting, and the widget
    // stops asking.
    conv.assigned_to = MEHDI;
    conv.metadata = { ...(conv.metadata as Row), routing_notice_sent: false };
    // A member of the team, here (routing announces only an operator who can answer).
    state.db.tables.workspace_members = [...(state.db.tables.workspace_members || []), { workspace_id: WS, user_id: MEHDI, role: 'agent' }];
    (await import('../../../server/services/calls/departments.js')).invalidateDepartmentCache(WS);
    expect(await routeConversationToOperator(CONFIG, { workspaceId: WS, conversationId: cid })).toMatchObject({ outcome: 'already_assigned' });
    const joined = onConversationChannel(cid, 'message')[1];
    expect(joined).toMatchObject({ metadata: { kind: 'routing_agent_joined', agent_name: 'مهدی' } });
    expect((joined.metadata as Row).agent_id).toBeUndefined();
    expect(state.published.find((p) => p.channel === INBOX && p.envelope.type === 'message' && (p.envelope.payload.metadata as Row).kind === 'routing_agent_joined')!
      .envelope.payload.metadata).toMatchObject({ agent_id: MEHDI });
    expect(await get(`/api/widget/queue?workspace_id=${WS}&conversation_id=${cid}`)).toEqual({ position: null, wait_minutes: null });
    const asked = sentTo(/\/api\/widget\/queue$/).length;
    h.emitMessages([joined]);
    await flush(30);
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(30);
    expect(sentTo(/\/api\/widget\/queue$/)).toHaveLength(asked);
    // The queued row says what it always said; the join row follows it.
    expect(pill(h)[0]).toBe('پیام شما در صف پشتیبانی قرار گرفت.');
    expect(pill(h).some((p) => /نفر/.test(p || ''))).toBe(false);
  });

  it('the server says the visitor is not waiting (claimed meanwhile): nulls, the row says what it always said, no second ask', async () => {
    state.template = 't1';
    database(() => ({ queue_position: 3, wait_minutes: null }));
    const cid = conversation({}, { ai_state: 'needs_human' });
    message(cid, 'contact', 'سلام');
    await routeConversationToOperator(CONFIG, { workspaceId: WS, conversationId: cid });
    state.db.tables.conversations!.find((c) => c.id === cid)!.assigned_to = SARA;
    const h = await widget(cid, { renderer: 't1' });
    await until(() => sentTo(/\/api\/widget\/queue$/).length === 1);
    await flush(20);
    expect(pill(h).some((p) => /نفر/.test(p || ''))).toBe(false);
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(30);
    expect(sentTo(/\/api\/widget\/queue$/)).toHaveLength(1);
  });
});

// ═══ The message left away (t1, t2) ═══════════════════════════════════════
describe('the message left while the team is away: offline-messages, offline-email and the reply card agree', () => {
  const AWAY = { state: 'offline', offline_mode: 'capture_message', next_open_at: null };
  /**
   * A first visit (no conversation yet) to the chat tab, away, once the late
   * pack is in. Before it Core's own leave-a-message form shows (an offline
   * start publishes its presence since round 5) and keeps the tab while it
   * is there (awayThread.test.ts).
   */
  async function away(opts: BootOptions = {}) {
    const h = boot({
      renderer: 't1',
      realtime: true,
      config: { workspaceId: WS, availability: AWAY, visitorEmail: true },
      identity: { identity_state: 'anonymous', contact: null },
      api,
      ...opts,
    });
    await flush(30);
    await until(() => (window as unknown as { __gs_mod_late?: unknown }).__gs_mod_late);
    await flush(30);
    h.runtime.setTab('chat');
    await flush(30);
    h.runtime.__test.setConnectionState('online');
    await flush(10);
    return h;
  }
  const composer = (h: ReturnType<typeof boot>) => h.q<HTMLTextAreaElement>('[data-msg-input]')!;
  async function send(h: ReturnType<typeof boot>, text: string) {
    typeInto(composer(h), text);
    key(composer(h), 'Enter');
    await flush(10);
  }
  const reply = (h: ReturnType<typeof boot>) => h.q('[data-chat-messages] .away-reply');
  const local = (h: ReturnType<typeof boot>) => (h.runtime.__test.chatState().messages as Array<Record<string, unknown>>)[0];
  const t = (h: ReturnType<typeof boot>) => h.env().t as (k: string) => string;

  it('t1: the first message is captured with its bubble\'s id; the email card\'s address goes to the contact; a reload\'s /history finds the reply again', async () => {
    const h = await away();
    await send(h, 'سلام، برای سفارش عمده تخفیف دارید؟');
    await until(() => reply(h));

    const [posted] = sentTo(/\/offline-messages$/);
    expect(posted.body).toEqual({
      workspace_id: WS, message: 'سلام، برای سفارش عمده تخفیف دارید؟', locale: 'fa', honeypot: '',
      client_message_id: local(h).localId,
    });
    const conv = state.db.tables.conversations![0];
    const row = state.db.tables.conversation_messages![0];
    expect(conv).toMatchObject({ tags: ['offline'], metadata: { source: 'offline_capture', visitor_id: 'visitor-1', channel_thread_key: `widget_cmid:${local(h).localId}` } });
    expect(row).toMatchObject({ conversation_id: conv.id, sender_type: 'contact', metadata: { source: 'offline_capture', client_message_id: local(h).localId } });
    // The bubble is that message; the thread is that conversation.
    expect(local(h)).toMatchObject({ __id: row.id, status: 'sent' });
    expect(h.runtime.__test.chatState().conversationId).toBe(conv.id);
    expect(state.pushes).toHaveLength(1);
    expect(answered('POST', /\/offline-messages$/).map((a) => [a.status, a.body])).toEqual([[200, {
      ok: true, captured: true, conversation_id: conv.id, transitioning: false, message_id: row.id,
    }]]);

    const field = h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!;
    typeInto(field, 'ali.r@example.com');
    field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => sentTo(/\/identity\/offline-email$/).length === 1 && !h.q('.away-reply [data-fb="email"]'));
    expect(sentTo(/\/identity\/offline-email$/)[0].body).toEqual({ workspace_id: WS, conversation_id: conv.id, email: 'ali.r@example.com' });
    expect(answered('POST', /\/identity\/offline-email$/).map((a) => [a.status, a.body])).toEqual([[200, { ok: true, contact_id: CONTACT }]]);
    expect(state.merges).toEqual([expect.objectContaining({ workspaceId: WS, visitorId: 'visitor-1', identity: { name: null, email: 'ali.r@example.com', phone: null }, method: 'prechat' })]);
    expect(conv.contact_id).toBe(CONTACT);
    // Saved: where the reply goes, no field any more.
    expect(reply(h)!.textContent).toContain('ali.r@example.com');

    // A reload: the server's own rows, the contact known.
    const rows = await history(conv.id as string);
    expect(rows[0]).toMatchObject({ id: row.id, sender_type: 'contact', metadata: { source: 'offline_capture' } });
    resetWindow();
    const again = await widget(conv.id as string, { renderer: 't1', messages: rows, config: { workspaceId: WS, availability: AWAY, visitorEmail: true } });
    await until(() => reply(again));
    expect(reply(again)!.previousElementSibling!.classList.contains('visitor')).toBe(true);
    expect(reply(again)!.querySelector('[data-fb="email"]')).toBeNull();
  });

  it('a lost answer: the retry sends the same client id and the server answers the same capture (one conversation, one push)', async () => {
    const h = await away();
    lose = (p) => p.endsWith('/offline-messages');
    await send(h, 'سلام');
    await until(() => h.q('[data-msg-retry]'));
    expect(state.db.tables.conversations).toHaveLength(1);
    click(h.q('[data-msg-retry]'));
    await until(() => reply(h));
    const posts = sentTo(/\/offline-messages$/);
    expect(posts).toHaveLength(2);
    expect((posts[1].body as Row).client_message_id).toBe((posts[0].body as Row).client_message_id);
    expect(state.db.tables.conversations).toHaveLength(1);
    expect(state.db.tables.conversation_messages).toHaveLength(1);
    expect(state.pushes).toHaveLength(1);
    expect(local(h)).toMatchObject({ __id: state.db.tables.conversation_messages![0].id, status: 'sent' });
    expect(h.runtime.__test.chatState().conversationId).toBe(state.db.tables.conversations![0].id);
  });

  it('a first message as long as the composer allows (POST /message\'s 5,000) is captured, not refused', async () => {
    const h = await away();
    const text = 'س'.repeat(4500);
    await send(h, text);
    await until(() => reply(h) || h.q('[data-msg-retry]'));
    expect(h.q('[data-msg-retry]')).toBeNull();
    expect(state.db.tables.conversation_messages![0].body).toBe(text);
  });

  it('what the contact already holds rides along; a stored value the form would refuse does not cost the message', async () => {
    const h = await away({ identity: { identity_state: 'anonymous', contact: { name: 'ع'.repeat(130), email: 'not-an-address', phone: '0912 123 4567' } } });
    await send(h, 'سلام');
    await until(() => reply(h));
    expect(sentTo(/\/offline-messages$/)[0].body).toMatchObject({ name: 'ع'.repeat(130), email: 'not-an-address', phone: '0912 123 4567' });
    expect(state.db.tables.conversation_messages).toHaveLength(1);
  });

  it('t2: an address the widget takes but the server refuses says "invalid"; a fixed one is saved', async () => {
    const h = await away({ renderer: 't2' });
    await send(h, 'سلام');
    await until(() => h.q('.away-reply [data-fb="email"]'));
    const field = () => h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!;
    // The widget's rule is the server's (V-14): refused in place, nothing sent.
    typeInto(field(), 'علی@example.com');
    field().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => h.q('.away-reply [data-fb-status]')?.textContent);
    expect(h.q('.away-reply [data-fb-status]')!.textContent).toBe(t(h)('invalidEmail'));
    expect(sentTo(/\/identity\/offline-email$/)).toEqual([]);
    // One only the server refuses (longer than its 254): said as invalid too.
    typeInto(field(), 'a'.repeat(250) + '@example.com');
    field().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => sentTo(/\/identity\/offline-email$/).length === 1 && h.q('.away-reply [data-fb-status]')?.textContent);
    expect(h.q('.away-reply [data-fb-status]')!.textContent).toBe(t(h)('invalidEmail'));
    expect(answered('POST', /\/identity\/offline-email$/)[0]).toMatchObject({ status: 400, body: { error: 'Invalid input' } });
    expect(state.merges).toEqual([]);
    typeInto(field(), 'ali.r@example.com');
    field().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => h.q('.away-reply .fcard.done'));
    expect(h.q('.away-reply .fcard.done b')!.textContent).toBe('ali.r@example.com');
    expect(refreshes).toBe(0);
  });

  it('the card for a conversation the server did not capture away: 409 not_offline_capture, said as a failure, nothing merged', async () => {
    const cid = conversation();
    message(cid, 'contact', 'سلام', { metadata: { source: 'offline_capture', visitor_id: 'visitor-1' } });
    const h = await widget(cid, { renderer: 't1', identity: { identity_state: 'anonymous', contact: null }, config: { workspaceId: WS, availability: AWAY, visitorEmail: true } });
    await until(() => h.q('.away-reply [data-fb="email"]'));
    const field = h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!;
    typeInto(field, 'ali.r@example.com');
    field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => sentTo(/\/identity\/offline-email$/).length === 1 && h.q('.away-reply [data-fb-status]')?.textContent);
    expect(h.q('.away-reply [data-fb-status]')!.textContent).toBe(t(h)('fallbackError'));
    expect(answered('POST', /\/identity\/offline-email$/).map((a) => [a.status, a.body])).toEqual([[409, { error: 'not_offline_capture' }]]);
    expect(state.merges).toEqual([]);
  });
});

// ═══ The step pre-chat (t1) ═══════════════════════════════════════════════
describe('the pre-chat one question at a time: /identity/me\'s flags and ONE POST /identity/prechat agree', () => {
  function settings(over: Row = {}) {
    state.db.tables.widget_prechat_settings = [{
      workspace_id: WS, ask_name: true, ask_email: true, ask_phone: true, require_name: true, require_email: true, require_phone: false,
      verify_email: false, verify_phone: false, prechat_timing: 'always', history_continue_window_hours: 24, ...over,
    }];
  }
  async function steps() {
    realIdentity = true;
    new Function(read('public/widget/presentation-t1-x.js')).call(window);
    new Function(read('public/widget/runtime-late.js')).call(window);
    const h = boot({
      renderer: 't1',
      config: { workspaceId: WS, templateOptions: { prechatMode: 'steps' } },
      api,
    });
    await flush(30);
    h.runtime.setTab('chat');
    await until(() => h.q('[data-prechat-step]'));
    return h;
  }
  const step = (h: ReturnType<typeof boot>) => h.q('[data-prechat-step]')?.getAttribute('data-prechat-step') ?? null;
  async function answer(h: ReturnType<typeof boot>, value: string) {
    typeInto(h.q<HTMLInputElement>('[data-prechat-step-input]')!, value);
    key(h.q('[data-prechat-step-input]')!, 'Enter');
    await flush(10);
  }
  const prechatPosts = () => sentTo(/\/identity\/prechat$/).filter((r) => r.method === 'POST');

  it('the steps the server\'s settings ask for; Persian digits and the edition\'s prefix make a number the server keeps; one POST; identified', async () => {
    settings();
    const h = await steps();
    expect(sentTo(/\/identity\/me$/).map((r) => r.path)).toEqual([`/api/widget/identity/me?workspace_id=${WS}`]);
    expect(step(h)).toBe('name');
    await answer(h, 'علی رضایی');
    expect(step(h)).toBe('email');
    await answer(h, 'ali.r@example.com');
    expect(step(h)).toBe('phone');
    await answer(h, '۰۹۱۲ ۱۲۳ ۴۵۶۷');
    await until(() => prechatPosts().length === 1 && !h.q('[data-prechat-step]'));
    expect(prechatPosts()[0].body).toEqual({ workspace_id: WS, name: 'علی رضایی', email: 'ali.r@example.com', phone: '+989121234567' });
    expect(state.merges).toEqual([expect.objectContaining({ identity: { name: 'علی رضایی', email: 'ali.r@example.com', phone: '+989121234567' }, method: 'prechat' })]);
    expect(answered('POST', /\/identity\/prechat$/)).toEqual([expect.objectContaining({ status: 200, body: expect.objectContaining({ success: true, contact_id: CONTACT }) })]);
    expect(h.q<HTMLElement>('[data-input-bar]')!.style.display).not.toBe('none');
  });

  it('the server\'s refusals go back to their step: an address only the server refuses (zod `details`), then a field it now requires (`field`)', async () => {
    settings();
    const h = await steps();
    await answer(h, 'علی');
    // The widget's rule is the server's (V-14): a Persian-letter address is
    // refused in place, before anything is sent.
    await answer(h, 'علی@example.com');
    expect(step(h)).toBe('email');
    expect(prechatPosts()).toEqual([]);
    // One the widget takes but the server does not (longer than its 254).
    const long = 'a'.repeat(250) + '@example.com';
    await answer(h, long);
    // The phone is optional, as /identity/me said: skipped.
    click(h.q('[data-prechat-step-skip]'));
    await until(() => prechatPosts().length === 1 && step(h) === 'email');
    expect(prechatPosts()[0].body).toMatchObject({ email: long, phone: null });
    // The owner makes the phone required meanwhile; the fixed address (the
    // skipped phone stands) goes at once.
    settings({ require_phone: true });
    await answer(h, 'ali.r@example.com');
    await until(() => prechatPosts().length === 2 && step(h) === 'phone');
    expect(state.merges).toEqual([]);
    await answer(h, '09121234567');
    await until(() => prechatPosts().length === 3 && !h.q('[data-prechat-step]'));
    expect(prechatPosts()[2].body).toEqual({ workspace_id: WS, name: 'علی', email: 'ali.r@example.com', phone: '+989121234567' });
    expect(state.merges).toHaveLength(1);
    // The refusals as the server gave them: the address refused (naming its
    // field, zod's `details` too), then the required field.
    expect(answered('POST', /\/identity\/prechat$/).map((a) => [a.status, a.body.error, a.body.field ?? Object.keys((a.body.details as Row) || {})])).toEqual([
      [400, 'email_invalid', 'email'], [400, 'phone_required', 'phone'], [200, undefined, []],
    ]);
  });
});

// ═══ Who is typing (t1) ═══════════════════════════════════════════════════
describe('who is typing: the inbox\'s typing event names the operator the row draws', () => {
  it('Mehdi types in the inbox: the real route\'s envelope (name, no id) is what the row says', async () => {
    state.template = 't1';
    const cid = conversation({ assigned_to: SARA });
    message(cid, 'contact', 'سلام');
    message(cid, 'agent', 'سلام، بفرمایید.');
    const h = await widget(cid, { renderer: 't1', assignedOperator: { name: 'سارا', avatar: null, online: true } });
    state.user = MEHDI;
    expect(await request('POST', '/api/conversations/typing', JSON.stringify({ conversation_id: cid, workspace_id: WS }))).toMatchObject({ status: 200, body: { ok: true, published: true } });
    const [typing] = onConversationChannel(cid, 'typing');
    expect(typing).toEqual({ actor: 'agent', conversation_id: cid, ts: expect.any(Number), name: 'مهدی' });
    h.emitTyping(typing);
    await until(() => h.q('.typing-row .msg-meta'));
    expect(h.q('.typing-row .msg-meta')!.textContent).toBe('مهدی در حال نوشتن…');
  });
});

// ═══ The privacy strip: two operators ═════════════════════════════════════
describe('messages of two operators, as the visitor now gets them (no operator ids), group and label by operator', () => {
  async function twoOperators() {
    const cid = conversation({ assigned_to: MEHDI });
    message(cid, 'contact', 'سلام، سفارشم نرسیده');
    message(cid, 'agent', 'سلام، بررسی می‌کنم.', { sender_id: SARA });
    message(cid, 'agent', 'همکارم مهدی ادامه می‌ده.', { sender_id: SARA });
    message(cid, 'system', 'مهدی joined the conversation.', { metadata: { kind: 'routing_agent_joined', agent_name: 'مهدی', agent_id: MEHDI, actor_id: SARA } });
    message(cid, 'agent', 'سلام! فردا می‌رسه.', { sender_id: MEHDI });
    message(cid, 'agent', 'کد رهگیری: TR-2290', { sender_id: MEHDI });
    const rows = await history(cid);
    // What the visitor's browser gets: names, never ids.
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(SARA);
    expect(raw).not.toContain(MEHDI);
    expect(rows.filter((m) => m.sender_type === 'agent').map((m) => m.sender_name)).toEqual(['سارا', 'سارا', 'مهدی', 'مهدی']);
    return { cid, rows };
  }
  /**
   * The thread's bubbles as the renderer grouped them: who wrote each (the
   * author its quote button names), `|` closing a run, the run's label
   * (`.msg-sender-label`, t1 / t2) before it.
   */
  function runs(h: ReturnType<typeof boot>) {
    return Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-row.visitor, [data-chat-messages] .msg-row.operator')).map((r) => {
      const label = r.querySelector('.msg-sender-label');
      return (label ? label.textContent + ': ' : '') + r.querySelector('[data-msg-reply-author]')!.getAttribute('data-msg-reply-author') +
        (r.classList.contains('is-last') ? '|' : '');
    });
  }
  // The chat bar names who answers, so the first run has no label; a
  // label only where the team's side changes hands (owner, 2026-10-18).
  const RUNS = ['شما|', 'سارا', 'سارا|', 'مهدی: مهدی', 'مهدی|'];

  it('t1 and t2: a label where another operator takes over, one avatar per run', async () => {
    for (const renderer of ['t1', 't2'] as const) {
      resetWindow();
      const { cid, rows } = await twoOperators();
      state.template = renderer;
      const h = await widget(cid, { renderer, messages: rows });
      await until(() => h.q('[data-chat-messages] .msg-sender-label'));
      expect(runs(h), renderer).toEqual(RUNS);
      const avatars = Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-row.operator .msg-avatar:not(.msg-avatar-spacer)'));
      expect(avatars.map((a) => a.textContent!.trim()), renderer).toEqual(['س', 'م']);
      expect(h.shadow.querySelector('[data-chat-messages]')!.textContent, renderer).toContain('مهدی');
    }
  });

  it('default: each run is its operator\'s', async () => {
    const { cid, rows } = await twoOperators();
    state.template = 'default';
    const h = await widget(cid, { renderer: 'default', messages: rows });
    await until(() => h.q('[data-chat-messages] .msg-row.operator'));
    expect(runs(h)).toEqual(['شما|', 'سارا', 'سارا|', 'مهدی', 'مهدی|']);
  });

  it('live: the conversation channel\'s copy of each reply has no operator id, and the widget groups it with its run', async () => {
    const { cid, rows } = await twoOperators();
    const h = await widget(cid, { renderer: 't1', messages: rows.slice(0, 3) });
    const { buildMessageEnvelope, publishConversationEvent } = await import('../../../server/services/realtime/publish.js');
    for (const m of state.db.tables.conversation_messages!.slice(3)) {
      await publishConversationEvent(CONFIG, WS, cid, buildMessageEnvelope({
        id: m.id as string, conversation_id: cid, sender_type: m.sender_type as 'agent' | 'system', body: m.body as string,
        created_at: m.created_at as string, metadata: m.metadata as Row, sender_id: m.sender_id as string | null,
        sender_name: m.sender_type === 'agent' ? (m.sender_id === MEHDI ? 'مهدی' : 'سارا') : null,
      }));
    }
    const live = onConversationChannel(cid, 'message');
    expect(JSON.stringify(live)).not.toContain(MEHDI);
    expect(JSON.stringify(state.published.filter((p) => p.channel === INBOX))).toContain(MEHDI);
    h.emitMessages(live);
    await until(() => h.shadow.querySelectorAll('[data-chat-messages] .msg-row.operator').length === 4);
    expect(runs(h)).toEqual(RUNS);
  });
});
