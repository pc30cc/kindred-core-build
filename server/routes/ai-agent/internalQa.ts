/**
 * AI Agent router — internalQa domain.
 *
 * Mechanically extracted from the original server/routes/aiAgent.ts (Phase 3
 * router split). Route paths, middleware order, auth, validation, rate
 * limits and response shapes are unchanged from the original file.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { requireModule } from '../../middleware/featureGating.js';
import { getOrCreateSettings } from '../../services/ai-agent/settings.js';
import { runPlayground } from '../../services/ai-agent/playground.js';
import { retrieveHybridSources } from '../../services/ai-agent/retrievalHybrid.js';
import { getSourceHealth, type HealthSourceType } from '../../services/ai-agent/sourceHealth.js';
import { runDryRun } from '../../services/ai-agent/overview.js';
import {
  runDryRunTest as e6_runDryRunTest,
  evaluateExpectations as e6_evaluateExpectations,
  type DryRunResult as E6DryRunResult,
} from '../../services/ai-agent/testHarness.js';
import {
  suggestFromAssistFeedback as e9_suggestFromAssistFeedback,
  suggestFromFailedTestRun as e9_suggestFromFailedTestRun,
  listSuggestedCases as e9_listSuggestedCases,
  acceptSuggestedCase as e9_acceptSuggestedCase,
  rejectSuggestedCase as e9_rejectSuggestedCase,
} from '../../services/ai-agent/regressionSuggestions.js';
import {
  listRegressionSchedules as e10_listSchedules,
  getOrCreateDefaultRegressionSchedule as e10_getOrCreateSchedule,
  updateRegressionSchedule as e10_updateSchedule,
  enqueueRegressionBatch as e10_enqueueBatch,
  listRegressionBatches as e10_listBatches,
  getRegressionBatchDetail as e10_getBatchDetail,
  claimQueuedBatch as e10_claimBatch,
  runRegressionBatch as e10_runBatch,
  cancelRegressionBatch as e10_cancelBatch,
  retryFailedRegressionBatch as e10_retryFailed,
  getRegressionOverview as e11_getOverview,
  exportRegressionBatchCsv as e11_exportBatchCsv,
} from '../../services/ai-agent/regressionRunner.js';
import { authorizeMember, isOwnerOrAdmin, requireWorkspace, redactDeep } from './shared.js';

export const internalQaRouter: Router = express.Router();


// ─── Phase 1 in-memory rate limit for playground tests ───
// 30 tests / 5 min per (workspace,user). Documented as temporary safeguard
// until usage-metering for playground is wired up in Phase 2.
const playgroundCounters = new Map<string, { count: number; windowStart: number }>();
const PLAYGROUND_LIMIT = 30;
const PLAYGROUND_WINDOW = 5 * 60_000;
function checkPlaygroundRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = playgroundCounters.get(key);
  if (!c || now - c.windowStart > PLAYGROUND_WINDOW) {
    playgroundCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= PLAYGROUND_LIMIT;
}

// ─── E6 Test-Harness in-memory rate limits (workspace:user scope) ───
const e6TestCounters = new Map<string, { count: number; windowStart: number }>();
const E6_TEST_LIMIT = 30;
const E6_TEST_WINDOW = 5 * 60_000;
const e6BulkCounters = new Map<string, { count: number; windowStart: number }>();
const E6_BULK_LIMIT = 3;
const E6_BULK_WINDOW = 10 * 60_000;
const E6_BULK_MAX_CASES = 50;
function checkE6TestRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = e6TestCounters.get(key);
  if (!c || now - c.windowStart > E6_TEST_WINDOW) {
    e6TestCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= E6_TEST_LIMIT;
}
function checkE6BulkRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = e6BulkCounters.get(key);
  if (!c || now - c.windowStart > E6_BULK_WINDOW) {
    e6BulkCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= E6_BULK_LIMIT;
}


// ─── POST /playground/test ───
const playgroundSchema = z.object({
  workspaceId: z.string().uuid(),
  question: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  guidanceOverride: z.enum(['conservative','balanced','creative']).optional(),
  modelOverride: z.string().max(100).optional(),
});

// Phase 1 entitlement enforcement: playground is by definition an
// `ai_assistant` module surface — gate it with the canonical middleware
// so plan/override changes take effect uniformly. Existing per-user
// rate limit and member auth are preserved.
internalQaRouter.post('/playground/test', requireModule('ai_assistant'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = playgroundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, question, locale, guidanceOverride, modelOverride } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  if (!checkPlaygroundRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({
      error: 'playground_rate_limited',
      message: `Limit ${PLAYGROUND_LIMIT} tests per 5 minutes per user.`,
    });
  }

  try {
    const result = await runPlayground(config, {
      workspaceId,
      question,
      locale: locale || 'en',
      guidanceOverride,
      modelOverride,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'playground_failed', details: err?.message });
  }
});

// ─── E5 — Retrieval Debugger ───
// POST /debug/retrieval — runs retrieval ONLY. No message insert, no workflows,
// no MCP/tools, no learning, no handoff, no LLM call, no visitor side-effects.
const debugRetrievalSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  pageContext: z.object({
    currentPageUrl: z.string().max(2000).nullable().optional(),
    currentPageOrigin: z.string().max(500).nullable().optional(),
    currentPagePath: z.string().max(1000).nullable().optional(),
    currentPageTitle: z.string().max(500).nullable().optional(),
  }).nullish(),
});
const debugCounters = new Map<string, { count: number; windowStart: number }>();
const DEBUG_LIMIT = 30;
const DEBUG_WINDOW = 5 * 60_000;
function checkDebugRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = debugCounters.get(key);
  if (!c || now - c.windowStart > DEBUG_WINDOW) {
    debugCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= DEBUG_LIMIT;
}

internalQaRouter.post('/debug/retrieval', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = debugRetrievalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, message, locale, pageContext } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkDebugRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'debug_rate_limited', message: `Limit ${DEBUG_LIMIT} runs per 5 minutes per user.` });
  }

  try {
    const hybrid = await retrieveHybridSources(config, {
      workspaceId,
      originalMessage: message,
      retrievalQuery: message,
      expandedQuery: message,
      responseLanguage: locale || 'en',
      inputLanguage: locale || 'en',
      limit: 8,
      pageContext: pageContext ? {
        currentPageUrl: pageContext.currentPageUrl ?? null,
        currentPageOrigin: pageContext.currentPageOrigin ?? null,
        currentPagePath: pageContext.currentPagePath ?? null,
        currentPageTitle: pageContext.currentPageTitle ?? null,
      } : null,
    });

    const top = hybrid.sources[0];
    let recommendation: 'answer_possible' | 'needs_clarification' | 'handoff_likely' | 'no_answer_likely';
    if (!top) recommendation = 'no_answer_likely';
    else if (top.final_score >= 0.55) recommendation = 'answer_possible';
    else if (top.final_score >= 0.3) recommendation = 'needs_clarification';
    else recommendation = 'handoff_likely';

    // Best-effort observability event (no visitor side-effect).
    const sb = getServiceClient(config);
    try {
      await sb.from('ai_agent_debug_events').insert({
        workspace_id: workspaceId,
        run_id: null,
        event_type: 'retrieval_debug_run',
        actor_user_id: auth.userId,
        metadata: { top_score: top?.final_score ?? 0, count: hybrid.sources.length },
      });
    } catch { /* noop */ }

    return res.json(redactDeep({
      retrieval_debug: hybrid.retrievalDebug,
      excluded_summary: hybrid.excludedSummary,
      page_context_debug: hybrid.pageContextDebug,
      recommendation,
      // Sources without raw content (preview already capped in retrieval_debug.selected_sources).
      sources: hybrid.sources.map((s) => ({
        id: s.source_id,
        source_type: s.source_type,
        title: s.title,
        source_url: s.source_type === 'file' ? null : (s.source_url || null),
        locale: s.locale,
        final_score: s.final_score,
        keyword_score: s.keyword_score,
        vector_score: s.vector_score,
        topic_boost: s.topic_boost,
        url_boost: s.url_boost,
        locale_bonus: s.locale_bonus,
        source_priority: s.source_priority,
        content_preview: ((s.content || s.excerpt || '') as string).slice(0, 300),
      })),
    }));
  } catch (err: any) {
    return res.status(500).json({ error: 'retrieval_debug_failed', details: err?.message });
  }
});

