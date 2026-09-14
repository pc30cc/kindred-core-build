/**
 * Behavioral (not source-string) tests over the REAL `widgetRouter` from
 * server/routes/widget.ts, mounted in an in-process Express app with every
 * external dependency mocked — Supabase, security/auth middleware, AI
 * engine, realtime publish, push, and the channel-outbound gate. No live
 * database or network call is made; the route's actual control flow
 * (idempotency lookup, reply-to validation, conversation creation RPC,
 * side-effect guards) runs for real against an in-memory fake.
 *
 * This complements (does not replace) the structural contract tests in
 * productionHardeningPass.test.ts — those prove the source has the right
 * shape; these prove the shape actually behaves correctly end to end.
 *
 * Covers, per the follow-up review:
 *   1. Reply-to-message survives send → response → realtime envelope →
 *      poll → history, is rejected for a foreign conversation, and
 *      degrades gracefully when the parent is gone.
 *   2. A duplicate resend (same client_message_id) inserts exactly one
 *      row and fires AI / realtime publish / push / attachment-bind
 *      exactly once, not twice.
 *   3. The fresh-conversation lost-response race: two requests with the
 *      same client_message_id and force_new_conversation=true converge
 *      on ONE conversation and ONE message, not two conversations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { enrichMessagesWithReplyTo, isVisitorVisibleMessageMeta, filterVisitorVisibleMessages } from '../../../server/routes/widgetAttachments.js';

// ─────────────────────────────────────────────────────────────────────────
// In-memory fake conversation_messages / conversations store
// ─────────────────────────────────────────────────────────────────────────
type FakeMessage = {
  id: string;
  conversation_id: string;
  sender_type: string;
  body: string;
  metadata: Record<string, any>;
  reply_to_message_id: string | null;
  created_at: string;
  seen_at: string | null;
};
type FakeConversation = { id: string; workspace_id: string; status: string; metadata: Record<string, any> };

let messages: FakeMessage[] = [];
let conversations: FakeConversation[] = [];
// messageSchema validates conversation_id/reply_to_message_id as real UUIDs
// (z.string().uuid()), so every id this fake mints must actually be one.
const freshId = (_prefix: string) => crypto.randomUUID();
const WS_ID = '11111111-1111-4111-8111-111111111111';

function resetFakeDb() {
  messages = [];
  conversations = [];
}

/** Minimal chainable query-builder covering exactly what widget.ts's
 * /message, /poll and /history handlers call on conversation_messages,
 * plus a permissive fallback for every other table so an unmocked,
 * best-effort lookup elsewhere in the handler degrades to "not found"
 * instead of throwing. */
