/**
 * AI Agent — Pass E10 — Scheduled regression runner.
 *
 * Self-host. All work runs in this Express server / standalone worker.
 *
 * Reuses the E6 dry-run evaluator (runDryRunTest + evaluateExpectations) to
 * execute each test case. NEVER inserts conversation_messages, handoffs,
 * workflows, or learning candidates. NEVER calls MCP/webhooks/external HTTP.
 * File source URLs are kept null in test_run rows (E6 already enforces this).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  runDryRunTest,
  evaluateExpectations,
  type DryRunResult,
} from './testHarness.js';

const HARD_MAX_CASES = 100;

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'manual';

export interface RegressionSchedule {
  id: string;
  workspace_id: string;
  enabled: boolean;
  name: string;
  frequency: Frequency;
  time_of_day: string | null;
  timezone: string;
  include_enabled_cases_only: boolean;
  max_cases_per_run: number;
  call_llm: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RegressionBatch {
  id: string;
  workspace_id: string;
  schedule_id: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger_type: 'manual' | 'scheduled';
  total_cases: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function computeNextRunAt(freq: Frequency, from: Date = new Date()): Date | null {
  if (freq === 'manual') return null;
  const ms =
    freq === 'hourly' ? 60 * 60 * 1000 :
    freq === 'daily' ? 24 * 60 * 60 * 1000 :
    7 * 24 * 60 * 60 * 1000;
  return new Date(from.getTime() + ms);
}

export async function listRegressionSchedules(
  config: ServerConfig,
  workspaceId: string,
): Promise<RegressionSchedule[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_regression_schedules')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as RegressionSchedule[];
}

export async function getOrCreateDefaultRegressionSchedule(
  config: ServerConfig,
  workspaceId: string,
  actorId?: string | null,
): Promise<RegressionSchedule> {
  const sb = getServiceClient(config);
  const { data: existing } = await sb
    .from('ai_agent_regression_schedules')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as RegressionSchedule;
  const { data, error } = await sb
    .from('ai_agent_regression_schedules')
    .insert({
      workspace_id: workspaceId,
      created_by: actorId || null,
      updated_by: actorId || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as RegressionSchedule;
}

const ALLOWED_PATCH_KEYS = new Set([
  'enabled', 'name', 'frequency', 'time_of_day', 'timezone',
  'include_enabled_cases_only', 'max_cases_per_run', 'call_llm',
]);

export async function updateRegressionSchedule(
  config: ServerConfig,
  scheduleId: string,
  patch: Partial<RegressionSchedule>,
  actorId: string,
): Promise<RegressionSchedule> {
  const sb = getServiceClient(config);
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED_PATCH_KEYS.has(k)) safe[k] = v;
  }
  if (typeof safe.max_cases_per_run === 'number') {
    safe.max_cases_per_run = Math.max(1, Math.min(HARD_MAX_CASES, safe.max_cases_per_run as number));
  }
  safe.updated_by = actorId;
  // Recompute next_run_at when enabled or frequency changes.
  if ('enabled' in safe || 'frequency' in safe) {
    const { data: cur } = await sb.from('ai_agent_regression_schedules')
      .select('frequency,enabled').eq('id', scheduleId).maybeSingle();
    const enabled = (safe.enabled ?? cur?.enabled) as boolean;
    const freq = (safe.frequency ?? cur?.frequency) as Frequency;
    safe.next_run_at = enabled ? (computeNextRunAt(freq)?.toISOString() ?? null) : null;
  }
  const { data, error } = await sb
    .from('ai_agent_regression_schedules')
    .update(safe)
    .eq('id', scheduleId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as RegressionSchedule;
}

export async function enqueueRegressionBatch(
  config: ServerConfig,
  args: { workspaceId: string; scheduleId?: string | null; triggerType: 'manual' | 'scheduled'; actorId?: string | null },
): Promise<RegressionBatch> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_regression_batches')
    .insert({
      workspace_id: args.workspaceId,
      schedule_id: args.scheduleId || null,
      status: 'queued',
      trigger_type: args.triggerType,
      created_by: args.actorId || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as RegressionBatch;
}

export async function listRegressionBatches(
  config: ServerConfig,
  workspaceId: string,
  limit = 50,
): Promise<RegressionBatch[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_regression_batches')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(200, Math.max(1, limit)));
  if (error) throw new Error(error.message);
  return (data || []) as RegressionBatch[];
}

export async function getRegressionBatchDetail(
  config: ServerConfig,
  batchId: string,
): Promise<{ batch: RegressionBatch; runs: any[] } | null> {
  const sb = getServiceClient(config);
  const { data: batch } = await sb
    .from('ai_agent_regression_batches')
    .select('*')
    .eq('id', batchId)
    .maybeSingle();
  if (!batch) return null;
  const { data: runs } = await sb
    .from('ai_agent_test_runs')
    .select('*')
    .eq('regression_batch_id', batchId)
    .order('created_at', { ascending: true });
  return { batch: batch as RegressionBatch, runs: runs || [] };
}

/**
 * Atomically claim a batch for execution: only succeeds if status is still
 * 'queued'. Returns the batch row or null if another worker won the race.
 */