// ─── E5-Final — Source Health ───
// GET /api/ai-agent/source-health?workspaceId=...&sourceType=...&eligible=true|false&query=...&limit=...
// Read-only. Workspace-member auth. Never exposes storage paths/URLs/credentials.
internalQaRouter.get('/source-health', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sourceType = (req.query.sourceType as string | undefined) as HealthSourceType | undefined;
  const allowed: HealthSourceType[] = ['qna', 'learned_qna', 'kb_article', 'file', 'website', 'web_page'];
  if (sourceType && !allowed.includes(sourceType)) {
    return res.status(400).json({ error: 'invalid_source_type' });
  }
  const eligibleRaw = req.query.eligible as string | undefined;
  const eligible = eligibleRaw === 'true' ? true : eligibleRaw === 'false' ? false : undefined;
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 500);
  const query = (req.query.query as string | undefined) || undefined;
  try {
    const result = await getSourceHealth(config, workspaceId, { sourceType, eligible, query, limit });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'source_health_failed', details: err?.message });
  }
});

// ── POST /test-run ──
const testRunSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  pageUrl: z.string().max(2000).optional(),
  visitorLocale: z.string().max(10).optional(),
  dryRun: z.boolean().optional().default(true),
});
internalQaRouter.post('/test-run', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = testRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, message, pageUrl, visitorLocale } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkPlaygroundRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'playground_rate_limited' });
  }
  try {
    const result = await runDryRun(config, { workspaceId, message, pageUrl, visitorLocale });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'test_run_failed', details: err?.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// E6 — Test Harness: dry-run runtime + test cases CRUD + bulk runs.
// Self-host. No conversation side effects, no workflows, no MCP, no handoff,
// no learning candidates. Workspace-scoped, status='active' chunks only.
// ═══════════════════════════════════════════════════════════════════════

const e6PageContextSchema = z.object({
  currentPageUrl: z.string().max(2000).nullable().optional(),
  currentPageOrigin: z.string().max(500).nullable().optional(),
  currentPagePath: z.string().max(1000).nullable().optional(),
  currentPageTitle: z.string().max(500).nullable().optional(),
}).nullish();

const e6DebugRunSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  pageContext: e6PageContextSchema,
  testCaseId: z.string().uuid().optional(),
  callLLM: z.boolean().optional(),
});

internalQaRouter.post('/debug/run-test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = e6DebugRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, message, locale, pageContext, callLLM } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkE6TestRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'test_rate_limited', limit: E6_TEST_LIMIT, window_ms: E6_TEST_WINDOW });
  }
  try {
    const result = await e6_runDryRunTest(config, {
      workspaceId, message, locale: locale || undefined,
      pageContext: pageContext || null,
      callLLM: callLLM !== false,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'dry_run_failed', details: err?.message });
  }
});

