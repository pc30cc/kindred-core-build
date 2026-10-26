/**
 * One current conversation per visitor (2026-10-24), the server's half,
 * through the REAL widgetRouter (services/widget/visitorConversations.ts).
 * The owner's rule: open, pending and resolved are LIVE for the visitor;
 * closed alone has ended.
 *
 *   POST /message     force_new_conversation, a closed or foreign id, joins
 *                     the visitor's live conversation (`continued`, nothing
 *                     created, no quota spent), never an older ended one;
 *                     a named resolved one with a newer open or pending one
 *                     beside it goes to that one; the signed visitor alone
 *                     decides (a body visitor_id names nobody, a body
 *                     session_id counts only when it is theirs); one lock per
 *                     visitor; a reply_to that is no message id is dropped.
 *   ai_intro          the greeting the visitor saw is stored before their
 *                     first message, the conversation born the AI's, only by
 *                     the request that created it and never next to a Smart
 *                     line or an AI nudge.
 *   /ai-agent/intro   preview writes nothing and names a live conversation;
 *                     an older widget's call never mints a second one.
 *   /offline-messages the away thread's first message goes on in the live
 *                     conversation.
 *   /poll             without an id, only a live conversation.
 *   the race          a message within 60 s of an inactivity close (migration
 *                     284), named or caught by the touch, goes back into that
 *                     conversation as it was; an operator's close, or one
 *                     older than that, still ends it.
 *
 * Only the database (the shared in-memory fake) and side effects are faked;
 * the routes' own control flow runs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const WS = '11111111-1111-4111-8111-111111111111';
const VISITOR = 'visitor-me';
const OTHER_VISITOR = 'visitor-other';
const SESSION = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const OTHER_CONTACT = '44444444-4444-4444-8444-444444444444';
const OPERATOR = '55555555-5555-4555-8555-555555555555';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  visitor: 'visitor-me' as string | null,
  contactCalls: [] as Array<Record<string, unknown>>,
  limitChecks: 0,
  allowance: { allowed: true } as { allowed: boolean; reason?: string },
  lifecycle: [] as Array<Record<string, unknown>>,
  pushes: [] as Array<Record<string, unknown>>,
  routed: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  aiAllowed: true,
  aiSettings: {} as Record<string, unknown>,
  teamOnline: false,
  /** The AI engine's calls (it answers nothing here). */
  aiRuns: [] as Array<Record<string, unknown>>,
  restores: [] as Array<Record<string, unknown>>,
  /** routeHumanBoundConversation runs for real (its decision is the subject). */
  realRouting: false,
  /** verifyConversationOwnership runs for real (the ids a route gives it are the subject). */
  realOwnership: false,
  /** The reopen RPC answers 42883 (a database before migration 284). */
  reopenMissing: false,
  operatorEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => (state.visitor ? { v: state.visitor, w: '11111111-1111-4111-8111-111111111111', exp: 9e9 } : null),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/security.js')>();
  return {
    ...real,
    enforceWidgetToken: (req: { _widgetWorkspaceId?: string }, _res: unknown, next: () => void) => { req._widgetWorkspaceId = '11111111-1111-4111-8111-111111111111'; next(); },
    enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
    widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    resolveWorkspaceId: (_req: unknown, _res: unknown, wsId: string) => wsId || '11111111-1111-4111-8111-111111111111',
    // Ownership: this visitor's session or contact (the fake has no cookie to
    // read), or the real check where the ids a route passes it are the subject.
    verifyConversationOwnership: async (...args: Parameters<typeof real.verifyConversationOwnership>) => {
      if (state.realOwnership) return real.verifyConversationOwnership(...args);
      const [, conversationId, workspaceId] = args;
      const conv = (state.db.tables.conversations || []).find((c) => c.id === conversationId && c.workspace_id === workspaceId);
      const mine = conv && (conv.visitor_session_id === '22222222-2222-4222-8222-222222222222' || conv.contact_id === '33333333-3333-4333-8333-333333333333');
      return mine ? { valid: true, conversation: conv } : { valid: false, conversation: null };
    },
  };
});
vi.mock('../../../server/services/widget/planGate.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/planGate.js')>()),
  widgetPlanDenied: async () => new Set<string>(),
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({
  enforceMaxConversationsLimit: async () => { state.limitChecks += 1; return true; },
  checkMaxConversationsAllowance: async () => state.allowance,
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  locksEnabled: async () => false,
}));
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({
  // The visitor's own contact, whoever they claim to be in the body.
  ensureVisitorContact: async (_sb: unknown, input: Record<string, unknown>) => {
    state.contactCalls.push(input);
    if (input.visitorId === 'visitor-me') return '33333333-3333-4333-8333-333333333333';
    if (input.visitorId === 'visitor-other') return '44444444-4444-4444-8444-444444444444';
    return randomUUID();
  },
}));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  pinContactOnVisitorSessions: async () => {},
  issueContinuityCookieForContact: async () => {},
}));
vi.mock('../../../server/services/widget/availability.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/availability.js')>()),
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/platformGuards.js')>()),
  isAutoAnswerAllowedForWorkspace: async () => (state.aiAllowed ? { allowed: true } : { allowed: false, reason: 'platform_ai_disabled' }),
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/settings.js')>()),
  getOrCreateSettings: async () => state.aiSettings,
}));
vi.mock('../../../server/services/ai-agent/visitorAiSnapshot.js', () => ({
  resolveVisitorAiSnapshot: async () => ({ visitorFacing: true, providerReady: true, introCapable: true, reason: 'ok' }),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => ({ state: state.teamOnline ? 'online' : 'offline', reason: 'test', source: 'widget_resolver', schedule: null }),
}));
vi.mock('../../../server/services/platformRegion.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/platformRegion.js')>()),
  clampLocaleToPlatformRegion: async (_c: unknown, l: string) => l,
  getPlatformAllowedLocales: async () => ['fa', 'en', 'tr'],
}));
vi.mock('../../../server/services/ai-agent/responder.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/responder.js')>()),
  // The AI's row, as the real one inserts it (sender 'ai', metadata.source).
  insertAiMessage: async (_c: unknown, input: Record<string, unknown>) => {
    type Chain = { insert(r: Row): Chain; select(c: string): Chain; single(): Promise<{ data: Row }> };
    const client = fakeServiceClient(state.db) as unknown as { from(t: string): Chain };
    const { data: row } = await client.from('conversation_messages').insert({
      conversation_id: input.conversationId,
      body: input.body,
      sender_type: 'ai',
      metadata: { source: input.source, mode: input.mode, agent_name: input.agentName },
    }).select('id, conversation_id, sender_type, body, created_at, metadata, seen_at').single();
    return { id: row.id, row, senderAvatar: 'https://cdn.test/agent.png' };
  },
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  logRun: async (_c: unknown, run: Record<string, unknown>) => { state.runs.push(run); },
}));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async (_c: unknown, input: Record<string, unknown>) => { state.aiRuns.push(input); return { action: 'skipped' }; },
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/handoffState.js')>()),
  clearAiManagementForPlatformOff: async (_c: unknown, a: Record<string, unknown>) => { state.restores.push(a); return { previousAiState: null, changed: false }; },
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async (_c: unknown, p: Record<string, unknown>) => { state.operatorEvents.push(p); },
}));
vi.mock('../../../server/services/push/index.js', () => ({
  notifyInboundMessage: async (_c: unknown, p: Record<string, unknown>) => { state.pushes.push(p); },
}));
vi.mock('../../../server/services/chatRouting.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/chatRouting.js')>();
  return {
    ...real,
    routeHumanBoundConversation: async (c: never, a: Parameters<typeof real.routeHumanBoundConversation>[1]) => {
      state.routed.push(a);
      return state.realRouting ? real.routeHumanBoundConversation(c, a) : null;
    },
    routeOfflineCapture: async (_c: unknown, a: Record<string, unknown>) => { state.routed.push({ ...a, offline: true }); return null; },
  };
});
vi.mock('../../../server/services/conversationEvents.js', () => ({ recordConversationEvent: async () => ({ ok: true }) }));
vi.mock('../../../server/services/conversationLifecycle.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/conversationLifecycle.js')>()),
  applyInboundConversationLifecycle: async (_c: unknown, a: Record<string, unknown>) => {
    state.lifecycle.push(a);
    return { transition: a.knownStatus === 'resolved' ? 'reopened_resolved' : 'none' };
  },
}));
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  sendEmail: async () => ({ ok: true }),
}));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
  attachUploadedFileToMessage: async () => true,
  enrichMessagesWithAttachments: async (_c: unknown, _w: string, m: unknown[]) => m,
  enrichMessagesWithReplyTo: async (_c: unknown, _id: string, m: unknown[]) => m,
}));
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));

