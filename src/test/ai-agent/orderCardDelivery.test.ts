/**
 * The order card through the AI engine: the card the commerce stage builds
 * beside its tool results reaches the auto reply's insertAiMessage (and
 * nothing else), while the prompt the model sees is byte-identical with or
 * without it. Harness: the same stand-ins as llmFirstArchitecture.test.ts.
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
let hybridImpl: () => Promise<unknown> = async () => makeHybridResult({ sources: [] });
let builtQueryImpl: () => Promise<unknown> = async () => makeBuiltQuery();
type Loose = Record<string, unknown>;
const logRunCalls: unknown[] = [];
const insertAiMessageCalls: Loose[] = [];
const markNeedsHumanCalls: unknown[] = [];
let aiCallCount = 0;
const aiCalls: unknown[][] = [];
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async (...args: unknown[]) => {
    aiCallCount++;
    aiCalls.push(args);
    return makeAIResponse();
  },
  executeAICompletionWithConfig: async (...args: unknown[]) => {
    aiCallCount++;
    aiCalls.push(args);
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

let hybridCallCount = 0;
vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: () => { hybridCallCount++; return hybridImpl(); },
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<Loose>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
  logRun: async (_config: unknown, input: unknown) => {
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
  insertAiMessage: async (_config: unknown, input: Loose) => {
    insertAiMessageCalls.push(input);
    return { id: `msg-${insertAiMessageCalls.length}` };
  },
  deriveAgentDisplay: (settings: Loose) => ({
    agentName: settings.agent_name || 'AI Assistant',
    agentLogoUrl: settings.agent_logo_url || null,
  }),
}));

vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  markAiManaged: vi.fn(async () => {}),
  markNeedsHuman: async (_config: unknown, input: unknown) => {
    markNeedsHumanCalls.push(input);
  },

  // vNext blocker 1 — handoff is a two-phase commit; the engine calls
  // commitNeedsHuman() then routeAfterHandoff(). Both are recorded here so
  // these suites keep asserting on handoff side effects.
  commitNeedsHuman: async (_config: unknown, input: unknown) => {
    markNeedsHumanCalls.push(input);
    return { ok: true, routingDeferred: false };
  },
  routeAfterHandoff: async () => {},
}));

vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({
  isConversationSpam: async () => false,
}));

vi.mock('../../../server/services/ai-agent/queryBuilder.js', () => ({
  buildRetrievalQuery: () => builtQueryImpl(),
}));

let runtimeCfgFixture: unknown = null;
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

vi.mock('../../../server/services/ai-agent/runtime/conversationState.js', () => ({
  updateRuntimeFlags: vi.fn(async () => {}),
  readRuntimeFlags: vi.fn(async () => ({})),
}));

// The commerce stage is the stand-in here: it answers with the same tool
// results either way, with or without an order card beside them.
let commerceImpl: () => Promise<unknown> = async () => ({ toolResults: [], toolsUsed: [] });
vi.mock('../../../server/services/ai-agent/commerce-tools/runner.js', () => ({
  runCommerceToolStage: () => commerceImpl(),
}));

const { maybeRunAiAssistantAfterVisitorMessage } = await import(
  '../../../server/services/ai-agent/engine.js'
);

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
} as never;

function baseInput(overrides: Loose = {}) {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
    question: 'hello',
    ...overrides,
  };
}

/** Everything the model was shown this turn (system + user prompt). */
function lastPromptText(): string {
  const args = aiCalls[aiCalls.length - 1] || [];
  return JSON.stringify(args);
}

beforeEach(() => {
  settingsFixture = makeSettings({
    mode: 'auto_reply_always',
    agent_name: 'Nova',
    answer_only_from_kb: true,
    // Owner has configured NO special escalation policy.
    handoff_when_no_kb_match: false,
    handoff_on_low_confidence: false,
  });
  conversationStateFixture = makeConversationState({ _metadata: { ai_greeting_sent: true } });
  availabilityFixture = makeAvailability();
  runtimeCfgFixture = null;
  hybridImpl = async () => makeHybridResult({ sources: [] });
  builtQueryImpl = async () => makeBuiltQuery();
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  markNeedsHumanCalls.length = 0;
  aiCalls.length = 0;
  aiCallCount = 0;
  hybridCallCount = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Acme', default_locale: 'fa', widget_locale: 'fa' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
  });
  vi.clearAllMocks();
});

beforeEach(() => { commerceImpl = async () => ({ toolResults: [], toolsUsed: [] }); });

const CARD = {
  v: 1, number: '48213', summary: null, more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null,
  trackingUrl: 'https://tracking.post.ir/?id=RR1',
};
const TOOL_RESULTS = [
  { name: 'commerce.get_customer_orders', data: { external_id: '48213', status: 'processing', total: '2450000', created_at: '2026-10-15T10:00:00Z' } },
  { name: 'commerce.get_tracking', data: { carrier: 'Post', tracking_number: 'RR1', status: 'in transit' } },
];

describe('the order card through the engine', () => {
  it('reaches the auto reply, and the prompt is the same as without it', async () => {
    commerceImpl = async () => ({ toolResults: TOOL_RESULTS, toolsUsed: ['commerce.get_customer_orders', 'commerce.get_tracking'] });
    const plain = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'پیگیری سفارشم' }));
    expect(plain.action).toBe('replied');
    const promptWithout = lastPromptText();
    expect(promptWithout).toContain('RR1');
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].orderCard).toBeNull();

    insertAiMessageCalls.length = 0;
    aiCalls.length = 0;
    commerceImpl = async () => ({ toolResults: TOOL_RESULTS, toolsUsed: ['commerce.get_customer_orders', 'commerce.get_tracking'], orderCard: CARD });
    const carded = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'پیگیری سفارشم' }));
    expect(carded.action).toBe('replied');
    expect(lastPromptText()).toBe(promptWithout);
    expect(lastPromptText()).not.toContain('tracking.post.ir');
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0]).toMatchObject({ source: 'ai_agent', orderCard: CARD });
    expect(insertAiMessageCalls[0].body).toBe(makeAIResponse().text);
  });

  it('a handoff turn carries no card', async () => {
    commerceImpl = async () => ({ toolResults: TOOL_RESULTS, toolsUsed: [], orderCard: CARD });
    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'I want to talk to a human agent' }));
    for (const call of insertAiMessageCalls) {
      if (call.source !== 'ai_agent') expect(call.orderCard ?? null).toBeNull();
    }
  });
});
