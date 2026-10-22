/**
 * The widget's write paths through the REAL routers (the database and the
 * side effects faked; the workspace snapshot, which /config is built from,
 * set per test):
 *
 *   S-08  POST /attachments/init and POST /message follow the PLAN, as
 *         /config does: a capability the plan denies is refused even when
 *         the workspace's own column still says on (a downgrade resets no
 *         column; a crafted request or a stale tab sent it anyway). An
 *         unreadable plan refuses nothing.
 *   V-28  the first message answering a "Message inside the chat" stores
 *         the published rule's own text before it (never text from the
 *         browser), counts the rule's conversation, and returns the line;
 *         a retry or a later message never writes it again; an unusable
 *         reference never refuses the message.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
interface Conversation { id: string; workspace_id: string; status: string; contact_id: string | null; metadata: Row }
interface Message { id: string; conversation_id: string; sender_type: string; body: string; metadata: Row; created_at: string }

const WS_ID = '11111111-1111-4111-8111-111111111111';
const RULE = '0c6b1c2e-1d2a-4e3b-9c4d-5e6f7a8b9c0d';
const state = vi.hoisted(() => ({
  conversations: [] as Conversation[],
  messages: [] as Message[],
  attachments: [] as Row[],
  widgetRow: { enabled: true, chat_enabled: true, attachments_enabled: true, voice_notes_enabled: true, attachments_max_size_mb: 10 } as Row,
  features: {} as Record<string, boolean>,
  degraded: false,
  smartEvents: [] as Row[],
  rules: [] as Row[],
}));

type Result = { data: unknown; error: { message: string } | null };

function messagesTable() {
  const filters: Array<(m: Message) => boolean> = [];
  const found = () => state.messages.filter((m) => filters.every((f) => f(m)));
  const b = {
    select: () => b,
    eq: (col: string, val: unknown) => { filters.push((m) => (m as unknown as Row)[col] === val); return b; },
    filter: (path: string, _op: string, val: unknown) => {
      if (path === 'metadata->>client_message_id') filters.push((m) => m.metadata.client_message_id === val);
      return b;
    },
    in: () => b, order: () => b, limit: () => b,
    maybeSingle: async (): Promise<Result> => ({ data: found()[0] || null, error: null }),
    then: (resolve: (r: Result) => unknown) => Promise.resolve({ data: found(), error: null }).then(resolve),
    insert: (row: Row) => {
      const inserted: Message = {
        id: crypto.randomUUID(),
        conversation_id: String(row.conversation_id),
        sender_type: String(row.sender_type),
        body: String(row.body ?? ''),
        metadata: (row.metadata as Row) || {},
        created_at: new Date(Date.now() + state.messages.length).toISOString(),
      };
      state.messages.push(inserted);
      return { select: () => ({ single: async (): Promise<Result> => ({ data: inserted, error: null }) }) };
    },
  };
  return b;
}

function anyTable(table: string) {
  const b = {
    select: () => b, eq: () => b, order: () => b, limit: () => b, in: () => b, contains: () => b, not: () => b, is: () => b,
    update: () => b,
    insert: (row: Row) => {
      const inserted = { id: crypto.randomUUID(), ...row };
      if (table === 'conversation_attachments') state.attachments.push(inserted);
      return { select: () => ({ single: async (): Promise<Result> => ({ data: inserted, error: null }) }) };
    },
    maybeSingle: async (): Promise<Result> => (table === 'widget_settings' ? { data: state.widgetRow, error: null } : { data: null, error: null }),
    single: async (): Promise<Result> => ({ data: null, error: null }),
    then: (resolve: (r: Result) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return b;
}

function ensureActiveConversation(args: Row): Result {
  const reusable = (c: Conversation) => c.workspace_id === args.p_workspace_id && c.status !== 'closed';
  const byKey = args.p_match_thread_key
    ? state.conversations.find((c) => reusable(c) && c.metadata.channel_thread_key === args.p_match_thread_key) : null;
  if (byKey) return { data: [{ id: byKey.id, created: false }], error: null };
  const created: Conversation = {
    id: crypto.randomUUID(), workspace_id: String(args.p_workspace_id), status: 'open',
    contact_id: (args.p_contact_id as string | null) ?? null, metadata: (args.p_metadata as Row) || {},
  };
  state.conversations.push(created);
  return { data: [{ id: created.id, created: true }], error: null };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => (table === 'conversation_messages' ? messagesTable() : anyTable(table)),
    rpc: async (fn: string, args: Row): Promise<Result> => (fn === 'ensure_active_conversation' ? ensureActiveConversation(args) : { data: null, error: null }),
  }),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/configSnapshot.js')>();
  return {
    ...actual,
    // What /config is built from: the plan's answer and the published rules.
    getWorkspaceWidgetSnapshot: async () => ({
      workspace: { id: WS_ID, name: 'فروشگاه نیلوفر' },
      settings: { brand_name: 'نیلوفر' },
      entitlements: { features: state.features, maxDomains: 0, ...(state.degraded ? { degraded: true } : {}) },
      smart: { enabled: true, rules: state.rules },
    }),
  };
});
vi.mock('../../../server/services/widget/smartEngagement.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/smartEngagement.js')>();
  return { ...actual, recordSmartEvent: async (_sb: unknown, payload: Row) => { state.smartEvents.push(payload); return { ok: true }; } };
});
vi.mock('../../../server/services/widget/security.js', () => ({
  createSessionToken: () => 'wss_test',
  verifySessionToken: () => ({ valid: true, workspaceId: WS_ID }),
  verifyTokenForRefresh: () => ({ valid: true, workspaceId: WS_ID }),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: () => WS_ID,
  verifyConversationOwnership: async (_config: unknown, conversationId: string, workspaceId: string) => {
    const conv = state.conversations.find((c) => c.id === conversationId && c.workspace_id === workspaceId);
    return conv ? { valid: true, conversation: conv } : { valid: false, conversation: null };
  },
  getClientIp: () => '127.0.0.1',
  getRequestOrigin: () => 'https://example.com',
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  resolveStorageConfig: async () => ({ provider: 'local' }),
  uploadFile: async () => ({ ok: true }),
  downloadFile: async () => null,
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({ enforceMaxConversationsLimit: async () => true }));
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({ ensureVisitorContact: async () => 'contact-1' }));
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

function post(path: string, body: Row): Promise<{ status: number; body: Row }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ workspace_id: WS_ID, ...body });
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: 'POST',
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

const chatRule = (over: Row = {}) => ({
  id: RULE, version: 3,
  presentation_config: { mode: 'chat_message' },
  content_config: {
    default_locale: 'fa',
    locales: {
      fa: { title: '', body: '۱۰٪ تخفیف اولین خرید در {{workspace.name}}؟ همین‌جا جواب بدهید!', cta_label: '' },
      en: { title: 'Welcome', body: '10% off your first order?', cta_label: '' },
    },
  },
  ...over,
});

beforeEach(() => {
  state.conversations = [];
  state.messages = [];
  state.attachments = [];
  state.widgetRow = { enabled: true, chat_enabled: true, attachments_enabled: true, voice_notes_enabled: true, attachments_max_size_mb: 10 };
  state.features = {};
  state.degraded = false;
  state.smartEvents = [];
  state.rules = [chatRule()];
});

describe('S-08: the plan, on the widget\'s write paths', () => {
  const file = { file_name: 'a.png', mime_type: 'image/png', size_bytes: 1000 };
  const voice = { file_name: 'v.webm', mime_type: 'audio/webm', size_bytes: 1000 };

  it('attachments: refused when the plan denies them, though the column says on', async () => {
    state.features = { widget_attachments: false };
    const r = await post('/api/widget/attachments/init', file);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Attachments not enabled for this workspace');
    expect(state.attachments).toHaveLength(0);
  });

  it('voice notes: refused when the plan denies them; files still go', async () => {
    state.features = { widget_voice_notes: false };
    expect((await post('/api/widget/attachments/init', voice)).status).toBe(403);
    const ok = await post('/api/widget/attachments/init', file);
    expect(ok.status).toBe(200);
    expect(ok.body.attachment_id).toBeTruthy();
  });

  it('chat: an upload and a message are refused when the plan has no chat', async () => {
    state.features = { chat: false };
    expect((await post('/api/widget/attachments/init', file)).body.error).toBe('Widget chat not enabled');
    const m = await post('/api/widget/message', { message: 'سلام' });
    expect(m.status).toBe(403);
    expect(state.messages).toHaveLength(0);
  });

  it('an unreadable plan refuses nothing (as before)', async () => {
    state.features = { chat: false, widget_attachments: false };
    state.degraded = true;
    expect((await post('/api/widget/attachments/init', file)).status).toBe(200);
    expect((await post('/api/widget/message', { message: 'سلام' })).status).toBe(200);
  });

  it('the workspace\'s own switch still refuses (unchanged)', async () => {
    state.widgetRow = { ...state.widgetRow, attachments_enabled: false };
    expect((await post('/api/widget/attachments/init', file)).status).toBe(403);
  });
});

describe('V-28: the rule\'s message opens the conversation it starts', () => {
  it('stores the published text before the visitor\'s message, counts the conversation and returns the line', async () => {
    const r = await post('/api/widget/message', { message: 'بله', client_message_id: 'cmid-rule-1', smart_rule: { id: RULE, locale: 'fa' } });
    expect(r.status).toBe(200);
    const thread = state.messages.filter((m) => m.conversation_id === r.body.conversation_id);
    expect(thread.map((m) => m.sender_type)).toEqual(['bot', 'contact']);
    expect(thread[0].body).toBe('۱۰٪ تخفیف اولین خرید در نیلوفر؟ همین‌جا جواب بدهید!');
    expect(thread[0].metadata).toMatchObject({ source: 'smart_rule', smart_rule_id: RULE, smart_rule_version: 3 });
    expect((r.body.opening_message as Row).id).toBe(thread[0].id);
    await vi.waitFor(() => expect(state.smartEvents).toHaveLength(1));
    expect(state.smartEvents[0]).toMatchObject({ ruleId: RULE, ruleVersion: 3, source: 'rule', eventType: 'conversation_started' });
  });

  it('in the locale the visitor saw it, title first', async () => {
    const r = await post('/api/widget/message', { message: 'yes', smart_rule: { id: RULE, locale: 'en' } });
    expect(state.messages.find((m) => m.conversation_id === r.body.conversation_id && m.sender_type === 'bot')!.body)
      .toBe('Welcome\n10% off your first order?');
  });

  it('a retry of that first message, and a later one, never write it again', async () => {
    const first = await post('/api/widget/message', { message: 'بله', client_message_id: 'cmid-rule-2', smart_rule: { id: RULE, locale: 'fa' } });
    await post('/api/widget/message', { message: 'بله', client_message_id: 'cmid-rule-2', smart_rule: { id: RULE, locale: 'fa' } });
    await post('/api/widget/message', { conversation_id: first.body.conversation_id, message: 'کد؟', client_message_id: 'cmid-rule-3', smart_rule: { id: RULE, locale: 'fa' } });
    expect(state.messages.filter((m) => m.sender_type === 'bot')).toHaveLength(1);
  });

  it('only a rule shown inside the chat, and only a published one of this workspace', async () => {
    state.rules = [chatRule({ presentation_config: { mode: 'launcher_nudge' } })];
    const a = await post('/api/widget/message', { message: 'بله', smart_rule: { id: RULE, locale: 'fa' } });
    expect(a.status).toBe(200);
    expect(a.body.opening_message).toBeUndefined();
    state.rules = [];
    const b = await post('/api/widget/message', { message: 'بله', smart_rule: { id: RULE, locale: 'fa' } });
    expect(b.body.opening_message).toBeUndefined();
    expect(state.messages.filter((m) => m.sender_type === 'bot')).toHaveLength(0);
  });

  it('an unusable reference is ignored, never a refused message', async () => {
    const r = await post('/api/widget/message', { message: 'بله', smart_rule: { id: 'not-a-uuid', locale: 'fa' } });
    expect(r.status).toBe(200);
    expect(state.messages.map((m) => m.sender_type)).toEqual(['contact']);
  });
});
