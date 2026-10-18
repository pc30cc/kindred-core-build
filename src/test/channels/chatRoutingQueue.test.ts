/**
 * The queue's entry (issue #340 g4 f2): when routing (assignment mode
 * `manual`) puts a conversation in the team's queue it saves
 * `metadata.queued_at` — once: kept while the conversation waits and routing
 * runs again on each visitor message, and when an operator hands it back; a
 * stamp older than 24 hours is a new entry — and the place it entered at
 * (`queue_entry_position`, from chat_queue_status, which 276's claim sampler
 * divides the wait by). Both are saved before the visitor's queue row is
 * published, so the widget's first GET /queue finds them. Before 276 the
 * position is simply not written.
 *
 * And readQueueStatus, GET /api/widget/queue's answer: two integers, or nulls
 * without a query when the conversation is plainly not waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown>;
let assignedTo: string | null;
const log: string[] = [];
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let queueStatus: { data: unknown; error: unknown } = { data: [{ queue_position: 3, wait_minutes: null }], error: null };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'patch_conversation_metadata') {
        log.push(`patch:${Object.keys(args.p_patch as object).sort().join(',')}`);
        stored = { ...stored, ...(args.p_patch as object) };
        return { data: true, error: null };
      }
      if (name === 'chat_queue_status') {
        log.push('queue_status');
        return queueStatus;
      }
      return { data: null, error: { message: 'unsupported_rpc' } };
    },
    from: (table: string) => {
      const api: Record<string, unknown> = {
        select: () => api, eq: () => api, not: () => api, order: () => api, limit: () => api,
        update: () => api,
        insert: (row: { metadata?: { kind?: string } }) => {
          if (table === 'conversation_messages') log.push(`insert:${row.metadata?.kind}`);
          return api;
        },
        maybeSingle: async () => {
          if (table === 'conversations') return { data: { id: 'c1', assigned_to: assignedTo, metadata: { ...stored } }, error: null };
          if (table === 'widget_settings') return { data: { assignment_mode: 'manual', round_robin_cursor_user_id: null }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({
          data: { id: 'm1', conversation_id: 'c1', sender_type: 'system', body: 'x', created_at: 'now', metadata: {}, seen_at: null },
          error: null,
        }),
      };
      return api;
    },
  }),
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => {},
  publishConversationEvent: async () => { log.push('publish'); },
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({ dispatchOutboundIfChannelConversation: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyAssignment: async () => {}, notifyHandoff: async () => {} }));
vi.mock('../../../server/services/platformSupport/changes.js', () => ({ onSupportConversationChanged: async () => {} }));

const { routeConversationToOperator, queueEntryStamp, readQueueStatus, QUEUE_ENTRY_MAX_AGE_MS } =
  await import('../../../server/services/chatRouting');

const config = {} as never;
const NOW = Date.parse('2026-10-18T09:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  stored = { ai_state: 'needs_human' };
  assignedTo = null;
  log.length = 0;
  rpcCalls.length = 0;
  queueStatus = { data: [{ queue_position: 3, wait_minutes: null }], error: null };
});
afterEach(() => { vi.useRealTimers(); });

describe('routing into the manual queue', () => {
  it('saves queued_at (now) and the place it entered at, before the queue row is published', async () => {
    const res = await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(res.outcome).toBe('manual_queue');
    expect(stored).toMatchObject({
      routing_outcome: 'manual_queue', routing_notice_sent: true, queued_at: new Date(NOW).toISOString(), queue_entry_position: 3,
    });
    expect(rpcCalls.find((c) => c.name === 'chat_queue_status')!.args).toEqual({ p_workspace_id: 'ws1', p_conversation_id: 'c1' });
    // The state first, then the visitor's row (and its live publish).
    expect(log.slice(0, 4)).toEqual([
      'patch:queued_at,routing_notice_sent,routing_outcome,routing_outcome_at', 'queue_status', 'patch:queue_entry_position', 'insert:routing_in_queue',
    ]);
  });

  it('keeps the first queued_at on the next routing runs (each visitor message), asks no new position, posts no second row', async () => {
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    const first = stored.queued_at;
    vi.setSystemTime(NOW + 10 * 60_000);
    log.length = 0;
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(stored.queued_at).toBe(first);
    expect(stored.queue_entry_position).toBe(3);
    expect(log).toEqual(['patch:routing_outcome,routing_outcome_at']);
  });

  it('a conversation handed back to the queue keeps its place; one whose stamp is a day old joins at the end', async () => {
    stored = { routing_outcome: 'manual_queue', routing_notice_sent: true, queued_at: new Date(NOW - 2 * 3600_000).toISOString(), queue_entry_position: 1 };
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(stored.queued_at).toBe(new Date(NOW - 2 * 3600_000).toISOString());
    stored.queued_at = new Date(NOW - QUEUE_ENTRY_MAX_AGE_MS - 1).toISOString();
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(stored.queued_at).toBe(new Date(NOW).toISOString());
    expect(stored.queue_entry_position).toBe(3);
  });

  it('before 276 (no chat_queue_status) or with no row: queued_at only, routing still succeeds', async () => {
    queueStatus = { data: null, error: { code: '42883', message: 'function public.chat_queue_status(uuid, uuid) does not exist' } };
    const res = await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(res.outcome).toBe('manual_queue');
    expect(stored.queued_at).toBe(new Date(NOW).toISOString());
    expect(stored).not.toHaveProperty('queue_entry_position');
    expect(log).toContain('insert:routing_in_queue');
    stored = {};
    queueStatus = { data: [], error: null };
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(stored).not.toHaveProperty('queue_entry_position');
  });

  it('an assigned conversation is not queued: no queued_at', async () => {
    assignedTo = 'u1';
    stored = { routing_notice_sent: true };
    const res = await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(res.outcome).toBe('already_assigned');
    expect(stored).not.toHaveProperty('queued_at');
  });
});

describe('queueEntryStamp', () => {
  it('now, unless a valid stamp younger than 24 h is there', () => {
    const now = NOW;
    expect(queueEntryStamp({}, now)).toBe(new Date(now).toISOString());
    expect(queueEntryStamp({ queued_at: new Date(now - 1000).toISOString() }, now)).toBeNull();
    expect(queueEntryStamp({ queued_at: new Date(now - QUEUE_ENTRY_MAX_AGE_MS).toISOString() }, now)).toBe(new Date(now).toISOString());
    expect(queueEntryStamp({ queued_at: 'yesterday-ish' }, now)).toBe(new Date(now).toISOString());
    expect(queueEntryStamp({ queued_at: 12345 }, now)).toBe(new Date(now).toISOString());
    // A stamp from the future (a skewed clock) is not trusted either.
    expect(queueEntryStamp({ queued_at: new Date(now + 60_000).toISOString() }, now)).toBe(new Date(now).toISOString());
  });
});

describe('readQueueStatus', () => {
  const waiting = { id: 'c1', status: 'open', assigned_to: null, metadata: { routing_outcome: 'manual_queue', queued_at: new Date(NOW).toISOString() } };

  it('two integers from chat_queue_status', async () => {
    queueStatus = { data: [{ queue_position: 2, wait_minutes: 4 }], error: null };
    expect(await readQueueStatus(config, 'ws1', waiting)).toEqual({ position: 2, wait_minutes: 4 });
    queueStatus = { data: { queue_position: '5', wait_minutes: null }, error: null };
    expect(await readQueueStatus(config, 'ws1', { ...waiting, status: 'pending' })).toEqual({ position: 5, wait_minutes: null });
  });

  it('nulls without a query when not waiting; nulls on an error or a nonsense row', async () => {
    rpcCalls.length = 0;
    for (const conv of [
      { ...waiting, assigned_to: 'u1' },
      { ...waiting, status: 'resolved' },
      { ...waiting, metadata: { routing_outcome: 'manual_queue' } },
      { ...waiting, metadata: { routing_outcome: 'assigned_auto', queued_at: 'x' } },
      { ...waiting, metadata: null },
    ]) {
      expect(await readQueueStatus(config, 'ws1', conv)).toEqual({ position: null, wait_minutes: null });
    }
    expect(rpcCalls).toHaveLength(0);
    queueStatus = { data: null, error: { message: 'boom' } };
    expect(await readQueueStatus(config, 'ws1', waiting)).toEqual({ position: null, wait_minutes: null });
    queueStatus = { data: [{ queue_position: 0, wait_minutes: -2 }], error: null };
    expect(await readQueueStatus(config, 'ws1', waiting)).toEqual({ position: null, wait_minutes: null });
    queueStatus = { data: [{ queue_position: 1.5, wait_minutes: 2 }], error: null };
    expect(await readQueueStatus(config, 'ws1', waiting)).toEqual({ position: null, wait_minutes: null });
  });
});
