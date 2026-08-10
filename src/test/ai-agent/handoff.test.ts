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
    conversations: [{ id: DEFAULT_CONVERSATION_ID, workspace_id: DEFAULT_WORKSPACE_ID, metadata: {} }],
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

describe('C8.9 — business_hours routing trigger (wired in Follow-up 9C via availability.reason)', () => {
  it('outside configured business hours (availability.reason="outside_hours") — the rule matches and forces handoff', async () => {
    availabilityFixture = makeAvailability({ state: 'offline', reason: 'outside_hours' });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-bh-1', name: 'Outside hours escalation', trigger_type: 'business_hours', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'what are your pricing plans' }),
    );

    expect(result.action).toBe('handoff');
    const handoffLog = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffLog.metadata.routing.matchedRuleIds).toContain('route-bh-1');
  });

  it('inside configured business hours (availability.reason="within_hours") — the rule does NOT match', async () => {
    availabilityFixture = makeAvailability({ state: 'online', reason: 'within_hours' });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-bh-2', name: 'Outside hours escalation', trigger_type: 'business_hours', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'what are your pricing plans' }),
    );

    expect(result.action).not.toBe('handoff');
    expect(aiCallCount).toBe(1);
    const finalLog = logRunCalls[logRunCalls.length - 1];
    expect(finalLog.metadata.routing.matchedRuleIds).not.toContain('route-bh-2');
  });

  it('inside business hours but no operator online (availability.reason="no_operators_online", state="offline") — the rule still does NOT match, proving operator presence is not conflated with business-hours closure', async () => {
    availabilityFixture = makeAvailability({ state: 'offline', reason: 'no_operators_online' });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-bh-3', name: 'Outside hours escalation', trigger_type: 'business_hours', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'what are your pricing plans' }),
    );

    expect(result.action).not.toBe('handoff');
    const finalLog = logRunCalls[logRunCalls.length - 1];
    expect(finalLog.metadata.routing.matchedRuleIds).not.toContain('route-bh-3');
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
  it('non-strict mode (answer_only_from_kb=false): on the FIRST weak-match message, decideStrategy asks a clarifying question and the LLM IS called — unaffected by the Phase 2 strict-KB fix', async () => {
    // This is the answer_only_from_kb=false counterpart of the Phase 2 fix
    // in knowledgeOnly.test.ts — handoff_on_low_confidence alone does not
    // (and per the fix, should not) prevent this first LLM call; the
    // strict-mode case (answer_only_from_kb=true) is covered there and in
    // this file's C8.7 block, both now asserting LLM=0.
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

describe('C8.10 — strict-KB provider boundary (Follow-up 9D.1/9D.2)', () => {
  it('SK0 — strict KB + zero sources + no Routing: existing invariant, unaffected by this fix', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: true, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });

  it('SK1 — strict KB + weak source + no Routing: existing invariant, unaffected by this fix', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: true, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });

  it('SKR1 — strict KB + weak source + LIVE topic_detected -> keep_ai: must NOT bypass the strict-KB invariant', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: true, fallback_behavior: 'handoff' });
    runtimeCfgFixture = makeRuntimeConfig({
      topics: [
        {
          id: 'topic-pricing', workspace_id: DEFAULT_WORKSPACE_ID, name: 'Pricing', description: null,
          slug: 'pricing', keywords: ['price', 'pricing', 'plan'], examples: [], language: null,
          confidence_threshold: 0.5, action: 'label_only', action_json: {}, enabled: true, system: false,
          created_at: '', updated_at: '',
        },
      ],
      routingRules: [
        { id: 'route-skr1', name: 'Pricing keep AI', trigger_type: 'topic_detected', conditions_json: { topic: 'pricing' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'what is your pricing plan' }));

    // Confirm the routing rule genuinely matched and set keepAi — otherwise
    // this test would pass for the wrong reason (no override attempted).
    const log = logRunCalls.find((c) => c.metadata?.routing?.matchedRuleIds?.includes('route-skr1'))
      || logRunCalls[logRunCalls.length - 1];
    expect(log?.metadata?.routing?.matchedRuleIds).toContain('route-skr1');
    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer', 'skipped']).toContain(result.action);
  });

  it('SKR2 — strict KB + zero sources + LIVE language -> keep_ai: proves the fix is a general invariant, not topic-specific', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: true, fallback_behavior: 'handoff' });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-skr2', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    const log = logRunCalls.find((c) => c.metadata?.routing?.matchedRuleIds?.includes('route-skr2'))
      || logRunCalls[logRunCalls.length - 1];
    expect(log?.metadata?.routing?.matchedRuleIds).toContain('route-skr2');
    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer', 'skipped']).toContain(result.action);
  });

  it('SKR3 — non-strict KB + weak source + keep_ai: the fix must NOT globally disable keep_ai outside strict-KB mode', async () => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always', answer_only_from_kb: false, fallback_behavior: 'handoff',
      allow_clarifying_questions: false,
    });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-skr3', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    // Weak match + clarification disabled -> decideStrategy falls through to
    // handoff(reason:'low_confidence'); non-strict keep_ai is still allowed
    // to override it, since the strict-KB invariant does not apply here.
    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
  });

  it('SKG1 — strict KB + zero sources + duplicate greeting: the greeting-dedup mutation must not bypass the strict-KB invariant either', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: true, fallback_behavior: 'handoff' });
    conversationStateFixture = makeConversationState({ _metadata: { ai_greeting_sent: true } });
    hybridImpl = async () => makeHybridResult({ sources: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'hi' }));

    expect(aiCallCount).toBe(0);
    expect(result.action).not.toBe('replied');
  });

  it('HR1 — explicit human-request keyword + an unrelated live keep_ai match: decideRuntime already terminates before retrieval, so no bypass exists here (confirms, does not change, production precedence)', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: true, handoff_keywords: ['operator'] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-hr1', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'let me talk to an operator' }));

    expect(result.action).toBe('handoff');
    expect(result.reason).toBe('human_request');
    expect(aiCallCount).toBe(0);
  });

  it('HR2 — human_request -> keep_ai routing rule cannot reach AnswerStage either, for the same reason as HR1', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: true, handoff_keywords: ['operator'] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-hr2', name: 'Human keep AI', trigger_type: 'human_request', conditions_json: {}, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'let me talk to an operator' }));

    expect(result.action).toBe('handoff');
    expect(result.reason).toBe('human_request');
    expect(aiCallCount).toBe(0);
  });
});