const e6TestCaseFields = {
  name: z.string().min(1).max(200),
  input_message: z.string().min(1).max(2000),
  locale: z.string().max(10).nullable().optional(),
  page_context: z.record(z.any()).nullable().optional(),
  expected_behavior: z.enum(['answer','no_answer','handoff','clarification']),
  expected_source_type: z.enum(['qna','learned_qna','kb_article','web_page','file','business_profile']).nullable().optional(),
  expected_source_url: z.string().max(2000).nullable().optional(),
  expected_source_id: z.string().max(200).nullable().optional(),
  expected_contains: z.array(z.string().max(500)).max(20).optional(),
  expected_not_contains: z.array(z.string().max(500)).max(20).optional(),
  min_confidence: z.number().min(0).max(1).nullable().optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
};

const e6CreateCaseSchema = z.object({ workspaceId: z.string().uuid(), ...e6TestCaseFields });
const e6PatchCaseSchema = z.object(Object.fromEntries(
  Object.entries(e6TestCaseFields).map(([k, v]: any) => [k, v.optional()]),
) as any);

// LIST
internalQaRouter.get('/test-cases', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  let q = sb.from('ai_agent_test_cases').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (req.query.enabled === 'true') q = q.eq('enabled', true);
  if (req.query.enabled === 'false') q = q.eq('enabled', false);
  if (req.query.expected_behavior) q = q.eq('expected_behavior', String(req.query.expected_behavior));
  if (req.query.expected_source_type) q = q.eq('expected_source_type', String(req.query.expected_source_type));
  if (req.query.query) q = q.ilike('name', `%${String(req.query.query)}%`);
  const { data, error } = await q.limit(500);
  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  return res.json({ items: data || [] });
});

// CREATE
internalQaRouter.post('/test-cases', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = e6CreateCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, ...fields } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_agent_test_cases').insert({
    workspace_id: workspaceId,
    created_by: auth.userId,
    expected_contains: fields.expected_contains || [],
    expected_not_contains: fields.expected_not_contains || [],
    metadata: fields.metadata || {},
    enabled: fields.enabled ?? true,
    ...fields,
  }).select('*').single();
  if (error) return res.status(500).json({ error: 'create_failed', details: error.message });
  return res.json({ item: data });
});

// PATCH
internalQaRouter.patch('/test-cases/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_test_cases').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = e6PatchCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { data, error } = await sb.from('ai_agent_test_cases').update(parsed.data).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: 'update_failed', details: error.message });
  return res.json({ item: data });
});

// DELETE
internalQaRouter.delete('/test-cases/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_test_cases').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_test_cases').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'delete_failed', details: error.message });
  return res.json({ ok: true });
});

async function e6PersistTestRun(
  sb: any, workspaceId: string, testCaseId: string | null, userId: string | null,
  result: E6DryRunResult, evalResult: { passed: boolean; failure_reasons: string[] },
  inputMessage: string,
): Promise<any> {
  const status = result.status === 'failed' && result.error
    ? 'errored'
    : (evalResult.passed ? 'passed' : 'failed');
  const failureReasons = status === 'errored'
    ? [result.error || 'errored', ...evalResult.failure_reasons]
    : evalResult.failure_reasons;
  const { data } = await sb.from('ai_agent_test_runs').insert({
    workspace_id: workspaceId,
    test_case_id: testCaseId,
    status,
    input_message: inputMessage,
    actual_output: result.output_text,
    actual_status: result.status,
    confidence: result.confidence,
    selected_sources: result.selected_sources,
    retrieval_debug: result.retrieval_debug,
    answer_strategy: result.answer_strategy,
    failure_reasons: failureReasons,
    metadata: {
      provider: result.provider,
      model: result.model,
      safety_notes: result.safety_notes,
      runtime: result.runtime,
      runtime_parity: result.runtime_parity,
      page_context: result.page_context,
      excluded_summary: result.excluded_summary,
    },
    created_by: userId,
  }).select('*').single();
  return data;
}

// RUN single test case
internalQaRouter.post('/test-cases/:id/run', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: tc } = await sb.from('ai_agent_test_cases').select('*').eq('id', req.params.id).maybeSingle();
  if (!tc) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, tc.workspace_id);
  if (!auth) return;
  if (!checkE6TestRateLimit(tc.workspace_id, auth.userId)) {
    return res.status(429).json({ error: 'test_rate_limited', limit: E6_TEST_LIMIT, window_ms: E6_TEST_WINDOW });
  }
  try {
    const pc = tc.page_context || null;
    const result = await e6_runDryRunTest(config, {
      workspaceId: tc.workspace_id,
      message: tc.input_message,
      locale: tc.locale || undefined,
      pageContext: pc,
    });
    const evalResult = e6_evaluateExpectations(result, {
      workspaceId: tc.workspace_id,
      expected_behavior: tc.expected_behavior,
      expected_source_type: tc.expected_source_type,
      expected_source_url: tc.expected_source_url,
      expected_source_id: tc.expected_source_id,
      expected_contains: tc.expected_contains,
      expected_not_contains: tc.expected_not_contains,
      min_confidence: tc.min_confidence,
    });
    const run = await e6PersistTestRun(sb, tc.workspace_id, tc.id, auth.userId, result, evalResult, tc.input_message);
    return res.json({ run, result, evaluation: evalResult });
  } catch (err: any) {
    return res.status(500).json({ error: 'run_failed', details: err?.message });
  }
});

