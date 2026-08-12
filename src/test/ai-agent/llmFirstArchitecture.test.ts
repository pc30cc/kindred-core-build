/**
 * LLM-FIRST ARCHITECTURE — acceptance tests.
 *
 * Proves the four contract points of the architecture verification pass:
 *   1. missing knowledge does NOT hand off by itself
 *   2. an owner routing rule DOES hand off on the same turn
 *   3. follow-ups work from conversation history, with no intent phrases
 *   4. identity questions are answered from Assistant Config, for arbitrary
 *      phrasings that appear in no list anywhere in the codebase
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
import { isBusinessEvidenceReason } from '../../../server/services/ai-agent/retrievalDecision.js';

let settingsFixture = makeSettings();
let conversationStateFixture = makeConversationState();
let availabilityFixture = makeAvailability();
let hybridImpl: () => Promise<any> = async () => makeHybridResult({ sources: [] });
let builtQueryImpl: () => Promise<any> = async () => makeBuiltQuery();
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
const markNeedsHumanCalls: any[] = [];
let aiCallCount = 0;
const aiCalls: any[][] = [];
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async (...args: any[]) => {
    aiCallCount++;
    aiCalls.push(args);
    return makeAIResponse();
  },
  executeAICompletionWithConfig: async (...args: any[]) => {
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
  retrieveHybridSources: (...args: any[]) => { hybridCallCount++; return hybridImpl(); },
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

let runtimeCfgFixture: any = null;
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

describe('LLM-first — missing knowledge is not an escalation', () => {
  it('A1 — business question with zero KB results and no owner rule: the model answers, NO handoff', async () => {
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: 'ارسال به کانادا چقدره؟',
      retrievalQuery: 'ارسال به کانادا چقدره؟',
      expandedQuery: 'ارسال به کانادا چقدره؟',
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG, baseInput({ question: 'ارسال به کانادا چقدره؟' }),
    );

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    expect(markNeedsHumanCalls.length).toBe(0);
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.decision_type).toBe('answer');
    expect(log.metadata.answer_strategy.reason).toBe('no_verified_evidence');
    expect(log.metadata.answer_strategy.grounding_mode).toBe('unverified');
    expect(log.metadata.answer_strategy.handoff_required).toBe(false);
    // The model is explicitly told it may not invent the missing fact.
    expect(lastPromptText()).toContain('No verified business information was retrieved');
  });

  it('A2 — the SAME turn hands off once an owner routing rule says unknown questions go to support', async () => {
    runtimeCfgFixture = {
      settings: settingsFixture,
      instructions: {},
      topics: [], guidanceRules: [], routingRules: [
        {
          id: 'route-unknown-shipping', name: 'Unknown questions → support',
          trigger_type: 'no_answer', conditions_json: {}, action_type: 'handoff',
          action_json: {}, priority: 1, enabled: true,
        },
      ],
      messageTriggers: [], workflows: [], internalTools: [],
      knowledgeStatus: { totalChunks: 0, totalSources: 0, hasEmbeddings: false },
      warnings: [], loadedAt: Date.now(),
    };
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: 'ارسال به کانادا چقدره؟',
      retrievalQuery: 'ارسال به کانادا چقدره؟',
      expandedQuery: 'ارسال به کانادا چقدره؟',
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG, baseInput({ question: 'ارسال به کانادا چقدره؟' }),
    );

    expect(result.action).toBe('handoff');
    expect(markNeedsHumanCalls.length).toBe(1);
  });
});

describe('LLM-first — no intent phrases anywhere', () => {
  it('B1 — a follow-up with no recognisable "intent phrase" still reaches the model with history', async () => {
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: 'اون آخری رو بیشتر توضیح بده',
      retrievalQuery: 'پلن Pro امکانات اون آخری',
      expandedQuery: 'پلن Pro امکانات اون آخری',
      followUpDetected: true,
      conversationContextUsed: true,
      conversationTurnsUsed: 2,
    });

    const result = await maybeRunAiAssistantAfterVisitorMessage(
      CONFIG, baseInput({ question: 'اون آخری رو بیشتر توضیح بده' }),
    );

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    expect(markNeedsHumanCalls.length).toBe(0);
  });

  for (const phrasing of [
    'چی باید صدات کنم؟',
    'خودتو چی معرفی می‌کنی؟',
    'اسم این دستیاری که دارم باهاش حرف می‌زنم چیه؟',
    'Who exactly am I chatting with?',
  ]) {
    it(`B2 — identity phrasing answered from Assistant Config, no hardcoded list: "${phrasing}"`, async () => {
      builtQueryImpl = async () => makeBuiltQuery({
        originalMessage: phrasing, retrievalQuery: phrasing, expandedQuery: phrasing,
      });

      const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: phrasing }));

      expect(result.action).toBe('replied');
      expect(aiCallCount).toBe(1);
      expect(markNeedsHumanCalls.length).toBe(0);
      // The configured assistant name is what the model answers from.
      expect(lastPromptText()).toContain('Nova');
    });
  }
});


/** Metadata the engine persisted for the auto_reply run. */
function replyRetrievalMeta(): any {
  const log = logRunCalls.find((c) => c.runType === 'auto_reply');
  return log?.metadata?.retrieval || {};
}

