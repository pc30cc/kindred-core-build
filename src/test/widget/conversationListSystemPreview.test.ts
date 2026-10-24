/**
 * GET /api/widget/conversations — a system row previews as its kind, never
 * as the server's English body (owner, 2026-10-18: «پیام شما در صف پشتیبانی
 * قرار گرفت» read right in the thread but in English on t2's home card).
 *
 * The row whose preview is a system row carries `systemKind` / `systemMeta`
 * (shared/systemMessages.ts visitorSystemPreview), from which Core writes
 * the sentence in the visitor's language. `preview` stays the stored body,
 * for a runtime loaded before the deploy. A system row the widget cannot
 * write (an unknown kind) is never the preview: the row before it is. Every
 * other row keeps exactly the keys it had.
 *
 * The REAL widgetRouter runs in-process against the in-memory fake of
 * conversationListPreview.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';
const OP2 = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

interface FakeQuery {
  [method: string]: unknown;
  then: <T>(resolve: (r: { data: Row[]; error: null }) => T) => Promise<T>;
}

/** The fake's query chain. `order` is a no-op: tables hold rows newest first. */
function builder(table: string): FakeQuery {
  const filters: Array<(r: Row) => boolean> = [];
  let max = Infinity;
  const rows = () => (db.tables[table] || []).filter((r) => filters.every((f) => f(r))).slice(0, max);
  const self = () => b;
  const b: FakeQuery = {
    select: self,
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
    in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
    is: self, not: self, or: self, contains: self, order: self, filter: self,
    limit: (n: number) => { max = n; return b; },
    maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
    single: async () => ({ data: rows()[0] || null, error: null }),
    then: (resolve) => Promise.resolve({ data: rows(), error: null as null }).then(resolve),
  };
  return b;
}

type Next = () => void;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-1' }),
}));
vi.mock('../../../server/services/widget/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: Next) => next(),
  resolveWorkspaceId: (_req: unknown, _res: unknown, wsId: string) => wsId || WS,
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({
  resolveKbLock: async () => null,
  applyKbUnlockedFilter: (q: unknown) => q,
}));
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetAttachments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const app = express();
app.use((req, _res, next) => {
  (req as unknown as Record<string, unknown>).serverConfig = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);

type ListRow = Record<string, unknown> & { id: string };

function list(): Promise<ListRow[]> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/widget/conversations?workspace_id=${WS}` }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve((JSON.parse(d) as { conversations: ListRow[] }).conversations));
    }).on('error', reject);
  });
}

const msg = (conversation_id: string, created_at: string, sender_type: string, body: string, metadata: Row = {}) =>
  ({ conversation_id, created_at, sender_type, body, metadata });

beforeEach(() => {
  db.tables = {
    visitor_sessions: [{ id: '99999999-9999-4999-8999-999999999999', workspace_id: WS, visitor_id: 'visitor-1' }],
    contacts: [],
    conversations: [
      { id: 'c1', workspace_id: WS, status: 'open', updated_at: '2026-10-17T10:00:00Z', assigned_to: null, visitor_session_id: '99999999-9999-4999-8999-999999999999' },
    ],
    widget_conversation_reads: [{ workspace_id: WS, visitor_id: 'visitor-1', conversation_id: 'c1', last_read_at: '2026-10-17T09:00:00Z' }],
    conversation_messages: [],
  };
});

describe('GET /api/widget/conversations — a system row previews as its kind', () => {
  it('the queue notice (the owner\'s case) carries routing_in_queue and nothing else; preview stays the stored body', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'Your message is in the support queue.', { kind: 'routing_in_queue' }),
      msg('c1', '2026-10-17T09:29:00Z', 'contact', 'سلام، سفارشم کجاست؟'),
    ];
    const [row] = await list();
    expect(row).toMatchObject({
      preview: 'Your message is in the support queue.',
      systemKind: 'routing_in_queue',
      systemMeta: {},
      outbound: false,
      unreadCount: 1,
      lastMessageAt: '2026-10-17T09:30:00Z',
    });
  });

  it('a transfer names the new holder only: no actor, no previous holder, no ids', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'Ali transferred this conversation to Sara', {
        kind: 'conversation_transferred', internal: false,
        actor_id: OP, actor_name: 'Ali', from_id: OP, from_name: 'Ali', to_id: OP2, to_name: 'Sara',
      }),
    ];
    const [row] = await list();
    expect(row.systemKind).toBe('conversation_transferred');
    expect(row.systemMeta).toEqual({ to_name: 'Sara' });
  });

  it('a join named "a colleague" (a legacy row) carries no name, so the widget writes its generic sentence', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'a colleague joined the conversation.', { kind: 'routing_agent_joined', agent_name: 'a colleague', agent_id: OP }),
    ];
    const [row] = await list();
    expect(row).toMatchObject({ systemKind: 'routing_agent_joined', systemMeta: {} });
  });

  it('an invitation whose operator_name is an email address never sends the address', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'You have been invited to a video call.', {
        kind: 'call_invitation', invitation_id: 'inv-1', channel: 'video', status: 'pending',
        expires_at: '2026-10-17T09:40:00Z', operator_name: 'sara@example.com',
      }),
    ];
    const [row] = await list();
    expect(row).toMatchObject({ systemKind: 'call_invitation', systemMeta: { channel: 'video' } });
    expect(JSON.stringify(row.systemMeta)).not.toContain('@');
  });

  it('a call summary carries what its sentence needs', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'Call ended by operator · 01:15', {
        kind: 'call_ended', call_session_id: 'cs-1', call_type: 'audio', ended_by: 'operator',
        end_reason: 'hangup', duration_seconds: 75, ended_at: '2026-10-17T09:30:00Z',
      }),
    ];
    const [row] = await list();
    expect(row).toMatchObject({
      systemKind: 'call_ended',
      systemMeta: { ended_by: 'operator', end_reason: 'hangup', duration_seconds: 75 },
    });
  });

  it('a system row of a kind the widget cannot write lets the row before it preview; it still counts as unread', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:31:00Z', 'system', 'Something new happened', { kind: 'something_new' }),
      msg('c1', '2026-10-17T09:30:00Z', 'agent', 'سفارشتان ارسال شد.'),
      msg('c1', '2026-10-17T08:50:00Z', 'contact', 'سفارشم کجاست؟'),
    ];
    const [row] = await list();
    expect(row).toMatchObject({ preview: 'سفارشتان ارسال شد.', outbound: false, unreadCount: 2, lastMessageAt: '2026-10-17T09:30:00Z' });
    expect(row).not.toHaveProperty('systemKind');
    expect(row).not.toHaveProperty('systemMeta');
  });

  it('a row whose preview is not a system row keeps exactly today\'s keys', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:31:00Z', 'agent', 'سلام، در خدمتم.'),
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'Your message is in the support queue.', { kind: 'routing_in_queue' }),
    ];
    expect(await list()).toEqual([{
      id: 'c1', status: 'open', updatedAt: '2026-10-17T10:00:00Z', preview: 'سلام، در خدمتم.',
      attachmentKind: null, outbound: false, unreadCount: 2, lastMessageAt: '2026-10-17T09:31:00Z',
      // One current conversation per visitor (conversationListOneConversation.test.ts).
      endedAt: null, unreadReplies: 1, hasVisitorMessage: false,
    }]);
  });
});
