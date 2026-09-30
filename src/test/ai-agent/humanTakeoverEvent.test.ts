/**
 * markHumanTakeover announces `ai_human_takeover` only when it is a move.
 *
 * Every operator reply lands here. The metadata is written each time (the
 * AI's freshness checks compare against human_takeover_at), but on a thread
 * that is already human-active the event would change nothing a dashboard
 * shows while reaching every open dashboard of the workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const publishOperatorEvent = vi.fn(async (_config: unknown, _event: Record<string, unknown>) => ({ ok: true }));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ rpc }) }));
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishOperatorEvent }));

const { markHumanTakeover } = await import('../../../server/services/ai-agent/handoffState');

const args = { workspaceId: 'ws-1', conversationId: 'conv-1', operatorId: 'op-1', reason: 'operator_replied' as const };

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: true, error: null });
  publishOperatorEvent.mockClear();
});

describe('markHumanTakeover', () => {
  it('writes the takeover but stays quiet when the thread was already human-active', async () => {
    await markHumanTakeover({} as never, { ...args, previousAiState: 'human_active' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_patch).toMatchObject({ ai_state: 'human_active', human_takeover_reason: 'operator_replied' });
    expect(publishOperatorEvent).not.toHaveBeenCalled();
  });

  it.each(['ai_managed', 'needs_human', null])('announces the move from %s', async (previous) => {
    await markHumanTakeover({} as never, { ...args, previousAiState: previous });
    expect(publishOperatorEvent).toHaveBeenCalledTimes(1);
    expect(publishOperatorEvent.mock.calls[0][1]).toMatchObject({ kind: 'ai_human_takeover', conversation_id: 'conv-1' });
  });

  it('announces when the caller does not know the previous state', async () => {
    await markHumanTakeover({} as never, args);
    expect(publishOperatorEvent).toHaveBeenCalledTimes(1);
  });

  it('announces when the write could not be confirmed', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await markHumanTakeover({} as never, { ...args, previousAiState: 'human_active' });
    expect(publishOperatorEvent).toHaveBeenCalledTimes(1);
  });
});