describe('Signal-based retrieval decision — no message-shape heuristics', () => {
  async function ask(question: string, built: Record<string, any> = {}) {
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: question, retrievalQuery: question, expandedQuery: question, ...built,
    });
    return maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question }));
  }

  it('C1 — long conversational message ("چه کارهایی می‌تونی برای من انجام بدی؟") answers with NO retrieval', async () => {
    const result = await ask('چه کارهایی می‌تونی برای من انجام بدی؟');
    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(false);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('no_business_signal');
    expect(markNeedsHumanCalls.length).toBe(0);
  });

  it('C2 — identity question with a question mark ("اسمت چیه؟") answers from config with NO retrieval', async () => {
    const result = await ask('اسمت چیه؟');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(false);
    expect(lastPromptText()).toContain('Nova');
  });

  it('C3 — a number alone ("من 25 سالمه") does not trigger business retrieval', async () => {
    const result = await ask('من 25 سالمه');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(false);
  });

  it('C4 — conversational referential follow-up after an identity turn: NO retrieval', async () => {
    const result = await ask('اون قسمت آخر رو بیشتر توضیح بده', {
      followUpDetected: true,
      conversationContextUsed: true,
      conversationTurnsUsed: 2,
      contextTurns: [
        { role: 'visitor', text: 'خودتو معرفی کن' },
        { role: 'assistant', text: 'من دستیار Nova هستم', metadata: { kb_article_ids: [], qna_ids: [] } },
      ],
      clarification: { asked: false, question: null, originalIntent: 'خودتو معرفی کن', followUpResponse: null },
    });
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(false);
  });

  it('C5 — a real business question ("پلن حرفه‌ای شما چه امکاناتی دارد؟") DOES retrieve', async () => {
    const result = await ask('پلن حرفه‌ای شما چه امکاناتی دارد؟');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(1);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(true);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('domain_vocabulary_match');
  });

  it('C6 — business follow-up ("قیمتش چقدره؟") keeps business context and retrieves', async () => {
    const result = await ask('قیمتش چقدره؟', {
      followUpDetected: true,
      contextTurns: [
        { role: 'visitor', text: 'پلن حرفه‌ای شما چه امکاناتی دارد؟' },
        { role: 'assistant', text: '...', metadata: { kb_article_ids: ['kb-1'], qna_ids: [] } },
      ],
    });
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(1);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(true);
  });

  it('C7 — a purely referential follow-up retrieves when the previous turn used business knowledge', async () => {
    const result = await ask('اون آخری رو بیشتر توضیح بده', {
      followUpDetected: true,
      contextTurns: [
        { role: 'visitor', text: 'امکانات را بگو' },
        { role: 'assistant', text: '...', metadata: { kb_article_ids: ['kb-9'], qna_ids: [] } },
      ],
    });
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(1);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('business_follow_up');
  });
});

