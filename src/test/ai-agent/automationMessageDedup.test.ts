/**
 * Follow-up 9A — cross-system automation message dedup.
 *
 * The automation-domain audit (Follow-up 9) proved that Message Triggers
 * and Workflows are evaluated AND executed independently for the same
 * event (see engine/automationStage.ts), with no shared dedup key between
 * the two executors (runtime/actionExecutor.ts and
 * runtime/workflowExecutor.ts). A Message Trigger and a Workflow
 * deliberately configured to send the identical visitor-facing body for
 * the same event will both physically insert that message today.
 *
 * These tests drive the REAL engine entry point
 * (maybeRunAiAssistantAfterVisitorMessage), not the evaluators in
 * isolation, using the same mocking convention as handoff.test.ts —
 * markHandoffRequested/readAiConversationMeta are left real against the
 * faked `conversations` table so idempotency assertions are genuine, not
 * stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
} from './helpers/engineFixtures.js';

let settingsFixture = makeSettings();
let conversationStateFixture = makeConversationState();
let availabilityFixture = makeAvailability();
let hybridImpl: () => Promise<any> = async () => makeHybridResult({ sources: [makeHybridSource()] });
let runtimeCfgFixture: any = null;
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

vi.mock('../../../server/services/ai-agent/conversationState.js', async (importOriginal) => {
  // markHandoffRequested left real (mutates the faked `conversations` row's
  // metadata) — actionExecutor.ts / workflowExecutor.ts both read that same
  // metadata back to decide whether a handoff already happened, matching
  // handoff.test.ts's convention.
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getConversationState: async () => conversationStateFixture,
  };
});

vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => availabilityFixture,
}));

// When set, the NEXT insertAiMessage() call whose body matches this string
// throws instead of succeeding, then resets to null -- simulates "the first
// system to attempt the insert fails" without needing to know in advance
// which source (Trigger or Workflow) the engine's own execution order will
// try first (E4/E5).
let failNextInsertForBody: string | null = null;

vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_config: any, input: any) => {
    if (failNextInsertForBody !== null && input.body === failNextInsertForBody) {
      failNextInsertForBody = null;
      throw new Error('simulated insert failure');
    }
    const id = `msg-${insertAiMessageCalls.length + 1}`;
    insertAiMessageCalls.push({ ...input, id });
    return { id };
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

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  // textMatchesLocale is used by triggerRuntime.ts's send_message branch —
  // left real, not stubbed out, or every message-trigger send_message
  // action would silently crash (swallowed by automationStage.ts's
  // try/catch) before the workflow loop that follows it in the same block
  // ever runs.
  const actual = await importOriginal<any>();
  return { ...actual, getPlatformAllowedLocales: async () => ['en'] };
});

vi.mock('../../../server/services/ai-agent/workspaceContext.js', () => ({
  loadWorkspaceContext: async () => null,
}));

vi.mock('../../../server/services/ai-agent/learning/candidates.js', () => ({
  maybeCreateLearningCandidateFromAiSkip: vi.fn(async () => {}),
}));

// runtime/conversationState.js (updateRuntimeFlags/readRuntimeFlags) is left
// entirely real (not mocked) — it only reads/writes the faked `conversations`
// row's metadata via getServiceClient, and D3/D4 below need that persistence
// to be genuine to prove per-turn scoping against pre-existing dedup keys.

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
    visitorMessageId: 'vmsg-1',
    question: 'hi there',
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

function dupBodies(body: string) {
  return insertAiMessageCalls.filter((m) => m.body === body);
}

/** Reads back whatever updateRuntimeFlags/appendExecutedKey persisted into
 * the faked conversations row, so the next simulated turn's
 * conversationStateFixture._metadata genuinely reflects it (mirrors what a
 * real second getConversationState() DB read would return). */
function persistedConversationMetadata(): any {
  const row = (fakeSb as any).__store.conversations.find((c: any) => c.id === DEFAULT_CONVERSATION_ID);
  return row?.metadata || {};
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
  aiCallCount = 0;
  failNextInsertForBody = null;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
  });
  vi.clearAllMocks();
});