// BULK run
internalQaRouter.post('/test-cases/run-bulk', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const schema = z.object({
    workspaceId: z.string().uuid(),
    ids: z.array(z.string().uuid()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, ids } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (ids && ids.length > E6_BULK_MAX_CASES) {
    return res.status(400).json({ error: 'bulk_too_many_cases', max: E6_BULK_MAX_CASES });
  }
  if (!checkE6BulkRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'bulk_test_rate_limited', limit: E6_BULK_LIMIT, window_ms: E6_BULK_WINDOW });
  }
  const sb = getServiceClient(config);
  let totalEnabled: number | null = null;
  let capped = false;
  let q = sb.from('ai_agent_test_cases').select('*').eq('workspace_id', workspaceId);
  if (ids && ids.length) {
    q = q.in('id', ids);
  } else {
    q = q.eq('enabled', true);
    const { count } = await sb.from('ai_agent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('enabled', true);
    totalEnabled = count ?? 0;
    if (totalEnabled > E6_BULK_MAX_CASES) capped = true;
  }
  const { data: cases, error } = await q.limit(E6_BULK_MAX_CASES);
  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  const summary = {
    total: 0, passed: 0, failed: 0, errored: 0,
    capped, max: E6_BULK_MAX_CASES, total_enabled: totalEnabled,
    runs: [] as any[],
  };
  for (const tc of cases || []) {
    summary.total += 1;
    try {
      const result = await e6_runDryRunTest(config, {
        workspaceId, message: tc.input_message,
        locale: tc.locale || undefined, pageContext: tc.page_context || null,
      });
      const evalResult = e6_evaluateExpectations(result, {
        workspaceId,
        expected_behavior: tc.expected_behavior,
        expected_source_type: tc.expected_source_type,
        expected_source_url: tc.expected_source_url,
        expected_source_id: tc.expected_source_id,
        expected_contains: tc.expected_contains,
        expected_not_contains: tc.expected_not_contains,
        min_confidence: tc.min_confidence,
      });
      const run = await e6PersistTestRun(sb, workspaceId, tc.id, auth.userId, result, evalResult, tc.input_message);
      if (run?.status === 'passed') summary.passed += 1;
      else if (run?.status === 'errored') summary.errored += 1;
      else summary.failed += 1;
      summary.runs.push({ test_case_id: tc.id, name: tc.name, status: run?.status, failure_reasons: run?.failure_reasons });
    } catch (err: any) {
      summary.errored += 1;
      summary.runs.push({ test_case_id: tc.id, name: tc.name, status: 'errored', failure_reasons: [err?.message || 'errored'] });
    }
  }
  return res.json(summary);
});

// LIST runs
internalQaRouter.get('/test-runs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  let q = sb.from('ai_agent_test_runs').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (req.query.testCaseId) q = q.eq('test_case_id', String(req.query.testCaseId));
  if (req.query.status) q = q.eq('status', String(req.query.status));
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { data, error } = await q.limit(limit);
  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  return res.json({ items: data || [] });
});

// GET single run (with linked test case for context)
internalQaRouter.get('/test-runs/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: run } = await sb.from('ai_agent_test_runs').select('*').eq('id', req.params.id).maybeSingle();
  if (!run) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, run.workspace_id);
  if (!auth) return;
  let testCase: any = null;
  if (run.test_case_id) {
    const { data: tc } = await sb.from('ai_agent_test_cases').select('*').eq('id', run.test_case_id).maybeSingle();
    testCase = tc || null;
  }
  return res.json({ item: run, test_case: testCase });
});