function makeFakeSupabase() {
  function conversationMessagesBuilder() {
    let filters: Array<(m: FakeMessage) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        filters.push((m: any) => m[col] === val);
        return b;
      },
      filter: (path: string, _op: string, val: any) => {
        // Only path used by widget.ts: 'metadata->>client_message_id'.
        if (path === 'metadata->>client_message_id') {
          filters.push((m: any) => m.metadata?.client_message_id === val);
        }
        return b;
      },
      in: (col: string, vals: any[]) => {
        filters.push((m: any) => vals.includes(m[col]));
        return b;
      },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const found = messages.filter((m) => filters.every((f) => f(m)));
        return { data: found[0] || null, error: null };
      },
      single: async () => {
        const found = messages.filter((m) => filters.every((f) => f(m)));
        return found[0]
          ? { data: found[0], error: null }
          : { data: null, error: { message: 'not found' } };
      },
      then: (resolve: any) => {
        const found = messages.filter((m) => filters.every((f) => f(m)));
        return Promise.resolve({ data: found, error: null }).then(resolve);
      },
      insert: (row: any) => {
        // Simulate migration 070's partial unique index:
        // (conversation_id, metadata->>'client_message_id').
        const cmid = row.metadata?.client_message_id;
        if (cmid) {
          const clash = messages.find(
            (m) => m.conversation_id === row.conversation_id && m.metadata?.client_message_id === cmid,
          );
          if (clash) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { message: 'duplicate key value violates unique constraint "idx_conversation_messages_client_message_id" 23505' } }),
              }),
            };
          }
        }
        const inserted: FakeMessage = {
          id: freshId('msg'),
          conversation_id: row.conversation_id,
          sender_type: row.sender_type,
          body: row.body,
          metadata: row.metadata || {},
          reply_to_message_id: row.reply_to_message_id ?? null,
          created_at: new Date().toISOString(),
          seen_at: null,
        };
        messages.push(inserted);
        return {
          select: () => ({
            single: async () => ({ data: inserted, error: null }),
          }),
        };
      },
    };
    return b;
  }

  function genericBuilder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      in: () => b,
      contains: () => b,
      not: () => b,
      maybeSingle: async () => {
        if (table === 'widget_settings') return { data: { enabled: true, chat_enabled: true }, error: null };
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      update: () => b,
      then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return b;
  }

  return {
    from(table: string) {
      if (table === 'conversation_messages') return conversationMessagesBuilder();
      return genericBuilder(table);
    },
    rpc: async (fn: string, args: any) => {
      if (fn === 'ensure_active_conversation') {
        const threadKey = args.p_match_thread_key as string | null;
        if (threadKey) {
          const byThreadKey = conversations.find(
            (c) => c.workspace_id === args.p_workspace_id && c.metadata?.channel_thread_key === threadKey && c.status !== 'closed',
          );
          if (byThreadKey) return { data: [{ id: byThreadKey.id, created: false, matched_by: 'thread_key' }], error: null };
        }
        if (args.p_match_session_id) {
          const bySession = conversations.find(
            (c) => c.workspace_id === args.p_workspace_id && c.metadata?.visitor_session_id === args.p_match_session_id && c.status !== 'closed',
          );
          if (bySession) return { data: [{ id: bySession.id, created: false, matched_by: 'session' }], error: null };
        }
        if (args.p_match_contact_id) {
          const byContact = conversations.find(
            (c) => c.workspace_id === args.p_workspace_id && c.metadata?.contact_id === args.p_match_contact_id && c.status !== 'closed',
          );
          if (byContact) return { data: [{ id: byContact.id, created: false, matched_by: 'contact' }], error: null };
        }
        const created: FakeConversation = {
          id: freshId('conv'),
          workspace_id: args.p_workspace_id,
          status: 'open',
          metadata: { ...(args.p_metadata || {}), contact_id: args.p_contact_id, visitor_session_id: args.p_visitor_session_id },
        };
        conversations.push(created);
        return { data: [{ id: created.id, created: true, matched_by: 'created' }], error: null };
      }
      return { data: null, error: null };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Mocks — every external dependency of server/routes/widget.ts
// ─────────────────────────────────────────────────────────────────────────
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => makeFakeSupabase(),
}));

vi.mock('../../../server/services/widget/security.js', () => ({
  createSessionToken: () => 'wss_test',
  verifySessionToken: () => ({ valid: true, workspaceId: WS_ID }),
  verifyTokenForRefresh: () => ({ valid: true, workspaceId: WS_ID }),
  enforceWidgetToken: (_req: any, _res: any, next: any) => next(),
  enforceOrigin: (_req: any, _res: any, next: any) => next(),
  widgetRateLimit: () => (_req: any, _res: any, next: any) => next(),
  resolveWorkspaceId: (_req: any, _res: any, bodyWsId: string) => bodyWsId || WS_ID,
  verifyConversationOwnership: async (_config: any, conversationId: string, workspaceId: string) => {
    const conv = conversations.find((c) => c.id === conversationId && c.workspace_id === workspaceId);
    return conv ? { valid: true, conversation: conv } : { valid: false, conversation: null };
  },
  getClientIp: () => '127.0.0.1',
  getRequestOrigin: () => 'https://example.com',
}));

