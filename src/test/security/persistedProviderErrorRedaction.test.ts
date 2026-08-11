/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles are intentionally untyped. */
/**
 * P1 — credential redaction must hold on the ACTUAL persistence payloads, not
 * only in redactSecrets() unit tests.
 *
 * Covered persistence paths:
 *   1. limit-handoff metadata written by the AI engine generation stage
 *      (extraMetadata.original_error)
 *   2. the operator-assist run record written by the suggest-reply route
 *      (ai_operator_assist_runs.error)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const CREDENTIALS = [
  'sk-proj-ABC123456789',
  'secret-token',
  'hunter2hunter2',
];

const DIRTY_ERROR =
  'OpenAI failed Authorization: Bearer secret-token sk-proj-ABC123456789 client_secret=hunter2hunter2 (no_credits)';

function assertRedacted(value: unknown) {
  const s = String(value);
  for (const c of CREDENTIALS) expect(s).not.toContain(c);
  expect(s).toContain('[redacted]');
}

// ── 1. Engine limit-handoff metadata ────────────────────────────────────
const limitHandoffCalls: any[] = [];
let aiError: any = new Error(DIRTY_ERROR);

vi.mock('../../../server/services/ai/index.js', () => ({
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
  executeAICompletionWithConfig: async () => { throw aiError; },
  executeAICompletion: async () => { throw aiError; },
}));

vi.mock('../../../server/services/ai-agent/limitHandoff.js', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return {
    ...actual,
    runLimitHandoff: async (_c: any, input: any) => {
      limitHandoffCalls.push(input);
      return { runId: 'run_lh', messageId: 'msg_lh' };
    },
  };
});

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  logRun: async () => 'run_x',
}));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async () => ({ id: 'm1' }),
  deriveAgentDisplay: () => ({ agentName: 'AI', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  markNeedsHuman: async () => {},
}));
vi.mock('../../../server/services/ai-agent/conversationState.js', () => ({
  markHandoffRequested: async () => {},
}));
vi.mock('../../../server/services/ai-agent/workspaceContext.js', () => ({
  loadWorkspaceContext: async () => ({}),
}));

const { runGenerationStage } = await import('../../../server/services/ai-agent/engine/generationStage.js');

function genArgs() {
  return [
    {} as any,
    { workspaceId: 'ws', conversationId: 'c1', visitorMessageId: 'v1', question: 'hi' } as any,
    { settings: { mode: 'auto', answer_guidance: 'balanced' }, runtimeCfg: null, decisionTimeline: [], pageContext: null } as any,
    {
      sb: { from: () => ({}) }, locale: 'en', inputLanguage: 'en', languageMeta: {},
      detectedTopicsMeta: {}, topTopicSlug: null, guidanceMeta: {}, availability: {},
    } as any,
    {} as any,
    { decision: { canAutoReply: true, canSuggest: false } } as any,
    { sources: [], queryMeta: {} } as any,
    {
      strategy: { confidence: 0.9, decisionType: 'answer', retrievalStrength: 'strong' },
      strategyMeta: {}, pageExact: false, pagePath: false, triggerMeta: {}, workflowMeta: {},
      toolMeta: {}, pageContextMetaRef: {}, routingMeta: {},
    } as any,
  ] as const;
}

describe('limit-handoff metadata persistence', () => {
  beforeEach(() => { limitHandoffCalls.length = 0; aiError = new Error(DIRTY_ERROR); });

  it('never persists raw provider credentials in extraMetadata.original_error', async () => {
    const r: any = await (runGenerationStage as any)(...genArgs());
    expect(r.terminal?.action).toBe('handoff');
    expect(limitHandoffCalls).toHaveLength(1);
    assertRedacted(limitHandoffCalls[0].extraMetadata.original_error);
  });

  it('keeps ordinary limit diagnostics readable', async () => {
    aiError = new Error('workspace is out of credits: quota exhausted, model gpt-4o-mini');
    await (runGenerationStage as any)(...genArgs());
    expect(limitHandoffCalls[0].extraMetadata.original_error)
      .toBe('workspace is out of credits: quota exhausted, model gpt-4o-mini');
  });
});

// ── 2. Operator-assist run persistence ──────────────────────────────────
const assistInserts: any[] = [];
let assistLlmError: any = new Error(DIRTY_ERROR);

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    rpc: async () => ({ error: null }),
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: async () => ({ data: [{ id: 'm1', sender_type: 'visitor', body: 'how do refunds work?', created_at: '2026-01-01' }], error: null }),
        maybeSingle: async () => {
          if (table === 'conversations') return { data: { id: '22222222-2222-4222-8222-222222222222', workspace_id: '11111111-1111-4111-8111-111111111111' }, error: null };
          return { data: { id: 'assist_1' }, error: null };
        },
        insert: (row: any) => { assistInserts.push({ table, row }); return chain; },
      };
      return chain;
    },
  }),
}));

vi.mock('../../../server/routes/ai-agent/shared.js', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return { ...actual, authorizeMember: async () => ({ userId: 'u1', isAdmin: true, role: 'owner' }) };
});

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, plan: 'pro', reason: null }),
}));

vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => ({ mode: 'auto', answer_guidance: 'balanced', allowed_locales: ['en'] }),
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => ({ sources: [], retrievalDebug: {}, hybridUsed: false }),
}));

const { operatorAssistRouter } = await import('../../../server/routes/ai-agent/operatorAssist.js');

function assistApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).serverConfig = { supabaseUrl: 'x', supabaseServiceRoleKey: 'y' }; next(); });
  app.use('/api/ai-agent', operatorAssistRouter);
  return app;
}

async function callAssist() {
  return request(assistApp())
    .post('/api/ai-agent/operator/suggest-reply')
    .set('authorization', 'Bearer t')
    .send({ workspaceId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222', callLLM: true });
}

describe('operator-assist run persistence', () => {
  beforeEach(() => { assistInserts.length = 0; assistLlmError = new Error(DIRTY_ERROR); aiError = assistLlmError; });

  it('LLM failure is persisted with credentials redacted', async () => {
    const res = await callAssist();
    expect(res.status).toBe(502);
    const run = assistInserts.find((i) => i.table === 'ai_operator_assist_runs');
    expect(run).toBeTruthy();
    assertRedacted(run.row.error);
  });

  it('HTTP response details never expose raw credentials', async () => {
    aiError = new Error(DIRTY_ERROR);
    const res = await callAssist();
    expect(res.status).toBe(502);
    const run = assistInserts.find((i) => i.table === 'ai_operator_assist_runs');
    assertRedacted(run.row.error);
    assertRedacted(res.body.details);
    expect(res.body.error).toBe('llm_failed');
  });

  it('response details fall back to unknown_error when message is empty', async () => {
    aiError = new Error('');
    const res = await callAssist();
    expect(res.status).toBe(502);
    expect(res.body.details).toBe('unknown_error');
  });

  it('safety notes and error stay readable for ordinary diagnostics', async () => {
    aiError = new Error('AI network error: ECONNRESET, model not found, rate limit reached');
    const res = await callAssist();
    expect(res.status).toBe(502);
    const run = assistInserts.find((i) => i.table === 'ai_operator_assist_runs');
    expect(run.row.error).toBe('AI network error: ECONNRESET, model not found, rate limit reached');
    expect(JSON.stringify(run.row.safety_notes)).toContain('ECONNRESET');
  });

  it('query-string and header style credentials are redacted too', async () => {
    aiError = new Error('GET https://api.openai.com/v1?api_key=AAAABBBBCCCCDDDD x-api-key: sk-proj-ABC123456789');
    const res = await callAssist();
    expect(res.status).toBe(502);
    const run = assistInserts.find((i) => i.table === 'ai_operator_assist_runs');
    expect(String(run.row.error)).not.toContain('AAAABBBBCCCCDDDD');
    expect(String(run.row.error)).not.toContain('sk-proj-ABC123456789');
    expect(String(run.row.error)).toContain('[redacted]');
  });
});