/**
 * ADVERSARIAL — page context is AMBIENT, never proof the turn is a business
 * question. The widget sits on /pricing for every one of these messages.
 */
describe('Page context present is not a business-knowledge requirement', () => {
  const PAGE = { currentPageUrl: 'https://acme.test/pricing', currentPageTitle: 'Pricing' };

  async function askOnPage(question: string, built: Record<string, any> = {}) {
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: question, retrievalQuery: question, expandedQuery: question, ...built,
    });
    return maybeRunAiAssistantAfterVisitorMessage(
      CONFIG, baseInput({ question, pageContext: PAGE }),
    );
  }

  function strategyMeta(): any {
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    return log?.metadata?.answer_strategy || {};
  }

  it('D-A — greeting on /pricing: no retrieval, no business grounding, no handoff', async () => {
    const result = await askOnPage('سلام');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(false);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('no_business_signal');
    expect(replyRetrievalMeta().business_signal_detected).toBe(false);
    expect(markNeedsHumanCalls.length).toBe(0);
    expect(strategyMeta().handoff_required).toBe(false);
  });

  it('D-B — identity question on /pricing: assistant name reaches the model, no strict-KB refusal', async () => {
    const result = await askOnPage('اسمت چیه؟');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(false);
    expect(lastPromptText()).toContain('Nova');
    expect(markNeedsHumanCalls.length).toBe(0);
  });

  it('D-C — "ممنون" on /pricing stays conversational', async () => {
    const result = await askOnPage('ممنون');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(0);
    expect(replyRetrievalMeta().business_signal_detected).toBe(false);
    expect(markNeedsHumanCalls.length).toBe(0);
  });

  it('D-D — "این پلن چه امکاناتی داره؟" on /pricing DOES retrieve (vocabulary), but vocabulary alone is not business evidence', async () => {
    const result = await askOnPage('این پلن چه امکاناتی داره؟');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(1);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(true);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('domain_vocabulary_match');
    expect(replyRetrievalMeta().business_signal_detected).toBe(false);
  });

  it('D-D2 — explicit page reference ("محتوای این صفحه چیه؟") IS business evidence', async () => {
    const result = await askOnPage('محتوای این صفحه چیه؟');
    expect(result.action).toBe('replied');
    expect(replyRetrievalMeta().business_signal_detected).toBe(true);
  });

  it('D-E — business-grounded follow-up on /pricing keeps retrieval', async () => {
    const result = await askOnPage('اون آخری رو بیشتر توضیح بده', {
      followUpDetected: true,
      contextTurns: [
        { role: 'visitor', text: 'امکانات را بگو' },
        { role: 'assistant', text: '...', metadata: { kb_article_ids: ['kb-9'], qna_ids: [] } },
      ],
    });
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(1);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('business_follow_up');
  });
});