// SEED recommended cases (idempotent on input_message + expected_behavior).
internalQaRouter.post('/test-cases/seed-recommended', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const schema = z.object({ workspaceId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);

  // Build a set of (source_type → set of source_ids) that have at least one
  // active+embedded chunk in this workspace. Reuses runtime eligibility rules.
  const { data: chunks } = await sb
    .from('ai_knowledge_chunks')
    .select('source_type, source_id, metadata')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .not('embedding', 'is', null)
    .limit(2000);
  const activeBy: Record<string, Set<string>> = { qna: new Set(), learned_qna: new Set(), kb_article: new Set(), file: new Set(), web_page: new Set() };
  const webPageParents = new Map<string, { source_id: string; url: string | null; title: string | null }>();
  for (const c of (chunks || []) as any[]) {
    if (!activeBy[c.source_type]) continue;
    activeBy[c.source_type].add(String(c.source_id));
    if (c.source_type === 'web_page') {
      const m = c.metadata || {};
      const parent = String(m.parent_source_id || m.source_id || String(c.source_id).split(':')[0] || c.source_id);
      if (!webPageParents.has(String(c.source_id))) {
        webPageParents.set(String(c.source_id), {
          source_id: parent,
          url: (m.page_url || m.url || null) as string | null,
          title: (m.page_title || m.title || null) as string | null,
        });
      }
    }
  }

  const created: Array<{ name: string; expected_source_type: string | null; expected_source_id: string | null }> = [];
  const skippedReasons: string[] = [];

  // Existing dedup key: normalized message + behavior + source_type + source_id
  const { data: existing } = await sb.from('ai_agent_test_cases')
    .select('input_message,expected_behavior,expected_source_type,expected_source_id')
    .eq('workspace_id', workspaceId);
  const dedupKey = (m: string, b: string, st: string | null, sid: string | null) =>
    `${m.toLowerCase().trim()}|${b}|${st || ''}|${sid || ''}`;
  const existingKeys = new Set((existing || []).map((r: any) => dedupKey(r.input_message, r.expected_behavior, r.expected_source_type, r.expected_source_id)));

  const toInsert: any[] = [];
  function addCase(c: { name: string; input_message: string; expected_behavior: string; expected_source_type: string | null; expected_source_id: string | null; expected_source_url?: string | null; page_context?: any }) {
    const k = dedupKey(c.input_message, c.expected_behavior, c.expected_source_type, c.expected_source_id);
    if (existingKeys.has(k)) { skippedReasons.push(`duplicate:${c.name}`); return; }
    existingKeys.add(k);
    toInsert.push({
      workspace_id: workspaceId,
      created_by: auth.userId,
      enabled: true,
      name: c.name,
      input_message: c.input_message,
      expected_behavior: c.expected_behavior,
      expected_source_type: c.expected_source_type,
      expected_source_id: c.expected_source_id,
      expected_source_url: c.expected_source_url || null,
      page_context: c.page_context || null,
      expected_contains: [], expected_not_contains: [],
      metadata: { seeded: true, seed_version: 'e6h' },
    });
    created.push({ name: c.name, expected_source_type: c.expected_source_type, expected_source_id: c.expected_source_id });
  }

  // Q&A
  if (activeBy.qna.size) {
    const ids = Array.from(activeBy.qna).slice(0, 50);
    const { data: qna } = await sb.from('ai_agent_qna')
      .select('id, question').eq('workspace_id', workspaceId).neq('enabled', false).in('id', ids).limit(1);
    const row = (qna || [])[0];
    if (row) addCase({ name: `Q&A coverage: ${String(row.question).slice(0, 60)}`, input_message: row.question, expected_behavior: 'answer', expected_source_type: 'qna', expected_source_id: row.id });
    else skippedReasons.push('qna:no_eligible_row');
  } else { skippedReasons.push('qna:no_active_chunks'); }

  // Learned Q&A
  if (activeBy.learned_qna.size) {
    const ids = Array.from(activeBy.learned_qna).slice(0, 50);
    const { data: lq } = await sb.from('ai_agent_learning_candidates')
      .select('id, question_text, suggested_title').eq('workspace_id', workspaceId).eq('status', 'approved').in('id', ids).limit(1);
    const row = (lq || [])[0];
    if (row) {
      const msg = row.question_text || row.suggested_title || '';
      if (msg) addCase({ name: `Learned answer: ${String(row.suggested_title || msg).slice(0, 60)}`, input_message: msg, expected_behavior: 'answer', expected_source_type: 'learned_qna', expected_source_id: row.id });
      else skippedReasons.push('learned_qna:no_question_text');
    } else { skippedReasons.push('learned_qna:no_approved_row'); }
  } else { skippedReasons.push('learned_qna:no_active_chunks'); }

  // KB Article
  if (activeBy.kb_article.size) {
    const ids = Array.from(activeBy.kb_article).slice(0, 50);
    const { data: kb } = await sb.from('knowledge_base_articles')
      .select('id, title').eq('workspace_id', workspaceId).eq('status', 'published').in('id', ids).limit(1);
    const row = (kb || [])[0];
    if (row && row.title) addCase({ name: `KB article: ${String(row.title).slice(0, 60)}`, input_message: `Tell me about ${row.title}`, expected_behavior: 'answer', expected_source_type: 'kb_article', expected_source_id: row.id });
    else skippedReasons.push('kb_article:no_published_row');
  } else { skippedReasons.push('kb_article:no_active_chunks'); }

  // File
  if (activeBy.file.size) {
    const ids = Array.from(activeBy.file).slice(0, 50);
    const { data: files } = await sb.from('ai_data_sources')
      .select('id, name, metadata').eq('workspace_id', workspaceId).eq('source_type', 'file').eq('status', 'active').in('id', ids).limit(1);
    const row = (files || [])[0];
    if (row) {
      const meta = row.metadata || {};
      const title = row.name || meta.original_file_name || 'uploaded document';
      addCase({ name: `File coverage: ${String(title).slice(0, 60)}`, input_message: `What does the document "${title}" say?`, expected_behavior: 'answer', expected_source_type: 'file', expected_source_id: row.id });
    } else { skippedReasons.push('file:no_active_source_row'); }
  } else { skippedReasons.push('file:no_active_chunks'); }

  // Web page (chunk-level, parent must be active website)
  if (webPageParents.size) {
    const parentIds = Array.from(new Set(Array.from(webPageParents.values()).map((v) => v.source_id)));
    const { data: parents } = await sb.from('ai_data_sources')
      .select('id, name, status, metadata').eq('workspace_id', workspaceId).eq('source_type', 'website').eq('status', 'active').in('id', parentIds).limit(50);
    const activeParentIds = new Set((parents || []).map((p: any) => p.id));
    let chosen: { chunkSourceId: string; url: string | null; title: string | null } | null = null;
    for (const [chunkSourceId, info] of webPageParents.entries()) {
      if (activeParentIds.has(info.source_id)) { chosen = { chunkSourceId, url: info.url, title: info.title }; break; }
    }
    if (chosen) {
      const t = chosen.title || chosen.url || 'this page';
      addCase({ name: `Web page: ${String(t).slice(0, 60)}`, input_message: `Tell me about ${t}`, expected_behavior: 'answer', expected_source_type: 'web_page', expected_source_id: chosen.chunkSourceId, expected_source_url: chosen.url || null });
    } else { skippedReasons.push('web_page:no_active_parent_website'); }
  } else { skippedReasons.push('web_page:no_active_chunks'); }

  // Unknown question (always seed)
  addCase({ name: 'Unknown question (no answer expected)', input_message: 'What is the airspeed velocity of an unladen swallow on a Tuesday in 1842?', expected_behavior: 'no_answer', expected_source_type: null, expected_source_id: null });

  if (!toInsert.length) {
    return res.json({ inserted: 0, skipped: skippedReasons.length, created: [], skipped_reasons: skippedReasons });
  }
  const { data, error } = await sb.from('ai_agent_test_cases').insert(toInsert).select('id');
  if (error) return res.status(500).json({ error: 'seed_failed', details: error.message });
  return res.json({ inserted: data?.length || 0, skipped: skippedReasons.length, created, skipped_reasons: skippedReasons });
});

