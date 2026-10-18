// @vitest-environment node
/**
 * The inbox's unassign of a queued conversation (PATCH /api/conversations/:id
 * with `assigned_to: null`, issue #340 g4 f2): 276's trigger stamps the
 * return on that UPDATE, and the PATCH runs routing at once, so the visitor's
 * new `routing_in_queue` row (their queue pill) arrives now instead of with
 * their next message:
 *
 *   - one queue row, after the inbox's own (internal) unassigned notice, and
 *     the only row the visitor's channel receives; the place (`queued_at`) is
 *     kept and the return is marked announced;
 *   - the visitor's next message routes again and posts nothing more; a
 *     second hand-back is announced again;
 *   - nothing is routed for a conversation that is not waiting in a manual
 *     queue: a workspace now in another mode, a conversation auto-routing
 *     gave out, one closed in the same PATCH, a transfer to a colleague, or a
 *     database without 276's trigger (no return stamp).
 *
 * The PATCH route and routing run for real against an in-memory data layer;
 * the trigger is its stand-in (`beforeUpdate`, the WHEN clause of
 * trg_conversations_queue_return), pinned on a real database in
 * src/test/integration/reactionsQueueAway276.pg.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  userId: '',
  /** What the visitor's conversation channel received, in order. */
  published: [] as Array<{ cid: string; envelope: { type: string; payload: Record<string, unknown> } }>,
  /** Each queue-return routing the PATCH ran, with its result. */
  routed: [] as unknown[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async (_c: unknown, _ws: string, cid: string, envelope: { type: string; payload: Record<string, unknown> }) => {
    state.published.push({ cid, envelope });
    return { ok: true };
  },
  publishOperatorEvent: async () => undefined,
  buildMessageEnvelope: (m: Record<string, unknown>) => ({ type: 'message', payload: m }),
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: state.userId, isAdmin: false, role: 'agent' }),
  isSeatLocked: async () => false,
}));
vi.mock('../../../server/services/contactChatLocks.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/contactChatLocks.js')>()),
  conversationLockedNow: async () => ({ locked: false, state: null }),
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyAssignment: async () => undefined,
  notifyHandoff: async () => undefined,
}));
vi.mock('../../../server/services/notificationEmail/producers.js', () => ({ queueTranscript: async () => undefined }));
vi.mock('../../../server/services/platformSupport/service.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/platformSupport/service.js')>()),
  onSupportConversationChanged: async () => undefined,
}));
vi.mock('../../../server/services/platformSupport/changes.js', () => ({ onSupportConversationChanged: async () => undefined }));
// The real routing; the PATCH's queue-return run is recorded so a test knows it finished.
vi.mock('../../../server/services/chatRouting.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/chatRouting.js')>();
  return {
    ...real,
    routeQueueReturn: async (...args: Parameters<typeof real.routeQueueReturn>) => {
      const result = await real.routeQueueReturn(...args);
      state.routed.push(result);
      return result;
    },
  };
});

const { conversationsRouter } = await import('../../../server/routes/conversations.js');
const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');

