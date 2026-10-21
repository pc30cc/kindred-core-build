// @vitest-environment node
/**
 * A resolved or closed thread is over, and the next one starts afresh (R-17):
 *
 *   - resolving (Send & resolve here; the PATCH in the pg suite) clears the
 *     AI's hold — a person's takeover, a waiting handoff — stamps the thread's
 *     end for routing, and forgets routing's skip list;
 *   - the AI then counts a person's replies, and its own, only from that
 *     stamp, so in "auto-reply until a human joins" it may answer the visitor
 *     who comes back (it stayed silent for good once a person had replied);
 *   - a thread resolved before this release is reset when the visitor's
 *     message reopens it (before the AI reads that message); one reset at
 *     its resolve is not touched again.
 *
 * The services run for real against an in-memory data layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

const state = vi.hoisted(() => ({ db: null as unknown as FakeServiceDb }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => undefined,
  publishConversationEvent: async () => ({ ok: true }),
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/conversationClosedNotice.js', () => ({ recordConversationClosed: async () => undefined }));

const { applyPostSendAction } = await import('../../../server/services/conversationPostSend.js');
const { reopenConversationIfResolved } = await import('../../../server/services/conversationLifecycle.js');
const { getConversationState } = await import('../../../server/services/ai-agent/conversationState.js');
const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');

const config = {} as never;
const WS = 'ws-1';
const conv = (id: string) => state.db.tables.conversations!.find((c) => c.id === id)!;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.rpc = (fn, args) => {
    if (fn === 'patch_conversation_metadata') {
      const row = conv(String(args.p_conversation_id));
      row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
      return { data: true, error: null };
    }
    if (fn === 'conversation_apply_post_send_action') {
      const row = conv(String(args.p_conversation_id));
      row.status = args.p_target_status;
      return { data: [{ changed: true, new_status: args.p_target_status, changed_at: at(0) }], error: null };
    }
    return { data: null, error: null };
  };
  state.db.tables.conversations = [{
    id: 'c-1', workspace_id: WS, status: 'open', assigned_to: 'u-ali',
    metadata: { ai_state: 'human_active', human_takeover_at: at(30), human_takeover_by: 'u-ali', ai_handoff_requested: true, visitor_id: 'v-1' },
  }];
  state.db.tables.conversation_messages = [
    { id: 'm1', conversation_id: 'c-1', sender_type: 'contact', body: 'سلام', created_at: at(40) },
    { id: 'm2', conversation_id: 'c-1', sender_type: 'ai', body: 'سلام!', created_at: at(39), metadata: { source: 'ai_agent' } },
    { id: 'm3', conversation_id: 'c-1', sender_type: 'agent', sender_id: 'u-ali', body: 'در خدمتم', created_at: at(30), metadata: { source: 'inbox' } },
  ];
});

const settings = {
  enabled: true, mode: 'auto_reply_until_human_joins', handoff_on_human_request: false, handoff_keywords: [],
  max_replies_per_conversation: 3, max_replies_per_hour: 0,
} as never;
const availability = { state: 'online', reason: 'test', source: 'widget_resolver', schedule: null } as never;

describe('Send & resolve ends the thread', () => {
  it('clears the AI\'s hold, stamps the end and forgets the skip list; the AI may answer the visitor\'s next thread', async () => {
    const before = await getConversationState(config, WS, 'c-1');
    expect(decideRuntime({ settings, state: before, availability, visitorText: 'یک سؤال دیگر' }).action).not.toBe('auto_reply');

    const res = await applyPostSendAction(config, { action: 'resolve', workspaceId: WS, conversationId: 'c-1', actorId: 'u-ali', messageId: 'm3' });
    expect(res).toMatchObject({ changed: true, status: 'resolved' });
    const meta = conv('c-1').metadata as Row;
    expect(meta).toMatchObject({ ai_state: null, managed_by_ai: false, human_takeover_at: null, ai_handoff_requested: false, visitor_id: 'v-1' });
    expect(typeof meta.ai_thread_reset_at).toBe('string');
    expect(meta.routing_thread_ended_at).toBe(meta.ai_thread_reset_at);
    expect(state.db.rpcs.find((r) => r.fn === 'chat_routing_skip')?.args).toEqual({ p_workspace_id: WS, p_conversation_id: 'c-1', p_user_id: null });

    // The visitor comes back: a new thread, nobody has replied in it yet.
    conv('c-1').status = 'open';
    state.db.tables.conversation_messages!.push({ id: 'm4', conversation_id: 'c-1', sender_type: 'contact', body: 'یک سؤال دیگر', created_at: new Date(Date.now() + 1000).toISOString() });
    const after = await getConversationState(config, WS, 'c-1');
    expect(after).toMatchObject({ hasHumanAgentReplied: false, aiRepliesCountInConversation: 0, humanTakeoverAt: null });
    expect(decideRuntime({ settings, state: after, availability, visitorText: 'یک سؤال دیگر' }).action).toBe('auto_reply');
  });
});

describe('a thread resolved before this release, reopened by the visitor', () => {
  it('is reset as it reopens; one already reset at its resolve is left as it is', async () => {
    conv('c-1').status = 'resolved';
    const res = await reopenConversationIfResolved(config, {
      workspaceId: WS, conversationId: 'c-1', source: 'widget', messageId: 'm4',
      message: { senderType: 'contact', direction: 'inbound', text: 'یک سؤال دیگر', attachmentCount: 0 },
    });
    expect(res.reopened).toBe(true);
    const meta = conv('c-1').metadata as Row;
    expect(meta).toMatchObject({ ai_state: null, human_takeover_at: null });
    expect(typeof meta.ai_thread_reset_at).toBe('string');
    // Routing hears of the reopen from the lifecycle itself, not from a stamp.
    expect(meta.routing_thread_ended_at).toBeUndefined();

    const patches = () => state.db.rpcs.filter((r) => r.fn === 'patch_conversation_metadata').length;
    const count = patches();
    conv('c-1').status = 'resolved';
    await reopenConversationIfResolved(config, {
      workspaceId: WS, conversationId: 'c-1', source: 'widget', messageId: 'm5',
      message: { senderType: 'contact', direction: 'inbound', text: 'باز هم من', attachmentCount: 0 },
    });
    expect(patches()).toBe(count);
  });
});
