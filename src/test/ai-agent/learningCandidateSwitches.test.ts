/**
 * The page's two learning switches (learning_enabled,
 * auto_create_learning_candidates) are what the operator-reply hook
 * (server/services/ai-agent/learning/candidates.ts, run after every operator
 * reply by routes/conversations.ts) reads: either one off and no candidate is
 * created; both on, and an operator answer after an AI handoff becomes a
 * pending candidate of this workspace. Driven for real over the fake data
 * layer of engineFixtures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase } from './helpers/engineFixtures.js';

const WS = 'ws-learn';
const CONV = 'conv-learn';
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({ isConversationSpam: async () => false }));

const { maybeCreateLearningCandidateFromOperatorReply } = await import('../../../server/services/ai-agent/learning/candidates.js');

const CONFIG = { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' } as never;
const OPERATOR_ANSWER = 'Refunds are possible within 14 days of the purchase date.';

function seed(switches: { learning_enabled?: boolean; auto_create_learning_candidates?: boolean }) {
  fakeSb = makeFakeSupabase({
    ai_agent_settings: [{ workspace_id: WS, allowed_locales: ['en'], ...switches }],
    conversation_messages: [
      { id: 'm-visitor', conversation_id: CONV, sender_type: 'contact', body: 'Can I get a refund after a week?', metadata: {}, created_at: '2026-11-01T10:00:00Z' },
      { id: 'm-operator', conversation_id: CONV, sender_type: 'agent', sender_id: 'op-1', body: OPERATOR_ANSWER, metadata: {}, created_at: '2026-11-01T10:01:00Z' },
    ],
    // The AI handed this conversation over: the signal the hook learns from.
    ai_agent_runs: [{ id: 'run-1', conversation_id: CONV, status: 'handoff', run_type: 'handoff', metadata: {} }],
  });
}

const reply = () => maybeCreateLearningCandidateFromOperatorReply(CONFIG, {
  workspaceId: WS,
  conversationId: CONV,
  operatorMessageId: 'm-operator',
  operatorMessageBody: OPERATOR_ANSWER,
  operatorId: 'op-1',
});

const candidates = () => (fakeSb.__store.ai_agent_learning_candidates || []) as Array<Record<string, unknown>>;

beforeEach(() => seed({ learning_enabled: true, auto_create_learning_candidates: true }));

describe('learning switches — the operator-reply hook honours them', () => {
  it('both on: the operator answer becomes a pending candidate of this workspace', async () => {
    const result = await reply();

    expect(result.created).toBe(true);
    expect(candidates()).toHaveLength(1);
    expect(candidates()[0]).toMatchObject({
      workspace_id: WS, conversation_id: CONV, status: 'pending',
      question_text: 'Can I get a refund after a week?', answer_text: OPERATOR_ANSWER,
    });
  });

  it('learning_enabled off: nothing is created', async () => {
    seed({ learning_enabled: false, auto_create_learning_candidates: true });
    expect(await reply()).toEqual({ created: false, reason: 'learning_disabled' });
    expect(candidates()).toEqual([]);
  });

  it('auto_create_learning_candidates off: nothing is created', async () => {
    seed({ learning_enabled: true, auto_create_learning_candidates: false });
    expect(await reply()).toEqual({ created: false, reason: 'auto_create_disabled' });
    expect(candidates()).toEqual([]);
  });
});