// SUMMARY
internalQaRouter.get('/test-summary', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [casesRes, recentRes] = await Promise.all([
    sb.from('ai_agent_test_cases').select('id,enabled,expected_source_type').eq('workspace_id', workspaceId),
    sb.from('ai_agent_test_runs').select('status,failure_reasons,selected_sources').eq('workspace_id', workspaceId).gte('created_at', since).limit(2000),
  ]);
  const cases = casesRes.data || [];
  const recent = recentRes.data || [];
  const last24Passed = recent.filter((r: any) => r.status === 'passed').length;
  const last24Failed = recent.filter((r: any) => r.status === 'failed').length;
  const last24Errored = recent.filter((r: any) => r.status === 'errored').length;
  const failuresByReason: Record<string, number> = {};
  for (const r of recent) {
    if (r.status === 'passed') continue;
    for (const reason of (r.failure_reasons || [])) {
      const key = String(reason).split(':')[0];
      failuresByReason[key] = (failuresByReason[key] || 0) + 1;
    }
  }
  const coverageByType: Record<string, number> = { qna: 0, learned_qna: 0, kb_article: 0, web_page: 0, file: 0 };
  for (const c of cases) {
    if (c.expected_source_type && coverageByType[c.expected_source_type] !== undefined) {
      coverageByType[c.expected_source_type] += 1;
    }
  }
  const total24 = recent.length;
  return res.json({
    total_cases: cases.length,
    enabled_cases: cases.filter((c: any) => c.enabled).length,
    last_24h_runs: total24,
    last_24h_passed: last24Passed,
    last_24h_failed: last24Failed,
    last_24h_errored: last24Errored,
    pass_rate: total24 ? Number((last24Passed / total24).toFixed(3)) : null,
    failures_by_reason: failuresByReason,
    coverage_by_source_type: coverageByType,
  });
});

// ─────────────────────────────────────────────────────────────────────
// E9 — Suggested regression test cases
// (operator-assist feedback + failed test runs → draft test cases)
//
// Hard rules:
//  - Workspace-scoped only.
//  - Read: workspace members. Generate: operator roles.
//    Accept/reject/delete: owner/admin only.
//  - No conversation_messages / handoff / workflow / learning side effects.
//  - No calls / LiveKit / widget-call code touched.
//  - No MCP / webhooks / external HTTP / Edge Functions.
//  - File expected_source_url is always null. All persisted text is redacted.
// ─────────────────────────────────────────────────────────────────────
const E9_OPERATOR_ROLES = new Set(['owner', 'admin', 'agent', 'support_agent', 'team_lead']);
function e9_canGenerateSuggestion(role: string | null, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !!(role && E9_OPERATOR_ROLES.has(role));
}
function e9_canManageSuggestion(role: string | null, isAdmin: boolean): boolean {
  return isOwnerOrAdmin(role, isAdmin);
}

internalQaRouter.get('/suggested-test-cases', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = String(req.query.workspaceId || '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = req.query.status ? String(req.query.status) : 'pending';
  const valid = new Set(['pending', 'accepted', 'rejected', 'converted', 'all']);
  if (!valid.has(status)) return res.status(400).json({ error: 'invalid_status' });
  const sb = getServiceClient(config);
  try {
    const items = await e9_listSuggestedCases(sb, workspaceId, { status: status as any });
    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: 'list_failed', details: err?.message });
  }
});

internalQaRouter.post('/suggested-test-cases/from-feedback/:feedbackId', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const feedbackId = String(req.params.feedbackId);
  if (!/^[0-9a-f-]{36}$/i.test(feedbackId)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: fb } = await sb.from('ai_operator_assist_feedback').select('workspace_id').eq('id', feedbackId).maybeSingle();
  if (!fb) return res.status(404).json({ error: 'feedback_not_found' });
  const auth = await authorizeMember(req, res, config, fb.workspace_id);
  if (!auth) return;
  if (!e9_canGenerateSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }
  const result = await e9_suggestFromAssistFeedback(sb, fb.workspace_id, feedbackId, auth.userId);
  if (!result.ok) {
    const code = result.reason === 'duplicate' ? 409 : (result.reason?.startsWith('insert_failed') ? 500 : 400);
    return res.status(code).json({ error: result.reason || 'suggest_failed', duplicate_of: result.duplicate_of });
  }
  return res.json({ ok: true, suggestion: result.suggestion });
});

internalQaRouter.post('/suggested-test-cases/from-test-run/:runId', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const runId = String(req.params.runId);
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: run } = await sb.from('ai_agent_test_runs').select('workspace_id').eq('id', runId).maybeSingle();
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  const auth = await authorizeMember(req, res, config, run.workspace_id);
  if (!auth) return;
  if (!e9_canGenerateSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }
  const result = await e9_suggestFromFailedTestRun(sb, run.workspace_id, runId, auth.userId);
  if (!result.ok) {
    const code = result.reason === 'duplicate' ? 409 : (result.reason?.startsWith('insert_failed') ? 500 : 400);
    return res.status(code).json({ error: result.reason || 'suggest_failed', duplicate_of: result.duplicate_of });
  }
  return res.json({ ok: true, suggestion: result.suggestion });
});