const DUP_BODY = 'Pricing information';

describe('D1 — exact cross-system duplicate (visitor_first_message)', () => {
  it('a Message Trigger and a Workflow both configured to send the identical body insert it only once', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-dup', name: 'Pricing trigger', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: false }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-dup', name: 'Pricing workflow', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: false } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies(DUP_BODY)).toHaveLength(1);
    // Deterministic winner per unchanged execution order: workflows are
    // matched+executed before message-trigger execution in the
    // pre-retrieval path (automationStage.ts), so the workflow's insert
    // claims the body first.
    expect(insertAiMessageCalls[0].source).toBe('ai_agent');
    expect(aiCallCount).toBe(0);

    // Observability: both sources still show as matched even though only
    // one of them physically inserted the message.
    const log = logRunCalls.find((c) => c.runType === 'auto_reply' || c.runType === 'handoff' || c.runType === 'skip');
    expect(log).toBeTruthy();
    expect(log.metadata.message_triggers.matched.map((m: any) => m.id)).toContain('trigger-dup');
    expect(log.metadata.workflows.matchedWorkflowIds).toContain('workflow-dup');
  });
});

describe('D2 — different bodies both remain intact', () => {
  it('a Trigger and a Workflow with genuinely different bodies both insert their own message', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-a', name: 'Welcome', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: 'Welcome!', continue_ai: false }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-b', name: 'Ask order number', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: 'Please tell me your order number.', continue_ai: false } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies('Welcome!')).toHaveLength(1);
    expect(dupBodies('Please tell me your order number.')).toHaveLength(1);
  });
});

describe('D3 — same body legitimately fires again on a later turn (no conversation-lifetime suppression)', () => {
  it('turn 1 dedupes the cross-system duplicate to one insert; turn 2 (same body, same rule pair) still inserts once, not zero', async () => {
    const topics = [{
      id: 'topic-hr', workspace_id: DEFAULT_WORKSPACE_ID, name: 'Human request', description: null,
      slug: 'human-request', keywords: ['talk to a person'], examples: [], language: null,
      confidence_threshold: 0.3, action: 'label_only', action_json: {}, enabled: true, system: true,
      created_at: '', updated_at: '',
    }];
    // Trigger explicitly opts out of the existing run_once_per_conversation
    // dedup so it is eligible to fire again on turn 2 — isolating THIS
    // registry's per-turn scoping from the pre-existing, intentionally
    // preserved per-trigger dedup (see D4).
    const messageTriggers = [
      { id: 'trigger-hr', name: 'Human request ack', event_type: 'human_requested', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: false, run_once_per_conversation: false }, delay_seconds: 0, enabled: true },
    ];
    const workflows = [
      { id: 'workflow-hr', name: 'Human request workflow', description: null, trigger_json: { event: 'human_requested' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: false } }], enabled: true, status: 'active', version: 1 },
    ];
    runtimeCfgFixture = makeRuntimeConfig({ topics, messageTriggers, workflows });
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: false });

    // Turn 1.
    await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ visitorMessageId: 'vmsg-A', question: 'I need to talk to a person please' }),
    );
    expect(dupBodies(DUP_BODY)).toHaveLength(1); // cross-system dedup within turn 1

    insertAiMessageCalls.length = 0; // isolate turn 2's inserts
    // Carry forward whatever turn 1 actually persisted (trigger-executed
    // ids, workflow dedup keys) into the conversationState turn 2 reads —
    // mirrors a real second getConversationState() DB read.
    conversationStateFixture = makeConversationState({ _metadata: persistedConversationMetadata() });

    // Turn 2 — same conversation continues. The workflow's own
    // (workflowId, event, topic) dedup key now legitimately blocks IT from
    // firing again (pre-existing behavior, untouched); only the trigger
    // (run_once_per_conversation: false) is eligible. A fresh per-run
    // registry must not additionally suppress it just because the same
    // body was sent on turn 1.
    await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG,
      baseInput({ visitorMessageId: 'vmsg-B', question: 'can I talk to a person again' }),
    );
    expect(dupBodies(DUP_BODY)).toHaveLength(1);
  });
});

