/**
 * A hand-back to the manual queue (issue #340 g4 f2, round-3 follow-up): an
 * operator unassigns a queued conversation, or a paused seat is released.
 * 276's trigger on the unassignment records the return in the metadata
 * (`queue_reentered_at`, and the place in `queue_entry_position`) and keeps
 * `queued_at` (the place); routing then posts a NEW `routing_in_queue` row,
 * once per return (`queue_return_notice_at`), so the visitor's queue pill
 * comes back, and asks for no new place (the trigger recorded it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown>;
let assignedTo: string | null;
let seatLocked = false;
/** What the database's 276 trigger adds to the row on an unassignment. */
let triggerStamp: Record<string, unknown> = {};
const log: string[] = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'patch_conversation_metadata') {
        log.push(`patch:${Object.keys(args.p_patch as object).sort().join(',')}`);
        stored = { ...stored, ...(args.p_patch as object) };
        return { data: true, error: null };
      }
      if (name === 'chat_queue_status') {
        log.push('queue_status');
        return { data: [{ queue_position: 4, wait_minutes: null }], error: null };
      }
      return { data: null, error: { message: 'unsupported_rpc' } };
    },
    from: (table: string) => {
      let updating = false;
      const api: Record<string, unknown> = {
        select: () => api, eq: () => api, not: () => api, order: () => api, limit: () => api, in: () => api,
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations' && 'assigned_to' in row) {
            updating = true;
            log.push('unassign');
            assignedTo = null;
            stored = { ...stored, ...triggerStamp };
          }
          return api;
        },
        insert: (row: { metadata?: { kind?: string } }) => {
          if (table === 'conversation_messages') log.push(`insert:${row.metadata?.kind}`);
          return api;
        },
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(
          updating ? { data: [{ id: 'c1', metadata: { ...stored } }], error: null } : { data: [], error: null },
        ).then(resolve),
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
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: true }),
}));
vi.mock('../../../server/services/billing/locks/predicates.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/predicates.js')>()),
  isMemberLocked: () => seatLocked,
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => {},
  publishConversationEvent: async () => { log.push('publish'); },
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({ dispatchOutboundIfChannelConversation: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyAssignment: async () => {}, notifyHandoff: async () => {} }));
vi.mock('../../../server/services/platformSupport/changes.js', () => ({ onSupportConversationChanged: async () => {} }));

const { routeConversationToOperator, queueReturnToAnnounce } = await import('../../../server/services/chatRouting');

const config = {} as never;
const NOW = Date.parse('2026-10-18T09:00:00Z');
const QUEUED_AT = new Date(NOW - 20 * 60_000).toISOString();
const RETURNED_AT = new Date(NOW - 60_000).toISOString();
const route = () => routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  // Queued 20 minutes ago, announced then.
  stored = { ai_state: 'needs_human', routing_outcome: 'manual_queue', routing_notice_sent: true, queued_at: QUEUED_AT, queue_entry_position: 2 };
  assignedTo = null;
  seatLocked = false;
  triggerStamp = {};
  log.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('queueReturnToAnnounce', () => {
  it('a return not yet announced, else null', () => {
    expect(queueReturnToAnnounce({})).toBeNull();
    expect(queueReturnToAnnounce({ queue_reentered_at: RETURNED_AT })).toBe(RETURNED_AT);
    expect(queueReturnToAnnounce({ queue_reentered_at: RETURNED_AT, queue_return_notice_at: RETURNED_AT })).toBeNull();
    expect(queueReturnToAnnounce({ queue_reentered_at: RETURNED_AT, queue_return_notice_at: QUEUED_AT })).toBe(RETURNED_AT);
    expect(queueReturnToAnnounce({ queue_reentered_at: 42 })).toBeNull();
  });
});

describe('after an operator hands it back', () => {
  beforeEach(() => {
    // What 276's trigger left on the unassignment.
    stored = { ...stored, queue_reentered_at: RETURNED_AT, queue_entry_position: 1 };
  });

  it('keeps its place, posts a new queue row once, and asks no new place', async () => {
    const res = await route();
    expect(res.outcome).toBe('manual_queue');
    expect(stored).toMatchObject({ queued_at: QUEUED_AT, queue_entry_position: 1, queue_return_notice_at: RETURNED_AT });
    expect(log).toEqual(['patch:queue_return_notice_at,routing_outcome,routing_outcome_at', 'insert:routing_in_queue', 'publish']);
    log.length = 0;
    await route();
    expect(log).toEqual(['patch:routing_outcome,routing_outcome_at']);
  });

  it('a second hand-back is announced again', async () => {
    await route();
    stored = { ...stored, queue_reentered_at: new Date(NOW).toISOString() };
    log.length = 0;
    await route();
    expect(log).toContain('insert:routing_in_queue');
    expect(stored.queue_return_notice_at).toBe(new Date(NOW).toISOString());
  });

  it('a stamp a day old joins at the end, and is announced', async () => {
    stored.queued_at = new Date(NOW - 25 * 3600_000).toISOString();
    await route();
    expect(stored.queued_at).toBe(new Date(NOW).toISOString());
    expect(stored.queue_entry_position).toBe(4);
    expect(log.filter((l) => l === 'insert:routing_in_queue')).toHaveLength(1);
  });
});

describe('a paused seat released by routing itself', () => {
  it('routes from the metadata the release left: the return is announced', async () => {
    assignedTo = 'u-paused';
    seatLocked = true;
    triggerStamp = { queue_reentered_at: RETURNED_AT, queue_entry_position: 1 };
    const res = await route();
    expect(res.outcome).toBe('manual_queue');
    expect(log[0]).toBe('unassign');
    expect(log).toContain('insert:routing_in_queue');
    expect(stored).toMatchObject({ queued_at: QUEUED_AT, queue_return_notice_at: RETURNED_AT });
  });

  it('before 276 (no trigger, no stamp): queued as before, no second row', async () => {
    assignedTo = 'u-paused';
    seatLocked = true;
    await route();
    expect(log.filter((l) => l === 'insert:routing_in_queue')).toHaveLength(0);
    expect(stored).not.toHaveProperty('queue_return_notice_at');
  });
});

describe('still waiting, never claimed', () => {
  it('each visitor message: no new row', async () => {
    await route();
    expect(log).toEqual(['patch:routing_outcome,routing_outcome_at']);
  });
});