vi.mock('../../../server/services/billing/conversationLimit.js', () => ({
  enforceMaxConversationsLimit: async () => true,
}));

vi.mock('../../../server/services/widget/anonymousContact.js', () => ({
  // Realistic: with no stable identity signal (visitorId/sessionId/email/
  // phone — none of which the widget client ever sends on POST /message),
  // the real ensureVisitorContact creates a FRESH anonymous placeholder
  // contact on every call. A fixed id here would make the fake RPC's
  // contact-match branch collide across genuinely unrelated calls in a way
  // the real implementation does not.
  ensureVisitorContact: async () => crypto.randomUUID(),
}));

vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({
  isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }),
}));

const aiRunSpy = vi.fn(async () => ({ action: 'skipped', reason: 'test_stub' }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: (...args: any[]) => aiRunSpy(...args),
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => {} }));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  clearAiManagementForPlatformOff: async () => ({ previousAiState: null, changed: false }),
  markNeedsHuman: async () => {},
}));

const publishSpy = vi.fn(async () => ({ ok: true }));
vi.mock('../../../server/services/realtime/publish.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/realtime/publish.js')>();
  return { ...actual, publishConversationEvent: (...args: any[]) => publishSpy(...args) };
});

const pushSpy = vi.fn(async () => {});
vi.mock('../../../server/services/push/index.js', () => ({
  notifyInboundMessage: (...args: any[]) => pushSpy(...args),
}));

const attachSpy = vi.fn(async () => true);
vi.mock('../../../server/routes/widgetAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/routes/widgetAttachments.js')>();
  return {
    ...actual,
    widgetAttachmentsRouter: express.Router(),
    attachUploadedFileToMessage: (...args: any[]) => attachSpy(...args),
  };
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

// ─────────────────────────────────────────────────────────────────────────
// App under test
// ─────────────────────────────────────────────────────────────────────────
const { widgetRouter } = await import('../../../server/routes/widget.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function post(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Widget-Token': 'wss_test' } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method: 'GET', headers: { 'X-Widget-Token': 'wss_test' } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(() => {
  resetFakeDb();
  aiRunSpy.mockClear();
  publishSpy.mockClear();
  pushSpy.mockClear();
  attachSpy.mockClear();
});

function seedConversation(workspaceId = WS_ID): string {
  const id = freshId('conv');
  conversations.push({ id, workspace_id: workspaceId, status: 'open', metadata: {} });
  return id;
}

/** Directly implant a message row, bypassing POST /message — used to seed
 * messages a visitor could never create themselves (an internal staffing
 * notice) or to simulate a stale/foreign FK for defense-in-depth tests. */
function seedMessage(convId: string, body: string, metadata: Record<string, any> = {}): string {
  const id = freshId('msg');
  messages.push({
    id,
    conversation_id: convId,
    sender_type: metadata.internal ? 'system' : 'contact',
    body,
    metadata,
    reply_to_message_id: null,
    created_at: new Date().toISOString(),
    seen_at: null,
  });
  return id;
}