describe('D4 — existing same-system dedup is preserved unchanged', () => {
  it('run_once_per_conversation (Message Trigger) still blocks a second physical firing of the SAME trigger id', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 1 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-once', name: 'Once', event_type: 'human_requested', conditions_json: {}, action_type: 'send_message', action_json: { message: 'Only once please', continue_ai: false }, delay_seconds: 0, enabled: true },
      ],
      topics: [{
        id: 'topic-hr', workspace_id: DEFAULT_WORKSPACE_ID, name: 'Human request', description: null,
        slug: 'human-request', keywords: ['talk to a person'], examples: [], language: null,
        confidence_threshold: 0.3, action: 'label_only', action_json: {}, enabled: true, system: true,
        created_at: '', updated_at: '',
      }],
    });
    settingsFixture = makeSettings({ mode: 'auto_reply_always', handoff_on_human_request: false });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ visitorMessageId: 'vmsg-A', question: 'talk to a person' }));
    expect(dupBodies('Only once please')).toHaveLength(1);
    insertAiMessageCalls.length = 0;
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 1, _metadata: persistedConversationMetadata() });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ visitorMessageId: 'vmsg-B', question: 'talk to a person' }));
    expect(dupBodies('Only once please')).toHaveLength(0);
  });

  it('workflow dedupKey(workflowId,event,topic) still blocks a second physical firing of the SAME workflow', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      workflows: [
        { id: 'workflow-once', name: 'Once', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: 'Only once please', continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ visitorMessageId: 'vmsg-A' }));
    expect(dupBodies('Only once please')).toHaveLength(1);
    insertAiMessageCalls.length = 0;

    // aiRepliesCountInConversation now > 0, so visitor_first_message would
    // not even be re-evaluated regardless — this pins that pre-existing
    // gate is unaffected too.
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 1 });
    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ visitorMessageId: 'vmsg-B' }));
    expect(dupBodies('Only once please')).toHaveLength(0);
  });
});

describe('D6 — post-answer ai_no_answer path is protected by the same registry', () => {
  it('a Trigger and a Workflow both bound to ai_no_answer with the identical body insert it only once', async () => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      answer_only_from_kb: true,
      allow_clarifying_questions: false,
      handoff_when_no_kb_match: true,
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-noans', name: 'No answer trigger', event_type: 'ai_no_answer', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: false }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-noans', name: 'No answer workflow', description: null, trigger_json: { event: 'ai_no_answer' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: false } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies(DUP_BODY)).toHaveLength(1);
    expect(aiCallCount).toBe(0);
    // Deterministic winner for the post-answer path: evaluateNoAnswerHooks
    // (engine/helpers.ts) executes message-trigger actions BEFORE workflow
    // actions — the opposite order from the pre-retrieval path, unchanged
    // by this fix. The trigger's insert wins here.
    expect(insertAiMessageCalls[0].source).toBe('ai_agent');
  });
});