const { widgetRouter } = await import('../../../server/routes/widget.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as Row).serverConfig = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

type Answer = { status: number; body: Row };
function call(method: 'GET' | 'POST', path: string, body?: Row): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify({ workspace_id: WS, ...body }) : '';
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Widget-Token': 'wss_test' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) as Row : {} }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const send = (body: Row) => call('POST', '/api/widget/message', body);

let clock = Date.parse('2026-10-24T08:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();
const ago = (minutes: number) => new Date(Date.parse('2026-10-24T08:00:00Z') - minutes * 60_000).toISOString();

function conversation(fields: Row = {}): Row {
  const row: Row = {
    id: randomUUID(), workspace_id: WS, status: 'open', contact_id: CONTACT, visitor_session_id: SESSION,
    assigned_to: null, metadata: {}, updated_at: ago(60), ...fields,
  };
  (state.db.tables.conversations ||= []).push(row);
  return row;
}
function message(conversationId: unknown, senderType: string, fields: Row = {}): Row {
  const row: Row = { id: randomUUID(), conversation_id: conversationId, sender_type: senderType, body: 'x', metadata: {}, created_at: tick(), ...fields };
  (state.db.tables.conversation_messages ||= []).push(row);
  return row;
}
const messagesOf = (id: unknown) => (state.db.tables.conversation_messages || []).filter((m) => m.conversation_id === id);
const created = () => state.db.rpcs.filter((r) => r.fn === 'ensure_active_conversation');

/** ensure_active_conversation (072): thread key, then session, then contact (live statuses), else insert. */
function ensureActiveConversation(args: Record<string, unknown>) {
  const live = (c: Row) => c.workspace_id === args.p_workspace_id && ['open', 'pending', 'resolved'].includes(String(c.status));
  const rows = (state.db.tables.conversations ||= []);
  const byKey = args.p_match_thread_key ? rows.find((c) => live(c) && (c.metadata as Row)?.channel_thread_key === args.p_match_thread_key) : null;
  if (byKey) return { data: [{ id: byKey.id, created: false, matched_by: 'thread_key' }], error: null };
  const bySession = args.p_match_session_id ? rows.find((c) => live(c) && c.visitor_session_id === args.p_match_session_id) : null;
  if (bySession) return { data: [{ id: bySession.id, created: false, matched_by: 'session' }], error: null };
  const byContact = args.p_match_contact_id ? rows.find((c) => live(c) && c.contact_id === args.p_match_contact_id) : null;
  if (byContact) return { data: [{ id: byContact.id, created: false, matched_by: 'contact' }], error: null };
  const row = conversation({
    contact_id: args.p_contact_id ?? null, visitor_session_id: args.p_visitor_session_id ?? null,
    metadata: (args.p_metadata as Row) || {}, updated_at: tick(),
  });
  return { data: [{ id: row.id, created: true, matched_by: 'created' }], error: null };
}

/**
 * conversation_reopen_after_idle_close (284) in brief: an inactivity close
 * within the grace goes back to closed_from, once; anything else NULL. The
 * SQL itself is pinned in src/test/integration/conversationIdleClose284.pg.test.ts.
 */
function reopenAfterIdleClose(args: Record<string, unknown>) {
  if (state.reopenMissing) return { data: null, error: { code: '42883', message: 'function public.conversation_reopen_after_idle_close does not exist' } };
  const none = { data: [{ restored_status: null, updated_at: null, event_id: null, event_created_at: null, retracted_line_id: null }], error: null };
  const row = (state.db.tables.conversations || []).find((c) => c.id === args.p_conversation_id && c.workspace_id === args.p_workspace_id);
  const meta = (row?.metadata || {}) as Row;
  if (!row || row.status !== 'closed' || meta.closed_reason !== 'inactivity') return none;
  if (Date.now() - Date.parse(String(meta.closed_at)) > Number(args.p_grace_seconds) * 1000) return none;
  const restored = String(meta.closed_from || 'open');
  row.status = restored;
  row.metadata = Object.fromEntries(Object.entries(meta).filter(([k]) => !k.startsWith('closed_')));
  return { data: [{ restored_status: restored, updated_at: tick(), event_id: randomUUID(), event_created_at: tick(), retracted_line_id: null }], error: null };
}
/** An inactivity close `secondsAgo` before now, from `from`. */
const idleClosed = (secondsAgo: number, from = 'open'): Row => ({
  closed_reason: 'inactivity', closed_by: 'system', closed_from: from, closed_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
});
const reopens = () => state.db.rpcs.filter((r) => r.fn === 'conversation_reopen_after_idle_close');

const aiSettings = (over: Row = {}) => ({
  enabled: true, mode: 'auto_reply_always', ai_intro_enabled: true, agent_name: 'نیلو',
  intro_message_localized: { fa: 'سلام! من نیلو هستم، دستیار هوشمند فروشگاه.', en: 'Hi, I am Nilo.' }, ...over,
});

beforeEach(() => {
  clock = Date.parse('2026-10-24T08:00:00Z');
  state.db = createFakeServiceDb();
  state.db.honourOr = true;
  state.db.now = tick;
  state.db.rpc = (fn, args) => {
    if (fn === 'ensure_active_conversation') return ensureActiveConversation(args);
    if (fn === 'patch_conversation_metadata') {
      const row = (state.db.tables.conversations || []).find((c) => c.id === args.p_conversation_id);
      if (row) row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
      return { data: !!row, error: null };
    }
    if (fn === 'conversation_reopen_after_idle_close') return reopenAfterIdleClose(args);
    return { data: null, error: null };
  };
  state.db.tables.widget_settings = [{ workspace_id: WS, enabled: true, chat_enabled: true }];
  state.db.tables.visitor_sessions = [
    { id: SESSION, workspace_id: WS, visitor_id: VISITOR, last_seen_at: ago(1) },
    { id: randomUUID(), workspace_id: WS, visitor_id: OTHER_VISITOR, last_seen_at: ago(1) },
  ];
  state.db.tables.contacts = [
    { id: CONTACT, workspace_id: WS, metadata: { visitor_id: VISITOR } },
    { id: OTHER_CONTACT, workspace_id: WS, metadata: { visitor_id: OTHER_VISITOR } },
  ];
  state.db.tables.conversations = [];
  state.db.tables.conversation_messages = [];
  state.visitor = VISITOR;
  state.contactCalls = [];
  state.limitChecks = 0;
  state.allowance = { allowed: true };
  state.lifecycle = [];
  state.pushes = [];
  state.routed = [];
  state.runs = [];
  state.aiAllowed = true;
  state.aiSettings = aiSettings();
  state.teamOnline = false;
  state.aiRuns = [];
  state.restores = [];
  state.realRouting = false;
  state.realOwnership = false;
  state.reopenMissing = false;
  state.operatorEvents = [];
});

describe('POST /message: force_new_conversation is ignored while the visitor has a live conversation', () => {
  for (const status of ['open', 'pending', 'resolved']) {
    it(`a ${status} one takes the message (continued), nothing is created and no quota is checked`, async () => {
      const live = conversation({ status });
      const res = await send({ message: 'سؤال تازه', force_new_conversation: true, client_message_id: 'cmid-new-0001' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ conversation_id: live.id, continued: true });
      expect(created()).toHaveLength(0);
      expect(state.limitChecks).toBe(0);
      expect(messagesOf(live.id).map((m) => m.body)).toEqual(['سؤال تازه']);
      // The lifecycle reopens a resolved one (and resumes a pending one), as for any message.
      expect(state.lifecycle[0]).toMatchObject({ conversationId: live.id, knownStatus: status });
    });
  }

  it('only a closed one: a new conversation, the closed one untouched', async () => {
    const closed = conversation({ status: 'closed' });
    const res = await send({ message: 'دوباره سلام', force_new_conversation: true, client_message_id: 'cmid-new-0002' });
    expect(res.status).toBe(200);
    expect(res.body.continued).toBeUndefined();
    expect(res.body.conversation_id).not.toBe(closed.id);
    expect(created()).toHaveLength(1);
    expect(created()[0].args).toMatchObject({ p_match_contact_id: null, p_match_session_id: null });
    expect(messagesOf(closed.id)).toHaveLength(0);
    expect(state.limitChecks).toBe(1);
  });

  it('only an unanswered greeting (an older widget\'s intro row): a new conversation', async () => {
    const greeting = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' } });
    message(greeting.id, 'ai', { metadata: { source: 'ai_agent_intro' } });
    const res = await send({ message: 'سلام', force_new_conversation: true, client_message_id: 'cmid-new-0003' });
    expect(res.body.conversation_id).not.toBe(greeting.id);
    expect(res.body.continued).toBeUndefined();
    expect(created()).toHaveLength(1);
  });

  it('a greeting the visitor answered is live like any other', async () => {
    const answered = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' } });
    message(answered.id, 'ai', { metadata: { source: 'ai_agent_intro' } });
    message(answered.id, 'contact');
    const res = await send({ message: 'باز هم', force_new_conversation: true, client_message_id: 'cmid-new-0004' });
    expect(res.body).toMatchObject({ conversation_id: answered.id, continued: true });
  });

  it('a live Telegram conversation of the same contact is not the widget\'s live one', async () => {
    conversation({ metadata: { channel: 'telegram' }, visitor_session_id: null });
    const res = await send({ message: 'سلام', force_new_conversation: true, client_message_id: 'cmid-new-0005' });
    expect(res.body.continued).toBeUndefined();
    expect(created()).toHaveLength(1);
  });

  it('several live ones: the newest by updated_at, the one the widget\'s list makes current', async () => {
    conversation({ status: 'open', updated_at: ago(120) });
    const newest = conversation({ status: 'resolved', updated_at: ago(5) });
    const res = await send({ message: 'سلام', force_new_conversation: true, client_message_id: 'cmid-new-0006' });
    expect(res.body).toMatchObject({ conversation_id: newest.id, continued: true });
  });

  it('behind more newer rows than a window holds (the contact\'s other channels, unanswered greetings): still the live one', async () => {
    const live = conversation({ status: 'resolved', updated_at: ago(500) });
    message(live.id, 'contact');
    // A verified contact's email and Telegram threads, resolved (live, but not the widget's).
    for (let i = 0; i < 12; i++) {
      conversation({ status: 'resolved', metadata: { channel: i % 2 ? 'telegram' : 'email' }, visitor_session_id: null, updated_at: ago(i + 1) });
    }
    // An older widget's greeting-only rows, one per "+ New conversation".
    for (let i = 0; i < 12; i++) {
      const g = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: ago(20 + i) });
      message(g.id, 'ai', { metadata: { source: 'ai_agent_intro' } });
    }
    const res = await send({ message: 'سلام', force_new_conversation: true, client_message_id: 'cmid-new-0008' });
    expect(res.body).toMatchObject({ conversation_id: live.id, continued: true });
    expect(created()).toHaveLength(0);
    expect(messagesOf(live.id).map((m) => m.body)).toEqual(['x', 'سلام']);
  });

  it('a retry of a new thread\'s first message finds the thread it created: one conversation, one row, one lock per visitor', async () => {
    const first = await send({ message: 'سؤال', force_new_conversation: true, client_message_id: 'cmid-retry-01' });
    // Now that thread is live: the retry carries force_new again and lands in it.
    const retry = await send({ message: 'سؤال', force_new_conversation: true, client_message_id: 'cmid-retry-01' });
    expect(retry.body.conversation_id).toBe(first.body.conversation_id);
    expect(retry.body.message_id).toBe(first.body.message_id);
    expect(state.db.tables.conversations).toHaveLength(1);
    expect(messagesOf(first.body.conversation_id)).toHaveLength(1);
    expect(created()[0].args.p_lock_key).toBe(`visitor:${VISITOR}`);
  });

  it('without a signed visitor there is nobody to look for: created as before', async () => {
    state.visitor = null;
    conversation({ status: 'open' });
    const res = await send({ message: 'سلام', force_new_conversation: true, client_message_id: 'cmid-anon-001' });
    expect(res.body.continued).toBeUndefined();
    expect(created()).toHaveLength(1);
    expect(String(created()[0].args.p_lock_key)).toBe('cmid-anon-001');
  });
});

