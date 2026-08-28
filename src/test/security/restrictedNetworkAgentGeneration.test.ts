/**
 * RESTRICTED-NETWORK ENTRYPOINT COVERAGE — AI Agent realtime reply.
 *
 * Drives the real engine entrypoint used after a visitor message
 * (`maybeRunAiAssistantAfterVisitorMessage` → generationStage) with provider
 * egress blocked for Core. The generation stage's provider orchestration
 * (resolveAIConfig / executeAICompletion / runtimeClient) is REAL; only the
 * surrounding IO (retrieval, settings, persistence) is faked, mirroring the
 * existing engine test convention.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeFakeSupabase,
  makeSettings,
  makeConversationState,
  makeAvailability,
  makeHybridResult,
  makeHybridSource,
  makeBuiltQuery,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_VISITOR_MESSAGE_ID,
} from '../ai-agent/helpers/engineFixtures.js';
import {
  installRestrictedNetwork,
  restrictedServerConfig,
  RUNTIME_BASE,
  type RestrictedNetwork,
} from './helpers/restrictedNetwork.js';
import { AI_RUNTIME_ROUTES } from '../../../shared/ai/internalRoutes.js';

let fakeSb: ReturnType<typeof makeFakeSupabase>;
const insertAiMessageCalls: any[] = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: vi.fn(async () => {}),
}));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => makeSettings({ mode: 'auto_reply_always' }),
}));
vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({ retrieveSources: async () => [] }));
vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => makeHybridResult({ sources: [makeHybridSource()] }),
}));
vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});
vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
  logRun: async () => 'run-1',
}));
vi.mock('../../../server/services/ai-agent/conversationState.js', () => ({
  getConversationState: async () => makeConversationState(),
  markHandoffRequested: vi.fn(async () => {}),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => makeAvailability(),
}));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_c: any, input: any) => {
    insertAiMessageCalls.push(input);
    return { id: `msg-${insertAiMessageCalls.length}` };
  },
  deriveAgentDisplay: () => ({ agentName: 'AI Assistant', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  markAiManaged: vi.fn(async () => {}),
  markNeedsHuman: vi.fn(async () => {}),
}));
vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({ isConversationSpam: async () => false }));
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

const CONFIG = restrictedServerConfig();
let net: RestrictedNetwork;

beforeEach(() => {
  insertAiMessageCalls.length = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
    provider_configs: [{
      id: 'pc-1',
      workspace_id: DEFAULT_WORKSPACE_ID,
      provider_type: 'ai',
      is_active: true,
      provider_name: 'openai',
      config: { api_key: 'sk-key', model: 'gpt-4o-mini' },
    }],
  });
  net = installRestrictedNetwork();
});
afterEach(() => vi.unstubAllGlobals());

describe('restricted network — AI Agent realtime generation stage', () => {
  it('replies to a visitor message through the AI Runtime with zero provider egress from Core', async () => {
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG as any, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationId: DEFAULT_CONVERSATION_ID,
      visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
      question: 'How do I reset my password?',
    } as any);

    expect(result.ran).toBe(true);
    expect(insertAiMessageCalls.length).toBe(1);
    expect(insertAiMessageCalls[0].body).toContain('hello from provider');

    expect(net.runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    expect(net.providerHits).toHaveLength(1);
    expect(net.coreProviderViolations).toEqual([]);
    expect(net.otherHits).toEqual([]);
  });
});
