/**
 * Behavioral contract: chat routing must patch ONLY its own routing keys.
 *
 * History: routing used to read `conversations.metadata`, mutate the object
 * in memory and write the whole document back. A Telegram offline screen that
 * claimed the conversation (`telegram_offline_notice_claim`) between the read
 * and the write was silently erased, which let the offline notice be sent
 * twice. The fix was NOT a re-read of the "latest metadata" inside
 * chatRouting.ts — the whole-document write was removed entirely: routing now
 * goes through `patchConversationMetadata()`, which merges server-side inside
 * `patch_conversation_metadata` (migration 057).
 *
 * This test proves the surviving behavior instead of a variable name: run
 * routing against a fake conversations row, have a concurrent writer add a
 * claim key after routing has read the row, and assert the claim survives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let stored: Record<string, unknown>;
const rpcCalls: Array<{ name: string; args: any }> = [];
const wholeDocumentWrites: any[] = [];
const systemMessages: any[] = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === 'patch_conversation_metadata') {
        stored = { ...stored, ...(args.p_patch || {}) };
        return { data: true, error: null };
      }
      return { data: null, error: { message: 'unsupported_rpc' } };
    },
    from: (table: string) => {
      const api: any = {
        _update: null as any,
        select: () => api,
        eq: () => api,
        not: () => api,
        order: () => api,
        limit: () => api,
        update(patch: any) {
          if (table === 'conversations' && patch && 'metadata' in patch) wholeDocumentWrites.push(patch);
          api._update = patch;
          return api;
        },
        insert(row: any) {
          if (table === 'conversation_messages') {
            systemMessages.push(row);
            // A concurrent Telegram offline-screen claim lands here, i.e.
            // strictly AFTER routing already read the conversation row.
            stored = { ...stored, telegram_offline_notice_claim: 'claim-1' };
          }
          return api;
        },
        maybeSingle: async () => {
          if (table === 'conversations') {
            return { data: { id: 'c1', assigned_to: null, metadata: { ...stored } }, error: null };
          }
          if (table === 'widget_settings') {
            return { data: { assignment_mode: 'manual', round_robin_cursor_user_id: null }, error: null };
          }
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
  publishConversationEvent: async () => {},
  buildMessageEnvelope: (m: any) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({
  dispatchOutboundIfChannelConversation: async () => {},
}));
vi.mock('../../../server/services/channels/telegram/offlineDelivery.js', () => ({
  maybeQueueTelegramOfflineScreen: async () => true,
}));

const { routeConversationToOperator } = await import('../../../server/services/chatRouting');

const config = {} as any;

beforeEach(() => {
  stored = { channel: 'telegram', ai_state: 'needs_human', human_takeover_at: '2026-01-01T00:00:00Z' };
  rpcCalls.length = 0;
  wholeDocumentWrites.length = 0;
  systemMessages.length = 0;
});

describe('chat routing metadata contract', () => {
  it('patches only routing keys and never writes a whole metadata document', async () => {
    const res = await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(res.outcome).toBe('manual_queue');

    expect(wholeDocumentWrites).toEqual([]);
    const patches = rpcCalls.filter((c) => c.name === 'patch_conversation_metadata');
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) {
      for (const key of Object.keys(p.args.p_patch)) {
        expect(key.startsWith('routing_')).toBe(true);
      }
    }
  });

  it('does not erase a concurrent offline-screen claim written after the read', async () => {
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    // Claim was written by the offline-screen path between routing's read and
    // its write. A whole-document write-back would have dropped it.
    expect(stored.telegram_offline_notice_claim).toBe('claim-1');
  });

  it('preserves AI ownership keys owned by other subsystems', async () => {
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(stored.ai_state).toBe('needs_human');
    expect(stored.human_takeover_at).toBe('2026-01-01T00:00:00Z');
    expect(stored.channel).toBe('telegram');
    expect(stored.routing_outcome).toBe('manual_queue');
  });

  it('is idempotent: a second routing pass does not repeat the queue notice', async () => {
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    const firstCount = systemMessages.length;
    expect(firstCount).toBe(1);
    expect(stored.routing_notice_sent).toBe(true);
    systemMessages.length = 0;
    await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(systemMessages).toEqual([]);
    expect(stored.routing_outcome).toBe('manual_queue');
  });
});