internalQaRouter.post('/suggested-test-cases/:id/accept', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('ai_agent_suggested_test_cases').select('workspace_id').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return;
  if (!e9_canManageSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const overrides = (req.body && typeof req.body === 'object') ? req.body : {};
  // Strip workspace_id / id / status / source_* from overrides.
  const safeOverrides = { ...overrides };
  for (const k of ['id', 'workspace_id', 'status', 'source_type', 'source_id', 'created_by', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at']) {
    delete (safeOverrides as any)[k];
  }
  const result: any = await e9_acceptSuggestedCase(sb, id, auth.userId, safeOverrides);
  if (!result.ok) {
    const r = result.reason as string | undefined;
    return res.status(r === 'not_found' ? 404 : 400).json({ error: r });
  }
  return res.json({ ok: true, test_case_id: result.test_case_id });
});

internalQaRouter.post('/suggested-test-cases/:id/reject', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('ai_agent_suggested_test_cases').select('workspace_id').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return;
  if (!e9_canManageSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const reason = req.body?.reason ? String(req.body.reason) : null;
  const result = await e9_rejectSuggestedCase(sb, id, auth.userId, reason);
  if (!result.ok) {
    return res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.reason });
  }
  return res.json({ ok: true });
});

internalQaRouter.delete('/suggested-test-cases/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('ai_agent_suggested_test_cases').select('workspace_id').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return;
  if (!e9_canManageSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const { error } = await sb.from('ai_agent_suggested_test_cases').delete().eq('id', id);
  if (error) return res.status(500).json({ error: 'delete_failed', details: error.message });
  return res.json({ ok: true });
});

// ─── E10 — Scheduled regression runs ─────────────────────────────────

internalQaRouter.get('/regression/schedules', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const items = await e10_listSchedules(config, workspaceId);
    return res.json({ items });
  } catch (e: any) {
    return res.status(500).json({ error: 'list_failed', details: e?.message });
  }
});

internalQaRouter.post('/regression/schedules/default', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const item = await e10_getOrCreateSchedule(config, workspaceId, auth.userId);
    return res.json({ item });
  } catch (e: any) {
    return res.status(500).json({ error: 'create_failed', details: e?.message });
  }
});

internalQaRouter.patch('/regression/schedules/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_schedules').select('workspace_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const item = await e10_updateSchedule(config, id, req.body || {}, auth.userId);
    return res.json({ item });
  } catch (e: any) {
    return res.status(400).json({ error: 'update_failed', details: e?.message });
  }
});

internalQaRouter.get('/regression/batches', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const limitRaw = parseInt(String(req.query.limit || '50'), 10);
  const offsetRaw = parseInt(String(req.query.offset || '0'), 10);
  const allowedStatus = new Set(['queued','running','completed','failed','cancelled']);
  const allowedTrigger = new Set(['manual','scheduled']);
  const status = allowedStatus.has(String(req.query.status)) ? String(req.query.status) as any : null;
  const triggerType = allowedTrigger.has(String(req.query.trigger_type)) ? String(req.query.trigger_type) as any : null;
  const scheduleId = typeof req.query.schedule_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.schedule_id) ? req.query.schedule_id : null;
  const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : null;
  const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : null;
  const onlyFailed = String(req.query.only_failed || '') === 'true';
  try {
    const r = await e10_listBatches(config, workspaceId, {
      limit: isFinite(limitRaw) ? limitRaw : 50,
      offset: isFinite(offsetRaw) ? offsetRaw : 0,
      status, triggerType, scheduleId, dateFrom, dateTo, onlyFailed,
    });
    return res.json(r);
  } catch (e: any) {
    return res.status(500).json({ error: 'list_failed', details: e?.message });
  }
});

internalQaRouter.get('/regression/batches/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const detail = await e10_getBatchDetail(config, id);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    const auth = await authorizeMember(req, res, config, detail.batch.workspace_id);
    if (!auth) return;
    // E11.1 — enrich runs with selected_source_summary, build runs_by_status
    // map, expose progress + retry_of_batch_id from batch metadata.
    const rawRuns = (detail.runs || []) as any[];
    const runs_by_status: { errored: any[]; failed: any[]; passed: any[] } = {
      errored: [], failed: [], passed: [],
    };
    const enrichedRuns = rawRuns.map((r) => {
      const ss: any[] = Array.isArray(r.selected_sources) ? r.selected_sources : [];
      const source_types = Array.from(new Set(ss.map((s) => s?.source_type).filter(Boolean))) as string[];
      const top_titles = ss.map((s) => (typeof s?.title === 'string' ? s.title : null)).filter(Boolean).slice(0, 8) as string[];
      const selected_source_summary = { source_types, top_titles, count: ss.length };
      return { ...r, selected_source_summary };
    });
    for (const r of enrichedRuns) {
      if (r.status === 'errored') runs_by_status.errored.push(r);
      else if (r.status === 'failed') runs_by_status.failed.push(r);
      else if (r.status === 'passed') runs_by_status.passed.push(r);
    }
    const meta = ((detail.batch as any).metadata || {}) as Record<string, any>;
    const progress = {
      current_case_index: meta.current_case_index ?? null,
      current_test_case_id: meta.current_test_case_id ?? null,
      current_test_case_name: meta.current_test_case_name ?? null,
      duration_ms: meta.duration_ms ?? null,
      avg_case_duration_ms: meta.avg_case_duration_ms ?? null,
    };
    return res.json({
      batch: detail.batch,
      runs: enrichedRuns,
      runs_by_status,
      progress,
      retry_of_batch_id: meta.retry_of_batch_id ?? null,
      retryChildren: (detail as any).retryChildren || [],
      summary: {
        total: detail.batch.total_cases,
        passed: detail.batch.passed,
        failed: detail.batch.failed,
        errored: detail.batch.errored,
        pass_rate: detail.batch.pass_rate,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'detail_failed', details: e?.message });
  }
});

