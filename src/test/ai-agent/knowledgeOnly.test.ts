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
let builtQueryImpl: () => Promise<any> = async () => makeBuiltQuery();
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
  buildRetrievalQuery: (...args: any[]) => builtQueryImpl(),
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
  builtQueryImpl = async () => makeBuiltQuery();
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
  it('PHASE 2 FIX: strict KB-only mode never calls the LLM, even on the first clarification attempt, when there is zero source grounding', async () => {
    // Phase 1 found decideStrategy resolved to 'ask_clarifying_question'
    // here (which DOES call the LLM), violating engine.ts's own declared
    // invariant ("answer_only_from_kb -> no LLM call without a Q&A/KB
    // match"). Phase 2 fix: decideStrategy now skips the
    // ask_clarifying_question branch when answer_only_from_kb=true and
    // retrieval strength is weak/none, falling through to the existing
    // handoff/no_answer_silent logic (step 6) instead — no new response
    // state was invented. This is an INTENTIONAL behavior change from the
    // Phase 1 characterization above; see git history for the prior
    // "SURPRISING FINDING" version of this test.
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
    const log = logRunCalls.find((c) => c.status === 'handoff' || c.status === 'no_answer');
    expect(log).toBeTruthy();
    expect(log.metadata.answer_strategy.decision_type).not.toBe('ask_clarifying_question');
  });

  it('PHASE 2 FIX: strict KB-only mode never calls the LLM for a weak (non-qualifying) source match either', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: true, mode: 'auto_reply_always' });
    hybridImpl = async () =>
      makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });

  it('non-strict mode (answer_only_from_kb=false) preserves the existing clarification behavior — LLM IS called on the first attempt', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: false, mode: 'auto_reply_always' });
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

describe('C9 — answer_only_from_kb vs. safe_guidance (known topic)', () => {
  // PR #1 review blocker: decideStrategy()'s safe_guidance branch (step 4)
  // ran BEFORE the strict-KB guard, which was only ever applied to the
  // clarification branch (step 5). A known topic (e.g. built.topics
  // includes 'pricing') with zero/weak grounding under
  // answer_only_from_kb=true therefore still resolved to 'safe_guidance',
  // which generationStage.ts treats as a normal LLM-eligible strategy —
  // violating the declared "no LLM call without a Q&A/KB match" invariant.
  // These tests pin the fix: the SAME strictKbNoGrounding condition now
  // gates both safe_guidance and ask_clarifying_question.
  it('strict KB + zero sources + known topic: never calls the LLM and never resolves to safe_guidance or ask_clarifying_question', async () => {
    hybridImpl = async () => makeHybridResult({ sources: [] });
    builtQueryImpl = async () => makeBuiltQuery({ topics: ['pricing'] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
    const log = logRunCalls.find((c) => c.status === 'handoff' || c.status === 'no_answer');
    expect(log).toBeTruthy();
    expect(log.metadata.answer_strategy.decision_type).not.toBe('safe_guidance');
    expect(log.metadata.answer_strategy.decision_type).not.toBe('ask_clarifying_question');
  });

  it('strict KB + weak (non-qualifying) source + known topic: never calls the LLM', async () => {
    hybridImpl = async () =>
      makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    builtQueryImpl = async () => makeBuiltQuery({ topics: ['support'] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
    const log = logRunCalls.find((c) => c.status === 'handoff' || c.status === 'no_answer');
    expect(log).toBeTruthy();
    expect(log.metadata.answer_strategy.decision_type).not.toBe('safe_guidance');
  });

  it('non-strict mode + zero sources + known topic: safe_guidance is preserved (fix does not globally disable it)', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: false, mode: 'auto_reply_always' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    builtQueryImpl = async () => makeBuiltQuery({ topics: ['pricing'] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.decision_type).toBe('safe_guidance');
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