describe('D7 — continue_ai conflict: dedup must not weaken a stop-AI instruction', () => {
  it('workflow (continue_ai=true) and trigger (continue_ai=false) send the same body: one message inserted, AI still stops', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-stop', name: 'Stop trigger', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: false }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-continue', name: 'Continue workflow', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    // Exactly one physical message, even though the workflow's own
    // continue_ai intent (true) would not have stopped the AI on its own.
    expect(dupBodies(DUP_BODY)).toHaveLength(1);
    // The trigger's continue_ai=false must still take effect even though
    // its own physical write lost the cross-system dedup race — the
    // evaluator's executed-action list (and therefore automationStage's
    // stoppedByTrigger check) is untouched by the executor-level dedup.
    expect(aiCallCount).toBe(0);
    expect(result.action).toBe('replied');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Follow-up 9A.1 — hardening: the registry must be SOURCE-AWARE (never
// suppress two same-system sources with the same body) and must record a
// SUCCESSFUL physical insert only (never a mere attempt), and per-action
// messageId attribution must never shift once any action in the batch is
// deduped or fails.
// ─────────────────────────────────────────────────────────────────────

describe('E1 — two Message Triggers, same body: same-system behavior unchanged', () => {
  it('both triggers physically insert the identical body — this registry never dedupes within one source', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-e1a', name: 'A', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: 'Same text', continue_ai: true }, delay_seconds: 0, enabled: true },
        { id: 'trigger-e1b', name: 'B', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: 'Same text', continue_ai: true }, delay_seconds: 0, enabled: true },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies('Same text')).toHaveLength(2);
  });
});

describe('E2 — two Workflows, same body: same-system behavior unchanged', () => {
  it('both workflows physically insert the identical body — this registry never dedupes within one source', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      workflows: [
        { id: 'workflow-e2a', name: 'A', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: 'Same text', continue_ai: true } }], enabled: true, status: 'active', version: 1 },
        { id: 'workflow-e2b', name: 'B', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: 'Same text', continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies('Same text')).toHaveLength(2);
  });
});

describe('E3 — one Workflow, two same-body steps: same-system behavior unchanged', () => {
  it('both steps physically insert the identical body — this registry is not a generic same-body deduper', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      workflows: [
        {
          id: 'workflow-e3', name: 'Two same steps', description: null,
          trigger_json: { event: 'visitor_first_message' },
          steps_json: [
            { type: 'send_message', payload: { body: 'Same text', continue_ai: true } },
            { type: 'send_message', payload: { body: 'Same text', continue_ai: true } },
          ],
          enabled: true, status: 'active', version: 1,
        },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies('Same text')).toHaveLength(2);
  });
});

describe('E4 — pre-retrieval: Workflow insert fails, Message Trigger fallback still succeeds', () => {
  it('a failed first physical insert must not block the second source; final count = 1, not 0', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-e4', name: 'Fallback', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: true }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-e4', name: 'Fails first', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
    });
    // Workflow executes first in the pre-retrieval path (unchanged order),
    // so this is the attempt that fails.
    failNextInsertForBody = DUP_BODY;

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies(DUP_BODY)).toHaveLength(1);
  });
});

describe('E5 — post-answer: Message Trigger insert fails, Workflow fallback still succeeds', () => {
  it('a failed first physical insert must not block the second source in the reverse-order post-answer path', async () => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      answer_only_from_kb: true,
      allow_clarifying_questions: false,
      handoff_when_no_kb_match: true,
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-e5', name: 'Fails first', event_type: 'ai_no_answer', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: true }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-e5', name: 'Fallback', description: null, trigger_json: { event: 'ai_no_answer' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
    });
    // The post-answer path executes Message Trigger actions BEFORE Workflow
    // actions (opposite order from pre-retrieval), so this is the attempt
    // that fails.
    failNextInsertForBody = DUP_BODY;

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies(DUP_BODY)).toHaveLength(1);
  });
});