describe('C8.11 — Follow-up 9E.3 post-strategy Routing (engine-level)', () => {
  it('PAGE1 — a page-context-upgraded strategy (decisionType forced to answer/page_context_match) is never seen by POST low_confidence Routing, even with a rule that would otherwise trivially match', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () =>
      makeHybridResult({
        sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })],
        pageContextDebug: {
          current_page_url: 'https://example.com/pricing', current_page_title: 'Pricing',
          exact_page_match: true, same_path_match: false, same_host_match: true,
          page_matched_source_ids: ['kb-1'], page_url_boost_applied: true,
        },
      });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-page1', name: 'Low conf handoff', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.99 }, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'what is this page about', pageContext: { currentPageUrl: 'https://example.com/pricing' } }),
    );

    // The page-context override forces decisionType='answer' BEFORE POST
    // Routing evaluates, so the rule (which would match almost any
    // confidence otherwise) must never fire.
    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).not.toContain('route-page1');
  });

  it('PAGE2 — the E2C no_url terminal reply returns before POST Routing ever evaluates, with zero unrelated side effects', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-page2', name: 'No-answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    // No pageContext supplied -> pageIntentOverride = 'no_url' -> the short
    // honest E2C reply fires and returns before POST Routing ever runs.
    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ question: 'what page am I on' }),
    );

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(0);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).not.toContain('route-page2');
    expect((log.metadata.routing.executedActions || []).every((a: any) => a.phase !== 'post_strategy')).toBe(true);
    expect(markNeedsHumanCalls).toHaveLength(0);
  });

  it('MIXB1 — an explicit POST no_answer -> handoff rule wins over a simultaneously-applicable PRE keep_ai rule', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-mixb1-keepai', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-mixb1-handoff', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(0);
    expect(result.action).toBe('handoff');
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).toContain('route-mixb1-keepai');
    expect(log.metadata.routing.matchedRuleIds).toContain('route-mixb1-handoff');
  });

  it('MIXB2 — an explicit POST low_confidence -> handoff rule wins over a simultaneously-applicable PRE keep_ai rule', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-mixb2-keepai', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-mixb2-handoff', name: 'Low conf handoff', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(0);
    expect(result.action).toBe('handoff');
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).toContain('route-mixb2-handoff');
  });

  it('MIXC — PRE and POST keep_ai combine via OR when no hard handoff is applicable, under non-strict KB: one non-handoff outcome', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-mixc-pre', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-mixc-post', name: 'Low conf keep AI', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.decision_timeline).toContain('routing_keep_ai_overrides_handoff');
    expect(log.metadata.routing.matchedRuleIds).toEqual(expect.arrayContaining(['route-mixc-pre', 'route-mixc-post']));
  });

  it('strict-KB blocks a POST low_confidence -> keep_ai rule exactly as it blocks a PRE rule: no bypass, reported truthfully as strict_kb_safety_block', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: true, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-skpost-1', name: 'Low conf keep AI', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer', 'skipped']).toContain(result.action);
    const log = logRunCalls.find((c) => c.metadata?.routing?.skippedActions?.some((a: any) => a.sourceId === 'route-skpost-1'))
      || logRunCalls[logRunCalls.length - 1];
    const skip = log.metadata.routing.skippedActions.find((a: any) => a.sourceId === 'route-skpost-1');
    expect(skip?.skippedReason).toBe('strict_kb_safety_block');
    expect(log.metadata.routing.executedActions.some((a: any) => a.sourceId === 'route-skpost-1')).toBe(false);
  });

  it('PRE mark_priority persists unconditionally on a normal (non-handoff) answer path', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always' });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-mp-pre', name: 'EN priority', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    const conv = fakeSb.__store.conversations.find((c: any) => c.id === DEFAULT_CONVERSATION_ID);
    expect(conv.priority).toBe('high');
  });

  it('MIXD — a PRE mark_priority match and an explicit POST no_answer -> handoff rule both take effect on the same message', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-mixd-pre', name: 'EN priority', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true },
        { id: 'route-mixd-post', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    const conv = fakeSb.__store.conversations.find((c: any) => c.id === DEFAULT_CONVERSATION_ID);
    expect(conv.priority).toBe('high');
  });

  it('POST mark_priority persists unconditionally even on a keep_ai-converted-to-answer path', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-postmp-keepai', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-postmp-priority', name: 'Low conf priority', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    const conv = fakeSb.__store.conversations.find((c: any) => c.id === DEFAULT_CONVERSATION_ID);
    expect(conv.priority).toBe('high');
  });

  it('a matched mark_priority action executes exactly once even when the legacy keyword handoff path also fires on the same message', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: true, handoff_keywords: ['operator'] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-nodup', name: 'EN priority', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true },
      ],
    });
    const logSpy = vi.spyOn(console, 'log');

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'let me talk to an operator' }));

    expect(result.action).toBe('handoff');
    const priorityLogs = logSpy.mock.calls.filter((args) => args[0] === '[ai-agent.runtime.routing] executed mark_priority');
    expect(priorityLogs).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('SILENT1 — an explicit POST no_answer -> handoff rule overrides fallback_behavior=silent: one real handoff, one visitor-facing ack, needs_human set', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'silent' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-silent1', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    expect(markNeedsHumanCalls).toHaveLength(1);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).toContain('route-silent1');
  });

  it('SILENT2 — when a Message Trigger ai_no_answer handoff already executed, the POST Routing handoff does not send a duplicate ack', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'silent' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-silent2', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
      messageTriggers: [
        { id: 'trig-silent2', name: 'AI no-answer handoff', event_type: 'ai_no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, delay_seconds: 0, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    // Exactly one physical ack total, no duplicate between the trigger's
    // execution and the POST Routing handoff branch.
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    // The trigger's own executeRuntimeActions handoff branch calls
    // markNeedsHuman exactly once; answerStage's handoff branch detects
    // noAnsResult.handoffExecuted and returns early WITHOUT a second call.
    expect(markNeedsHumanCalls).toHaveLength(1);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.decision_timeline).toContain('handoff_message_already_sent');
    expect(log.metadata.routing.matchedRuleIds).toContain('route-silent2');
  });

  it('no_answer -> keep_ai persisted directly via runtimeConfig (bypassing the UI) does not apply at the engine level either', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-illegal-keepai', name: 'Illegal keep AI', trigger_type: 'no_answer', conditions_json: {}, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    expect(aiCallCount).toBe(0);
    const log = logRunCalls[logRunCalls.length - 1];
    const skip = log.metadata.routing.skippedActions.find((a: any) => a.sourceId === 'route-illegal-keepai');
    expect(skip?.skippedReason).toBe('unsupported_action_for_trigger:keep_ai');
  });

  it('METADATA — a dormant POST low_confidence rule (legacy threshold key) is never in matchedRuleIds but is truthfully observable as skipped', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false });
    // Strong match -> decisionType='answer' regardless of Routing, isolating
    // this test to the metadata truthfulness question alone. The dormancy
    // check runs before the reason comparison, so it still fires here.
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource()] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-meta-dormant', name: 'Legacy low conf', trigger_type: 'low_confidence', conditions_json: { threshold: 0.5 }, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(1);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).not.toContain('route-meta-dormant');
    const skip = log.metadata.routing.skippedActions.find((a: any) => a.sourceId === 'route-meta-dormant');
    expect(skip?.skippedReason).toBe('unsupported_condition:threshold');
  });
});