describe('Strict knowledge-only mode + page context', () => {
  const PAGE = { currentPageUrl: 'https://acme.test/pricing', currentPageTitle: 'Pricing' };

  beforeEach(() => {
    settingsFixture = makeSettings({
      mode: 'auto_reply_always',
      agent_name: 'Nova',
      answer_only_from_kb: true,
      handoff_when_no_kb_match: false,
      handoff_on_low_confidence: false,
    });
  });

  async function askOnPage(question: string) {
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: question, retrievalQuery: question, expandedQuery: question,
    });
    return maybeRunAiAssistantAfterVisitorMessage(
      CONFIG, baseInput({ question, pageContext: PAGE }),
    );
  }

  it('E1 — "تو کی هستی؟" under strict KB is answered from Assistant Config, not refused', async () => {
    const result = await askOnPage('تو کی هستی؟');
    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.requires_business_knowledge).toBe(false);
    expect(markNeedsHumanCalls.length).toBe(0);
    expect(lastPromptText()).toContain('Nova');
  });

  it('E2 — unverified business question does not invent facts and does not auto-handoff', async () => {
    const result = await askOnPage('هزینه ارسال به کانادا برای این پلن چقدره؟');
    expect(result.action).toBe('replied');
    expect(markNeedsHumanCalls.length).toBe(0);
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.answer_strategy.grounding_mode).toBe('unverified');
    expect(log.metadata.answer_strategy.handoff_required).toBe(false);
  });

  it('E3 — retrieval attempted with zero sources never hands off on its own', async () => {
    hybridImpl = async () => makeHybridResult({ sources: [] });
    const result = await askOnPage('قیمت پلن حرفه‌ای چقدره؟');
    expect(replyRetrievalMeta().retrieval_attempted).toBe(true);
    expect(result.action).toBe('replied');
    expect(markNeedsHumanCalls.length).toBe(0);
  });
});

/**
 * FINAL CLEANUP — static domain vocabulary is a RETRIEVAL OPTIMIZATION only.
 * It may trigger a (speculative) retrieval, but it must never by itself make
 * the turn "business knowledge required" / strictly workspace-grounded.
 */
describe('Domain vocabulary triggers retrieval but is not business evidence', () => {
  async function ask(question: string) {
    builtQueryImpl = async () => makeBuiltQuery({
      originalMessage: question, retrievalQuery: question, expandedQuery: question,
    });
    return maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question }));
  }
  function strategyMeta(): any {
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    return log?.metadata?.answer_strategy || {};
  }

  it('F1 — "یه فاکتور مهم برای انتخاب هاست چیه؟" retrieves via vocabulary only', async () => {
    const result = await ask('یه فاکتور مهم برای انتخاب هاست چیه؟');
    expect(result.action).toBe('replied');
    expect(hybridCallCount).toBe(1);
    expect(replyRetrievalMeta().retrieval_attempted).toBe(true);
    expect(replyRetrievalMeta().retrieval_decision_reason).toBe('domain_vocabulary_match');
    expect(replyRetrievalMeta().business_signal_detected).toBe(false);
  });

  it('F2 — vocabulary retrieval with ZERO sources does not become strict business grounding', async () => {
    hybridImpl = async () => makeHybridResult({ sources: [] });
    const result = await ask('یه فاکتور مهم برای انتخاب هاست چیه؟');
    expect(result.action).toBe('replied');
    expect(strategyMeta().requires_business_knowledge).toBe(false);
    expect(strategyMeta().grounding_mode).toBe('unverified');
    expect(strategyMeta().handoff_required).toBe(false);
    expect(markNeedsHumanCalls.length).toBe(0);
  });

  it('F3 — the same turn WITH relevant retrieved sources is grounded business knowledge', async () => {
    hybridImpl = async () => makeHybridResult({
      sources: [makeHybridSource({ id: 'kb-1', kind: 'kb', title: 'Hosting plans', score: 0.9 })],
    });
    const result = await ask('یه فاکتور مهم برای انتخاب هاست چیه؟');
    expect(result.action).toBe('replied');
    expect(strategyMeta().requires_business_knowledge).toBe(true);
    expect(strategyMeta().grounding_mode).toBe('grounded');
  });

  it('F4 — an owner-configured workspace topic still counts as business evidence', () => {
    expect(isBusinessEvidenceReason('workspace_topic_match')).toBe(true);
    expect(isBusinessEvidenceReason('page_context_referenced')).toBe(true);
    expect(isBusinessEvidenceReason('business_follow_up')).toBe(true);
    expect(isBusinessEvidenceReason('domain_vocabulary_match')).toBe(false);
    expect(isBusinessEvidenceReason('no_business_signal')).toBe(false);
  });
});