describe('POST /message: a named conversation that cannot take it, or a resolved one', () => {
  it('a closed one with an older resolved one beside it: the resolved one (live), continued', async () => {
    const older = conversation({ status: 'resolved', updated_at: ago(300) });
    const closed = conversation({ status: 'closed', updated_at: ago(10) });
    const res = await send({ message: 'سلام', conversation_id: closed.id, client_message_id: 'cmid-closed-01' });
    expect(res.body).toMatchObject({ conversation_id: older.id, continued: true });
    expect(created()).toHaveLength(0);
  });

  it('a closed one and nothing live: a new one, never matched by identity', async () => {
    const closed = conversation({ status: 'closed' });
    const res = await send({ message: 'سلام', conversation_id: closed.id, client_message_id: 'cmid-closed-02' });
    expect(res.body.conversation_id).not.toBe(closed.id);
    expect(res.body.continued).toBeUndefined();
    expect(created()[0].args).toMatchObject({ p_match_contact_id: null, p_match_session_id: null });
  });

  it('another visitor\'s id: their conversation is never touched; my live one takes it', async () => {
    const theirs = conversation({ contact_id: OTHER_CONTACT, visitor_session_id: null });
    const mine = conversation({ status: 'pending' });
    const res = await send({ message: 'سلام', conversation_id: theirs.id, client_message_id: 'cmid-foreign-1' });
    expect(res.body).toMatchObject({ conversation_id: mine.id, continued: true });
    expect(messagesOf(theirs.id)).toHaveLength(0);
  });

  for (const status of ['open', 'pending']) {
    it(`a resolved one with a newer ${status} one: that one, continued`, async () => {
      const resolved = conversation({ status: 'resolved', updated_at: ago(90) });
      const newer = conversation({ status, updated_at: ago(3) });
      const res = await send({ message: 'هنوز هستید؟', conversation_id: resolved.id, client_message_id: `cmid-res-${status}` });
      expect(res.body).toMatchObject({ conversation_id: newer.id, continued: true });
      expect(messagesOf(resolved.id)).toHaveLength(0);
    });
  }

  it('a resolved one with only an older open one: written into (it reopens), not continued', async () => {
    conversation({ status: 'open', updated_at: ago(500) });
    const resolved = conversation({ status: 'resolved', updated_at: ago(10) });
    const res = await send({ message: 'سؤال دیگر', conversation_id: resolved.id, client_message_id: 'cmid-res-alone' });
    expect(res.body.conversation_id).toBe(resolved.id);
    expect(res.body.continued).toBeUndefined();
    expect(state.lifecycle[0]).toMatchObject({ conversationId: resolved.id, knownStatus: 'resolved' });
  });

  it('an open one is simply continued', async () => {
    const open = conversation({ status: 'open' });
    const res = await send({ message: 'ادامه', conversation_id: open.id, client_message_id: 'cmid-open-0001' });
    expect(res.body.conversation_id).toBe(open.id);
    expect(res.body.continued).toBeUndefined();
  });
});

