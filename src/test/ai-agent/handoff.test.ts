/**
 * Phase 1 characterization — C8: handoff precedence.
 *
 * Keyword-based human-request handoff is already pinned directly against
 * decideRuntime() in runtimeDecision.test.ts ("human_request keyword
 * precedence"). This file covers the remaining sources engine.ts currently
 * supports, using the real (unmocked) pure evaluators —
 * topics/detector.ts, runtime/routingRuntime.ts — driven through a
 * populated AiAgentRuntimeConfig fixture, plus the real decideStrategy for
 * low-confidence / no-KB-match handoff.
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

vi.mock('../../../server/services/ai-agent/conversationState.js', async (importOriginal) => {
  // markHandoffRequested is left REAL (mutates the faked `conversations`
  // table's metadata) rather than a no-op capture stub — actionExecutor.ts
  // and workflowExecutor.ts both read that same metadata back via
  // readAiConversationMeta() to decide whether a handoff was already sent,
  // so a stub that doesn't persist the flag would make the cross-source
  // (trigger vs workflow) idempotency tests below assert a false positive.
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getConversationState: async () => conversationStateFixture,
    markHandoffRequested: async (...args: any[]) => {
      markHandoffRequestedCalls.push(args);
      return actual.markHandoffRequested(...args);
    },
  };
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
  // readAiConversationMeta is left REAL (reads the faked `conversations`
  // table) — it's how actionExecutor.ts / workflowExecutor.ts detect an
  // already-in-progress handoff to avoid a duplicate ack message, which is
  // exactly the invariant the message-trigger/workflow handoff tests below
  // need to be real, not stubbed.
  const actual = await importOriginal<any>();
  return {
    ...actual,
    markAiManaged: vi.fn(async () => {}),
    markNeedsHuman: async (_config: any, input: any) => {
      markNeedsHumanCalls.push(input);
    },
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

function baseInput(overrides: Record<string, any> = {}) {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
    question: 'I want to talk to someone about billing',
    ...overrides,
  };
}

function makeRuntimeConfig(overrides: Record<string, any> = {}) {
  return {
    settings: settingsFixture,
    instructions: {},
    guidanceRules: [],
    routingRules: [],
    topics: [],
    messageTriggers: [],
    workflows: [],
    internalTools: [],
    knowledgeStatus: { totalChunks: 0, totalSources: 0, hasEmbeddings: false },
    warnings: [],
    loadedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  settingsFixture = makeSettings({ mode: 'auto_reply_always' });
  conversationStateFixture = makeConversationState();
  availabilityFixture = makeAvailability();
  hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource()] });
  runtimeCfgFixture = null;
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

describe('C8.2 — topic-detected human-request handoff', () => {
  it('a configured "human-request" topic match forces handoff even without a literal keyword hit', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: true, handoff_keywords: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      topics: [
        {
          id: 'topic-1',
          workspace_id: DEFAULT_WORKSPACE_ID,
          name: 'Human request',
          description: null,
          slug: 'human-request',
          keywords: ['speak to someone', 'billing team'],
          examples: [],
          language: null,
          confidence_threshold: 0.3,
          action: 'label_only',
          action_json: {},
          enabled: true,
          system: true,
          created_at: '', updated_at: '',
        },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'I want to talk to someone about billing team please' }),
    );

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    expect(markNeedsHumanCalls).toHaveLength(1);
    expect(markNeedsHumanCalls[0].reason).toBe('human_request');
  });
});

describe('C8.3 — routing hard-handoff rule', () => {
  it('a matched routing rule with action_type=handoff forces a terminal handoff pre-generation', async () => {
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        {
          id: 'route-1',
          name: 'VIP escalation',
          trigger_type: 'no_answer',
          conditions_json: {},
          action_type: 'handoff',
          action_json: {},
          priority: 1,
          enabled: true,
        },
      ],
    });
    // no_answer trigger_type needs answerStrategy.action to be no_answer at
    // evaluation time — but C2A routing runs BEFORE retrieval/strategy in
    // engine.ts, using only conversation/topic context at that point, so a
    // no_answer-conditioned rule cannot fire pre-retrieval. Use
    // human_request trigger_type instead, matched via the built-in regex,
    // to exercise the hard-handoff branch deterministically pre-retrieval.
    runtimeCfgFixture.routingRules[0].trigger_type = 'human_request';

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'can I speak to an operator' }),
    );

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog.metadata.routing.matchedRuleIds).toContain('route-1');
  });
});

describe('C8 — precedence when multiple handoff sources are simultaneously true', () => {
  it('keyword/decideRuntime human_request reason wins over a simultaneously-matched routing hard-handoff rule', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: true, handoff_keywords: ['operator'] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        {
          id: 'route-2',
          name: 'Any human request escalation',
          trigger_type: 'human_request',
          conditions_json: {},
          action_type: 'handoff',
          action_json: {},
          priority: 1,
          enabled: true,
        },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'let me talk to an operator' }),
    );

    expect(result.action).toBe('handoff');
    // Pinned precedence: decideRuntime's own keyword-matched reason
    // ('human_request') is set first and routing's `decision.reason ||`
    // assignment never overwrites an already-truthy reason — so the final
    // reason stays 'human_request', not 'routing_handoff', even though the
    // routing rule also matched.
    expect(result.reason).toBe('human_request');
  });
});

describe('C8.6 — low-confidence handoff', () => {
  it('SURPRISING FINDING (documented, not fixed): on the FIRST weak-match message, decideStrategy asks a clarifying question (LLM IS called), not an immediate handoff', async () => {
    // Consistent with the same finding in knowledgeOnly.test.ts (C9): a
    // weak/low-scoring match with clarificationAttemptCount=0 resolves to
    // decisionType='ask_clarifying_question' today, which is NOT one of
    // engine.ts's no-LLM branches (no_answer_silent/handoff/greeting only).
    // handoff_on_low_confidence does not prevent this first LLM call.
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_low_confidence: true, answer_only_from_kb: false });
    hybridImpl = async () =>
      makeHybridResult({
        sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })],
      });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'asdkjaslkdj random text' }));

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.decision_type).toBe('ask_clarifying_question');
  });

  it('once the clarification budget is exhausted, the same weak match routes to handoff without a further LLM call', async () => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      handoff_on_low_confidence: true,
      answer_only_from_kb: false,
      allow_clarifying_questions: false,
    });
    hybridImpl = async () =>
      makeHybridResult({
        sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })],
      });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'asdkjaslkdj random text' }));

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });
});

describe('C8.7 — no-KB-match handoff (exhausted clarification budget)', () => {
  it('with clarifying questions disallowed and no source match, engine resolves to handoff/no-answer without an LLM call', async () => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      answer_only_from_kb: true,
      allow_clarifying_questions: false,
      handoff_when_no_kb_match: true,
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });
});

describe('C8.4 — message-trigger-forced handoff', () => {
  it('a matched visitor_first_message trigger with action_type=handoff terminates before any LLM call, writes handoff side effects exactly once, and identifies the trigger as the source', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 }); // isFirstVisitorMessage
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        {
          id: 'trigger-1',
          name: 'Greet and handoff',
          event_type: 'visitor_first_message',
          conditions_json: {},
          action_type: 'handoff',
          action_json: {},
          delay_seconds: 0,
          enabled: true,
        },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'hi there' }));

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    // Exactly one handoff ack message, exactly one markNeedsHuman call — no
    // duplicate insertion between the trigger executor and engine's own
    // handoff branch.
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    expect(markNeedsHumanCalls).toHaveLength(1);
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog).toBeTruthy();
    expect(handoffLog.metadata.message_triggers.matched.map((m: any) => m.id)).toContain('trigger-1');
    // Engine's own handoff branch detects the trigger already sent the ack
    // and does not send a second one (handoffAlreadyDone path).
    expect(handoffLog.metadata.decision_timeline).toContain('handoff_message_already_sent');
  });

  it('a second visitor message after the trigger already fired does not re-execute it (idempotent per conversation)', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    // aiRepliesCountInConversation > 0 -> isFirstVisitorMessage is false, so
    // the visitor_first_message event is not even re-evaluated on message 2
    // — this pins the actual current dedup mechanism (event-gating), not an
    // assumed one.
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 1 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-1', name: 'Greet and handoff', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'handoff', action_json: {}, delay_seconds: 0, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'a follow-up message' }));

    expect(insertAiMessageCalls.filter((m) => m.handoff).length).toBeLessThanOrEqual(1);
    expect(markNeedsHumanCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('C8.5 — workflow handoff', () => {
  it('a matched workflow with a handoff step terminates before any LLM call, writes handoff side effects exactly once, and identifies the workflow as the source', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      workflows: [
        {
          id: 'workflow-1',
          name: 'First message handoff',
          description: null,
          trigger_json: { event: 'visitor_first_message' },
          steps_json: [{ type: 'handoff' }],
          enabled: true,
          status: 'active',
          version: 1,
        },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'hi there' }));

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    expect(markNeedsHumanCalls).toHaveLength(1);
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog.metadata.workflows.matchedWorkflowIds).toContain('workflow-1');
  });

  it('stop-AI workflow step (no handoff) short-circuits before the LLM without routing to human', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      workflows: [
        {
          id: 'workflow-stop',
          name: 'Send message and stop',
          description: null,
          trigger_json: { event: 'visitor_first_message' },
          steps_json: [{ type: 'send_message', payload: { body: 'We are closed right now.', continue_ai: false } }],
          enabled: true,
          status: 'active',
          version: 1,
        },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'hi there' }));

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].body).toBe('We are closed right now.');
    expect(markNeedsHumanCalls).toHaveLength(0);
  });
});

describe('C8 — combined precedence: routing + trigger + workflow all request handoff simultaneously', () => {
  it('the workflow (executed before trigger execution in current code order) sends the ack; the trigger handoff sees it already done and does not send a second one', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-combo', name: 'Escalate', trigger_type: 'human_request', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
      messageTriggers: [
        { id: 'trigger-combo', name: 'First message handoff', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'handoff', action_json: {}, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-combo', name: 'First message workflow handoff', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'handoff' }], enabled: true, status: 'active', version: 1 },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'let me talk to an operator please' }));

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    // The mandatory invariant: no matter how many independent sources
    // requested a handoff, exactly one ack message and exactly one
    // markNeedsHuman call happen — current code's idempotency check
    // (readAiConversationMeta) is what prevents duplication across
    // trigger/workflow/engine branches.
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(markNeedsHumanCalls).toHaveLength(1);
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog).toBeTruthy();
    // Pinned as current precedence (verified via engine.ts's actual code
    // order, not assumed): workflows are matched AND EXECUTED first
    // (the wfEvents loop, engine.ts lines ~391-442), inserting the ack and
    // marking the handoff; message-trigger EXECUTION happens afterward
    // (the `if (triggerResult && triggerResult.executed.length)` block,
    // engine.ts lines ~469-495) via executeRuntimeActions, which detects
    // "already in handoff/takeover state" through readAiConversationMeta
    // and skips inserting a second ack — confirmed by the
    // "[ai-agent.runtime.executor] handoff skipped — already in
    // handoff/takeover state" log line this test produces. Both sources
    // still report matched in their respective metadata blocks even though
    // only the workflow's write actually happened.
    expect(handoffLog.metadata.message_triggers.matched.map((m: any) => m.id)).toContain('trigger-combo');
    expect(handoffLog.metadata.workflows.matchedWorkflowIds).toContain('workflow-combo');
  });
});
