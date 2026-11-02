/* eslint-disable @typescript-eslint/no-explicit-any -- the engine's test doubles are intentionally untyped, as in handoff.test.ts. */
/**
 * The "Personality & behavior" settings, end to end through the real engine
 * (maybeRunAiAssistantAfterVisitorMessage): every stage runs for real; the
 * provider, the run log, the message insert and a few reads are fakes, and
 * the data layer is engineFixtures' fake Supabase (working memory included,
 * so a second visitor message sees what the first one left).
 *
 *   - reply language: instructions.reply_language 'workspace_default' answers
 *     in the workspace's default language when allowed; it never passes the
 *     platform's languages or allowed_locales; 'visitor' is unchanged.
 *   - clarifying questions: the owner's switch and limit reach the prompt; a
 *     reply that is a clarifying question is recorded as one; only replies
 *     the visitor received count.
 *   - "the visitor asks for a person" per handoff policy: immediate hands
 *     over at once; assist_first makes ONE attempt and hands over on the
 *     second request (it used to hand over at once: decideStrategy repeated
 *     the explicit-request check after the policy chose to assist); adaptive
 *     skips the attempt when the visitor rejects the AI; the switch off never
 *     hands over.
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
} from './helpers/engineFixtures.js';

// No burst debounce: each call is one visitor message answered at once.
process.env.AI_RESPONSE_DEBOUNCE_MS = '0';

let settingsFixture = makeSettings();
let platformLocales = ['en', 'fa', 'tr'];
let hybridImpl: () => Promise<any> = async () => makeHybridResult({ sources: [makeHybridSource()] });
let aiText = 'Here is the answer to your question.';
const aiCalls: Array<{ systemPrompt: string; prompt: string }> = [];
const logRunCalls: any[] = [];
const insertAiMessageCalls: any[] = [];
const commitCalls: any[] = [];
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai/index.js', () => {
  const complete = async (...args: any[]) => {
    const input = args.find((a) => a && typeof a === 'object' && 'systemPrompt' in a);
    aiCalls.push({ systemPrompt: input.systemPrompt, prompt: input.prompt });
    return makeAIResponse({ text: aiText });
  };
  return {
    executeAICompletion: complete,
    executeAICompletionWithConfig: complete,
    resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
  };
});
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishOperatorEvent: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({ getOrCreateSettings: async () => settingsFixture }));
vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({ retrieveSources: async () => [] }));
vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({ retrieveHybridSources: () => hybridImpl() }));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
  logRun: async (_config: any, input: any) => {
    logRunCalls.push(input);
    return `run-${logRunCalls.length}`;
  },
}));
vi.mock('../../../server/services/ai-agent/conversationState.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getConversationState: async () => makeConversationState(),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({ getOperatorAvailability: async () => makeAvailability() }));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_config: any, input: any) => {
    insertAiMessageCalls.push(input);
    return { id: `msg-${insertAiMessageCalls.length}` };
  },
  deriveAgentDisplay: (s: any) => ({ agentName: s.agent_name || 'AI Assistant', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    markAiManaged: vi.fn(async () => {}),
    commitNeedsHuman: async (config: any, input: any) => {
      commitCalls.push(input);
      return actual.commitNeedsHuman(config, input);
    },
    routeAfterHandoff: async () => {},
  };
});
vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({ isConversationSpam: async () => false }));
vi.mock('../../../server/services/ai-agent/queryBuilder.js', () => ({ buildRetrievalQuery: async () => makeBuiltQuery() }));
vi.mock('../../../server/services/ai-agent/runtimeConfig.js', () => ({ loadAiAgentRuntimeConfig: async () => null }));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/platformRegion.js', () => ({ getPlatformAllowedLocales: async () => platformLocales }));
vi.mock('../../../server/services/ai-agent/workspaceContext.js', () => ({ loadWorkspaceContext: async () => null }));
vi.mock('../../../server/services/ai-agent/learning/candidates.js', () => ({ maybeCreateLearningCandidateFromAiSkip: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/runtime/conversationState.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  updateRuntimeFlags: vi.fn(async () => {}),
}));

const { maybeRunAiAssistantAfterVisitorMessage } = await import('../../../server/services/ai-agent/engine.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;

let messageSeq = 0;
function ask(question: string, extra: Record<string, unknown> = {}) {
  messageSeq += 1;
  return maybeRunAiAssistantAfterVisitorMessage(CONFIG, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    visitorMessageId: `vmsg-${messageSeq}`,
    question,
    ...extra,
  });
}

function seedDb(opts: { defaultLocale?: string; runs?: any[] } = {}) {
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Tea House', default_locale: opts.defaultLocale ?? 'fa', widget_locale: 'auto' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, workspace_id: DEFAULT_WORKSPACE_ID, metadata: {} }],
    ai_agent_runs: (opts.runs || []).map((r, i) => ({ id: `old-run-${i}`, conversation_id: DEFAULT_CONVERSATION_ID, ...r })),
  });
}

const replyRun = () => logRunCalls.find((c) => c.runType === 'auto_reply');

beforeEach(() => {
  settingsFixture = makeSettings({ mode: 'auto_reply_always', allowed_locales: ['fa', 'en', 'tr'] });
  platformLocales = ['en', 'fa', 'tr'];
  hybridImpl = async () => makeHybridResult({ sources: [makeHybridSource()] });
  aiText = 'Here is the answer to your question.';
  aiCalls.length = 0;
  logRunCalls.length = 0;
  insertAiMessageCalls.length = 0;
  commitCalls.length = 0;
  seedDb();
});

describe('reply language (instructions.reply_language)', () => {
  const withReplyLanguage = (reply_language: string | undefined, extra: Record<string, unknown> = {}) =>
    makeSettings({ mode: 'auto_reply_always', allowed_locales: ['fa', 'en', 'tr'], instructions: reply_language ? { reply_language } : {}, ...extra });

  it("'visitor' (unset): an English question is answered in English, as before", async () => {
    settingsFixture = withReplyLanguage(undefined);
    expect((await ask('how do I reset my password please')).action).toBe('replied');
    expect(replyRun().metadata.locale).toBe('en');
    expect(replyRun().metadata.language.reply_language).toBe('visitor');
  });

  it("'workspace_default': the same question is answered in the workspace's default language", async () => {
    settingsFixture = withReplyLanguage('workspace_default');
    expect((await ask('how do I reset my password please')).action).toBe('replied');
    expect(replyRun().metadata.locale).toBe('fa');
    expect(replyRun().metadata.language).toMatchObject({ reply_language: 'workspace_default', language_decision_source: 'workspace_default', input_language: 'en' });
    expect(aiCalls[0].systemPrompt).toContain('Response language: fa');
  });

  it("'workspace_default' also wins over the language a channel reported", async () => {
    settingsFixture = withReplyLanguage('workspace_default');
    await ask('how do I reset my password please', { locale: 'tr' });
    expect(replyRun().metadata.locale).toBe('fa');
  });

  it('a default outside allowed_locales is not used: the visitor rule decides', async () => {
    settingsFixture = withReplyLanguage('workspace_default', { allowed_locales: ['en', 'tr'] });
    await ask('how do I reset my password please');
    expect(replyRun().metadata.locale).toBe('en');
  });

  it("the platform's languages are never passed: a Persian default on an en/tr platform is not used", async () => {
    platformLocales = ['en', 'tr'];
    settingsFixture = withReplyLanguage('workspace_default');
    await ask('how do I reset my password please');
    expect(replyRun().metadata.locale).toBe('en');
  });
});

describe('clarifying questions', () => {
  const CLARIFYING = 'Which plan do you mean?<ai_control>{"clarifying_question":true}</ai_control>';

  it('allowed: the prompt offers one, and a clarifying reply is recorded as one (run and message)', async () => {
    aiText = CLARIFYING;
    expect((await ask('how much is it')).action).toBe('replied');

    expect(aiCalls[0].systemPrompt).toContain('ask ONE short clarifying question');
    expect(replyRun().metadata.answer_strategy).toMatchObject({
      decision_type: 'ask_clarifying_question', clarifying_question_source: 'model', strategy_decision_type: 'answer',
    });
    expect(insertAiMessageCalls[0]).toMatchObject({ body: 'Which plan do you mean?', decisionType: 'ask_clarifying_question' });
  });

  it('without a status block, a reply that is one short question is recognised by its shape', async () => {
    aiText = 'Which plan do you mean?';
    await ask('how much is it');
    expect(replyRun().metadata.answer_strategy).toMatchObject({ decision_type: 'ask_clarifying_question', clarifying_question_source: 'shape' });
  });

  it('an ordinary answer, or a short question the model says is not one, stays an answer', async () => {
    await ask('how much is it');
    expect(replyRun().metadata.answer_strategy.decision_type).toBe('answer');

    logRunCalls.length = 0;
    aiText = 'Anything else I can help with?<ai_control>{"clarifying_question":false}</ai_control>';
    await ask('thanks');
    expect(replyRun().metadata.answer_strategy.decision_type).toBe('answer');
  });

  it('the limit reached (one asked, max 1): the prompt says not to ask another', async () => {
    seedDb({ runs: [{ status: 'replied', metadata: { answer_strategy: { decision_type: 'ask_clarifying_question' } } }] });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    await ask('how much is it');

    expect(aiCalls[0].systemPrompt).toContain('You already asked the visitor 1 clarifying question in this conversation');
    expect(aiCalls[0].systemPrompt).not.toContain('ask ONE short clarifying question');
    expect(aiCalls[0].prompt).toContain('Do not ask a clarifying question.');
    expect(replyRun().metadata.answer_strategy.clarification_attempt_count).toBe(1);
  });

  it('a raised limit leaves room: one asked of max 3 still allows one', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', max_clarification_attempts: 3 });
    seedDb({ runs: [{ status: 'replied', metadata: { answer_strategy: { decision_type: 'ask_clarifying_question' } } }] });
    await ask('how much is it');
    expect(aiCalls[0].systemPrompt).toContain('ask ONE short clarifying question');
  });

  it("a suggestion the visitor never received does not count", async () => {
    seedDb({ runs: [{ status: 'suggested', metadata: { answer_strategy: { decision_type: 'ask_clarifying_question' } } }] });
    await ask('how much is it');
    expect(replyRun().metadata.answer_strategy.clarification_attempt_count).toBe(0);
    expect(aiCalls[0].systemPrompt).toContain('ask ONE short clarifying question');
  });

  it('turned off: the prompt forbids them', async () => {
    settingsFixture = makeSettings({ mode: 'auto_reply_always', allow_clarifying_questions: false });
    hybridImpl = async () => makeHybridResult({ sources: [] });
    await ask('how much is it');

    expect(aiCalls[0].systemPrompt).toContain('Never ask the visitor a clarifying question');
    expect(aiCalls[0].systemPrompt).not.toContain('ask ONE short clarifying question');
    expect(aiCalls[0].prompt).toContain('Do not ask a clarifying question.');
  });

  it('a clarifying question is never post-validated into a handoff ("not sure which…")', async () => {
    aiText = "I'm not sure which plan you mean, could you tell me?<ai_control>{\"clarifying_question\":true}</ai_control>";
    const result = await ask('how much is it');
    expect(result.action).toBe('replied');
    expect(commitCalls).toEqual([]);
  });
});

describe('the visitor asks for a person, per handoff policy', () => {
  const ASK_HUMAN = 'I want to talk to a human';
  const withPolicy = (handoff_policy: string | null, extra: Record<string, unknown> = {}) =>
    makeSettings({ mode: 'auto_reply_always', handoff_policy, max_assist_attempts: 1, ...extra });

  it('legacy (no policy, switch on): hands over at once, no model call', async () => {
    settingsFixture = withPolicy(null);
    const result = await ask(ASK_HUMAN);
    expect(result.action).toBe('handoff');
    expect(aiCalls).toHaveLength(0);
    expect(commitCalls).toHaveLength(1);
  });

  it("'immediate': hands over at once, no model call", async () => {
    settingsFixture = withPolicy('immediate');
    expect((await ask(ASK_HUMAN)).action).toBe('handoff');
    expect(aiCalls).toHaveLength(0);
  });

  it("'assist_first': ONE attempt (no transfer claimed), then the second request hands over", async () => {
    settingsFixture = withPolicy('assist_first');

    const first = await ask(ASK_HUMAN);
    expect(first.action).toBe('replied');
    expect(commitCalls).toEqual([]);
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].prompt).toContain('TURN DIRECTIVE — the visitor asked for a human. A transfer has NOT happened.');
    expect(replyRun().metadata.answer_strategy.decision_type).not.toBe('handoff');

    const second = await ask(ASK_HUMAN);
    expect(second.action).toBe('handoff');
    expect(aiCalls).toHaveLength(1);
    const handoffRun = logRunCalls.find((c) => c.runType === 'handoff');
    expect(handoffRun.metadata).toMatchObject({ handoff_policy: 'assist_first', handoff_decision: 'handoff', handoff_decision_reason: 'repeated_human_request' });
  });

  it("'assist_first' with 0 attempts hands over at once", async () => {
    settingsFixture = withPolicy('assist_first', { max_assist_attempts: 0 });
    expect((await ask(ASK_HUMAN)).action).toBe('handoff');
    expect(aiCalls).toHaveLength(0);
  });

  it("'adaptive': a visitor rejecting the AI is handed over at once; a plain request gets one attempt", async () => {
    settingsFixture = withPolicy('adaptive');
    expect((await ask("I don't want a bot, give me a real person")).action).toBe('handoff');
    expect(aiCalls).toHaveLength(0);
    expect(logRunCalls.find((c) => c.runType === 'handoff').metadata.handoff_decision_reason).toBe('visitor_rejected_ai');

    seedDb();
    logRunCalls.length = 0;
    expect((await ask(ASK_HUMAN)).action).toBe('replied');
    expect(aiCalls).toHaveLength(1);
  });

  it('the switch off: the AI keeps answering, whatever the policy says, every time', async () => {
    for (const policy of [null, 'assist_first']) {
      seedDb();
      settingsFixture = withPolicy(policy, { handoff_on_human_request: false });
      expect((await ask(ASK_HUMAN)).action).toBe('replied');
      expect((await ask(ASK_HUMAN)).action).toBe('replied');
    }
    expect(commitCalls).toEqual([]);
  });
});
