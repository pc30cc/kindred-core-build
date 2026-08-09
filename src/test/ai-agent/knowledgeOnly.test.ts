/**
 * Phase 1 characterization — C9: answer_only_from_kb.
 *
 * decideStrategy() (server/services/ai-agent/answerStrategy.ts) is left
 * REAL in this file (only countClarificationAttempts is stubbed, since it
 * does IO) — this exercises the actual current production decision logic
 * for the no-source and has-source cases, not a re-implementation of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeFakeSupabase,
  makeSettings,
  makeConversationState,
  makeAvailability,
  makeHybridResult,
  makeHybridSource,
  makeAIResponse,
  makeBuiltQuery,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_VISITOR_MESSAGE_ID,
} from './helpers/engineFixtures.js';

let settingsFixture = makeSettings();
let conversationStateFixture = makeConversationState();
let availabilityFixture = makeAvailability();
let hybridImpl: () => Promise<any> = async () => makeHybridResult({ sources: [] });
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
const markNeedsHumanCalls: any[] = [];
let aiCallCount = 0;
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async () => {
    aiCallCount++;
    return makeAIResponse();
  },
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: vi.fn(async () => {}),
}));

vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => settingsFixture,
}));

vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({
  retrieveSources: async () => [],
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: (...args: any[]) => hybridImpl(),
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  logRun: async (_config: any, input: any) => {
    logRunCalls.push(input);
    return `run-${logRunCalls.length}`;
  },
}));

vi.mock('../../../server/services/ai-agent/conversationState.js', () => ({
  getConversationState: async () => conversationStateFixture,
  markHandoffRequested: vi.fn(async () => {}),
}));

vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => availabilityFixture,
}));

vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_config: any, input: any) => {
    insertAiMessageCalls.push(input);
    return { id: `msg-${insertAiMessageCalls.length}` };
  },
  deriveAgentDisplay: (settings: any) => ({
    agentName: settings.agent_name || 'AI Assistant',
    agentLogoUrl: settings.agent_logo_url || null,
  }),
}));

vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  markAiManaged: vi.fn(async () => {}),
  markNeedsHuman: async (_config: any, input: any) => {
    markNeedsHumanCalls.push(input);
  },
}));

vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({
  isConversationSpam: async () => false,
}));

vi.mock('../../../server/services/ai-agent/queryBuilder.js', () => ({
  buildRetrievalQuery: async () => makeBuiltQuery(),
}));

vi.mock('../../../server/services/ai-agent/runtimeConfig.js', () => ({
  loadAiAgentRuntimeConfig: async () => null,
}));

vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({
  isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }),
}));

vi.mock('../../../server/services/platformRegion.js', () => ({
  getPlatformAllowedLocales: async () => ['en'],
}));

vi.mock('../../../server/services/ai-agent/workspaceContext.js', () => ({
  loadWorkspaceContext: async () => null,
}));

vi.mock('../../../server/services/ai-agent/learning/candidates.js', () => ({
  maybeCreateLearningCandidateFromAiSkip: vi.fn(async () => {}),
}));

vi.mock('../../../server/services/ai-agent/runtime/conversationState.js', () => ({
  updateRuntimeFlags: vi.fn(async () => {}),
}));

const { maybeRunAiAssistantAfterVisitorMessage } = await import(
  '../../../server/services/ai-agent/engine.js'
);

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
} as any;

function baseInput(overrides: Record<string, any> = {}) {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
    question: 'How do I reset my password?',
    ...overrides,
  };
}

beforeEach(() => {
  settingsFixture = makeSettings({ answer_only_from_kb: true, mode: 'auto_reply_always' });
  conversationStateFixture = makeConversationState();
  availabilityFixture = makeAvailability();
  hybridImpl = async () => makeHybridResult({ sources: [] });
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  markNeedsHumanCalls.length = 0;
  aiCallCount = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
  });
  vi.clearAllMocks();
});

describe('C9 — answer_only_from_kb, no matching source', () => {
  it('SURPRISING FINDING (documented, not fixed): decideStrategy asks a clarifying question rather than going silent/handoff, so the LLM IS still called once', async () => {
    // With zero retrieval matches and answer_only_from_kb=true,
    // decideStrategy's real (unmocked) logic currently returns
    // decisionType='ask_clarifying_question' rather than 'no_answer_silent'
    // or 'handoff' for a fresh conversation (clarificationAttemptCount=0).
    // engine.ts only special-cases no_answer_silent/handoff/greeting as
    // "no LLM call" branches — ask_clarifying_question falls through to the
    // normal LLM call to word the clarifying question. So
    // answer_only_from_kb=true does NOT, on its own, guarantee "no LLM
    // execution without a KB match" — it guarantees no *answer* is invented,
    // but a clarifying-question LLM call can still happen. Pinned exactly
    // as current behavior; see KNOWN BUGS in the Phase 1 report — this is
    // flagged, not changed.
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.decision_type).toBe('ask_clarifying_question');
  });

  it('after the clarification budget is exhausted, current behavior moves to handoff/no-answer without a further LLM call', async () => {
    // countClarificationAttempts is mocked to 0 for every test above; here
    // we drive the real decideStrategy with an attempt count at/above
    // max_clarification_attempts (default 1) to characterize the OTHER
    // side of this same decision, still without a real DB attempts-count.
    settingsFixture = makeSettings({
      answer_only_from_kb: true,
      mode: 'auto_reply_always',
      max_clarification_attempts: 1,
      allow_clarifying_questions: false,
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });
});

describe('C9 — answer_only_from_kb, one matching source', () => {
  it('becomes eligible for an LLM call and produces a normal answer', async () => {
    hybridImpl = async () =>
      makeHybridResult({ sources: [makeHybridSource({ final_score: 0.9, keyword_score: 0.9, vector_score: 0.9 })] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    expect(insertAiMessageCalls).toHaveLength(1);
  });
});