describe('E6 — pre-retrieval messageId attribution does not shift after a dedup', () => {
  it('the deduped trigger reports messageId=null; the distinct trigger reports its OWN real id, never the workflow\'s', async () => {
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    const BODY_B = 'A distinct second body';
    runtimeCfgFixture = makeRuntimeConfig({
      messageTriggers: [
        { id: 'trigger-a', name: 'Cross-dup', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: true }, delay_seconds: 0, enabled: true },
        { id: 'trigger-b', name: 'Distinct', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: BODY_B, continue_ai: true }, delay_seconds: 0, enabled: true },
      ],
      workflows: [
        { id: 'workflow-a', name: 'Claims the body first', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    expect(dupBodies(DUP_BODY)).toHaveLength(1); // workflow wins, trigger-a suppressed
    expect(dupBodies('A distinct second body')).toHaveLength(1);
    const bodyBMessageId = insertAiMessageCalls.find((m) => m.body === BODY_B)?.id;
    expect(bodyBMessageId).toBeTruthy();

    const log = logRunCalls.find((c) => c.metadata?.message_triggers?.executed?.length);
    expect(log).toBeTruthy();
    const executed: any[] = log.metadata.message_triggers.executed;
    const entryA = executed.find((e) => e.id === 'trigger-a');
    const entryB = executed.find((e) => e.id === 'trigger-b');
    expect(entryA.messageId).toBeNull();
    expect(entryB.messageId).toBe(bodyBMessageId);
    expect(entryB.messageId).not.toBe(entryA.messageId);
  });
});

describe('E7 — post-answer messageId attribution does not shift after a dedup', () => {
  it('a trigger deduped against an EARLIER pre-retrieval workflow write reports messageId=null; a distinct sibling trigger in the same batch reports its OWN real id', async () => {
    // Post-answer order is Trigger-then-Workflow, so within the ai_no_answer
    // batch itself nothing has claimed a body yet when triggers run --  the
    // in-batch shift can only be reproduced here by having something claim
    // DUP_BODY EARLIER in the SAME run (the pre-retrieval automation stage),
    // then colliding with it once the post-answer trigger batch processes
    // two actions together (one distinct, one colliding).
    conversationStateFixture = makeConversationState({ aiRepliesCountInConversation: 0 });
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      answer_only_from_kb: true,
      allow_clarifying_questions: false,
      handoff_when_no_kb_match: true,
    });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    const BODY_B = 'A distinct post-answer body';
    runtimeCfgFixture = makeRuntimeConfig({
      workflows: [
        // Pre-retrieval: claims DUP_BODY first, before any post-answer code runs.
        { id: 'workflow-early', name: 'Claims early', description: null, trigger_json: { event: 'visitor_first_message' }, steps_json: [{ type: 'send_message', payload: { body: DUP_BODY, continue_ai: true } }], enabled: true, status: 'active', version: 1 },
      ],
      messageTriggers: [
        // Deliberately ordered with the colliding (soon-to-be-suppressed)
        // trigger FIRST: a naive compact-insertedMessageIds[index] mapping
        // only misattributes when the suppressed entry is NOT last, since a
        // trailing suppressed entry's out-of-bounds index coincidentally
        // still resolves to undefined/null either way.
        { id: 'trigger-noans-b', name: 'Cross-dup', event_type: 'ai_no_answer', conditions_json: {}, action_type: 'send_message', action_json: { message: DUP_BODY, continue_ai: true }, delay_seconds: 0, enabled: true },
        { id: 'trigger-noans-a', name: 'Distinct', event_type: 'ai_no_answer', conditions_json: {}, action_type: 'send_message', action_json: { message: BODY_B, continue_ai: true }, delay_seconds: 0, enabled: true },
      ],
    });

    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput());

    // The pre-retrieval workflow wins DUP_BODY; trigger-noans-b (same body,
    // later in the run) is the one suppressed.
    expect(dupBodies(DUP_BODY)).toHaveLength(1);
    const bodyBMessageId = insertAiMessageCalls.find((m) => m.body === BODY_B)?.id;
    expect(bodyBMessageId).toBeTruthy();

    const log = logRunCalls.find((c) => (c.metadata?.message_triggers?.executed || []).some((e: any) => e.id === 'trigger-noans-b'));
    expect(log).toBeTruthy();
    const executed: any[] = log.metadata.message_triggers.executed;
    const entryA = executed.find((e) => e.id === 'trigger-noans-a');
    const entryB = executed.find((e) => e.id === 'trigger-noans-b');
    expect(entryA.messageId).toBe(bodyBMessageId);
    expect(entryB.messageId).toBeNull();
  });
});
