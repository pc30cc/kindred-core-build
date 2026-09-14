/**
 * Focused behavioral regression coverage for a P1 visitor-visibility bug:
 * GET /api/widget/identity/history returned internal staffing/system
 * messages directly inside `messages[]`, because unlike /poll and /history
 * (which filter via enrichMessagesWithSender) it never applied the
 * canonical visitor-visibility filter at all — and, separately, that a
 * hidden/foreign/missing reply-to parent's raw id could still leak through
 * `reply_to_message_id` even once its body preview was already null.
 *
 * Mounts the REAL widgetIdentityRouter (not mocked out, unlike
 * messageSendBehavioral.test.ts's app, which only needs widgetRouter) with
 * its visitor-cookie/conversation-continuation lookups mocked and a
 * minimal fake Supabase for conversation_messages — filterVisitorVisibleMessages,
 * enrichMessagesWithAttachments and enrichMessagesWithReplyTo all run for
 * real, exactly as widget.ts's own routes exercise them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS_ID = '22222222-2222-4222-8222-222222222222';
const CONV_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CONV_ID = '44444444-4444-4444-8444-444444444444';

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
let messages: FakeMessage[] = [];
let seq = 0;

function seedMessage(
  body: string,
  senderType: string,
  opts: { metadata?: Record<string, any>; replyTo?: string | null; conversationId?: string } = {},
): string {
  seq += 1;
  const id = crypto.randomUUID();
  messages.push({
    id,
    conversation_id: opts.conversationId || CONV_ID,
    sender_type: senderType,
    body,
    metadata: opts.metadata || {},
    reply_to_message_id: opts.replyTo || null,
    // Strictly increasing so /identity/history's ascending order is stable.
    created_at: new Date(Date.now() + seq * 1000).toISOString(),
    seen_at: null,
  });
  return id;
}

function makeFakeSupabase() {
  function conversationMessagesBuilder() {
    let filters: Array<(m: FakeMessage) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        filters.push((m: any) => m[col] === val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filters.push((m: any) => vals.includes(m[col]));
        return b;
      },
      order: () => b,
      limit: () => b,
      then: (resolve: any) =>
        Promise.resolve({ data: messages.filter((m) => filters.every((f) => f(m))), error: null }).then(resolve),
    };
    return b;
  }
  function genericBuilder() {
    const b: any = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      not: () => b,
      in: () => b,
      contains: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return b;
  }
  return {
    from(table: string) {
      return table === 'conversation_messages' ? conversationMessagesBuilder() : genericBuilder();
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => makeFakeSupabase(),
}));

vi.mock('../../../server/services/widget/security.js', () => ({
  enforceWidgetToken: (_req: any, _res: any, next: any) => next(),
  enforceOrigin: (_req: any, _res: any, next: any) => next(),
  widgetRateLimit: () => (_req: any, _res: any, next: any) => next(),
  resolveWorkspaceId: (_req: any, _res: any, bodyWsId: string) => bodyWsId || WS_ID,
  getClientIp: () => '127.0.0.1',
}));

// Bypass real cookie decoding — this suite is about message visibility,
// not cookie parsing, and every /identity/history route requires a valid
// visitor cookie before it does anything else.
vi.mock('../../../server/services/widget/visitorIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/visitorIdentity.js')>();
  return {
    ...actual,
    readVisitorCookie: () => ({ v: 'visitor-1', w: WS_ID, exp: Math.floor(Date.now() / 1000) + 3600 }),
  };
});

// Always resolve to the seeded conversation — the smart-continuation
// matching logic (contact/session/window lookups) is unrelated to this bug.
vi.mock('../../../server/services/widget/identityMerge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/identityMerge.js')>();
  return {
    ...actual,
    findContinuableConversation: async () => ({ id: CONV_ID, updatedAt: new Date().toISOString() }),
  };
});

const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');

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
app.use('/api/widget/identity', widgetIdentityRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

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
  messages = [];
  seq = 0;
});

describe('GET /api/widget/identity/history — visitor visibility (P1 regression)', () => {
  it('excludes an internal staffing/system message entirely, while returning the normal visitor and agent messages', async () => {
    seedMessage('hello there', 'contact');
    const internalId = seedMessage('X transferred this conversation to Y', 'system', { metadata: { internal: true } });
    seedMessage('how can I help', 'agent');

    const res = await get(`/api/widget/identity/history?workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages.map((m: any) => m.text)).toEqual(['hello there', 'how can I help']);
    // Not just absent from the list — absent from the serialized payload
    // entirely, so there's no other field it could have leaked through.
    expect(JSON.stringify(res.body)).not.toContain('transferred this conversation');
    expect(JSON.stringify(res.body)).not.toContain(internalId);
  });

  it('a visible, same-conversation reply parent still returns BOTH the id and the preview', async () => {
    const parentId = seedMessage('original question', 'contact');
    seedMessage('here is my reply', 'contact', { replyTo: parentId });

    const res = await get(`/api/widget/identity/history?workspace_id=${WS_ID}`);
    const child = res.body.messages.find((m: any) => m.text === 'here is my reply');
    expect(child.reply_to_message_id).toBe(parentId);
    expect(child.reply_to).toEqual({ id: parentId, text: 'original question', sender_type: 'contact' });
  });

  it('a hidden (internal) reply parent returns null for BOTH reply_to_message_id and reply_to — never just the preview', async () => {
    const internalId = seedMessage('internal staffing note', 'system', { metadata: { internal: true } });
    seedMessage('quoting staff note', 'contact', { replyTo: internalId });

    const res = await get(`/api/widget/identity/history?workspace_id=${WS_ID}`);
    const child = res.body.messages.find((m: any) => m.text === 'quoting staff note');
    expect(child.reply_to_message_id).toBeNull();
    expect(child.reply_to).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('internal staffing note');
    expect(JSON.stringify(res.body)).not.toContain(internalId);
  });

  it('a foreign-conversation reply parent returns null for BOTH fields, indistinguishable from missing', async () => {
    const foreignId = seedMessage('secret in another conversation', 'contact', { conversationId: OTHER_CONV_ID });
    seedMessage('trying to quote across conversations', 'contact', { replyTo: foreignId });
    const missingChildId = seedMessage('quoting a message that will never exist', 'contact', {
      replyTo: crypto.randomUUID(),
    });

    const res = await get(`/api/widget/identity/history?workspace_id=${WS_ID}`);
    const foreignChild = res.body.messages.find((m: any) => m.text === 'trying to quote across conversations');
    const missingChild = res.body.messages.find((m: any) => m.id === missingChildId);
    for (const child of [foreignChild, missingChild]) {
      expect(child.reply_to_message_id).toBeNull();
      expect(child.reply_to).toBeNull();
    }
    expect(JSON.stringify(res.body)).not.toContain('secret in another conversation');
    expect(JSON.stringify(res.body)).not.toContain(foreignId);
  });
});
