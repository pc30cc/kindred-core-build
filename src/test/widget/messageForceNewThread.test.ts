/**
 * POST /api/widget/message through the REAL widgetRouter, for a RETURNING
 * visitor: the same contact on every request, as ensureVisitorContact
 * returns for the same dvsid visitor (messageSendBehavioral.test.ts mints a
 * new contact per call, which hid the first case below).
 *
 *   V-04  "+ New conversation" (force_new_conversation) never lands in the
 *         visitor's open thread; a lost-response retry of that first message
 *         (same client_message_id) finds the NEW thread; without the flag the
 *         visitor continues the open one, as before. For a request without
 *         a signed visitor: a signed visitor's force-new joins their live
 *         conversation since 2026-10-24 (one current conversation per
 *         visitor, oneLiveConversation.test.ts).
 *   V-31  contact details a site passed with identify() that are not usable
 *         (an email that is not one, a phone over 30 characters) are left
 *         out instead of refusing the message; usable ones still arrive.
 *
 * Only the database and the side effects are faked; the route's own
 * control flow runs.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
interface Conversation { id: string; workspace_id: string; status: string; contact_id: string | null; metadata: Row }
interface Message { id: string; conversation_id: string; sender_type: string; body: string; metadata: Row; reply_to_message_id: string | null; created_at: string; seen_at: string | null }

const WS_ID = '11111111-1111-4111-8111-111111111111';
const store = vi.hoisted(() => ({
  conversations: [] as Conversation[],
  messages: [] as Message[],
  contactId: '',
  contactCalls: [] as Array<Record<string, unknown>>,
}));

type Result = { data: unknown; error: { message: string } | null };

function messagesTable() {
  const filters: Array<(m: Message) => boolean> = [];
  const found = () => store.messages.filter((m) => filters.every((f) => f(m)));
  const b = {
    select: () => b,
    eq: (col: string, val: unknown) => { filters.push((m) => (m as unknown as Row)[col] === val); return b; },
    filter: (path: string, _op: string, val: unknown) => {
      if (path === 'metadata->>client_message_id') filters.push((m) => m.metadata.client_message_id === val);
      return b;
    },
    in: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async (): Promise<Result> => ({ data: found()[0] || null, error: null }),
    then: (resolve: (r: Result) => unknown) => Promise.resolve({ data: found(), error: null }).then(resolve),
    insert: (row: Row) => {
      const cmid = (row.metadata as Row | undefined)?.client_message_id;
      const clash = cmid && store.messages.find((m) => m.conversation_id === row.conversation_id && m.metadata.client_message_id === cmid);
      const inserted: Message = {
        id: crypto.randomUUID(),
        conversation_id: String(row.conversation_id),
        sender_type: String(row.sender_type),
        body: String(row.body ?? ''),
        metadata: (row.metadata as Row) || {},
        reply_to_message_id: (row.reply_to_message_id as string | null) ?? null,
        created_at: new Date().toISOString(),
        seen_at: null,
      };
      if (!clash) store.messages.push(inserted);
      return {
        select: () => ({
          single: async (): Promise<Result> => (clash
            ? { data: null, error: { message: 'duplicate key value violates unique constraint 23505' } }
            : { data: inserted, error: null }),
        }),
      };
    },
  };
  return b;
}

function anyTable(table: string) {
  const b = {
    select: () => b, eq: () => b, order: () => b, limit: () => b, in: () => b, contains: () => b, not: () => b, is: () => b,
    update: () => b,
    maybeSingle: async (): Promise<Result> => (table === 'widget_settings'
      ? { data: { enabled: true, chat_enabled: true }, error: null }
      : { data: null, error: null }),
    single: async (): Promise<Result> => ({ data: null, error: null }),
    then: (resolve: (r: Result) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return b;
}

/** ensure_active_conversation (migration 072): thread key, then session, then contact, else insert. */
function ensureActiveConversation(args: Row): Result {
  const reusable = (c: Conversation) => c.workspace_id === args.p_workspace_id && c.status !== 'closed';
  const byKey = args.p_match_thread_key
    ? store.conversations.find((c) => reusable(c) && c.metadata.channel_thread_key === args.p_match_thread_key) : null;
  if (byKey) return { data: [{ id: byKey.id, created: false, matched_by: 'thread_key' }], error: null };
  const byContact = args.p_match_contact_id
    ? store.conversations.find((c) => reusable(c) && c.contact_id === args.p_match_contact_id) : null;
  if (byContact) return { data: [{ id: byContact.id, created: false, matched_by: 'contact' }], error: null };
  const created: Conversation = {
    id: crypto.randomUUID(),
    workspace_id: String(args.p_workspace_id),
    status: 'open',
    contact_id: (args.p_contact_id as string | null) ?? null,
    metadata: (args.p_metadata as Row) || {},
  };
  store.conversations.push(created);
  return { data: [{ id: created.id, created: true, matched_by: 'created' }], error: null };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => (table === 'conversation_messages' ? messagesTable() : anyTable(table)),
    rpc: async (fn: string, args: Row): Promise<Result> => (fn === 'ensure_active_conversation' ? ensureActiveConversation(args) : { data: null, error: null }),
  }),
}));
vi.mock('../../../server/services/widget/security.js', () => ({
  createSessionToken: () => 'wss_test',
  verifySessionToken: () => ({ valid: true, workspaceId: WS_ID }),
  verifyTokenForRefresh: () => ({ valid: true, workspaceId: WS_ID }),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: (_req: unknown, _res: unknown, bodyWsId: string) => bodyWsId || WS_ID,
  verifyConversationOwnership: async (_config: unknown, conversationId: string, workspaceId: string) => {
    const conv = store.conversations.find((c) => c.id === conversationId && c.workspace_id === workspaceId);
    return conv ? { valid: true, conversation: conv } : { valid: false, conversation: null };
  },
  getClientIp: () => '127.0.0.1',
  getRequestOrigin: () => 'https://example.com',
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({ enforceMaxConversationsLimit: async () => true }));
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({
  // A returning visitor: the same contact every time.
  ensureVisitorContact: async (_sb: unknown, input: Record<string, unknown>) => {
    store.contactCalls.push(input);
    return store.contactId;
  },
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({ maybeRunAiAssistantAfterVisitorMessage: async () => ({ action: 'skipped' }) }));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => {} }));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  clearAiManagementForPlatformOff: async () => ({ previousAiState: null, changed: false }),
  markNeedsHuman: async () => {},
}));
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
vi.mock('../../../server/services/conversationLifecycle.js', () => ({
  applyInboundConversationLifecycle: async () => {},
  INBOUND_REUSABLE_STATUSES: ['open', 'pending', 'resolved'],
}));

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