describe('POST /message: the signed visitor decides, never body.visitor_id or body.session_id', () => {
  it('a body visitor_id of another visitor selects neither their contact nor their conversation', async () => {
    const theirs = conversation({ contact_id: OTHER_CONTACT, visitor_session_id: null, status: 'open' });
    const res = await send({ message: 'سلام', visitor_id: OTHER_VISITOR, client_message_id: 'cmid-forged-01' });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).not.toBe(theirs.id);
    expect(messagesOf(theirs.id)).toHaveLength(0);
    expect(state.contactCalls[0]).toMatchObject({ visitorId: VISITOR });
    expect(created()[0].args.p_match_contact_id).toBe(CONTACT);
  });

  it('without force_new the visitor\'s own open thread is continued by contact (unchanged)', async () => {
    const mine = conversation({ status: 'open' });
    const res = await send({ message: 'دو', client_message_id: 'cmid-plain-002' });
    expect(res.body.conversation_id).toBe(mine.id);
    expect(res.body.continued).toBeUndefined();
  });

  it('a body session_id of another visitor\'s session: their conversation untouched, nothing linked to their session, pinned or filed under it', async () => {
    const otherSession = String((state.db.tables.visitor_sessions as Row[])[1].id);
    const theirs = conversation({ contact_id: OTHER_CONTACT, visitor_session_id: otherSession, status: 'open', updated_at: ago(1) });
    const res = await send({ message: 'سلام', session_id: otherSession, client_message_id: 'cmid-forged-02' });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).not.toBe(theirs.id);
    expect(messagesOf(theirs.id)).toHaveLength(0);
    expect(created()[0].args).toMatchObject({ p_match_session_id: null, p_visitor_session_id: SESSION });
    expect(state.contactCalls[0]).toMatchObject({ visitorId: VISITOR, sessionId: null });
    const mine = (state.db.tables.conversations as Row[]).find((c) => c.id === res.body.conversation_id);
    expect(mine).toMatchObject({ visitor_session_id: SESSION });
    expect((messagesOf(mine?.id)[0].metadata as Row).session_id).toBeUndefined();
  });

  it('the visitor\'s own session in the body (an older widget) still counts', async () => {
    const res = await send({ message: 'سلام', session_id: SESSION, client_message_id: 'cmid-own-03' });
    expect(res.status).toBe(200);
    expect(created()[0].args).toMatchObject({ p_match_session_id: SESSION, p_visitor_session_id: SESSION });
    expect(state.contactCalls[0]).toMatchObject({ sessionId: SESSION });
    expect((messagesOf(res.body.conversation_id)[0].metadata as Row).session_id).toBe(SESSION);
  });
});

