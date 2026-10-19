/**
 * GET /api/widget/conversations — the visitor's list previews and counts only
 * what the visitor can see (contract §6b).
 *
 * The list used to take its preview and unread count from every row of the
 * thread, internal ones included: when an operator unassigned a conversation,
 * the inbox-only notice "Ali unassigned this conversation" (English, written
 * for the inbox) became the visitor's preview and added one unread. The
 * `conversation_closed` line (drawn by templates that show it, in the thread)
 * is skipped the same way. Everything else about the answer stays as it was
 * (apart from a system row's systemKind/systemMeta,
 * conversationListSystemPreview.test.ts), which the last test pins for
 * `default` (no operator=1).
 *
 * The REAL widgetRouter runs in-process against an in-memory fake of the
 * data layer (as widgetOperatorFields.test.ts does).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';

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
    visitor_sessions: [{ id: 'sess-1', workspace_id: WS, visitor_id: 'visitor-1' }],
    contacts: [],
    conversations: [
      { id: 'c1', workspace_id: WS, status: 'open', updated_at: '2026-10-17T10:00:00Z', assigned_to: null, visitor_session_id: 'sess-1' },
    ],
    widget_conversation_reads: [{ workspace_id: WS, visitor_id: 'visitor-1', conversation_id: 'c1', last_read_at: '2026-10-17T09:00:00Z' }],
    conversation_messages: [],
  };
});

describe('GET /api/widget/conversations — preview and unread', () => {
  it('an internal "X unassigned this conversation" row neither previews the thread nor counts as unread', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'Ali unassigned this conversation', { kind: 'conversation_unassigned', internal: true, actor_id: OP }),
      msg('c1', '2026-10-17T09:20:00Z', 'agent', 'سفارشتان ارسال شد.'),
      msg('c1', '2026-10-17T08:50:00Z', 'contact', 'سفارشم کجاست؟'),
    ];
    const [row] = await list();
    expect(row).toMatchObject({ preview: 'سفارشتان ارسال شد.', outbound: false, unreadCount: 1, lastMessageAt: '2026-10-17T09:20:00Z' });
  });

  it('the conversation_closed line is skipped the same way', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:40:00Z', 'system', 'Sara closed the conversation', { kind: 'conversation_closed', by: 'agent', agent_name: 'Sara' }),
      msg('c1', '2026-10-17T09:35:00Z', 'system', 'Ali unassigned this conversation', { kind: 'conversation_unassigned', internal: true }),
      msg('c1', '2026-10-17T08:50:00Z', 'contact', 'ممنون'),
    ];
    const [row] = await list();
    expect(row).toMatchObject({ preview: 'ممنون', outbound: true, unreadCount: 0, lastMessageAt: '2026-10-17T08:50:00Z' });
  });

  it('a thread with nothing the visitor can see previews nothing', async () => {
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:30:00Z', 'system', 'Ali unassigned this conversation', { kind: 'conversation_unassigned', internal: true }),
    ];
    const [row] = await list();
    expect(row).toMatchObject({ preview: '', outbound: false, unreadCount: 0, lastMessageAt: '2026-10-17T10:00:00Z' });
  });

  it('pins default\'s answer otherwise: visible system rows (a join) still preview and count, the shape is unchanged', async () => {
    db.tables.conversations.push(
      { id: 'c2', workspace_id: WS, status: 'resolved', updated_at: '2026-10-16T10:00:00Z', assigned_to: OP, visitor_session_id: 'sess-1' },
    );
    db.tables.conversation_messages = [
      msg('c1', '2026-10-17T09:31:00Z', 'system', 'Sara joined the conversation.', { kind: 'routing_agent_joined', agent_id: OP, agent_name: 'Sara' }),
      msg('c1', '2026-10-17T09:30:00Z', 'ai', 'یک لحظه، همکارم پاسخ می‌دهد.'),
      msg('c1', '2026-10-17T08:50:00Z', 'contact', 'سلام'),
      msg('c2', '2026-10-16T09:00:00Z', 'agent', 'x'.repeat(130)),
    ];
    expect(await list()).toEqual([
      {
        id: 'c1', status: 'open', updatedAt: '2026-10-17T10:00:00Z', preview: 'Sara joined the conversation.',
        attachmentKind: null, outbound: false, unreadCount: 2, lastMessageAt: '2026-10-17T09:31:00Z',
        // A system row also says which it is, so the widget writes it in the
        // visitor's language (conversationListSystemPreview.test.ts).
        systemKind: 'routing_agent_joined', systemMeta: { agent_name: 'Sara' },
      },
      {
        id: 'c2', status: 'resolved', updatedAt: '2026-10-16T10:00:00Z', preview: `${'x'.repeat(119)}…`,
        attachmentKind: null, outbound: false, unreadCount: 1, lastMessageAt: '2026-10-16T09:00:00Z',
      },
    ]);
  });
});
