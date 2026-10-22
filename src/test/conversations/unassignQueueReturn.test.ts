// @vitest-environment node
/**
 * The inbox hands a conversation back (PATCH /api/conversations/:id with
 * `assigned_to: null`): routing runs again at once, in every mode (R-20),
 * and the visitor hears what happens next.
 *
 *   manual (issue #340 g4 f2): 276's trigger stamps the return on that
 *     UPDATE, and the visitor's new `routing_in_queue` row (their queue
 *     pill) arrives now instead of with their next message — one queue row,
 *     after the inbox's own (internal) unassigned notice, and the only row
 *     the visitor's channel receives; the place (`queued_at`) is kept and the
 *     return is marked announced (open or pending alike). The visitor's next
 *     message routes again and posts nothing more; a second hand-back is
 *     announced again. A conversation that never waited in the queue (taken
 *     by hand, or before 276) joins it, and the visitor is told so.
 *   auto / round robin: the next operator gets it — never the one who let it
 *     go — and the visitor reads who joined.
 *   nothing: one the AI has again (it answers the next message; a handoff
 *     routes it), one marked as spam, one closed in the same PATCH, a
 *     transfer to a colleague. Two unassigns at once (a double click): the
 *     second is refused (409), so the return is announced once.
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
  /** Each routing the PATCH ran after an unassign, with its result. */
  routed: [] as unknown[],
  /** user id → routing presence state. */
  presence: new Map<string, string>(),
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
vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.filter((id) => state.presence.has(id)).map((id) => [id, { state: state.presence.get(id)!, lastActivityAt: Date.now() - 60_000 }])),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: false, kb: null, contact: null, member: null, conversation: null }),
}));
// The real routing; the PATCH's routing run is recorded so a test knows it finished.
// The plan allows automatic assignment (a plan without it routes as manual).
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/entitlements.js')>()),
  resolveWidgetCapability: async () => true,
}));
vi.mock('../../../server/services/chatRouting.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/chatRouting.js')>();
  return {
    ...real,
    rerouteConversation: async (...args: Parameters<typeof real.rerouteConversation>) => {
      const result = await real.rerouteConversation(...args);
      state.routed.push(result);
      return result;
    },
  };
});

const { conversationsRouter } = await import('../../../server/routes/conversations.js');
const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
const { invalidateDepartmentCache } = await import('../../../server/services/calls/departments.js');

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
// An hour ago, a second per stamp: a queue entry stays recent (queueEntryStamp's 24 h window runs on the real clock).
let clock = Date.now() - 60 * 60 * 1000;
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
/**
 * The PATCH's background work is done: an unassign's last step is its
 * routing (after the inbox's notice), a transfer's the notice reaching the
 * visitor. Waits for that, never for a fixed time.
 */
async function settled(cid: string, routed: number) {
  await until(() => (routed
    ? state.routed.length >= routed && kinds(cid).includes('conversation_unassigned')
    : visitorRows(cid).includes('conversation_transferred')));
}