describe('a body or query visitor_id / session_id proves no conversation theirs (the real ownership check)', () => {
  it('POST /message naming another visitor\'s conversation with their visitor and session ids: theirs untouched, mine takes it', async () => {
    state.realOwnership = true;
    const otherSession = (state.db.tables.visitor_sessions as Row[])[1].id;
    const theirs = conversation({ contact_id: OTHER_CONTACT, visitor_session_id: otherSession, status: 'open', updated_at: ago(1) });
    const mine = conversation({ status: 'open', updated_at: ago(30) });
    const res = await send({ conversation_id: theirs.id, visitor_id: OTHER_VISITOR, session_id: otherSession, message: 'سلام' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversation_id: mine.id, continued: true });
    expect(messagesOf(theirs.id)).toHaveLength(0);
    // My own conversation, named by the cookie alone, still takes its message.
    const own = await send({ conversation_id: mine.id, message: 'دوباره' });
    expect(own.body.conversation_id).toBe(mine.id);
    expect(own.body.continued).toBeUndefined();
  });

  it('GET /poll and GET /history: a query visitor_id or session_id never reads another visitor\'s thread', async () => {
    state.realOwnership = true;
    const otherSession = String((state.db.tables.visitor_sessions as Row[])[1].id);
    const theirs = conversation({ contact_id: OTHER_CONTACT, visitor_session_id: otherSession, status: 'open' });
    message(theirs.id, 'agent', { body: 'secret' });
    const forged = `workspace_id=${WS}&conversation_id=${theirs.id}&visitor_id=${OTHER_VISITOR}&session_id=${otherSession}`;
    const poll = await call('GET', `/api/widget/poll?${forged}`);
    expect(poll.body.conversation_id).not.toBe(theirs.id);
    expect(JSON.stringify(poll.body)).not.toContain('secret');
    const history = await call('GET', `/api/widget/history?${forged}`);
    expect(history.status).toBe(403);
  });
});

describe('POST /message: reply_to_message_id that is no message id is dropped, never a 400', () => {
  it('the local id of a greeting not yet stored', async () => {
    const res = await send({ message: 'همین', reply_to_message_id: 'ai-intro-local-1729760000000', client_message_id: 'cmid-reply-001' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reply_to_message_id: null, reply_to: null });
  });

  it('a real one in the same conversation still quotes', async () => {
    const open = conversation({ status: 'open' });
    const parent = message(open.id, 'agent', { body: 'سفارش شما ارسال شد' });
    const res = await send({ message: 'ممنون', conversation_id: open.id, reply_to_message_id: parent.id, client_message_id: 'cmid-reply-002' });
    expect(res.body.reply_to_message_id).toBe(parent.id);
  });
});

describe('POST /message ai_intro: the greeting the visitor saw is stored before their first message', () => {
  it('the conversation is born the AI\'s, the server\'s own text first, echoed as intro_message', async () => {
    const res = await send({ message: 'قیمت؟', force_new_conversation: true, client_message_id: 'cmid-intro-001', ai_intro: { locale: 'fa', body: 'متن جعلی' } });
    expect(res.status).toBe(200);
    const conv = state.db.tables.conversations.find((c) => c.id === res.body.conversation_id)!;
    expect(conv.metadata).toEqual({ channel_thread_key: 'widget_cmid:cmid-intro-001', ai_state: 'ai_managed', source: 'ai_agent_intro' });
    const rows = messagesOf(conv.id);
    expect(rows.map((m) => m.sender_type)).toEqual(['ai', 'contact']);
    expect(rows[0]).toMatchObject({ body: 'سلام! من نیلو هستم، دستیار هوشمند فروشگاه.', metadata: { source: 'ai_agent_intro' } });
    expect(String(rows[0].created_at) < String(rows[1].created_at)).toBe(true);
    expect(res.body.intro_message).toMatchObject({ id: rows[0].id, sender_type: 'ai', text: rows[0].body, sender_name: 'نیلو', sender_avatar: 'https://cdn.test/agent.png' });
    expect((res.body.intro_message as Row).sender_id).toBeUndefined();
    expect(state.db.tables.ai_agent_intro_log).toEqual([expect.objectContaining({ conversation_id: conv.id, message_id: rows[0].id, visitor_id: VISITOR })]);
    expect(state.runs.filter((r) => (r.metadata as Row)?.intro === true)).toEqual([
      expect.objectContaining({ conversationId: conv.id, metadata: expect.objectContaining({ intro: true, before_first_message: true }) }),
    ]);
  });

  it('in the language it was shown in', async () => {
    const res = await send({ message: 'price?', client_message_id: 'cmid-intro-002', ai_intro: { locale: 'en' } });
    expect(messagesOf(res.body.conversation_id)[0].body).toBe('Hi, I am Nilo.');
  });

  it('a retry of the first message never stores it twice', async () => {
    const one = { message: 'قیمت؟', force_new_conversation: true, client_message_id: 'cmid-intro-003', ai_intro: { locale: 'fa' } };
    const first = await send(one);
    const again = await send(one);
    expect(again.body.conversation_id).toBe(first.body.conversation_id);
    expect(messagesOf(first.body.conversation_id).filter((m) => m.sender_type === 'ai')).toHaveLength(1);
    expect(again.body.intro_message).toBeUndefined();
  });

  it('with a Smart Engagement line or an AI nudge: no greeting, no AI state', async () => {
    const smart = await send({ message: 'بله', client_message_id: 'cmid-intro-004', ai_intro: { locale: 'fa' }, smart_rule: { id: randomUUID(), locale: 'fa' } });
    const nudge = await send({ message: 'بله', force_new_conversation: true, client_message_id: 'cmid-intro-005', ai_intro: { locale: 'fa' }, nudge_context: { source: 'ai_proactive_nudge', nudge_id: randomUUID() } });
    for (const res of [smart, nudge]) {
      expect(res.status).toBe(200);
      expect(res.body.intro_message).toBeUndefined();
    }
    expect(state.db.tables.conversations.every((c) => !(c.metadata as Row).ai_state)).toBe(true);
    expect((state.db.tables.conversation_messages || []).filter((m) => m.sender_type === 'ai')).toHaveLength(0);
  });

  it('into a live conversation (nothing created): nothing stored', async () => {
    const live = conversation({ status: 'open' });
    const res = await send({ message: 'باز هم', force_new_conversation: true, client_message_id: 'cmid-intro-006', ai_intro: { locale: 'fa' } });
    expect(res.body).toMatchObject({ conversation_id: live.id, continued: true });
    expect(res.body.intro_message).toBeUndefined();
    expect(messagesOf(live.id).map((m) => m.sender_type)).toEqual(['contact']);
  });

  for (const [why, setup] of [
    ['the intro is off', () => { state.aiSettings = aiSettings({ ai_intro_enabled: false }); }],
    ['suggest-only', () => { state.aiSettings = aiSettings({ mode: 'suggest_only' }); }],
    ['offline-only mode while the team is online', () => { state.aiSettings = aiSettings({ mode: 'auto_reply_when_offline' }); state.teamOnline = true; }],
    ['the platform turned the AI off', () => { state.aiAllowed = false; }],
  ] as const) {
    it(`${why}: nothing stored, the conversation is not the AI's`, async () => {
      (setup as () => void)();
      const res = await send({ message: 'سلام', client_message_id: 'cmid-intro-gate', ai_intro: { locale: 'fa' } });
      expect(res.status).toBe(200);
      expect(messagesOf(res.body.conversation_id).map((m) => m.sender_type)).toEqual(['contact']);
      expect((state.db.tables.conversations[0].metadata as Row).ai_state).toBeUndefined();
    });
  }

  it('without ai_intro (or an unusable one): as before', async () => {
    const res = await send({ message: 'سلام', client_message_id: 'cmid-intro-007', ai_intro: 'yes' });
    expect(res.status).toBe(200);
    expect(state.db.tables.conversations[0].metadata).toEqual({ channel_thread_key: 'widget_cmid:cmid-intro-007' });
    expect(res.body.intro_message).toBeUndefined();
  });
});

