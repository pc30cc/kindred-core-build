/**
 * POST /api/widget/ai-agent/intro writes the AI's greeting only into the
 * visitor's own conversation (2026-10-23 review). The conversation id comes
 * from the visitor's browser, and the greeting used to be written into
 * whatever it named: another workspace's conversation (whose channel would
 * then deliver it), another visitor's, or a closed one. Now, as POST
 * /message does, a conversation that is not this visitor's own, in this
 * workspace and not closed is ignored, and the intro finds or creates the
 * visitor's own.
 *
 * The real widgetRouter and the real maybeSendIntro run; the database, the
 * gates and the side effects are fakes.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
interface Conversation { id: string; workspace_id: string; status: string; visitor_session_id: string | null; metadata: Row }

const WS_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const MY_SESSION = '33333333-3333-4333-8333-333333333333';
const store = vi.hoisted(() => ({ conversations: [] as Conversation[], greeted: [] as string[] }));

type Result = { data: unknown; error: null };

/** conversations, filtered as PostgREST would; every other table is empty. */
function table(name: string) {
  const filters: Array<(c: Conversation) => boolean> = [];
  const found = () => (name === 'conversations' ? store.conversations.filter((c) => filters.every((f) => f(c))) : []);
  const b = {
    select: () => b, order: () => b, limit: () => b, is: () => b, in: () => b, not: () => b, update: () => b,
    eq: (col: string, val: unknown) => { filters.push((c) => (c as unknown as Row)[col] === val); return b; },
    neq: (col: string, val: unknown) => { filters.push((c) => (c as unknown as Row)[col] !== val); return b; },
    contains: (_col: string, val: Row) => { filters.push((c) => Object.entries(val).every(([k, v]) => c.metadata[k] === v)); return b; },
    maybeSingle: async (): Promise<Result> => ({ data: found()[0] ?? null, error: null }),
    single: async (): Promise<Result> => ({ data: found()[0] ?? null, error: null }),
    then: (resolve: (r: Result) => unknown) => Promise.resolve({ data: found(), error: null }).then(resolve),
    insert: (row: Row) => {
      if (name !== 'conversations') return Promise.resolve({ data: null, error: null });
      const created: Conversation = {
        id: crypto.randomUUID(), workspace_id: String(row.workspace_id), status: String(row.status ?? 'open'),
        visitor_session_id: (row.visitor_session_id as string | null) ?? null, metadata: (row.metadata as Row) || {},
      };
      store.conversations.push(created);
      return { select: () => ({ single: async (): Promise<Result> => ({ data: { id: created.id }, error: null }) }) };
    },
  };
  return b;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (name: string) => table(name), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock('../../../server/services/widget/security.js', () => ({
  createSessionToken: () => 'wss_test',
  verifySessionToken: () => ({ valid: true, workspaceId: WS_ID }),
  verifyTokenForRefresh: () => ({ valid: true, workspaceId: WS_ID }),
  // As the real one: the token names the workspace.
  enforceWidgetToken: (req: { _widgetWorkspaceId?: string }, _res: unknown, next: () => void) => { req._widgetWorkspaceId = WS_ID; next(); },
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: (_req: unknown, _res: unknown, bodyWsId: string) => bodyWsId || WS_ID,
  // The real rule, reduced to the session match: this workspace's, and this visitor's.
  verifyConversationOwnership: async (_config: unknown, conversationId: string, workspaceId: string, _visitorId: unknown, sessionId: string | null) => {
    const conv = store.conversations.find((c) => c.id === conversationId);
    return conv && conv.workspace_id === workspaceId && sessionId && conv.visitor_session_id === sessionId
      ? { valid: true, conversation: conv } : { valid: false, conversation: null };
  },
  getClientIp: () => '127.0.0.1',
  getRequestOrigin: () => 'https://example.com',
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({
  enforceMaxConversationsLimit: async () => true,
  checkMaxConversationsAllowance: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({ ensureVisitorContact: async () => null }));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/ai-agent/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/settings.js')>()),
  getOrCreateSettings: async () => ({ enabled: true, mode: 'auto_reply_always', ai_intro_enabled: true, agent_name: null, intro_message_localized: null }),
}));
vi.mock('../../../server/services/ai-agent/visitorAiSnapshot.js', () => ({
  resolveVisitorAiSnapshot: async () => ({ visitorFacing: true, providerReady: true, introCapable: true, reason: 'ok' }),
}));
vi.mock('../../../server/services/ai-agent/responder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/responder.js')>()),
  insertAiMessage: async (_config: unknown, input: Row) => { store.greeted.push(String(input.conversationId)); return { id: 'm-intro' }; },
}));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  clampLocaleToPlatformRegion: async (_config: unknown, locale: string) => locale,
  getPlatformAllowedLocales: async () => ['fa'],
}));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({ maybeRunAiAssistantAfterVisitorMessage: async () => ({ action: 'skipped' }) }));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => {} }));
vi.mock('../../../server/services/realtime/publish.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/realtime/publish.js')>();
  return { ...actual, publishConversationEvent: async () => ({ ok: true }) };
});
vi.mock('../../../server/services/push/index.js', () => ({ notifyInboundMessage: async () => {} }));
vi.mock('../../../server/routes/widgetAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/routes/widgetAttachments.js')>();
  return { ...actual, widgetAttachmentsRouter: express.Router(), attachUploadedFileToMessage: async () => true };
});
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/services/conversationEvents.js', () => ({ recordConversationEvent: async () => {} }));

