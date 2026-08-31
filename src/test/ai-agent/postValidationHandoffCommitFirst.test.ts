/**
 * P0 — the post-validation ("the model bailed out") handoff in
 * generationStage.ts must be truthfully COMMIT-FIRST.
 *
 * A failed durable needs_human transition is NOT a handoff: no visitor
 * acknowledgement, no routing, run status = failed, terminal action != handoff,
 * conversation stays non-handoff.
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
let hybridImpl: () => Promise<any> = async () => makeHybridResult({ sources: [makeHybridSource()] });
let runtimeCfgFixture: any = null;
let aiText = "I don't know.";
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
const commitCalls: any[] = [];
const routeAfterHandoffCalls: any[] = [];
let commitNeedsHumanFails = false;
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async () => makeAIResponse({ text: aiText }),
  executeAICompletionWithConfig: async () => makeAIResponse({ text: aiText }),
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
  retrieveHybridSources: () => hybridImpl(),
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

vi.mock('../../../server/services/ai-agent/conversationState.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, getConversationState: async () => conversationStateFixture };
});

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

vi.mock('../../../server/services/ai-agent/handoffState.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    markAiManaged: vi.fn(async () => {}),
    markNeedsHuman: vi.fn(async () => {}),
    commitNeedsHuman: async (config: any, input: any) => {
      commitCalls.push(input);
      if (commitNeedsHumanFails) return { ok: false, routingDeferred: false };
      return actual.commitNeedsHuman(config, input);
    },
    routeAfterHandoff: async (_config: any, input: any) => { routeAfterHandoffCalls.push(input); },
  };
});

vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({
  isConversationSpam: async () => false,
}));

vi.mock('../../../server/services/ai-agent/queryBuilder.js', () => ({
  buildRetrievalQuery: async () => makeBuiltQuery(),
}));

vi.mock('../../../server/services/ai-agent/runtimeConfig.js', () => ({
  loadAiAgentRuntimeConfig: async () => runtimeCfgFixture,
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

vi.mock('../../../server/services/ai-agent/runtime/conversationState.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, updateRuntimeFlags: vi.fn(async () => {}) };
});

const { maybeRunAiAssistantAfterVisitorMessage } = await import(
  '../../../server/services/ai-agent/engine.js'
);

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
} as any;

const input = () => ({
  workspaceId: DEFAULT_WORKSPACE_ID,
  conversationId: DEFAULT_CONVERSATION_ID,
  visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
  question: 'how do I reset my password',
});

beforeEach(() => {
  settingsFixture = makeSettings({
    mode: 'auto_reply_always',
    answer_only_from_kb: false,
    allow_clarifying_questions: false,
    handoff_when_no_kb_match: true,
  });
  conversationStateFixture = makeConversationState();
  availabilityFixture = makeAvailability();
  hybridImpl = async () => makeHybridResult({
    sources: [makeHybridSource({ final_score: 0.9, keyword_score: 0.9, vector_score: 0.9 })],
  });
  runtimeCfgFixture = null;
  aiText = "I don't know.";
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  commitCalls.length = 0;
  routeAfterHandoffCalls.length = 0;
  commitNeedsHumanFails = false;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, workspace_id: DEFAULT_WORKSPACE_ID, metadata: {} }],
  });
  vi.clearAllMocks();
});

describe('post-validation handoff is commit-first', () => {
  it('commit failure: no ack, no routing, status=failed, action != handoff', async () => {
    commitNeedsHumanFails = true;

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, input());

    expect(commitCalls).toHaveLength(1);
    expect(result.action).not.toBe('handoff');
    expect(result.action).toBe('failed');
    expect(result.reason).toBe('handoff_state_commit_failed');

    expect(insertAiMessageCalls).toHaveLength(0);
    expect(routeAfterHandoffCalls).toHaveLength(0);

    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.status).toBe('failed');
    expect(log.metadata.handoff_committed).toBe(false);
    expect(log.metadata.handoff_attempt_source).toBe('post_validation_failed');
    expect(log.metadata.final_handoff_source).toBeUndefined();

    const meta = fakeSb.__store.conversations[0].metadata || {};
    expect(meta.ai_state).toBeUndefined();
    expect(meta.ai_handoff_requested).toBeUndefined();
  });

  it('commit success: handoff, ack sent, routing runs, status=handoff', async () => {
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, input());

    expect(commitCalls).toHaveLength(1);
    expect(result.action).toBe('handoff');

    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    expect(routeAfterHandoffCalls).toHaveLength(1);

    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.status).toBe('handoff');
    expect(log.metadata.handoff_committed).toBe(true);
    expect(log.metadata.final_handoff_source).toBe('post_validation_failed');

    const meta = fakeSb.__store.conversations[0].metadata || {};
    expect(meta.ai_state).toBe('needs_human');
  });
});