describe('POST /api/widget/message — reply-to end-to-end (behavioral)', () => {
  it('persists reply_to_message_id and returns a resolved reply_to preview in the send response', async () => {
    const convId = seedConversation();
    const first = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'original question' });
    expect(first.status).toBe(200);
    const parentId = first.body.message_id;

    const reply = await post('/api/widget/message', {
      workspace_id: WS_ID,
      conversation_id: convId,
      message: 'here is my reply',
      reply_to_message_id: parentId,
    });
    expect(reply.status).toBe(200);
    expect(reply.body.reply_to_message_id).toBe(parentId);
    expect(reply.body.reply_to).toEqual({ id: parentId, text: 'original question', sender_type: 'contact' });

    // DB actually stored the FK, not just returned it in the response.
    const stored = messages.find((m) => m.id === reply.body.message_id);
    expect(stored?.reply_to_message_id).toBe(parentId);
  });

  it('the realtime envelope for the reply carries the same structured relation', async () => {
    const convId = seedConversation();
    const first = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'parent' });
    const parentId = first.body.message_id;

    publishSpy.mockClear();
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'child', reply_to_message_id: parentId });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const envelope = publishSpy.mock.calls[0][3];
    expect(envelope.type).toBe('message');
    expect(envelope.payload.reply_to_message_id).toBe(parentId);
    expect(envelope.payload.reply_to).toEqual({ id: parentId, text: 'parent', sender_type: 'contact' });
  });

  it('GET /poll returns the resolved reply_to preview for a message sent earlier in the same conversation', async () => {
    const convId = seedConversation();
    const first = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'parent' });
    const parentId = first.body.message_id;
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'child', reply_to_message_id: parentId });

    const polled = await get(`/api/widget/poll?workspace_id=${WS_ID}&conversation_id=${convId}`);
    expect(polled.status).toBe(200);
    const childMsg = polled.body.messages.find((m: any) => m.text === 'child');
    expect(childMsg.reply_to_message_id).toBe(parentId);
    expect(childMsg.reply_to).toEqual({ id: parentId, text: 'parent', sender_type: 'contact' });
  });

  it('GET /history returns the resolved reply_to preview (page-reload path)', async () => {
    const convId = seedConversation();
    const first = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'parent' });
    const parentId = first.body.message_id;
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'child', reply_to_message_id: parentId });

    const history = await get(`/api/widget/history?workspace_id=${WS_ID}&conversation_id=${convId}`);
    expect(history.status).toBe(200);
    const childMsg = history.body.messages.find((m: any) => m.text === 'child');
    expect(childMsg.reply_to_message_id).toBe(parentId);
    expect(childMsg.reply_to.text).toBe('parent');
  });

  it('rejects/ignores a reply_to_message_id belonging to a DIFFERENT conversation (no cross-conversation leak)', async () => {
    const convA = seedConversation();
    const convB = seedConversation();
    const foreign = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convA, message: 'secret in A' });
    const foreignId = foreign.body.message_id;

    const attempt = await post('/api/widget/message', {
      workspace_id: WS_ID,
      conversation_id: convB,
      message: 'trying to quote across conversations',
      reply_to_message_id: foreignId,
    });
    expect(attempt.status).toBe(200);
    // Silently dropped, not leaked, and the send is NOT failed.
    expect(attempt.body.reply_to_message_id).toBeNull();
    expect(attempt.body.reply_to).toBeNull();
    const stored = messages.find((m) => m.id === attempt.body.message_id);
    expect(stored?.reply_to_message_id).toBeNull();
  });

  it('a deleted parent (ON DELETE SET NULL) degrades to no reply preview instead of breaking rendering', async () => {
    const convId = seedConversation();
    const first = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'will be deleted' });
    const parentId = first.body.message_id;
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'child', reply_to_message_id: parentId });

    // Simulate the FK's ON DELETE SET NULL semantics (out of scope to spin
    // up real Postgres here): the parent row is gone, but the child's own
    // reply_to_message_id column would have been nulled by the DB. What
    // matters behaviorally is that enrichment never crashes and never
    // fabricates a preview for a vanished parent.
    messages = messages.filter((m) => m.id !== parentId);
    const polled = await get(`/api/widget/poll?workspace_id=${WS_ID}&conversation_id=${convId}`);
    expect(polled.status).toBe(200);
    const childMsg = polled.body.messages.find((m: any) => m.text === 'child');
    // Public shape is sanitized to indistinguishable-from-none: no preview
    // is fabricated, AND the now-dangling raw id is not echoed back either.
    expect(childMsg.reply_to).toBeNull();
    expect(childMsg.reply_to_message_id).toBeNull();
  });
});

