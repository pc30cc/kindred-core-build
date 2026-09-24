/**
 * The bounded fallback for WHMCS fast-path misses, through the real engine
 * entrypoint (generationStage is real; provider, retrieval and persistence
 * are faked the same way the other engine suites fake them).
 *
 * The deterministic router misses some unseen phrasings (measured in
 * src/test/commerce/whmcsIntent.test.ts). When a billing connection is in
 * context and nothing was fetched, the SAME generation may name the account
 * section it needed in its private control block; the stage then runs once
 * for that section and the answer is regenerated once — only if real rows
 * came back, and never more than once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeFakeSupabase,
  makeSettings,
  makeConversationState,
  makeAvailability,
  makeHybridResult,
  makeAIResponse,
  makeBuiltQuery,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_VISITOR_MESSAGE_ID,
} from './helpers/engineFixtures.js';

type Req = { prompt: string; systemPrompt?: string };
type StageInput = { forcedIntent?: { kind: string; resource?: string } };

let fakeSb: ReturnType<typeof makeFakeSupabase>;
const completionRequests: Req[] = [];
let responses: string[] = [];
const insertAiMessageCalls: Array<{ body: string }> = [];
const stageInputs: StageInput[] = [];
let connectionsFixture: Array<Record<string, unknown>> = [];
let forcedResult: 'rows' | 'identity_required' = 'rows';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async () => makeAIResponse(),
  executeAICompletionWithConfig: async (_c: unknown, _cfg: unknown, req: Req) => {
    completionRequests.push(req);
    return makeAIResponse({ text: responses.shift() ?? 'fallback text' });
  },
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
}));
vi.mock('../../../server/services/commerce/connectionSelection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspaceConnections: async () => connectionsFixture,
}));
vi.mock('../../../server/services/ai-agent/commerce-tools/whmcsRunner.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runWhmcsToolStage: async (_c: unknown, input: StageInput) => {
      stageInputs.push(input);
      const base = { toolsUsed: [] as string[], urls: [] as string[], directive: 'ACCOUNT DATA RULES (billing system):', historyCutoff: null, selection: 'only_one', metrics: {} };
      if (!input.forcedIntent) return { ...base, toolResults: [], intent: 'none', directive: null };
      if (forcedResult === 'identity_required') {
        return { ...base, toolResults: [{ name: 'whmcs.status', data: { error_code: 'identity_required' } }], intent: 'account' };
      }
      return {
        ...base,
        intent: 'account',
        toolsUsed: ['whmcs.invoices.list'],
        urls: ['https://billing.example.com/viewinvoice.php?id=1001'],
        toolResults: [{ name: 'whmcs.invoices', data: { position: 1, number: 'INV-2026-001', status: 'Unpaid', total: '99.00', balance: '69.00', currency: 'USD', url: 'https://billing.example.com/viewinvoice.php?id=1001' } }],
      };
    },
  };
});
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishOperatorEvent: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => makeSettings({ mode: 'auto_reply_always', handoff_when_no_kb_match: false, handoff_on_low_confidence: false }),
}));
vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({ retrieveSources: async () => [] }));
vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({ retrieveHybridSources: async () => makeHybridResult({ sources: [] }) }));
vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countClarificationAttempts: async () => 0,
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ finalizeRun: async () => ({ ok: true as const, attempts: 1 }), logRun: async () => 'run-1' }));
vi.mock('../../../server/services/ai-agent/conversationState.js', () => ({ getConversationState: async () => makeConversationState(), markHandoffRequested: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({ getOperatorAvailability: async () => makeAvailability() }));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_c: unknown, input: { body: string }) => { insertAiMessageCalls.push(input); return { id: 'msg-1' }; },
  deriveAgentDisplay: () => ({ agentName: 'AI Assistant', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  markAiManaged: vi.fn(async () => {}),
  markNeedsHuman: vi.fn(async () => {}),
  commitNeedsHuman: vi.fn(async () => ({ ok: true, routingDeferred: false })),
  routeAfterHandoff: vi.fn(async () => {}),
}));
vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({ isConversationSpam: async () => false }));
vi.mock('../../../server/services/ai-agent/queryBuilder.js', () => ({ buildRetrievalQuery: async () => makeBuiltQuery() }));
vi.mock('../../../server/services/ai-agent/runtimeConfig.js', () => ({ loadAiAgentRuntimeConfig: async () => null }));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/platformRegion.js', () => ({ getPlatformAllowedLocales: async () => ['en'] }));
vi.mock('../../../server/services/ai-agent/workspaceContext.js', () => ({ loadWorkspaceContext: async () => null }));
vi.mock('../../../server/services/ai-agent/learning/candidates.js', () => ({ maybeCreateLearningCandidateFromAiSkip: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/runtime/conversationState.js', () => ({ updateRuntimeFlags: vi.fn(async () => {}) }));

const { maybeRunAiAssistantAfterVisitorMessage } = await import('../../../server/services/ai-agent/engine.js');
const CONFIG = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'ANON', supabaseServiceRoleKey: 'SERVICE' } as Parameters<typeof maybeRunAiAssistantAfterVisitorMessage>[0];

const WHMCS_CONNECTION = {
  id: 'conn-whmcs', workspace_id: DEFAULT_WORKSPACE_ID, installation_id: 'inst', provider_type: 'whmcs',
  store_id: 'https://billing.example.com', approved_origin: 'https://billing.example.com', capabilities: [], permissions: {},
  health: 'connected', catalog_ready: false, revoked_at: null, protocol_version: 'webyar-commerce/1',
};

const control = (json: Record<string, unknown>) => `<ai_control>${JSON.stringify(json)}</ai_control>`;
const ask = (question: string) => maybeRunAiAssistantAfterVisitorMessage(CONFIG, {
  workspaceId: DEFAULT_WORKSPACE_ID, conversationId: DEFAULT_CONVERSATION_ID, visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID, question,
} as Parameters<typeof maybeRunAiAssistantAfterVisitorMessage>[1]);

beforeEach(() => {
  completionRequests.length = 0;
  insertAiMessageCalls.length = 0;
  stageInputs.length = 0;
  responses = [];
  forcedResult = 'rows';
  connectionsFixture = [WHMCS_CONNECTION];
  fakeSb = makeFakeSupabase({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }],
    conversations: [{ id: DEFAULT_CONVERSATION_ID, metadata: {} }],
  });
});

describe('model-signalled account data (fast-path miss)', () => {
  it('offers account_data only when a billing connection is in context', async () => {
    responses = ['Hello!'];
    await ask('did you get my payment?');
    expect(completionRequests[0].systemPrompt).toContain('"account_data"');

    completionRequests.length = 0;
    connectionsFixture = [];
    responses = ['Hello!'];
    await ask('did you get my payment?');
    expect(completionRequests[0].systemPrompt).not.toContain('"account_data"');
  });

  it('fetches the named section once and regenerates once with the rows', async () => {
    responses = [
      `I need to look that up. ${control({ account_data: 'invoices' })}`,
      'Your invoice INV-2026-001 has 69.00 USD left to pay.',
    ];
    const result = await ask('did you get my payment?');
    expect(result.action).toBe('replied');
    expect(stageInputs.map((i) => i.forcedIntent?.resource ?? null)).toEqual([null, 'invoices']);
    expect(completionRequests).toHaveLength(2);
    expect(completionRequests[1].prompt).toContain('whmcs.invoices: position=1, number=INV-2026-001');
    expect(completionRequests[1].prompt).toContain('ACCOUNT DATA RULES');
    expect(insertAiMessageCalls[0].body).toBe('Your invoice INV-2026-001 has 69.00 USD left to pay.');
  });

  it('a refusal (not signed in) costs no second generation', async () => {
    forcedResult = 'identity_required';
    responses = [`Please sign in to your client area to see invoices. ${control({ account_data: 'invoices' })}`];
    await ask('did you get my payment?');
    expect(completionRequests).toHaveLength(1);
    expect(insertAiMessageCalls[0].body).toBe('Please sign in to your client area to see invoices.');
  });

  it('is bounded: a second request from the regenerated answer is ignored', async () => {
    responses = [
      `x ${control({ account_data: 'invoices' })}`,
      `Here it is. ${control({ account_data: 'tickets' })}`,
    ];
    await ask('did you get my payment?');
    expect(completionRequests).toHaveLength(2);
    expect(stageInputs).toHaveLength(2);
    expect(insertAiMessageCalls[0].body).toBe('Here it is.');
  });

  it('an unknown section name is ignored', async () => {
    responses = [`Hi ${control({ account_data: 'passwords' })}`];
    await ask('did you get my payment?');
    expect(completionRequests).toHaveLength(1);
    expect(stageInputs).toHaveLength(1);
  });
});
