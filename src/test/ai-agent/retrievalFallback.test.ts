/**
 * Phase 1 characterization — C11: hybrid retrieval -> legacy retrieval
 * fallback.
 *
 * server/services/ai-agent/engine.ts has two production-reachable branches
 * that fall back from retrieveHybridSources() to the legacy retrieveSources()
 * (see engine.ts around the "Pass 2 — hybrid retrieval with safe fallback"
 * comment):
 *
 *   C11-A: retrieveHybridSources() resolves successfully but returns zero
 *          sources while vectorUsed or keywordUsed was true — engine falls
 *          through to retrieveSources() and uses its results if any.
 *   C11-B: retrieveHybridSources() throws — engine catches it and calls
 *          retrieveSources() unconditionally.
 *
 * This file pins that orchestration exactly as it exists today. It does NOT
 * modify retrieval.ts or retrievalHybrid.ts.
 *
 * Mocking approach: true external boundaries (Supabase, LLM provider,
 * realtime) are mocked, plus the direct collaborator modules engine.ts
 * imports (settings/conversation-state/availability/spam-guard/logs/
 * responder/handoff-state/query-builder/platform-guards/platform-region/
 * runtime-config/workspace-context) so each test can deterministically drive
 * the engine into the scenario under test without needing a full relational
 * fake of a dozen tables. retrieveHybridSources/retrieveSources themselves
 * are the two functions under test for this file, so they are mocked at the
 * module boundary and their *return values*, not their internals, are what
 * each test controls — this is what C11-A/C11-B ask for ("simulate ... the
 * exact condition that currently causes the engine to call retrieveSources()").
 * decideStrategy, runtimePolicy, language and prompt-building stay REAL
 * (all pure, no IO) so the eventual reply/suggestion decision is genuine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeFakeSupabase,
  makeSettings,
  makeConversationState,
  makeAvailability,
  makeHybridResult,
  makeHybridSource,
  makeRetrievedSource,
  makeAIResponse,
  makeBuiltQuery,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_VISITOR_MESSAGE_ID,
} from './helpers/engineFixtures.js';

// ─── Controllable state, reset in beforeEach ───
let settingsFixture = makeSettings();
let conversationStateFixture = makeConversationState();
let availabilityFixture = makeAvailability();
let hybridImpl: () => Promise<any> = async () => makeHybridResult();
let legacyImpl: () => Promise<any> = async () => [];
let aiResponseImpl: () => Promise<any> = async () => makeAIResponse();
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
const suggestionInserts: any[] = [];
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => fakeSb,
}));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: (...args: any[]) => aiResponseImpl(),
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: vi.fn(async () => {}),
}));

vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => settingsFixture,
}));

vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({
  retrieveSources: (...args: any[]) => legacyImpl(),
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: (...args: any[]) => hybridImpl(),
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => {},
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
  markNeedsHuman: vi.fn(async () => {}),
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
const { retrieveHybridSources } = await import(
  '../../../server/services/ai-agent/retrievalHybrid.js'
);
const { retrieveSources } = await import('../../../server/services/ai-agent/retrieval.js');

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
  settingsFixture = makeSettings();
  conversationStateFixture = makeConversationState();
  availabilityFixture = makeAvailability();
  hybridImpl = async () => makeHybridResult();
  legacyImpl = async () => [];
  aiResponseImpl = async () => makeAIResponse();
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  suggestionInserts.length = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
  });
  vi.clearAllMocks();
});

describe('C11-A — hybrid returns zero usable sources -> legacy fallback', () => {
  it('calls the legacy retriever exactly once and uses its results', async () => {
    let hybridCallCount = 0;
    let legacyCallCount = 0;
    hybridImpl = async () => {
      hybridCallCount++;
      // Exact production condition (engine.ts): hybrid resolved, sources
      // empty, but vectorUsed/keywordUsed true — this is what triggers the
      // fallback branch (not just "any empty result").
      return makeHybridResult({ sources: [], vectorUsed: true, keywordUsed: true });
    };
    legacyImpl = async () => {
      legacyCallCount++;
      return [makeRetrievedSource({ id: 'legacy-kb-1', score: 0.7 })];
    };

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(hybridCallCount).toBe(1);
    expect(legacyCallCount).toBe(1);
    // No duplicate retrieval beyond the one expected fallback call each way.
    expect(result.ran).toBe(true);
  });

  it('lets the legacy source reach answer strategy and produce a normal reply', async () => {
    hybridImpl = async () => makeHybridResult({ sources: [], vectorUsed: true, keywordUsed: true });
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-kb-1', title: 'Password reset', score: 0.9 })];

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    // auto_reply_always (default fixture mode) + a decent-scoring legacy
    // source is enough for decideStrategy to answer today — same as
    // production would with a strong hybrid match.
    expect(result.action).toBe('replied');
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].body).toBe('Here is the answer to your question.');
  });

  it('produces a suggestion (not a visitor message) in suggest_only mode via the same fallback', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only' });
    hybridImpl = async () => makeHybridResult({ sources: [], vectorUsed: true, keywordUsed: true });
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-kb-1', score: 0.9 })];

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('suggested');
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(fakeSb.__store['ai_agent_suggestions']?.length).toBe(1);
  });

  it('preserves the current fallback reason/state in run metadata', async () => {
    hybridImpl = async () =>
      makeHybridResult({
        sources: [],
        vectorUsed: true,
        keywordUsed: true,
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
      });
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-kb-1', score: 0.9 })];

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    const replyLog = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(replyLog).toBeTruthy();
    const retrieval = replyLog.metadata.retrieval;
    expect(retrieval.hybrid_used).toBe(false); // fell back to legacy, no longer "hybrid"
    expect(retrieval.vector_used).toBe(true); // preserved from the hybrid attempt
    expect(retrieval.keyword_used).toBe(true);
    expect(retrieval.retrieval_results_count).toBe(1);
    expect(retrieval.selected_sources[0].id).toBe('legacy-kb-1');
  });

  it('does NOT fall back when hybrid legitimately found nothing and neither vector nor keyword ran', async () => {
    // Documented current condition: fallback only triggers when
    // (vectorUsed || keywordUsed) is true. If hybrid ran with neither
    // strategy usable, engine currently does NOT call the legacy retriever.
    let legacyCallCount = 0;
    hybridImpl = async () => makeHybridResult({ sources: [], vectorUsed: false, keywordUsed: false });
    legacyImpl = async () => {
      legacyCallCount++;
      return [makeRetrievedSource({ id: 'should-not-be-used' })];
    };

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(legacyCallCount).toBe(0);
  });
});

describe('C11-B — hybrid throws -> legacy fallback', () => {
  it('does not crash the visitor runtime and calls the legacy retriever', async () => {
    let legacyCallCount = 0;
    hybridImpl = async () => {
      throw new Error('vector index unreachable');
    };
    legacyImpl = async () => {
      legacyCallCount++;
      return [makeRetrievedSource({ id: 'legacy-kb-2', score: 0.8 })];
    };

    let thrown: unknown = null;
    let result: any = null;
    try {
      result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeNull();
    expect(legacyCallCount).toBe(1);
    expect(result.ran).toBe(true);
  });

  it('still produces a normal AI result using the legacy fallback knowledge', async () => {
    hybridImpl = async () => {
      throw new Error('embedding provider timeout');
    };
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-kb-3', title: 'Reset password', score: 0.9 })];

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('replied');
    expect(insertAiMessageCalls).toHaveLength(1);
  });

  it('keeps the failure isolated from normal visitor messaging when BOTH retrievers fail', async () => {
    // Even in the worst case (hybrid throws AND legacy throws/returns
    // nothing), the top-level wrapper must never let a visitor message
    // crash the request — it must degrade to a defined result, not throw.
    hybridImpl = async () => {
      throw new Error('vector index unreachable');
    };
    legacyImpl = async () => {
      throw new Error('kb table unreachable too');
    };

    let thrown: unknown = null;
    let result: any = null;
    try {
      result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeNull();
    expect(result).toBeTruthy();
    expect(result.action).toBe('failed');
    expect(result.ran).toBe(false);
  });

  it('records the hybrid_throw fallback reason in run metadata', async () => {
    hybridImpl = async () => {
      throw new Error('vector index unreachable');
    };
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-kb-4', score: 0.9 })];

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    const replyLog = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(replyLog).toBeTruthy();
    const retrieval = replyLog.metadata.retrieval;
    expect(retrieval.fallback_reason).toMatch(/^hybrid_throw:/);
    // PHASE 2 FIX: on the hybrid-throws path, the engine falls back to the
    // legacy keyword retriever unconditionally, and that legacy retriever
    // DID execute and produce the sources actually used for this run. The
    // top-level queryMeta.keyword_used must therefore also be true, matching
    // the nested retrieval_debug.execution.keyword_used (which was already
    // correctly hardcoded true) -- both describe the same actual execution.
    // Previously the top-level flag stayed at its `false` initial value
    // because engine.ts's catch block never reassigned it; see git history
    // for the prior version of this test, which pinned that disagreement.
    expect(retrieval.hybrid_used).toBe(false);
    expect(retrieval.vector_used).toBe(false);
    expect(retrieval.keyword_used).toBe(true);
    expect(retrieval.retrieval_debug.execution.keyword_used).toBe(true);
    expect(retrieval.retrieval_debug.execution.fallback_reason).toBe('legacy_retriever_used');
  });
});