describe('POST /api/widget/message — duplicate-send idempotency (behavioral)', () => {
  it('a retry with the SAME client_message_id inserts exactly one row', async () => {
    const convId = seedConversation();
    const r1 = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'hello', client_message_id: 'cmid-abc123' });
    const r2 = await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'hello', client_message_id: 'cmid-abc123' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.message_id).toBe(r1.body.message_id);
    expect(messages.filter((m) => m.conversation_id === convId)).toHaveLength(1);
  });

  it('AI trigger, realtime publish, push, and attachment-bind each fire exactly once across original + duplicate resend', async () => {
    const convId = seedConversation();
    await post('/api/widget/message', {
      workspace_id: WS_ID,
      conversation_id: convId,
      message: 'hi',
      client_message_id: 'cmid-once',
      attachment_id: crypto.randomUUID(),
    });
    expect(aiRunSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(1);

    // Retry: simulates "client never saw the response, resend fired".
    await post('/api/widget/message', {
      workspace_id: WS_ID,
      conversation_id: convId,
      message: 'hi',
      client_message_id: 'cmid-once',
      attachment_id: crypto.randomUUID(),
    });
    expect(aiRunSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(1);
  });

  it('two DIFFERENT client_message_id values in the same conversation each insert their own row', async () => {
    const convId = seedConversation();
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'one', client_message_id: 'cmid-one-1' });
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'two', client_message_id: 'cmid-two-2' });
    expect(messages.filter((m) => m.conversation_id === convId)).toHaveLength(2);
  });
});

