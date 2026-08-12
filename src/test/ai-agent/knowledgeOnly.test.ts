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
  executeAICompletionWithConfig: async () => {
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
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
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
  it('LLM-FIRST: strict KB-only mode with zero grounding still lets the model reply — the prompt, not silence, protects business facts', async () => {
    // Architecture rewrite: answer_only_from_kb restricts BUSINESS FACTS,
    // it is no longer an LLM kill-switch. With no evidence the turn is
    // tagged groundingMode='unverified' and the model must say it has no
    // confirmed information instead of inventing one.
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.grounding_mode).toBe('unverified');
    expect(log.metadata.answer_strategy.handoff_required).toBe(false);
  });

  it('LLM-FIRST: a weak (non-qualifying) source match is answered with unverified grounding, not silence', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: true, mode: 'auto_reply_always' });
    hybridImpl = async () =>
      makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
  });

  it('non-strict mode + zero sources: the model answers, and never resolves to a legacy scripted state', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: false, mode: 'auto_reply_always' });
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.decision_type).toBe('answer');
    expect(log.metadata.answer_strategy.reason).toBe('no_verified_evidence');
  });

  it('owner policy handoff_when_no_kb_match=true + a configured topic escalates instead', async () => {
    settingsFixture = makeSettings({
      answer_only_from_kb: true,
      mode: 'auto_reply_always',
      handoff_when_no_kb_match: true,
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    builtQueryImpl = async () => makeBuiltQuery({ topics: ['pricing'] });

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
  it('the scripted safe_guidance state no longer exists: a known topic with zero grounding is answered by the model', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: true, mode: 'auto_reply_always' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    builtQueryImpl = async () => makeBuiltQuery({ topics: ['pricing'] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.decision_type).not.toBe('safe_guidance');
    expect(log.metadata.answer_strategy.decision_type).not.toBe('ask_clarifying_question');
  });

  it('non-strict mode + zero sources + known topic is also answered by the model, with unverified grounding', async () => {
    settingsFixture = makeSettings({ answer_only_from_kb: false, mode: 'auto_reply_always' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    builtQueryImpl = async () => makeBuiltQuery({ topics: ['pricing'] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.grounding_mode).toBe('unverified');
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