internalQaRouter.post('/regression/run-now', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const schema = z.object({
    workspaceId: z.string().uuid(),
    scheduleId: z.string().uuid().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, scheduleId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const batch = await e10_enqueueBatch(config, {
      workspaceId,
      scheduleId: scheduleId || null,
      triggerType: 'manual',
      actorId: auth.userId,
    });
    return res.json({ batch });
  } catch (e: any) {
    return res.status(500).json({ error: 'enqueue_failed', details: e?.message });
  }
});

internalQaRouter.post('/regression/batches/:id/run', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_batches').select('workspace_id,status').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  if (existing.status !== 'queued') {
    return res.status(409).json({ error: 'batch_not_queued', status: existing.status });
  }
  const claimed = await e10_claimBatch(sb, id);
  if (!claimed) return res.status(409).json({ error: 'claim_lost' });
  try {
    const result = await e10_runBatch(config, id);
    return res.json({ ok: true, result });
  } catch (e: any) {
    await sb.from('ai_agent_regression_batches').update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_error: String(e?.message || 'unknown'),
    }).eq('id', id);
    return res.status(500).json({ error: 'run_failed', details: e?.message });
  }
});

internalQaRouter.post('/regression/batches/:id/cancel', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_batches').select('workspace_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const r = await e10_cancelBatch(config, id, auth.userId);
  if (!r.ok) return res.status(400).json({ error: r.error || 'cancel_failed' });
  return res.json({ ok: true, status: r.status, idempotent: !!r.idempotent });
});

internalQaRouter.post('/regression/batches/:id/retry-failed', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_batches').select('workspace_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const r = await e10_retryFailed(config, id, auth.userId);
  if (!r.ok) {
    const code = r.error === 'no_failed_cases' ? 400 : 500;
    return res.status(code).json({ error: r.error || 'retry_failed' });
  }
  return res.json({ batch: r.batch });
});

// ─── E11 — Regression observability ───

internalQaRouter.get('/regression/overview', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const overview = await e11_getOverview(config, workspaceId);
    return res.json(overview);
  } catch (e: any) {
    return res.status(500).json({ error: 'overview_failed', details: e?.message });
  }
});

internalQaRouter.get('/regression/batches/:id/export.csv', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const r = await e11_exportBatchCsv(config, id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, r.workspaceId);
  if (!auth) return;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  return res.send(r.csv);
});

// ─── Customer-safe Test AI ───
// Wraps runDryRunTest. Returns ONLY action/answer/confidence-bucket/source-titles.
// Never returns retrieval_debug, prompt_preview, source ids, raw scores, chunks,
// embeddings, or storage paths. Respects show_sources_to_operator.
const customerTestAiSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  pageContext: z.object({
    currentPageUrl: z.string().max(2000).nullable().optional(),
    currentPageOrigin: z.string().max(500).nullable().optional(),
    currentPagePath: z.string().max(1000).nullable().optional(),
    currentPageTitle: z.string().max(500).nullable().optional(),
  }).nullish(),
});
function confidenceBucketLabel(c: number): 'low' | 'medium' | 'high' {
  if (c >= 0.7) return 'high';
  if (c >= 0.4) return 'medium';
  return 'low';
}
function friendlyTestAiReason(action: string, status: string): string {
  if (action === 'answer') return 'A confident answer was generated from your knowledge.';
  if (action === 'clarification') return 'The AI needs more details before it can answer.';
  if (action === 'handoff') return 'The AI would transfer this conversation to a human operator.';
  if (action === 'no_answer') return 'No matching knowledge was found.';
  if (status === 'failed') return 'The test could not be completed. Please try again.';
  return 'The AI evaluated this message.';
}
internalQaRouter.post('/test-ai', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = customerTestAiSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, message, locale, pageContext } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkPlaygroundRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'test_ai_rate_limited' });
  }
  try {
    const settings = await getOrCreateSettings(config, workspaceId);
    const result = await e6_runDryRunTest(config, {
      workspaceId,
      message,
      locale: locale || undefined,
      pageContext: pageContext || null,
      callLLM: true,
    });
    const action = result.answer_strategy?.action || 'no_answer';
    const showSources = !!settings.show_sources_to_operator;
    const sources = showSources
      ? (result.selected_sources || []).slice(0, 5).map((s) => ({
          title: s.title || '(untitled)',
          source_type: s.source_type,
        }))
      : [];
    return res.json({
      action,
      answer: result.output_text || null,
      confidence_bucket: confidenceBucketLabel(result.confidence || 0),
      reason: friendlyTestAiReason(action, result.status),
      sources,
      sources_hidden: !showSources,
      // explicit absence of internal fields
      retrieval_debug: undefined,
      prompt_preview: undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'test_ai_failed', details: err?.message });
  }
});