describe('POST /api/widget/message — fresh-conversation lost-response retry (behavioral)', () => {
  it('does NOT create a second conversation when the client retries after losing the first response', async () => {
    const payload = {
      workspace_id: WS_ID,
      message: 'first ever message',
      force_new_conversation: true,
      client_message_id: 'cmid-fresh-1',
    };
    const first = await post('/api/widget/message', payload);
    expect(first.status).toBe(200);
    expect(first.body.conversation_id).toBeTruthy();

    // Retry: client believes it still has no conversation_id (response was
    // "lost"), so it resends with conversation_id omitted and
    // force_new_conversation still true — exactly the dangerous scenario.
    const retry = await post('/api/widget/message', payload);
    expect(retry.status).toBe(200);

    expect(retry.body.conversation_id).toBe(first.body.conversation_id);
    expect(retry.body.message_id).toBe(first.body.message_id);
    expect(conversations).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it('a genuinely separate "+ New conversation" click (new client_message_id) still creates a real second conversation', async () => {
    const first = await post('/api/widget/message', {
      workspace_id: WS_ID,
      message: 'first thread',
      force_new_conversation: true,
      client_message_id: 'cmid-thread-a',
    });
    const second = await post('/api/widget/message', {
      workspace_id: WS_ID,
      message: 'second thread, explicitly new',
      force_new_conversation: true,
      client_message_id: 'cmid-thread-b',
    });
    expect(second.body.conversation_id).not.toBe(first.body.conversation_id);
    expect(conversations).toHaveLength(2);
    expect(messages).toHaveLength(2);
  });
});

describe('POST /api/widget/message — reply-to visitor visibility (internal messages never preview)', () => {
  it('an internal parent never returns a body preview in the send response (the FK may still be recorded)', async () => {
    const convId = seedConversation();
    const internalId = seedMessage(convId, 'X transferred this conversation to Y', { internal: true, kind: 'conversation_transferred' });

    const reply = await post('/api/widget/message', {
      workspace_id: WS_ID,
      conversation_id: convId,
      message: 'quoting staff note',
      reply_to_message_id: internalId,
    });
    expect(reply.status).toBe(200);
    // The DB-stored FK MAY persist (same-conversation is still a true
    // fact, and it may be useful internally for audit/integrity), but the
    // PUBLIC response must be indistinguishable from a missing/deleted
    // parent: both reply_to_message_id AND reply_to come back null — the
    // id alone must never act as a "something hidden exists here" oracle.
    expect(reply.body.reply_to_message_id).toBeNull();
    expect(reply.body.reply_to).toBeNull();
    expect(JSON.stringify(reply.body)).not.toContain('transferred this conversation');
    expect(JSON.stringify(reply.body)).not.toContain(internalId);

    const stored = messages.find((m) => m.id === reply.body.message_id);
    expect(stored?.reply_to_message_id).toBe(internalId);
  });

  it('GET /poll and GET /history never surface the internal parent id or preview', async () => {
    const convId = seedConversation();
    const internalId = seedMessage(convId, 'internal staffing note body', { internal: true });
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'quoting staff note', reply_to_message_id: internalId });

    const polled = await get(`/api/widget/poll?workspace_id=${WS_ID}&conversation_id=${convId}`);
    const childPolled = polled.body.messages.find((m: any) => m.text === 'quoting staff note');
    expect(childPolled.reply_to_message_id).toBeNull();
    expect(childPolled.reply_to).toBeNull();
    expect(JSON.stringify(polled.body)).not.toContain('internal staffing note body');
    expect(JSON.stringify(polled.body)).not.toContain(internalId);

    const history = await get(`/api/widget/history?workspace_id=${WS_ID}&conversation_id=${convId}`);
    const childHistory = history.body.messages.find((m: any) => m.text === 'quoting staff note');
    expect(childHistory.reply_to_message_id).toBeNull();
    expect(childHistory.reply_to).toBeNull();
    expect(JSON.stringify(history.body)).not.toContain('internal staffing note body');
    expect(JSON.stringify(history.body)).not.toContain(internalId);
  });

  it('the realtime envelope never carries the internal parent body OR id', async () => {
    const convId = seedConversation();
    const internalId = seedMessage(convId, 'do not leak this body via realtime', { internal: true });
    publishSpy.mockClear();
    await post('/api/widget/message', { workspace_id: WS_ID, conversation_id: convId, message: 'quoting staff note', reply_to_message_id: internalId });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const envelope = publishSpy.mock.calls[0][3];
    expect(envelope.payload.reply_to).toBeUndefined();
    expect(envelope.payload.reply_to_message_id).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toContain('do not leak this body via realtime');
    expect(JSON.stringify(envelope)).not.toContain(internalId);
  });

  it('a bypassed cross-conversation FK (simulating a stale/foreign link) is rejected by enrichment defense-in-depth, independent of POST-time validation', async () => {
    const convA = seedConversation();
    const convB = seedConversation();
    const parentIdA = seedMessage(convA, 'secret in A');

    // Implant a child row directly in conv B whose FK points at conv A's
    // message — something POST-time validation already refuses to create,
    // but the enrichment layer (used by /poll, /history, /identity/history)
    // must not trust a `reply_to_message_id` FK blindly either.
    messages.push({
      id: freshId('msg'),
      conversation_id: convB,
      sender_type: 'contact',
      body: 'bypassed child',
      metadata: {},
      reply_to_message_id: parentIdA,
      created_at: new Date().toISOString(),
      seen_at: null,
    });

    const polled = await get(`/api/widget/poll?workspace_id=${WS_ID}&conversation_id=${convB}`);
    const child = polled.body.messages.find((m: any) => m.text === 'bypassed child');
    expect(child.reply_to).toBeNull();
    expect(child.reply_to_message_id).toBeNull();
    expect(JSON.stringify(polled.body)).not.toContain('secret in A');
    expect(JSON.stringify(polled.body)).not.toContain(parentIdA);
  });
});