describe('POST /ai-agent/intro', () => {
  const intro = (body: Row) => call('POST', '/api/widget/ai-agent/intro', body);

  it('preview: the greeting, and nothing written', async () => {
    const res = await intro({ preview: true, locale: 'fa', force_new_conversation: true });
    expect(res.body).toEqual({
      sent: true, preview: true, conversationId: null, messageId: null,
      body: 'سلام! من نیلو هستم، دستیار هوشمند فروشگاه.', agentName: 'نیلو', agentLogoUrl: null,
    });
    expect(state.db.inserts).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it('preview with a live conversation: conversation_live and its id, nothing written', async () => {
    const live = conversation({ status: 'resolved' });
    const res = await intro({ preview: true, locale: 'fa' });
    expect(res.body).toEqual({ sent: false, reason: 'conversation_live', conversationId: live.id });
    expect(state.db.inserts).toEqual([]);
  });

  it('preview ignores an unanswered greeting row (it is no live conversation)', async () => {
    const greeting = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' } });
    message(greeting.id, 'ai', { metadata: { source: 'ai_agent_intro' } });
    const res = await intro({ preview: true, locale: 'fa' });
    expect(res.body).toMatchObject({ sent: true, preview: true });
  });

  it('preview at a full quota: no greeting to draw', async () => {
    state.allowance = { allowed: false, reason: 'limit_reached' };
    const res = await intro({ preview: true, locale: 'fa' });
    expect(res.body).toEqual({ sent: false, reason: 'conversation_limit_limit_reached' });
  });

  it('preview keeps the gates: the team online in offline-only mode', async () => {
    state.aiSettings = aiSettings({ mode: 'auto_reply_when_offline' });
    state.teamOnline = true;
    const res = await intro({ preview: true, locale: 'fa' });
    expect(res.body).toEqual({ sent: false, reason: 'operators_online' });
  });

  it('an older widget (no preview), nothing live: written at once, as before', async () => {
    const res = await intro({ locale: 'fa', force_new_conversation: true });
    expect(res.body).toMatchObject({ sent: true, body: 'سلام! من نیلو هستم، دستیار هوشمند فروشگاه.' });
    expect(res.body.conversationId).toBeTruthy();
    expect(messagesOf(res.body.conversationId).filter((m) => m.sender_type === 'ai')).toHaveLength(1);
  });

  it('an older widget\'s force-new while a conversation is live: greets that one, mints none', async () => {
    const live = conversation({ status: 'open' });
    const res = await intro({ locale: 'fa', force_new_conversation: true });
    expect(res.body).toMatchObject({ sent: true, conversationId: live.id });
    expect(state.db.tables.conversations).toHaveLength(1);
  });

  it('an older widget reuses a greeting-only row instead of creating another', async () => {
    const greeting = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' } });
    message(greeting.id, 'ai', { metadata: { source: 'ai_agent_intro' } });
    state.db.tables.ai_agent_intro_log = [{ id: randomUUID(), workspace_id: WS, conversation_id: greeting.id }];
    const res = await intro({ locale: 'fa', force_new_conversation: true });
    expect(res.body).toEqual({ sent: false, reason: 'already_sent', conversationId: greeting.id });
    expect(state.db.tables.conversations).toHaveLength(1);
  });

  it('an older widget naming a closed conversation: never greeted; the live one or a new one', async () => {
    const closed = conversation({ status: 'closed' });
    const res = await intro({ locale: 'fa', conversation_id: closed.id });
    expect(res.body.conversationId).not.toBe(closed.id);
    expect(messagesOf(closed.id)).toHaveLength(0);
  });
});

describe('POST /offline-messages: the away thread\'s first message while one is live', () => {
  const away = (body: Row) => call('POST', '/api/widget/offline-messages', { message: 'کسی هست؟', client_message_id: 'cmid-away-0001', locale: 'fa', ...body });

  it('goes on in the live conversation (continued), the lifecycle, push and routing run; no capture is made', async () => {
    const live = conversation({ status: 'resolved', assigned_to: OPERATOR });
    const res = await away({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, captured: true, conversation_id: live.id, continued: true });
    const rows = messagesOf(live.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sender_type: 'contact', body: 'کسی هست؟', metadata: { client_message_id: 'cmid-away-0001' } });
    expect(res.body.message_id).toBe(rows[0].id);
    expect(state.db.tables.conversations).toHaveLength(1);
    expect(state.limitChecks).toBe(0);
    expect(state.lifecycle[0]).toMatchObject({ conversationId: live.id, knownStatus: 'resolved' });
    expect(state.pushes).toEqual([expect.objectContaining({ conversationId: live.id, messageId: rows[0].id })]);
    expect(state.routed).toEqual([expect.objectContaining({ conversationId: live.id, reopened: true })]);
  });

  it('an AI that answers the live conversation answers it: the engine runs, routing (for real) leaves it to the AI', async () => {
    // AI on, auto-reply always, the intro off (so the widget took the away
    // path): the live thread is the AI's and nobody has it.
    state.realRouting = true;
    state.db.tables.ai_agent_settings = [{ workspace_id: WS, enabled: true, mode: 'auto_reply_always' }];
    const live = conversation({ status: 'open', metadata: { ai_state: 'ai_managed' } });
    const res = await away({});
    expect(res.body).toMatchObject({ conversation_id: live.id, continued: true });
    const [row] = messagesOf(live.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.aiRuns).toEqual([expect.objectContaining({ conversationId: live.id, visitorMessageId: row.id, question: 'کسی هست؟', locale: 'fa' })]);
    expect(state.routed).toEqual([expect.objectContaining({ conversationId: live.id, platformAiOff: false, quiet: true })]);
    // Still the AI's, nobody assigned, no routing notice posted.
    expect(live).toMatchObject({ assigned_to: null, metadata: { ai_state: 'ai_managed' } });
    expect((live.metadata as Row).routing_notice_sent).toBeUndefined();
    expect(state.restores).toEqual([]);
  });

  it('with the platform\'s AI off: no AI run, the main-inbox restore, routing told so and quiet', async () => {
    state.aiAllowed = false;
    const live = conversation({ status: 'open', metadata: { ai_state: 'ai_managed' } });
    await away({});
    await new Promise((r) => setTimeout(r, 20));
    expect(state.aiRuns).toEqual([]);
    expect(state.restores).toEqual([expect.objectContaining({ conversationId: live.id, reason: 'platform_ai_disabled' })]);
    expect(state.routed).toEqual([expect.objectContaining({ conversationId: live.id, platformAiOff: true, quiet: true })]);
  });

  it('a retry of it answers the same message, with no second row', async () => {
    const live = conversation({ status: 'open' });
    const first = await away({});
    const again = await away({});
    expect(again.body).toMatchObject({ conversation_id: live.id, message_id: first.body.message_id, continued: true });
    expect(messagesOf(live.id)).toHaveLength(1);
  });

  it('nothing live: a capture of its own, as before', async () => {
    conversation({ status: 'closed' });
    const res = await away({});
    expect(res.status).toBe(200);
    expect(res.body.continued).toBeUndefined();
    expect(state.db.tables.conversations).toHaveLength(2);
    expect(state.limitChecks).toBe(1);
  });

  it('the leave-a-message form (no client id) is always a capture of its own', async () => {
    conversation({ status: 'open' });
    const res = await call('POST', '/api/widget/offline-messages', { message: 'لطفاً تماس بگیرید', name: 'مریم', locale: 'fa' });
    expect(res.status).toBe(200);
    expect(res.body.continued).toBeUndefined();
    expect(state.db.tables.conversations).toHaveLength(2);
  });
});

describe('GET /poll without a conversation id: only a live conversation', () => {
  const poll = () => call('GET', `/api/widget/poll?workspace_id=${WS}`);

  it('an ended thread is never handed back', async () => {
    conversation({ status: 'closed', updated_at: ago(1) });
    const res = await poll();
    expect(res.body).toMatchObject({ status: 'unknown', conversation_id: null });
  });

  it('the live one, with its status (an operator\'s outreach, another tab\'s thread)', async () => {
    conversation({ status: 'closed', updated_at: ago(1) });
    const live = conversation({ status: 'resolved', updated_at: ago(30) });
    message(live.id, 'agent', { body: 'سلام، می‌توانم کمک کنم؟' });
    const res = await poll();
    expect(res.body).toMatchObject({ status: 'resolved', conversation_id: live.id });
    expect((res.body.messages as Row[]).map((m) => m.text)).toEqual(['سلام، می‌توانم کمک کنم؟']);
  });

  it('a query visitor_id names nobody: another visitor\'s thread is never polled', async () => {
    state.visitor = null;
    conversation({ contact_id: OTHER_CONTACT, visitor_session_id: null, status: 'open' });
    const res = await call('GET', `/api/widget/poll?workspace_id=${WS}&visitor_id=${OTHER_VISITOR}`);
    expect(res.body.conversation_id).toBeNull();
  });
});

describe('the closed line an older server wrote on a resolve is never handed to the visitor', () => {
  it('the one visibility rule every read path applies (/identity/history and the list too) leaves it out', async () => {
    const { filterVisitorVisibleMessages } = await import('../../../server/routes/widgetAttachments.js');
    const rows = [
      { id: 'a', metadata: { kind: 'conversation_closed', status: 'resolved' } },
      { id: 'b', metadata: { kind: 'conversation_closed', status: 'closed' } },
      { id: 'c', metadata: { internal: true } },
      { id: 'd', metadata: null },
    ];
    expect(filterVisitorVisibleMessages(rows).map((r) => r.id)).toEqual(['b', 'd']);
  });

  it('GET /poll and GET /history leave it out (the conversation is live for them); a real close line stays', async () => {
    const resolved = conversation({ status: 'resolved' });
    message(resolved.id, 'agent', { body: 'بفرمایید' });
    message(resolved.id, 'system', { body: 'Sara closed the conversation', metadata: { kind: 'conversation_closed', status: 'resolved', operator_name: 'Sara' } });
    for (const path of [`/api/widget/poll?workspace_id=${WS}&conversation_id=${resolved.id}`, `/api/widget/history?workspace_id=${WS}&conversation_id=${resolved.id}`]) {
      const res = await call('GET', path);
      expect(res.status, path).toBe(200);
      expect((res.body.messages as Row[]).map((m) => m.text), path).toEqual(['بفرمایید']);
    }
    const closed = conversation({ status: 'closed' });
    message(closed.id, 'agent', { body: 'خداحافظ' });
    message(closed.id, 'system', { body: 'Sara closed the conversation', metadata: { kind: 'conversation_closed', status: 'closed', operator_name: 'Sara' } });
    const res = await call('GET', `/api/widget/history?workspace_id=${WS}&conversation_id=${closed.id}`);
    expect((res.body.messages as Row[]).map((m) => (m.metadata as Row | null)?.kind ?? m.text)).toEqual(['خداحافظ', 'conversation_closed']);
  });
});

describe('a message racing the inactivity close (migration 284) goes back into that conversation, as it was', () => {
  it('justClosedForInactivity: an inactivity close within the grace; a bad stamp never, one in the future always', async () => {
    const { justClosedForInactivity } = await import('../../../server/services/widget/visitorConversations.js');
    const now = Date.parse('2026-10-24T08:00:00Z');
    const at = (ms: number) => new Date(now - ms).toISOString();
    const closedRow = (meta: Row) => ({ status: 'closed', metadata: { closed_reason: 'inactivity', ...meta } });
    expect(justClosedForInactivity(closedRow({ closed_at: at(10_000) }), now)).toBe(true);
    expect(justClosedForInactivity(closedRow({ closed_at: at(60_000) }), now)).toBe(true);
    expect(justClosedForInactivity(closedRow({ closed_at: at(60_001) }), now)).toBe(false);
    expect(justClosedForInactivity(closedRow({ closed_at: at(-30_000) }), now)).toBe(true);
    for (const bad of ['', 'yesterday', 42, null, undefined]) {
      expect(justClosedForInactivity(closedRow({ closed_at: bad }), now), String(bad)).toBe(false);
    }
    expect(justClosedForInactivity({ status: 'closed', metadata: { closed_reason: 'operator', closed_at: at(1_000) } }, now)).toBe(false);
    expect(justClosedForInactivity({ status: 'closed', metadata: { closed_at: at(1_000) } }, now)).toBe(false);
    expect(justClosedForInactivity({ status: 'resolved', metadata: { closed_reason: 'inactivity', closed_at: at(1_000) } }, now)).toBe(false);
    expect(justClosedForInactivity({ status: 'closed', metadata: null }, now)).toBe(false);
    expect(justClosedForInactivity(null, now)).toBe(false);
  });

  it('liveConversationForNextMessage: a live one wins with no RPC; else the named one closed 10 s ago reopens; 5 minutes ago, an operator\'s close or before 284: none', async () => {
    const { liveConversationForNextMessage, resolveVisitorConversationScope } = await import('../../../server/services/widget/visitorConversations.js');
    const sb = fakeServiceClient(state.db) as never;
    const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
    const scope = await resolveVisitorConversationScope(sb, WS, VISITOR);
    const recent = conversation({ status: 'closed', metadata: idleClosed(10, 'pending') });
    const named = { id: recent.id as string, status: 'closed', metadata: recent.metadata };

    const live = conversation({ status: 'open' });
    expect(await liveConversationForNextMessage(config, sb, WS, scope, { closed: named })).toMatchObject({ id: live.id });
    expect(reopens()).toHaveLength(0);
    live.status = 'closed';

    expect(await liveConversationForNextMessage(config, sb, WS, scope, { closed: named }))
      .toMatchObject({ id: recent.id, status: 'pending', reopened: true });
    expect(reopens()).toEqual([{ fn: 'conversation_reopen_after_idle_close', args: expect.objectContaining({ p_workspace_id: WS, p_conversation_id: recent.id, p_grace_seconds: 60 }) }]);
    expect(recent.status).toBe('pending');
    // The Inbox hears of it as of a reopen, with the visitor's reason, no actor.
    expect(state.operatorEvents).toEqual([
      expect.objectContaining({ kind: 'conversation_reopened', conversation_id: recent.id, actor_id: null, changes: { status: { from: 'closed', to: 'pending' } }, reason: 'customer_replied_after_inactivity_close' }),
      expect.objectContaining({ kind: 'timeline_event', conversation_id: recent.id, event_type: 'reopened', actor_type: 'visitor' }),
    ]);

    state.db.rpcs.length = 0;
    recent.status = 'closed';
    const old = conversation({ status: 'closed', metadata: idleClosed(300) });
    expect(await liveConversationForNextMessage(config, sb, WS, scope, { closed: { id: old.id as string, status: 'closed', metadata: old.metadata } })).toBeNull();
    const byOperator = conversation({ status: 'closed', metadata: { closed_reason: 'operator', closed_at: new Date().toISOString() } });
    expect(await liveConversationForNextMessage(config, sb, WS, scope, { closed: { id: byOperator.id as string, status: 'closed', metadata: byOperator.metadata } })).toBeNull();
    expect(reopens()).toHaveLength(0);
    expect(await liveConversationForNextMessage(config, sb, WS, scope)).toBeNull();

    state.reopenMissing = true;
    const racing = conversation({ status: 'closed', metadata: idleClosed(5) });
    expect(await liveConversationForNextMessage(config, sb, WS, scope, { closed: { id: racing.id as string, status: 'closed', metadata: racing.metadata } })).toBeNull();
    expect(racing.status).toBe('closed');
  });

  it('POST /message naming a conversation the timer closed 10 s ago: the same conversation, not `continued`, nothing created, the lifecycle from what it was', async () => {
    const recent = conversation({ status: 'closed', metadata: idleClosed(10, 'resolved') });
    const res = await send({ message: 'هنوز هستید؟', conversation_id: recent.id, client_message_id: 'cmid-race-0001' });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe(recent.id);
    expect(res.body.continued).toBeUndefined();
    expect(created()).toHaveLength(0);
    expect(state.limitChecks).toBe(0);
    expect(messagesOf(recent.id).map((m) => m.body)).toEqual(['هنوز هستید؟']);
    // Back to resolved, so the visitor's message reopens it as any message does.
    expect(state.lifecycle).toEqual([expect.objectContaining({ conversationId: recent.id, knownStatus: 'resolved' })]);
    expect(state.routed).toEqual([expect.objectContaining({ conversationId: recent.id, reopened: true })]);
  });

  it('…closed 5 minutes ago, or by an operator: a new conversation, as before', async () => {
    for (const metadata of [idleClosed(300), { closed_reason: 'operator', closed_at: new Date().toISOString() }]) {
      state.db.rpcs.length = 0;
      const ended = conversation({ status: 'closed', metadata });
      const res = await send({ message: 'سلام دوباره', conversation_id: ended.id, client_message_id: `cmid-new-${randomUUID().slice(0, 8)}` });
      expect(res.status).toBe(200);
      expect(res.body.conversation_id).not.toBe(ended.id);
      expect(created()).toHaveLength(1);
      expect(ended.status).toBe('closed');
      // The next round starts with no live conversation of the visitor's.
      for (const c of state.db.tables.conversations || []) c.status = 'closed';
    }
  });

  it('the touch finds the conversation closed (the close committed while the message was on its way): reopened, the lifecycle runs from the restored status', async () => {
    const live = conversation({ status: 'resolved', assigned_to: OPERATOR });
    // The timer's close lands between the ownership read and the insert.
    state.db.beforeInsert = (table) => {
      if (table !== 'conversation_messages' || live.status === 'closed') return;
      live.status = 'closed';
      live.metadata = { ...(live.metadata as Row), ...idleClosed(0, 'resolved') };
    };
    const res = await send({ message: 'یک سؤال دیگر', conversation_id: live.id, client_message_id: 'cmid-touch-0001' });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe(live.id);
    expect(reopens()).toEqual([{ fn: 'conversation_reopen_after_idle_close', args: expect.objectContaining({ p_conversation_id: live.id, p_message_id: messagesOf(live.id)[0].id }) }]);
    expect(state.lifecycle).toEqual([expect.objectContaining({ conversationId: live.id, knownStatus: 'resolved' })]);
    expect(state.routed).toEqual([expect.objectContaining({ conversationId: live.id, reopened: true })]);
    expect((live.metadata as Row).closed_reason).toBeUndefined();
  });

  it('…an operator\'s close there stays closed: no reopen, the lifecycle sees closed (unchanged)', async () => {
    const live = conversation({ status: 'open' });
    state.db.beforeInsert = (table) => {
      if (table !== 'conversation_messages' || live.status === 'closed') return;
      live.status = 'closed';
      live.metadata = { closed_reason: 'operator', closed_by: 'agent', closed_at: new Date().toISOString(), closed_from: 'open' };
    };
    await send({ message: 'سلام', conversation_id: live.id, client_message_id: 'cmid-touch-0002' });
    expect(live.status).toBe('closed');
    expect(state.lifecycle).toEqual([expect.objectContaining({ conversationId: live.id, knownStatus: 'closed' })]);
  });

  it('POST /offline-messages appending to the live conversation behaves the same', async () => {
    const live = conversation({ status: 'pending' });
    state.db.beforeInsert = (table) => {
      if (table !== 'conversation_messages' || live.status === 'closed') return;
      live.status = 'closed';
      live.metadata = { ...idleClosed(0, 'pending') };
    };
    const res = await call('POST', '/api/widget/offline-messages', { message: 'کسی هست؟', client_message_id: 'cmid-away-race1', locale: 'fa' });
    expect(res.body).toMatchObject({ conversation_id: live.id, continued: true });
    expect(live.status).toBe('pending');
    expect(state.lifecycle).toEqual([expect.objectContaining({ conversationId: live.id, knownStatus: 'pending' })]);
  });
});