describe('C8.12 — Follow-up 9E.3.1 POST hard handoff independent of canAutoReply', () => {
  it('POSTMODE1 — suggest_only + reason=no_kb_match + POST no_answer->handoff: real handoff state transition, no visitor ack', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-postmode1', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    expect(markNeedsHumanCalls).toHaveLength(1);
    expect(markHandoffRequestedCalls.length).toBeGreaterThanOrEqual(1);
    // suggest_only suppresses the Routing-generated visitor ack.
    expect(insertAiMessageCalls).toHaveLength(0);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).toContain('route-postmode1');
    expect(log.metadata.routing.executedActions.some((a: any) => a.sourceId === 'route-postmode1')).toBe(true);
  });

  it('POSTMODE2 — suggest_only + reason=low_confidence + POST low_confidence->handoff: same real handoff state semantics', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-postmode2', name: 'Low conf handoff', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    expect(markNeedsHumanCalls).toHaveLength(1);
    expect(insertAiMessageCalls).toHaveLength(0);
  });

  it('POSTMODE3 — auto_reply_when_offline with operators online (canAutoReply=false) + POST no_answer->handoff: real handoff, preserves the existing non-suggest_only acknowledgement', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_when_offline', answer_only_from_kb: false, allow_clarifying_questions: false });
    availabilityFixture = makeAvailability({ state: 'online', reason: 'operators_online' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-postmode3', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    expect(markNeedsHumanCalls).toHaveLength(1);
    // Non-suggest_only mode preserves the existing ack, even though
    // canAutoReply is false here (operators are online).
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
  });

  it('POSTMODE4 — suggest_only + Trigger/Workflow ai_no_answer handoff already executed: one physical handoff only, no duplicate', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-postmode4', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
      messageTriggers: [
        { id: 'trig-postmode4', name: 'AI no-answer handoff', event_type: 'ai_no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, delay_seconds: 0, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    // The trigger's own executeRuntimeActions handoff branch sends an ack
    // unconditionally (existing, unrelated semantics) and calls
    // markNeedsHuman once; the corrective POST hard-handoff code detects
    // noAnsResult.handoffExecuted and does not send a second of either.
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(markNeedsHumanCalls).toHaveLength(1);
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.decision_timeline).toContain('handoff_message_already_sent');
  });

  it('REGRESSION — suggest_only + low/no-answer strategy with NO POST handoff rule preserves pre-9E.3 behavior (no automatic human handoff)', async () => {
    settingsFixture = makeSettings({ mode: 'suggest_only', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({ routingRules: [] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).not.toBe('handoff');
    expect(markNeedsHumanCalls).toHaveLength(0);
  });
});

describe('C8.13 — Follow-up 9E.3.1 hard-handoff/keep_ai metadata truthfulness', () => {
  it('META-HH1 — within the SAME POST phase, a lower-priority hard handoff overrides an already-matched higher-priority keep_ai: keepAi=false, keep_ai rule stays matched but is NOT reported executed', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-hh1-keepai', name: 'Low conf keep AI', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-hh1-handoff', name: 'Low conf handoff', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'handoff', action_json: {}, priority: 2, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(0);
    expect(result.action).toBe('handoff');
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).toContain('route-hh1-keepai');
    expect(log.metadata.routing.matchedRuleIds).toContain('route-hh1-handoff');
    expect(log.metadata.routing.executedActions.some((a: any) => a.sourceId === 'route-hh1-keepai')).toBe(false);
    const skip = log.metadata.routing.skippedActions.find((a: any) => a.sourceId === 'route-hh1-keepai');
    expect(skip?.skippedReason).toBe('overridden_by_hard_handoff');
  });

  it('META-HH2 — a PRE keep_ai remains condition-matched but is NOT reported executed once a POST hard handoff wins cross-phase', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false, fallback_behavior: 'handoff' });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-hh2-pre', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-hh2-post', name: 'No answer handoff', trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(result.action).toBe('handoff');
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.matchedRuleIds).toContain('route-hh2-pre');
    expect(log.metadata.routing.executedActions.some((a: any) => a.sourceId === 'route-hh2-pre')).toBe(false);
    const skip = log.metadata.routing.skippedActions.find((a: any) => a.sourceId === 'route-hh2-pre');
    expect(skip?.skippedReason).toBe('overridden_by_post_hard_handoff');
  });

  it('META-HH3 — PRE keep_ai + POST keep_ai with no hard handoff: both remain genuinely executed, effective keepAi=true', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', answer_only_from_kb: false, allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource({ final_score: 0.15, keyword_score: 0.15, vector_score: 0.1 })] });
    runtimeCfgFixture = makeRuntimeConfig({
      routingRules: [
        { id: 'route-hh3-pre', name: 'EN keep AI', trigger_type: 'language', conditions_json: { language: 'en' }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
        { id: 'route-hh3-post', name: 'Low conf keep AI', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'how do I reset my password' }));

    expect(aiCallCount).toBe(1);
    expect(result.action).toBe('replied');
    const log = logRunCalls[logRunCalls.length - 1];
    expect(log.metadata.routing.executedActions.some((a: any) => a.sourceId === 'route-hh3-pre')).toBe(true);
    expect(log.metadata.routing.executedActions.some((a: any) => a.sourceId === 'route-hh3-post')).toBe(true);
  });
});
