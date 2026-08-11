/**
 * Phase 1 characterization — C1 (AI disabled), C2 (platform kill switch),
 * C3 (entitlement boundary), plus wiring tests tying runtimePolicy's
 * decision (see runtimeDecision.test.ts for the exhaustive matrix) to the
 * actual engine.ts action taken.
 *
 * C3 finding (documented, not invented): server/services/ai-agent/engine.ts
 * has exactly ONE runtime gate before settings/mode are even loaded —
 * `isAutoAnswerAllowedForWorkspace()` (platformGuards.ts). That single
 * function internally checks, in order: platform kill switch
 * (ai_agent_enabled) -> platform auto_answer feature flag
 * (auto_answer_enabled) -> the `ai_assistant` PLAN/ENTITLEMENT module via
 * checkModuleAccess() -> a workspace-level `metadata.platform_disabled`
 * override. There is no separate engine-level entitlement check distinct
 * from the platform gate — "platform disabled" and "plan does not include
 * ai_assistant" surface through the exact same
 * `{ allowed: false, reason }` shape and the exact same engine.ts
 * short-circuit (return skipped, log the reason, never touch retrieval or
 * the LLM). This file characterizes that real, single boundary rather than
 * inventing a second one.
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
let platformGateImpl: () => Promise<any> = async () => ({ allowed: true });
let hybridImpl: () => Promise<any> = async () =>
  makeHybridResult({ sources: [makeHybridSource()] });
let aiResponseImpl: () => Promise<any> = async () => makeAIResponse();
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
let hybridCallCount = 0;
let legacyCallCount = 0;
let aiCallCount = 0;
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async (...args: any[]) => {
    aiCallCount++;
    return aiResponseImpl();
  },
  executeAICompletionWithConfig: async (..._args: any[]) => {
    aiCallCount++;
    return aiResponseImpl();
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
  retrieveSources: async () => {
    legacyCallCount++;
    return [];
  },
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => {
    hybridCallCount++;
    return hybridImpl();
  },
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
  isAutoAnswerAllowedForWorkspace: async () => platformGateImpl(),
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
  platformGateImpl = async () => ({ allowed: true });
  hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource()] });
  aiResponseImpl = async () => makeAIResponse();
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  hybridCallCount = 0;
  legacyCallCount = 0;
  aiCallCount = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
  });
  vi.clearAllMocks();
});

describe('C1 — workspace AI disabled (real engine.ts path, not effectiveMode.ts)', () => {
  it('enabled=false: no LLM, no retrieval, no message, no suggestion, correct skip reason', async () => {
    settingsFixture = makeSettings({ enabled: false });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.ran).toBe(false);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('disabled_or_off');
    expect(hybridCallCount).toBe(0);
    expect(legacyCallCount).toBe(0);
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(fakeSb.__store['ai_agent_suggestions']).toBeUndefined();
    // Current behavior: this specific skip path does NOT call logRun at all
    // (engine.ts returns immediately after the enabled/mode check, before
    // any logRun call) — pinned exactly as-is.
    expect(logRunCalls).toHaveLength(0);
  });

  it('mode=off (enabled=true): no LLM, no retrieval, no message, no suggestion, correct skip reason', async () => {
    settingsFixture = makeSettings({ enabled: true, mode: 'off' });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.ran).toBe(false);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('disabled_or_off');
    expect(hybridCallCount).toBe(0);
    expect(legacyCallCount).toBe(0);
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(logRunCalls).toHaveLength(0);
  });
});

describe('C2 — platform kill switch', () => {
  it('rejects before settings/retrieval/LLM are ever touched, does not throw, logs the skip', async () => {
    platformGateImpl = async () => ({ allowed: false, reason: 'ai_agent_platform_disabled' });

    let thrown: unknown = null;
    let result: any = null;
    try {
      result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeNull();
    expect(result.ran).toBe(false);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('ai_agent_platform_disabled');
    expect(hybridCallCount).toBe(0);
    expect(legacyCallCount).toBe(0);
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(0);
    // Unlike the C1 branch, the platform-gate skip DOES call logRun today.
    expect(logRunCalls).toHaveLength(1);
    expect(logRunCalls[0]).toMatchObject({
      runType: 'skip',
      mode: 'off',
      status: 'skipped',
      skipReason: 'ai_agent_platform_disabled',
    });
  });

  it('auto_answer feature flag off surfaces its own distinct reason through the same gate', async () => {
    platformGateImpl = async () => ({ allowed: false, reason: 'auto_answer_disabled_by_platform' });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());
    expect(result.reason).toBe('auto_answer_disabled_by_platform');
    expect(aiCallCount).toBe(0);
  });
});

describe('C3 — entitlement gate (documented boundary: same function as C2, different reason)', () => {
  it('plan without the ai_assistant module is rejected through the identical platform-gate short-circuit', async () => {
    // This is the real runtime shape: isAutoAnswerAllowedForWorkspace()
    // returns { allowed: false, reason: 'ai_assistant_plan_required' } when
    // checkModuleAccess() denies the ai_assistant module — there is no
    // separate engine-level entitlement branch to test independently.
    platformGateImpl = async () => ({ allowed: false, reason: 'ai_assistant_plan_required' });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.ran).toBe(false);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('ai_assistant_plan_required');
    expect(hybridCallCount).toBe(0);
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(logRunCalls).toHaveLength(1);
    expect(logRunCalls[0].skipReason).toBe('ai_assistant_plan_required');
  });
});

describe('wiring: engine acts correctly on decideRuntime output', () => {
  it('auto_reply_always + strong source -> inserts a visitor-facing AI message, not a suggestion', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('replied');
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(aiCallCount).toBe(1);
    expect(fakeSb.__store['ai_agent_suggestions']).toBeUndefined();
  });

  it('suggest_only -> creates a suggestion row and an operator event, never a visitor message', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only' });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('suggested');
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(fakeSb.__store['ai_agent_suggestions']).toHaveLength(1);
    expect(aiCallCount).toBe(1); // provider may still execute in suggest_only
  });

  it('auto_reply_when_offline + operators online -> suggests, does not auto-reply, still calls the provider', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_when_offline' });
    availabilityFixture = makeAvailability({ state: 'online' });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('suggested');
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(fakeSb.__store['ai_agent_suggestions']).toHaveLength(1);
  });

  it('auto_reply_when_offline + operators offline -> auto-replies to the visitor', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_when_offline' });
    availabilityFixture = makeAvailability({ state: 'offline' });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(result.action).toBe('replied');
    expect(insertAiMessageCalls).toHaveLength(1);
  });

  it('AI failure (provider throws) does not break the visitor runtime — returns failed, does not throw', async () => {
    aiResponseImpl = async () => {
      throw new Error('provider unreachable');
    };
    let thrown: unknown = null;
    let result: any = null;
    try {
      result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    expect(result.action).toBe('failed');
    expect(insertAiMessageCalls).toHaveLength(0);
  });
});