describe('enrichMessagesWithReplyTo / isVisitorVisibleMessageMeta — direct unit coverage (the exact function GET /identity/history also calls)', () => {
  const config = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'ANON_KEY', supabaseServiceRoleKey: 'SERVICE_KEY' } as any;

  it('isVisitorVisibleMessageMeta rejects metadata.internal === true and accepts everything else', () => {
    expect(isVisitorVisibleMessageMeta({ internal: true })).toBe(false);
    expect(isVisitorVisibleMessageMeta({ internal: false })).toBe(true);
    expect(isVisitorVisibleMessageMeta(null)).toBe(true);
    expect(isVisitorVisibleMessageMeta(undefined)).toBe(true);
    expect(isVisitorVisibleMessageMeta({})).toBe(true);
    expect(isVisitorVisibleMessageMeta('not an object')).toBe(true);
  });

  it('filterVisitorVisibleMessages removes only the internal messages, preserving order of the rest — the exact function GET /identity/history calls directly', () => {
    const visitor = { id: 'm1', metadata: {} };
    const internal = { id: 'm2', metadata: { internal: true } };
    const agent = { id: 'm3', metadata: { internal: false } };
    expect(filterVisitorVisibleMessages([visitor, internal, agent])).toEqual([visitor, agent]);
    expect(filterVisitorVisibleMessages([])).toEqual([]);
  });

  it('attaches BOTH the id and preview for a visible, same-conversation parent', async () => {
    const convId = seedConversation();
    const parentId = seedMessage(convId, 'visible parent text');
    const [result] = await enrichMessagesWithReplyTo(config, convId, [
      { id: 'c1', reply_to_message_id: parentId },
    ]);
    expect(result.reply_to_message_id).toBe(parentId);
    expect(result.reply_to).toEqual({ id: parentId, text: 'visible parent text', sender_type: 'contact' });
  });

  it('drops BOTH the id and preview for an internal parent, even in the same conversation', async () => {
    const convId = seedConversation();
    const parentId = seedMessage(convId, 'internal secret', { internal: true });
    const [result] = await enrichMessagesWithReplyTo(config, convId, [
      { id: 'c1', reply_to_message_id: parentId },
    ]);
    expect(result.reply_to_message_id).toBeNull();
    expect(result.reply_to).toBeNull();
  });

  it('drops BOTH the id and preview for a cross-conversation parent even though the row resolves', async () => {
    const convA = seedConversation();
    const convB = seedConversation();
    const parentId = seedMessage(convA, 'secret in A');
    const [result] = await enrichMessagesWithReplyTo(config, convB, [
      { id: 'c1', reply_to_message_id: parentId },
    ]);
    expect(result.reply_to_message_id).toBeNull();
    expect(result.reply_to).toBeNull();
  });

  it('drops BOTH the id and preview for a missing/deleted parent without throwing', async () => {
    const convId = seedConversation();
    const goneId = freshId('gone');
    const [result] = await enrichMessagesWithReplyTo(config, convId, [
      { id: 'c1', reply_to_message_id: goneId },
    ]);
    expect(result.reply_to_message_id).toBeNull();
    expect(result.reply_to).toBeNull();
  });

  it('hidden, foreign, and missing parents are indistinguishable from each other in the public shape', async () => {
    const convA = seedConversation();
    const convB = seedConversation();
    const internalId = seedMessage(convB, 'internal', { internal: true });
    const foreignId = seedMessage(convA, 'foreign');
    const [hidden, foreign, missing] = await enrichMessagesWithReplyTo(config, convB, [
      { id: 'c1', reply_to_message_id: internalId },
      { id: 'c2', reply_to_message_id: foreignId },
      { id: 'c3', reply_to_message_id: freshId('gone') },
    ]);
    const shape = (m: any) => ({ reply_to_message_id: m.reply_to_message_id, reply_to: m.reply_to });
    expect(shape(hidden)).toEqual({ reply_to_message_id: null, reply_to: null });
    expect(shape(foreign)).toEqual({ reply_to_message_id: null, reply_to: null });
    expect(shape(missing)).toEqual({ reply_to_message_id: null, reply_to: null });
  });
});