export async function claimQueuedBatch(
  sb: SupabaseClient,
  batchId: string,
): Promise<RegressionBatch | null> {
  const { data, error } = await sb
    .from('ai_agent_regression_batches')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', batchId)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle();
  if (error) return null;
  return (data as RegressionBatch) || null;
}

export async function findDueScheduleIds(sb: SupabaseClient, limit = 5): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const { data } = await sb
    .from('ai_agent_regression_schedules')
    .select('id')
    .eq('enabled', true)
    .neq('frequency', 'manual')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(limit);
  return (data || []).map((r: any) => r.id);
}

export async function findQueuedBatchIds(sb: SupabaseClient, limit = 5): Promise<string[]> {
  const { data } = await sb
    .from('ai_agent_regression_batches')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit);
  return (data || []).map((r: any) => r.id);
}

/**
 * Claim a due schedule: atomically advances next_run_at so concurrent workers
 * cannot enqueue duplicate batches for the same tick. Returns the schedule
 * row if we won the claim.
 */
export async function claimDueSchedule(
  sb: SupabaseClient,
  scheduleId: string,
): Promise<RegressionSchedule | null> {
  const { data: cur } = await sb
    .from('ai_agent_regression_schedules')
    .select('*')
    .eq('id', scheduleId)
    .maybeSingle();
  if (!cur || !cur.enabled || cur.frequency === 'manual') return null;
  const prevNext = cur.next_run_at;
  const newNext = computeNextRunAt(cur.frequency as Frequency)?.toISOString() ?? null;
  const nowIso = new Date().toISOString();
  const { data: claimed } = await sb
    .from('ai_agent_regression_schedules')
    .update({ next_run_at: newNext, last_run_at: nowIso })
    .eq('id', scheduleId)
    .eq('next_run_at', prevNext)
    .select('*')
    .maybeSingle();
  return (claimed as RegressionSchedule) || null;
}

/**
 * Run a regression batch end-to-end. Reuses the E6 dry-run + evaluator.
 * Caller is expected to have claimed the batch first (status='running').
 */