const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
app.use(express.json());
app.use('/api/conversations', conversationsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

const WS = randomUUID();
const SARA = randomUUID();
const ALI = randomUUID();
let clock = Date.parse('2026-10-18T09:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();
let QUEUED_AT = '';

function patch(cid: string, body: Row): Promise<{ status: number; body: Row }> {
  const payload = JSON.stringify({ workspace_id: WS, ...body });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/conversations/${cid}`, method: 'PATCH',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function until(cond: () => unknown, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A queued widget conversation (routed into the manual queue, announced), now held by Sara. */
function queuedConversation(meta: Row = {}, fields: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'open', assigned_to: SARA, is_spam: false, tags: [], created_at: tick(), updated_at: tick(),
    metadata: { visitor_id: 'visitor-1', ai_state: 'needs_human', routing_outcome: 'manual_queue', routing_notice_sent: true, queued_at: QUEUED_AT, queue_entry_position: 2, ...meta },
    ...fields,
  });
  (state.db.tables.conversation_messages ||= []).push(
    { id: randomUUID(), conversation_id: id, sender_type: 'contact', body: 'سلام', metadata: {}, created_at: tick() },
    { id: randomUUID(), conversation_id: id, sender_type: 'system', body: 'Your message is in the support queue.', metadata: { kind: 'routing_in_queue' }, created_at: tick() },
  );
  return id;
}
const conv = (cid: string) => state.db.tables.conversations!.find((c) => c.id === cid)!;
const kinds = (cid: string) => (state.db.tables.conversation_messages || [])
  .filter((m) => m.conversation_id === cid).map((m) => (m.metadata as Row | null)?.kind ?? m.sender_type);
const queueRows = (cid: string) => kinds(cid).filter((k) => k === 'routing_in_queue').length;
const visitorRows = (cid: string) => state.published.filter((p) => p.cid === cid && p.envelope.type === 'message')
  .map((p) => (p.envelope.payload.metadata as Row | null)?.kind);
/** The PATCH's background work is done: its notice row is in, and (for an unassign) its routing ran. */
async function settled(cid: string, routed: number) {
  await until(() => kinds(cid).some((k) => k === 'conversation_unassigned' || k === 'conversation_transferred') && state.routed.length >= routed);
  await new Promise((r) => setTimeout(r, 10));
}

let triggerInstalled = true;
beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.now = tick;
  state.userId = SARA;
  state.published.length = 0;
  state.routed.length = 0;
  triggerInstalled = true;
  QUEUED_AT = tick();
  state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'manual', round_robin_cursor_user_id: null }];
  state.db.tables.profiles = [{ id: SARA, full_name: 'سارا' }, { id: ALI, full_name: 'علی' }];
  // patch_conversation_metadata (057) merges routing's keys; is_workspace_member for a transfer.
  state.db.rpc = (fn, args) => {
    if (fn === 'patch_conversation_metadata') {
      const row = conv(String(args.p_conversation_id));
      row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
      return { data: true, error: null };
    }
    if (fn === 'is_workspace_member') return { data: true, error: null };
    return { data: null, error: null };
  };
  // trg_conversations_queue_return (276): a hand-back of a queued conversation stamps its return.
  state.db.beforeUpdate = (table, row, p) => {
    const meta = (row.metadata || {}) as Row;
    if (!triggerInstalled || table !== 'conversations' || !('assigned_to' in p)) return;
    if (!(row.assigned_to && p.assigned_to === null)) return;
    if (!['open', 'pending'].includes(String(p.status ?? row.status)) || row.is_spam) return;
    if (!meta.queued_at || meta.routing_outcome !== 'manual_queue') return;
    return { ...p, metadata: { ...meta, queue_reentered_at: tick(), queue_entry_position: 1 } };
  };
});

describe('the inbox hands a queued conversation back', () => {
  it('the visitor is told at once: one queue row after the internal notice, the only row on their channel', async () => {
    const cid = queuedConversation();
    const res = await patch(cid, { assigned_to: null });
    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ assigned_to: null });
    await settled(cid, 1);

    expect(state.routed).toEqual([{ outcome: 'manual_queue', assignedTo: null }]);
    expect(kinds(cid)).toEqual(['contact', 'routing_in_queue', 'conversation_unassigned', 'routing_in_queue']);
    expect(visitorRows(cid)).toEqual(['routing_in_queue']);
    const meta = conv(cid).metadata as Row;
    expect(meta).toMatchObject({ queued_at: QUEUED_AT, queue_entry_position: 1, routing_outcome: 'manual_queue' });
    expect(meta.queue_return_notice_at).toBe(meta.queue_reentered_at);

    // The visitor's next message routes again: nothing more.
    expect((await routeConversationToOperator(config, { workspaceId: WS, conversationId: cid })).outcome).toBe('manual_queue');
    expect(queueRows(cid)).toBe(2);
    expect(visitorRows(cid)).toEqual(['routing_in_queue']);
  });

  it('claimed again and handed back again: announced again, once', async () => {
    const cid = queuedConversation();
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    await patch(cid, { assigned_to: ALI });
    await until(() => kinds(cid).includes('routing_agent_joined'));
    state.userId = ALI;
    await patch(cid, { assigned_to: null });
    await until(() => state.routed.length === 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(queueRows(cid)).toBe(3);
    expect(visitorRows(cid)).toEqual(['routing_in_queue', 'routing_agent_joined', 'routing_in_queue']);
  });
});

describe('nothing is routed for a conversation that is not waiting in a manual queue', () => {
  it('the workspace switched to another mode meanwhile', async () => {
    state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'auto', round_robin_cursor_user_id: null }];
    const cid = queuedConversation();
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([null]);
    expect(queueRows(cid)).toBe(1);
    expect(conv(cid)).toMatchObject({ assigned_to: null });
    expect((conv(cid).metadata as Row).queue_return_notice_at).toBeUndefined();
  });

  it('a conversation auto-routing gave out (no return stamp)', async () => {
    const cid = queuedConversation({ routing_outcome: 'assigned_auto', queued_at: undefined });
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([null]);
    expect(queueRows(cid)).toBe(1);
    expect(visitorRows(cid)).toEqual([]);
  });

  it('closed in the same PATCH', async () => {
    const cid = queuedConversation();
    await patch(cid, { assigned_to: null, status: 'closed' });
    await settled(cid, 1);
    expect(state.routed).toEqual([null]);
    expect(queueRows(cid)).toBe(1);
  });

  it('a database before 276 (no trigger, no return stamp)', async () => {
    triggerInstalled = false;
    const cid = queuedConversation();
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([null]);
    expect(queueRows(cid)).toBe(1);
    expect(visitorRows(cid)).toEqual([]);
  });

  it('a transfer to a colleague routes nothing', async () => {
    const cid = queuedConversation();
    await patch(cid, { assigned_to: ALI });
    await settled(cid, 0);
    expect(state.routed).toEqual([]);
    expect(queueRows(cid)).toBe(1);
    expect(visitorRows(cid)).toEqual(['conversation_transferred']);
  });
});
