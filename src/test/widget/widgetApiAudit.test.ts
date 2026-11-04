/**
 * The widget API audit of 2026-11-04, through the REAL widgetRouter (the
 * mocks are oneLiveConversation.test.ts's, with the real ownership rule):
 *
 *   widgetapi-3  PUT /action resolve_visitor is gone (Unknown action): it
 *                echoed a contact's name, email and phone for any body
 *                visitor_id and renamed contacts.
 *   widgetapi-4  /queue, /action typing / heartbeat / reopen, /escalate,
 *                /ai-agent/intro: the signed visitor alone; a body or query
 *                visitor_id / session_id proves nothing, and the intro puts
 *                its conversation in the visitor's own session only.
 *   widgetapi-9  the loader's session heartbeat touches the signed visitor's
 *                own session only.
 *   widgetapi-6  POST /offline-messages: the widget, its chat, the plan's
 *                chat, and no capture while away with hide_widget.
 *   widgetapi-8  /poll's operator: the name a visitor may read (I-10).
 *   widgetapi-10 call queue: the signed visitor, their conversation, their
 *                session; cancel only their own entry.
 *   frontend-3   a page URL that is no http(s) one is not kept.
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
const OTHER_SESSION = '66666666-6666-4666-8666-666666666666';
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
  offlineMode: 'capture_message' as string,
  intro: [] as Array<Record<string, unknown>>,
  queue: [] as Array<Record<string, unknown>>,
  cancelled: [] as string[],
  queueEntry: null as Record<string, unknown> | null,
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
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null, offline_mode: state.offlineMode }),
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

vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Array<Record<string, unknown>>) => { for (const r of rows || []) { r.avatar_url = null; delete r.avatar_storage_key; } return rows; },
}));
vi.mock('../../../server/services/calls/queue.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/calls/queue.js')>()),
  enqueueCall: async (_c: unknown, input: Record<string, unknown>) => { state.queue.push(input); return { id: 'entry-1', ...input }; },
  getEntry: async () => state.queueEntry,
  cancelEntry: async (_c: unknown, id: string) => { state.cancelled.push(id); return { id, state: 'cancelled' }; },
}));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({ loadEffectiveCallEntitlements: async () => ({}) }));
vi.mock('../../../server/services/calls/queueEntitlementGate.js', () => ({ evaluateVisitorQueueEnqueueGate: () => ({ allowed: true }) }));
vi.mock('../../../server/services/ai-agent/intro.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/intro.js')>()),
  maybeSendIntro: async (_c: unknown, input: Record<string, unknown>) => { state.intro.push(input); return { sent: false, reason: 'test' }; },
}));

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
function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: Row): Promise<Answer> {
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
    { id: OTHER_SESSION, workspace_id: WS, visitor_id: OTHER_VISITOR, last_seen_at: ago(1) },
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
  state.realOwnership = true;
  state.offlineMode = 'capture_message';
  state.intro = [];
  state.queue = [];
  state.cancelled = [];
  state.queueEntry = null;
});

describe('widgetapi-3 — resolve_visitor is gone', () => {
  it('answers Unknown action and reads or writes no contact', async () => {
    const before = JSON.stringify(state.db.tables.contacts);
    const res = await call('PUT', '/api/widget/action', { action: 'resolve_visitor', visitor_id: OTHER_VISITOR, visitor_name: 'Mallory', visitor_email: 'victim@example.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Unknown action' });
    expect(JSON.stringify(state.db.tables.contacts)).toBe(before);
    expect(state.db.reads.filter((t) => t === 'contacts')).toHaveLength(0);
  });
});

describe('widgetapi-4 — a body or query id proves nothing', () => {
  // Another visitor's thread, named by its own ids.
  const theirs = () => conversation({ contact_id: OTHER_CONTACT, visitor_session_id: OTHER_SESSION, metadata: { visitor_id: OTHER_VISITOR } });

  it('PUT /action typing, heartbeat and reopen of another visitor’s conversation are refused', async () => {
    const conv = theirs();
    conv.status = 'resolved';
    const ids = { conversation_id: conv.id, visitor_id: OTHER_VISITOR, session_id: OTHER_SESSION };
    expect((await call('PUT', '/api/widget/action', { action: 'typing', ...ids })).status).toBe(403);
    expect((await call('PUT', '/api/widget/action', { action: 'heartbeat', ...ids })).status).toBe(403);
    expect((await call('PUT', '/api/widget/action', { action: 'reopen_conversation', ...ids })).body).toEqual({ ok: false, not_found: true });
    expect(conv.status).toBe('resolved');
    // Without any cookie as well.
    state.visitor = null;
    expect((await call('PUT', '/api/widget/action', { action: 'typing', ...ids })).status).toBe(403);
  });

  it('the visitor’s own conversation still works', async () => {
    const mine = conversation({ status: 'resolved' });
    const res = await call('PUT', '/api/widget/action', { action: 'reopen_conversation', conversation_id: mine.id });
    expect(res.body).toEqual({ ok: true, status: 'open' });
    expect(mine.status).toBe('open');
  });

  it('GET /queue and POST /escalate refuse another visitor’s conversation', async () => {
    const conv = theirs();
    const q = await call('GET', `/api/widget/queue?workspace_id=${WS}&conversation_id=${conv.id}&visitor_id=${OTHER_VISITOR}&session_id=${OTHER_SESSION}`);
    expect(q.status).toBe(403);
    const e = await call('POST', '/api/widget/escalate', { conversation_id: conv.id, visitor_id: OTHER_VISITOR, session_id: OTHER_SESSION });
    expect(e.status).toBe(403);
  });

  it('POST /ai-agent/intro: another visitor’s conversation and session are not used', async () => {
    const conv = theirs();
    await call('POST', '/api/widget/ai-agent/intro', { conversation_id: conv.id, session_id: OTHER_SESSION });
    expect(state.intro[0]).toMatchObject({ conversationId: null, visitorSessionId: null, visitorId: VISITOR });
    await call('POST', '/api/widget/ai-agent/intro', { session_id: SESSION });
    expect(state.intro[1]).toMatchObject({ visitorSessionId: SESSION });
  });
});

describe('widgetapi-9 — the loader’s session heartbeat', () => {
  it('touches the signed visitor’s own session only', async () => {
    const touched: Array<Record<string, unknown>> = [];
    const rpc = state.db.rpc!;
    state.db.rpc = (fn, args) => {
      if (fn === 'visitor_touch_liveness') { touched.push(args); return { data: [{ matched: args.p_visitor_id === VISITOR && args.p_session_id === SESSION, page_changed: false, wrote: true }], error: null }; }
      return rpc(fn, args);
    };
    const other = state.db.tables.visitor_sessions.find((s) => s.visitor_id === OTHER_VISITOR)!;
    const res = await call('PUT', '/api/widget/action', { action: 'heartbeat', session_id: other.id, visitor_id: OTHER_VISITOR });
    expect(res.body).toMatchObject({ ok: true, matched: false });
    expect(touched[0]).toMatchObject({ p_visitor_id: VISITOR });
    state.visitor = null;
    expect((await call('PUT', '/api/widget/action', { action: 'heartbeat', session_id: other.id })).body).toEqual({ ok: true, matched: false });
    expect(touched).toHaveLength(1);
  });
});

describe('widgetapi-6 — POST /offline-messages keeps the widget’s gates', () => {
  const capture = () => call('POST', '/api/widget/offline-messages', { message: 'سلام', email: 'a@example.com', name: 'Ali' });
  const captured = () => (state.db.tables.conversations || []).length;

  it('a disabled widget or chat captures nothing', async () => {
    state.db.tables.widget_settings = [{ workspace_id: WS, enabled: false, chat_enabled: true }];
    expect((await capture()).status).toBe(403);
    state.db.tables.widget_settings = [{ workspace_id: WS, enabled: true, chat_enabled: false }];
    expect((await capture()).status).toBe(403);
    expect(captured()).toBe(0);
  });

  it('away with hide_widget captures nothing; capture_message captures', async () => {
    state.offlineMode = 'hide_widget';
    expect((await capture()).status).toBe(403);
    expect(captured()).toBe(0);
    state.offlineMode = 'capture_message';
    const res = await capture();
    expect(res.status).toBe(200);
    expect(res.body.captured).toBe(true);
  });
});

describe('widgetapi-8 — /poll names the operator as a visitor may read', () => {
  it('an operator whose profile name is their email address has none', async () => {
    const conv = conversation({ assigned_to: OPERATOR });
    state.db.tables.profiles = [{ id: OPERATOR, full_name: 'ali.private@example.com', avatar_storage_key: null }];
    const res = await call('GET', `/api/widget/poll?workspace_id=${WS}&conversation_id=${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.operator).toEqual({ name: null, avatar: null });
    expect(JSON.stringify(res.body)).not.toContain('ali.private@example.com');
    state.db.tables.profiles = [{ id: OPERATOR, full_name: 'Ali', avatar_storage_key: null }];
    expect((await call('GET', `/api/widget/poll?workspace_id=${WS}&conversation_id=${conv.id}`)).body.operator).toEqual({ name: 'Ali', avatar: null });
  });
});

describe('widgetapi-10 — the widget’s call queue', () => {
  it('enqueue needs the signed visitor and their own conversation, and keys the entry on their session', async () => {
    state.visitor = null;
    expect((await call('POST', '/api/widget/call-queue/enqueue', { channel: 'audio' })).status).toBe(401);
    state.visitor = VISITOR;
    const theirs = conversation({ contact_id: OTHER_CONTACT, visitor_session_id: OTHER_SESSION, metadata: { visitor_id: OTHER_VISITOR } });
    expect((await call('POST', '/api/widget/call-queue/enqueue', { channel: 'audio', conversation_id: theirs.id })).status).toBe(403);
    expect(state.queue).toHaveLength(0);
    const mine = conversation();
    expect((await call('POST', '/api/widget/call-queue/enqueue', { channel: 'audio', conversation_id: mine.id })).status).toBe(200);
    expect(state.queue[0]).toMatchObject({ conversationId: mine.id });
    expect(state.queue[0].visitorSessionId).not.toBe(VISITOR);
  });

  it('cancel: only the visitor whose entry it is', async () => {
    state.queueEntry = { id: 'entry-1', workspace_id: WS, visitor_session_id: OTHER_SESSION };
    expect((await call('POST', '/api/widget/call-queue/entry-1/cancel', {})).status).toBe(403);
    state.visitor = null;
    expect((await call('POST', '/api/widget/call-queue/entry-1/cancel', {})).status).toBe(403);
    expect(state.cancelled).toHaveLength(0);
    state.visitor = VISITOR;
    state.queueEntry = { id: 'entry-1', workspace_id: WS, visitor_session_id: SESSION };
    expect((await call('POST', '/api/widget/call-queue/entry-1/cancel', {})).status).toBe(200);
    // An entry written before (the visitor id in the column) is theirs too.
    state.queueEntry = { id: 'entry-2', workspace_id: WS, visitor_session_id: VISITOR };
    expect((await call('POST', '/api/widget/call-queue/entry-2/cancel', {})).status).toBe(200);
    expect(state.cancelled).toEqual(['entry-1', 'entry-2']);
  });
});

describe('frontend-3 — the visitor’s page URL is an http(s) one', () => {
  it('a javascript: page is not kept; an https one is', async () => {
    const pageOf = async (url: string, cmid: string) => {
      const res = await send({ message: 'hi', client_message_id: cmid, page_context: { currentPageUrl: url } });
      expect(res.status).toBe(200);
      const msg = (state.db.tables.conversation_messages || []).find((m) => (m.metadata as Row)?.client_message_id === cmid)!;
      return ((msg.metadata as Row).page_context as Row | undefined)?.currentPageUrl;
    };
    expect(await pageOf('javascript:alert(document.cookie)//', 'cmid-page-0001')).toBeUndefined();
    expect(await pageOf('https://shop.test/cart?x=1', 'cmid-page-0002')).toBe('https://shop.test/cart?x=1');
  });
});