let triggerInstalled = true;
let skipped: Record<string, string[]> = {};
beforeEach(() => {
  skipped = {};
  state.db = createFakeServiceDb();
  state.db.now = tick;
  state.userId = SARA;
  state.published.length = 0;
  state.routed.length = 0;
  triggerInstalled = true;
  QUEUED_AT = tick();
  state.presence.clear();
  invalidateDepartmentCache(WS);
  state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'manual', round_robin_cursor_user_id: null }];
  state.db.tables.profiles = [{ id: SARA, full_name: 'سارا' }, { id: ALI, full_name: 'علی' }];
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: SARA, role: 'agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: ALI, role: 'agent', suspended_at: null, receives_chats: true },
  ];
  // patch_conversation_metadata (057) merges routing's keys; is_workspace_member for a transfer.
  state.db.rpc = (fn, args) => {
    if (fn === 'patch_conversation_metadata') {
      const row = conv(String(args.p_conversation_id));
      row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
      return { data: true, error: null };
    }
    if (fn === 'chat_routing_skip') {
      (skipped[String(args.p_conversation_id)] ||= []).push(String(args.p_user_id));
      return { data: null, error: null };
    }
    // chat_route_claim's stand-in: the first candidate not skipped for this chat.
    if (fn === 'chat_route_claim') {
      const pick = (args.p_candidates as string[]).find((id) => !(skipped[String(args.p_conversation_id)] || []).includes(id)) ?? null;
      if (!pick) return { data: [{ outcome: 'none', picked_user_id: null }], error: null };
      conv(String(args.p_conversation_id)).assigned_to = pick;
      return { data: [{ outcome: 'assigned', picked_user_id: pick }], error: null };
    }
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

  it('a pending conversation waits again too', async () => {
    const cid = queuedConversation({}, { status: 'pending' });
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([{ outcome: 'manual_queue', assignedTo: null }]);
    expect(visitorRows(cid)).toEqual(['routing_in_queue']);
  });

  it('two unassigns at once (a double click): only one lands — the other finds it done, or is refused — and the return is announced once', async () => {
    const cid = queuedConversation();
    const both = await Promise.all([patch(cid, { assigned_to: null }), patch(cid, { assigned_to: null })]);
    for (const r of both) {
      if (r.status === 409) expect(r.body).toEqual({ error: 'assignment_changed', assigned_to: null });
      else expect(r.status).toBe(200);
    }
    await settled(cid, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(state.routed).toHaveLength(1);
    expect(queueRows(cid)).toBe(2);
    expect(visitorRows(cid)).toEqual(['routing_in_queue']);
  });

  it('claimed again and handed back again: announced again, once', async () => {
    const cid = queuedConversation();
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    // Ali takes it (only a supervisor may give it to someone else).
    state.userId = ALI;
    expect((await patch(cid, { assigned_to: ALI })).status).toBe(200);
    await until(() => visitorRows(cid).includes('routing_agent_joined'));
    await patch(cid, { assigned_to: null });
    await settled(cid, 2);
    expect(queueRows(cid)).toBe(3);
    expect(visitorRows(cid)).toEqual(['routing_in_queue', 'routing_agent_joined', 'routing_in_queue']);
  });
});

describe('routed again in every mode (R-20)', () => {
  it('auto: the next operator gets it, never the one who let it go; the visitor reads who joined', async () => {
    state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'auto', round_robin_cursor_user_id: null }];
    state.presence.set(SARA, 'active');
    state.presence.set(ALI, 'active');
    const cid = queuedConversation({ routing_outcome: 'assigned_auto', queued_at: undefined });
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([{ outcome: 'assigned_auto', assignedTo: ALI }]);
    expect(skipped[cid]).toEqual([SARA]);
    expect(conv(cid)).toMatchObject({ assigned_to: ALI });
    expect(visitorRows(cid)).toEqual(['routing_agent_joined']);
  });

  it('manual, a conversation that never waited in the queue (taken by hand): it joins the queue, and the visitor is told', async () => {
    const cid = queuedConversation({ routing_outcome: 'assigned_auto', queued_at: undefined });
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([{ outcome: 'manual_queue', assignedTo: null }]);
    expect((conv(cid).metadata as Row).routing_outcome).toBe('manual_queue');
    expect(typeof (conv(cid).metadata as Row).queued_at).toBe('string');
    expect(visitorRows(cid)).toEqual(['routing_in_queue']);
  });

  it('manual, a database before 276 (no trigger, no return stamp): the queue, and the visitor is told once', async () => {
    triggerInstalled = false;
    const cid = queuedConversation();
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([{ outcome: 'manual_queue', assignedTo: null }]);
    expect(queueRows(cid)).toBe(2);
    expect(visitorRows(cid)).toEqual(['routing_in_queue']);
  });
});

describe('nothing is routed', () => {
  it('the AI has the conversation again (it answers the next message; a handoff routes it then)', async () => {
    const cid = queuedConversation({ ai_state: 'ai_managed' });
    await patch(cid, { assigned_to: null });
    await settled(cid, 1);
    expect(state.routed).toEqual([null]);
    expect(queueRows(cid)).toBe(1);
    expect(visitorRows(cid)).toEqual([]);
    expect((conv(cid).metadata as Row).queue_return_notice_at).toBeUndefined();
  });

  it('a conversation marked as spam', async () => {
    const cid = queuedConversation({}, { is_spam: true });
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

  it('a transfer to a colleague routes nothing', async () => {
    const cid = queuedConversation();
    await patch(cid, { assigned_to: ALI });
    await settled(cid, 0);
    expect(state.routed).toEqual([]);
    expect(queueRows(cid)).toBe(1);
    expect(visitorRows(cid)).toEqual(['conversation_transferred']);
  });
});
