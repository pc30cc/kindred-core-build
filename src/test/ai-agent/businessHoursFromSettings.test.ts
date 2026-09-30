/**
 * The AI answers "what are your working hours?" from the business hours set
 * in the workspace panel — no knowledge-base entry needed — and a
 * knowledge-base entry about hours, when there is one, takes precedence.
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
import { describeBusinessHours } from '../../../server/services/widget/availability';

let settingsFixture = makeSettings();
let conversationStateFixture = makeConversationState();
let availabilityFixture = makeAvailability();
type LogCall = { runType?: string; metadata: { answer_strategy: { reason: string; grounding_mode: string } } };

let hybridImpl: () => Promise<unknown> = async () => makeHybridResult({ sources: [] });
let builtQueryImpl: () => Promise<unknown> = async () => makeBuiltQuery();
const logRunCalls: LogCall[] = [];
const prompts: string[] = [];
const insertAiMessageCalls: unknown[] = [];
const markNeedsHumanCalls: unknown[] = [];
let aiCallCount = 0;
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async () => {
    aiCallCount++;
    return makeAIResponse();
  },
  executeAICompletionWithConfig: async (_config: unknown, _ai: unknown, opts: { prompt?: string } | undefined) => {
    aiCallCount++;
    prompts.push(String(opts?.prompt || ''));
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
  retrieveHybridSources: () => hybridImpl(),
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
  logRun: async (_config: unknown, input: LogCall) => {
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
  insertAiMessage: async (_config: unknown, input: unknown) => {
    insertAiMessageCalls.push(input);
    return { id: `msg-${insertAiMessageCalls.length}` };
  },
  deriveAgentDisplay: (settings: { agent_name?: string; agent_logo_url?: string | null }) => ({
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
} as never;

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
    question: 'How do I reset my password?',
    ...overrides,
  };
}

beforeEach(() => {
  settingsFixture = makeSettings({ answer_only_from_kb: true, mode: 'auto_reply_always', handoff_when_no_kb_match: false, handoff_on_low_confidence: false });
  conversationStateFixture = makeConversationState();
  availabilityFixture = makeAvailability();
  hybridImpl = async () => makeHybridResult({ sources: [] });
  builtQueryImpl = async () => makeBuiltQuery();
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  markNeedsHumanCalls.length = 0;
  aiCallCount = 0;
  prompts.length = 0;
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
  });
  vi.clearAllMocks();
});


const schedule = describeBusinessHours(
  {
    enabled: true,
    timezone: 'Europe/Istanbul',
    weekly: { mon: [{ from: '09:00', to: '18:00' }], tue: [{ from: '09:00', to: '18:00' }] },
    overrides: [],
  },
  new Date('2026-09-28T08:00:00Z'), // Monday 11:00 in Istanbul
  null,
);

describe('business hours from the workspace panel', () => {
  beforeEach(() => {
    // The strictest owner policy: hand off whenever the knowledge base has nothing.
    settingsFixture = makeSettings({
      answer_only_from_kb: true, mode: 'auto_reply_always', handoff_when_no_kb_match: true, handoff_on_low_confidence: true,
    });
    builtQueryImpl = async () => makeBuiltQuery({
      followUpDetected: true,
      contextTurns: [
        { role: 'visitor', text: 'do you sell gift cards' },
        { role: 'assistant', text: '...', metadata: { kb_article_ids: ['kb-1'], qna_ids: [] } },
      ],
    });
  });

  it('answers from the configured schedule with nothing in the knowledge base', async () => {
    availabilityFixture = makeAvailability({ schedule });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'What are your working hours?' }));

    expect(result.action).toBe('replied');
    expect(aiCallCount).toBe(1);
    expect(markNeedsHumanCalls).toHaveLength(0);
    const log = logRunCalls.find((c) => c.runType === 'auto_reply')!;
    expect(log.metadata.answer_strategy.reason).toBe('workspace_settings_match');
    expect(log.metadata.answer_strategy.grounding_mode).toBe('grounded');
    expect(prompts[0]).toContain('get_business_hours: source=workspace_settings');
    expect(prompts[0]).toContain('weekly_hours=Monday 09:00-18:00; Tuesday 09:00-18:00; Wednesday closed');
    expect(prompts[0]).toContain('the SOURCES take precedence over get_business_hours');
  });

  it('puts a knowledge-base answer about hours first', async () => {
    availabilityFixture = makeAvailability({ schedule });
    hybridImpl = async () => makeHybridResult({
      sources: [makeHybridSource({ final_score: 0.9, keyword_score: 0.9, vector_score: 0.9, title: 'Opening hours', content: 'We are open 08:00-16:00 on weekdays.' })],
    });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'What are your working hours?' }));

    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply')!;
    expect(log.metadata.answer_strategy.reason).not.toBe('workspace_settings_match');
    const p = prompts[0];
    expect(p.indexOf('BEGIN SOURCES')).toBeGreaterThan(-1);
    expect(p.indexOf('BEGIN SOURCES')).toBeLessThan(p.indexOf('get_business_hours'));
    expect(p).toContain('the SOURCES take precedence over get_business_hours');
  });

  it('without configured hours, the owner policy still hands the question off', async () => {
    availabilityFixture = makeAvailability({ schedule: null });
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'What are your working hours?' }));

    expect(aiCallCount).toBe(0);
    expect(['handoff', 'no_answer']).toContain(result.action);
  });

  it('leaves questions that are not about hours alone', async () => {
    availabilityFixture = makeAvailability({ schedule });
    settingsFixture = makeSettings({
      answer_only_from_kb: false, mode: 'auto_reply_always', handoff_when_no_kb_match: false, handoff_on_low_confidence: false,
    });
    await maybeRunAiAssistantAfterVisitorMessage(CONFIG, baseInput({ question: 'How do I reset my password?' }));

    expect(aiCallCount).toBe(1);
    expect(prompts[0]).not.toContain('get_business_hours');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply')!;
    expect(log.metadata.answer_strategy.reason).not.toBe('workspace_settings_match');
  });
});
