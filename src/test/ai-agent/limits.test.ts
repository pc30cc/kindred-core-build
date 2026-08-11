/**
 * Phase 1 characterization — C16: AI-Agent-specific conversation limits
 * (max_replies_per_conversation, max_replies_per_hour) and
 * server/services/ai-agent/limitHandoff.ts. This deliberately does NOT
 * reuse the /api/ai/complete credit/rate-limit tests (aiCreditOrdering.test.ts)
 * — those cover a different route entirely. limitHandoff.ts itself is left
 * REAL here (not mocked) since its own orchestration is exactly what C16
 * asks to characterize; only its true IO collaborators (already mocked by
 * the shared engine harness pattern) are controlled.
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
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
const markNeedsHumanCalls: any[] = [];
const markHandoffRequestedCalls: any[] = [];
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
  retrieveHybridSources: async () => makeHybridResult({ sources: [makeHybridSource()] }),
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

// logRun/insertAiMessage/conversationState/handoffState are the real IO
// boundaries limitHandoff.ts itself calls — capture, don't fake their logic.
vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => {},
  logRun: async (_config: any, input: any) => {
    logRunCalls.push(input);
    return `run-${logRunCalls.length}`;
  },
}));

vi.mock('../../../server/services/ai-agent/conversationState.js', () => ({
  getConversationState: async () => conversationStateFixture,
  markHandoffRequested: async (...args: any[]) => {
    markHandoffRequestedCalls.push(args);
  },
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
  settingsFixture = makeSettings();
  conversationStateFixture = makeConversationState();
  availabilityFixture = makeAvailability();
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  markNeedsHumanCalls.length = 0;
  markHandoffRequestedCalls.length = 0;
  aiCallCount = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
  });
  vi.clearAllMocks();
});

describe('C16 — max_replies_per_conversation', () => {
  it('reaching the cap never calls the LLM and routes to a human-friendly handoff', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', max_replies_per_conversation: 3 });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 3 });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(result.action).toBe('handoff');
    expect(result.reason).toBe('max_replies_reached');
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    expect(markNeedsHumanCalls).toHaveLength(1);
    expect(markNeedsHumanCalls[0].reason).toBe('max_replies_reached');
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog.skipReason).toBe('max_replies_reached');
    expect(handoffLog.metadata.limit_handoff).toBe(true);
    expect(handoffLog.creditsUsed).toBe(0);
  });

  it('does not send a second handoff message for the same reason on a repeat visitor message (idempotent)', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', max_replies_per_conversation: 3 });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 3 });
    fakeSb = makeFakeSupabase({
      workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
      conversations: [
        {
          id: DEFAULT_CONVERSATION_ID,
          metadata: { ai_limit_handoff_sent: true, ai_limit_handoff_reason: 'max_replies_reached' },
        },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(insertAiMessageCalls).toHaveLength(0);
    expect(result.action).toBe('handoff');
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog.metadata.duplicate).toBe(true);
  });
});

describe('C16 — max_replies_per_hour', () => {
  it('reaching the hourly cap never calls the LLM and routes to handoff', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', max_replies_per_hour: 20 });
    conversationStateFixture = makeConversationState({ aiRepliesInLastHour: 20 });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(result.action).toBe('handoff');
    expect(result.reason).toBe('rate_limited');
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog.skipReason).toBe('rate_limited');
  });
});

describe('C16 — suggest_only + limit reached suppresses the visitor-facing message', () => {
  it('logs and routes to needs_human but inserts no visitor message', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only', max_replies_per_conversation: 3 });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 3 });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('handoff');
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(markNeedsHumanCalls).toHaveLength(1);
  });
});

describe('C16 — fallback_behavior=silent + limit reached', () => {
  it('routes to needs_human without a visitor-facing message', async () => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      max_replies_per_conversation: 3,
      fallback_behavior: 'silent',
    });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 3 });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('handoff');
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(markNeedsHumanCalls).toHaveLength(1);
  });
});

describe('C16 — pending handoff (related runtime limit, no limitHandoff involved)', () => {
  it('skips silently (no handoff message, no logRun) while a handoff is already pending', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', stop_on_handoff: true });
    conversationStateFixture = makeConversationState({ pendingHandoffRequested: true });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('pending_handoff');
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(0);
    const skipLog = logRunCalls.find((c) => c.runType === 'skip');
    expect(skipLog.skipReason).toBe('pending_handoff');
  });
});