function send(body: Row): Promise<{ status: number; body: Row }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ workspace_id: WS_ID, ...body });
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/widget/message', method: 'POST',
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

beforeEach(() => {
  store.conversations = [];
  store.messages = [];
  store.contactId = crypto.randomUUID();
  store.contactCalls = [];
});

// These requests carry no signed visitor (no dvsid cookie or credential
// header), so the one-current-conversation guard has nobody to look for: a
// signed visitor's force-new joins their live conversation and starts a new
// one only once it is closed (src/test/widget/oneLiveConversation.test.ts).
describe('V-04: "+ New conversation" for a returning visitor (no signed visitor)', () => {
  it('never lands in the open thread, and a retry of its first message finds the new one', async () => {
    const open = await send({ message: 'the old thread', client_message_id: 'cmid-old-1' });
    expect(open.status).toBe(200);
    const fresh = await send({ message: 'a new question', force_new_conversation: true, client_message_id: 'cmid-new-1' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.conversation_id).not.toBe(open.body.conversation_id);
    expect(store.conversations).toHaveLength(2);
    const retry = await send({ message: 'a new question', force_new_conversation: true, client_message_id: 'cmid-new-1' });
    expect(retry.body.conversation_id).toBe(fresh.body.conversation_id);
    expect(retry.body.message_id).toBe(fresh.body.message_id);
    expect(store.conversations).toHaveLength(2);
    expect(store.messages.filter((m) => m.conversation_id === fresh.body.conversation_id)).toHaveLength(1);
  });

  it('without the flag the visitor continues the open thread (unchanged)', async () => {
    const first = await send({ message: 'one', client_message_id: 'cmid-a-1' });
    const second = await send({ message: 'two', client_message_id: 'cmid-a-2' });
    expect(second.body.conversation_id).toBe(first.body.conversation_id);
    expect(store.conversations).toHaveLength(1);
  });
});

describe('V-31: identify() details that are not usable never refuse the message', () => {
  it('an invalid email and a phone over 30 characters are left out; the name is trimmed; the message is accepted', async () => {
    const res = await send({ message: 'hello', visitor_email: 'not an email', visitor_phone: '0'.repeat(40), visitor_name: '  Maryam  ' });
    expect(res.status).toBe(200);
    expect(store.contactCalls[0]).toMatchObject({ email: null, phone: null, name: 'Maryam' });
    expect(store.messages).toHaveLength(1);
  });

  it('a valid email still reaches the contact', async () => {
    const res = await send({ message: 'hello', visitor_email: ' maryam@example.com ', visitor_phone: '+98 912 123 4567' });
    expect(res.status).toBe(200);
    expect(store.contactCalls[0]).toMatchObject({ email: 'maryam@example.com', phone: '+98 912 123 4567' });
  });
});