const { widgetRouter } = await import('../../../server/routes/widget.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: Row }).serverConfig = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'ANON', supabaseServiceRoleKey: 'SERVICE' };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

function intro(body: Row): Promise<{ status: number; body: Row }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ workspace_id: WS_ID, session_id: MY_SESSION, locale: 'fa', ...body });
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/widget/ai-agent/intro', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Widget-Token': 'wss_test' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) as Row : {} }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function conversation(c: Partial<Conversation>): string {
  const id = crypto.randomUUID();
  store.conversations.push({ id, workspace_id: WS_ID, status: 'open', visitor_session_id: null, metadata: {}, ...c });
  return id;
}

beforeEach(() => {
  store.conversations = [];
  store.greeted = [];
});

describe('the AI greeting goes only into the visitor\'s own conversation', () => {
  it('the visitor\'s own open conversation is greeted', async () => {
    const mine = conversation({ visitor_session_id: MY_SESSION });
    const res = await intro({ conversation_id: mine });
    expect(res.body).toMatchObject({ sent: true, conversationId: mine });
    expect(store.greeted).toEqual([mine]);
  });

  it('another workspace\'s conversation is never written into', async () => {
    const theirs = conversation({ workspace_id: OTHER_WS, visitor_session_id: MY_SESSION });
    const res = await intro({ conversation_id: theirs });
    expect(res.body.sent).toBe(true);
    expect(res.body.conversationId).not.toBe(theirs);
    expect(store.greeted).not.toContain(theirs);
    // The visitor got their own, in this workspace.
    expect(store.conversations.find((c) => c.id === res.body.conversationId)?.workspace_id).toBe(WS_ID);
  });

  it('another visitor\'s conversation in the same workspace is never written into', async () => {
    const someoneElses = conversation({ visitor_session_id: crypto.randomUUID() });
    const res = await intro({ conversation_id: someoneElses });
    expect(store.greeted).not.toContain(someoneElses);
    expect(res.body.conversationId).not.toBe(someoneElses);
  });

  it('a closed conversation is never revived by a greeting', async () => {
    const closed = conversation({ visitor_session_id: MY_SESSION, status: 'closed' });
    const res = await intro({ conversation_id: closed });
    expect(store.greeted).not.toContain(closed);
    expect(res.body.conversationId).not.toBe(closed);
  });
});

describe('maybeSendIntro on its own (any caller)', () => {
  it('never writes into another workspace\'s or a closed conversation it is handed', async () => {
    const { maybeSendIntro } = await import('../../../server/services/ai-agent/intro.js');
    const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
    const theirs = conversation({ workspace_id: OTHER_WS });
    const closed = conversation({ status: 'closed' });
    for (const id of [theirs, closed]) {
      const res = await maybeSendIntro(config, { workspaceId: WS_ID, conversationId: id, locale: 'fa' });
      expect(res.conversationId).not.toBe(id);
    }
    expect(store.greeted).not.toContain(theirs);
    expect(store.greeted).not.toContain(closed);
  });
});