export async function runRegressionBatch(
  config: ServerConfig,
  batchId: string,
): Promise<{ ok: boolean; total: number; passed: number; failed: number; errored: number; error?: string }> {
  const sb = getServiceClient(config);
  const { data: batch } = await sb
    .from('ai_agent_regression_batches')
    .select('*')
    .eq('id', batchId)
    .maybeSingle();
  if (!batch) return { ok: false, total: 0, passed: 0, failed: 0, errored: 0, error: 'not_found' };

  // Deterministic guard against re-running terminal/cancelled batches.
  if (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'cancelled') {
    return {
      ok: false,
      total: batch.total_cases || 0,
      passed: batch.passed || 0,
      failed: batch.failed || 0,
      errored: batch.errored || 0,
      error: `batch_already_${batch.status}`,
    };
  }

  // Ensure status='running' even if caller forgot to claim.
  if (batch.status === 'queued') {
    await sb.from('ai_agent_regression_batches')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', batchId);
  }

  // Resolve schedule config (or defaults).
  let includeEnabledOnly = true;
  let maxCases = 50;
  let callLLM = true;
  if (batch.schedule_id) {
    const { data: sch } = await sb
      .from('ai_agent_regression_schedules')
      .select('include_enabled_cases_only,max_cases_per_run,call_llm')
      .eq('id', batch.schedule_id)
      .maybeSingle();
    if (sch) {
      includeEnabledOnly = !!sch.include_enabled_cases_only;
      maxCases = Math.min(HARD_MAX_CASES, Math.max(1, sch.max_cases_per_run || 50));
      callLLM = !!sch.call_llm;
    }
  }

  let q = sb.from('ai_agent_test_cases').select('*').eq('workspace_id', batch.workspace_id);
  if (includeEnabledOnly) q = q.eq('enabled', true);
  const { data: cases, error: casesErr } = await q.order('created_at', { ascending: true }).limit(maxCases);
  if (casesErr) {
    await sb.from('ai_agent_regression_batches').update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_error: `cases_query_failed:${casesErr.message}`,
    }).eq('id', batchId);
    return { ok: false, total: 0, passed: 0, failed: 0, errored: 0, error: casesErr.message };
  }
  const list = cases || [];
  await sb.from('ai_agent_regression_batches').update({ total_cases: list.length }).eq('id', batchId);

  let passed = 0, failed = 0, errored = 0;
  for (const tc of list) {
    try {
      let result: DryRunResult;
      try {
        result = await runDryRunTest(config, {
          workspaceId: tc.workspace_id,
          message: tc.input_message,
          locale: tc.locale || undefined,
          pageContext: tc.page_context || null,
          callLLM,
        });
      } catch (innerErr: any) {
        result = {
          status: 'failed', output_text: null, confidence: 0,
          selected_sources: [], retrieval_debug: null, excluded_summary: null,
          page_context: null,
          answer_strategy: {
            action: 'no_answer', decision_type: 'failed', reason: 'runner_error',
            retrieval_strength: 'none', top_score: 0, handoff_required: false, source_types_used: [],
          },
          prompt_preview: null,
          safety_notes: [`runner_error:${innerErr?.message || 'unknown'}`],
          provider: null, model: null, error: innerErr?.message || 'runner_error',
          runtime: {
            conversation_created: false, handoff_created: false,
            workflow_executed: false, learning_candidate_created: false,
            llm_called: false, ai_usage_logged: false,
          },
          runtime_parity: {
            retrieval: 'real_hybrid_retrieval',
            query_expansion: 'not_used',
            conversation_history: 'not_used',
            workflow_execution: 'disabled',
            handoff_execution: 'disabled',
            learning_generation: 'disabled',
          },
        };
      }
      const evalResult = evaluateExpectations(result, {
        workspaceId: tc.workspace_id,
        expected_behavior: tc.expected_behavior,
        expected_source_type: tc.expected_source_type,
        expected_source_url: tc.expected_source_url,
        expected_source_id: tc.expected_source_id,
        expected_contains: tc.expected_contains,
        expected_not_contains: tc.expected_not_contains,
        min_confidence: tc.min_confidence,
      });
      const status: 'passed' | 'failed' | 'errored' =
        result.status === 'failed' && result.error ? 'errored'
          : (evalResult.passed ? 'passed' : 'failed');
      const failureReasons = status === 'errored'
        ? [result.error || 'errored', ...evalResult.failure_reasons]
        : evalResult.failure_reasons;
      await sb.from('ai_agent_test_runs').insert({
        workspace_id: tc.workspace_id,
        test_case_id: tc.id,
        regression_batch_id: batchId,
        status,
        input_message: tc.input_message,
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
          regression_trigger: batch.trigger_type,
        },
        created_by: batch.created_by,
      });
      if (status === 'passed') passed += 1;
      else if (status === 'failed') failed += 1;
      else errored += 1;

      // Periodic counter update so progress is visible.
      const total = passed + failed + errored;
      if (total % 5 === 0 || total === list.length) {
        const passRate = total > 0 ? passed / total : null;
        await sb.from('ai_agent_regression_batches').update({
          passed, failed, errored, pass_rate: passRate,
        }).eq('id', batchId);
      }
    } catch (caseErr: any) {
      // Last-resort: don't abort whole batch.
      errored += 1;
      await sb.from('ai_agent_test_runs').insert({
        workspace_id: tc.workspace_id,
        test_case_id: tc.id,
        regression_batch_id: batchId,
        status: 'errored',
        input_message: tc.input_message,
        actual_output: null,
        actual_status: 'failed',
        confidence: null,
        selected_sources: [],
        retrieval_debug: null,
        answer_strategy: null,
        failure_reasons: [`runner_unhandled:${caseErr?.message || 'unknown'}`],
        metadata: { regression_trigger: batch.trigger_type },
        created_by: batch.created_by,
      });
    }
  }

  const total = passed + failed + errored;
  const passRate = total > 0 ? passed / total : null;
  await sb.from('ai_agent_regression_batches').update({
    status: 'completed',
    passed, failed, errored,
    pass_rate: passRate,
    finished_at: new Date().toISOString(),
  }).eq('id', batchId);

  return { ok: true, total, passed, failed, errored };
}