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
import { recordAiAgentDebugEvent } from './debugEvents.js';
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

// ──────────────────────────────────────────────────────────────────────
// Timezone-aware schedule math.
//
// No hardcoded city/zone (no Istanbul, no server tz, no browser tz).
// Resolution order:
//   1) schedule.timezone (if valid IANA)
//   2) workspace-level timezone (if a `workspaces.timezone` column exists)
//   3) platform_settings.timezone
//   4) 'UTC'
//
// NOTE: As of E10.2 the public.workspaces table does NOT have a `timezone`
// column. The lookup below probes for it and silently caches "unsupported"
// after the first miss so we don't hammer the DB. If a future migration
// adds workspaces.timezone, this code starts honouring it automatically
// without further changes.
// Invalid IANA strings fall back to UTC and emit metadata.warning.
// ──────────────────────────────────────────────────────────────────────

function isValidTimezone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
    parseInt(parts.hour, 10), parseInt(parts.minute, 10), parseInt(parts.second, 10),
  );
  return (asUTC - date.getTime()) / 60000;
}

function utcFromWallClock(year: number, month1: number, day: number, h: number, m: number, tz: string): Date {
  const naiveUtc = Date.UTC(year, month1 - 1, day, h, m, 0);
  let guess = new Date(naiveUtc);
  const off1 = tzOffsetMinutes(guess, tz);
  guess = new Date(naiveUtc - off1 * 60000);
  const off2 = tzOffsetMinutes(guess, tz);
  if (off2 !== off1) guess = new Date(naiveUtc - off2 * 60000);
  return guess;
}

function partsInTz(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return {
    year: parseInt(p.year, 10), month: parseInt(p.month, 10), day: parseInt(p.day, 10),
    hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10), weekday: wd,
  };
}

function parseHHmm(s: string | null | undefined): { h: number; m: number } | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { h: hh, m: mm };
}

let _platformTzCache: { tz: string | null; ts: number } | null = null;
async function getPlatformTimezone(sb: SupabaseClient): Promise<string | null> {
  if (_platformTzCache && Date.now() - _platformTzCache.ts < 60_000) return _platformTzCache.tz;
  try {
    const { data } = await sb.from('platform_settings').select('timezone').limit(1).maybeSingle();
    const tz = (data as any)?.timezone || null;
    _platformTzCache = { tz, ts: Date.now() };
    return tz;
  } catch { return null; }
}


let _workspaceTzColumnSupported: boolean | null = null;
const _workspaceTzCache = new Map<string, { tz: string | null; ts: number }>();
async function getWorkspaceTimezone(
  sb: SupabaseClient,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (!workspaceId) return null;
  if (_workspaceTzColumnSupported === false) return null;
  const cached = _workspaceTzCache.get(workspaceId);
  if (cached && Date.now() - cached.ts < 60_000) return cached.tz;
  try {
    const { data, error } = await sb.from('workspaces')
      .select('timezone').eq('id', workspaceId).maybeSingle();
    if (error) {
      // 42703 = undefined_column. Treat any column-missing error as "not supported".
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('column') || (error as any).code === '42703') {
        _workspaceTzColumnSupported = false;
        return null;
      }
      return null;
    }
    _workspaceTzColumnSupported = true;
    const tz = (data as any)?.timezone || null;
    _workspaceTzCache.set(workspaceId, { tz, ts: Date.now() });
    return tz;
  } catch {
    _workspaceTzColumnSupported = false;
    return null;
  }
}

export interface ResolvedSchedule {
  resolvedTimezone: string;
  warning: string | null;
}

/** Test-only: clear timezone caches between unit runs. */
export function __resetTimezoneCachesForTests(): void {
  _platformTzCache = null;
  _workspaceTzColumnSupported = null;
  _workspaceTzCache.clear();
}

export async function resolveScheduleTimezone(
  sb: SupabaseClient,
  scheduleTz: string | null | undefined,
  workspaceId?: string | null,
): Promise<ResolvedSchedule> {
  // 1) schedule
  if (scheduleTz && scheduleTz.trim()) {
    if (isValidTimezone(scheduleTz)) return { resolvedTimezone: scheduleTz, warning: null };
    // Fall through with warning
  }
  const invalidWarning = scheduleTz && !isValidTimezone(scheduleTz)
    ? 'timezone_invalid_fallback_utc' : null;
  // 2) workspace-level (if column exists)
  const wsTz = await getWorkspaceTimezone(sb, workspaceId);
  if (wsTz && isValidTimezone(wsTz)) {
    return { resolvedTimezone: wsTz, warning: invalidWarning };
  }
  // 3) platform default
  const platformTz = await getPlatformTimezone(sb);
  if (platformTz && isValidTimezone(platformTz)) {
    return { resolvedTimezone: platformTz, warning: invalidWarning };
  }
  // 4) UTC
  return { resolvedTimezone: 'UTC', warning: invalidWarning };
}

export interface NextRunComputation {
  next_run_at: Date | null;
  resolved_timezone: string;
  warning: string | null;
}

export async function computeNextRunAt(
  sb: SupabaseClient,
  schedule: Pick<RegressionSchedule, 'frequency' | 'time_of_day' | 'timezone' | 'metadata'> & { workspace_id?: string | null },
  from: Date = new Date(),
): Promise<NextRunComputation> {
  if (schedule.frequency === 'manual') {
    const r = await resolveScheduleTimezone(sb, schedule.timezone, schedule.workspace_id ?? null);
    return { next_run_at: null, resolved_timezone: r.resolvedTimezone, warning: r.warning };
  }
  const tzInfo = await resolveScheduleTimezone(sb, schedule.timezone, schedule.workspace_id ?? null);
  const tz = tzInfo.resolvedTimezone;
  let warning = tzInfo.warning;

  if (schedule.frequency === 'hourly') {
    // Round up to next full hour boundary.
    const next = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
    return { next_run_at: next, resolved_timezone: tz, warning };
  }

  const hhmm = parseHHmm(schedule.time_of_day);
  if (!hhmm) {
    // Fallback to interval math.
    const ms = schedule.frequency === 'daily' ? 86_400_000 : 7 * 86_400_000;
    warning = warning || 'time_of_day_invalid_interval_fallback';
    return { next_run_at: new Date(from.getTime() + ms), resolved_timezone: tz, warning };
  }

  if (schedule.frequency === 'daily') {
    const t = partsInTz(from, tz);
    let candidate = utcFromWallClock(t.year, t.month, t.day, hhmm.h, hhmm.m, tz);
    if (candidate.getTime() <= from.getTime()) {
      const tomorrow = new Date(Date.UTC(t.year, t.month - 1, t.day) + 86_400_000);
      const tt = partsInTz(tomorrow, tz);
      candidate = utcFromWallClock(tt.year, tt.month, tt.day, hhmm.h, hhmm.m, tz);
    }
    return { next_run_at: candidate, resolved_timezone: tz, warning };
  }

  // weekly
  const meta = (schedule.metadata || {}) as Record<string, unknown>;
  const targetWeekday = typeof meta.weekday === 'number' && meta.weekday >= 0 && meta.weekday <= 6
    ? (meta.weekday as number) : null;
  const t = partsInTz(from, tz);
  let candidate = utcFromWallClock(t.year, t.month, t.day, hhmm.h, hhmm.m, tz);
  if (targetWeekday == null) {
    if (candidate.getTime() <= from.getTime()) {
      candidate = new Date(candidate.getTime() + 7 * 86_400_000);
    }
  } else {
    let daysAhead = (targetWeekday - t.weekday + 7) % 7;
    if (daysAhead === 0 && candidate.getTime() <= from.getTime()) daysAhead = 7;
    const target = new Date(Date.UTC(t.year, t.month - 1, t.day) + daysAhead * 86_400_000);
    const tt = partsInTz(target, tz);
    candidate = utcFromWallClock(tt.year, tt.month, tt.day, hhmm.h, hhmm.m, tz);
  }
  return { next_run_at: candidate, resolved_timezone: tz, warning };
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
  // Recompute next_run_at + resolved_timezone metadata whenever scheduling
  // inputs change (enabled, frequency, time_of_day, timezone).
  const recomputeKeys = ['enabled', 'frequency', 'time_of_day', 'timezone'];
  if (recomputeKeys.some((k) => k in safe)) {
    const { data: cur } = await sb.from('ai_agent_regression_schedules')
      .select('*').eq('id', scheduleId).maybeSingle();
    const merged = { ...(cur || {}), ...safe } as RegressionSchedule;
    if (merged.enabled) {
      const c = await computeNextRunAt(sb, merged);
      safe.next_run_at = c.next_run_at?.toISOString() ?? null;
      const meta = { ...((cur as any)?.metadata || {}) };
      meta.resolved_timezone = c.resolved_timezone;
      if (c.warning) meta.warning = c.warning;
      else delete meta.warning;
      safe.metadata = meta;
    } else {
      safe.next_run_at = null;
    }
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
  filters: {
    limit?: number;
    offset?: number;
    status?: RegressionBatch['status'] | null;
    triggerType?: RegressionBatch['trigger_type'] | null;
    scheduleId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    onlyFailed?: boolean;
  } = {},
): Promise<{ items: RegressionBatch[]; total: number; limit: number; offset: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const offset = Math.max(0, filters.offset ?? 0);
  let q = sb
    .from('ai_agent_regression_batches')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId);
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.triggerType) q = q.eq('trigger_type', filters.triggerType);
  if (filters.scheduleId) q = q.eq('schedule_id', filters.scheduleId);
  if (filters.dateFrom) q = q.gte('created_at', filters.dateFrom);
  if (filters.dateTo) q = q.lte('created_at', filters.dateTo);
  if (filters.onlyFailed) {
    // batches that have at least one failure or errored run, OR whose status is failed/cancelled.
    q = q.or('failed.gt.0,errored.gt.0,status.eq.failed,status.eq.cancelled');
  }
  const { data, count, error } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return { items: (data || []) as RegressionBatch[], total: count || 0, limit, offset };
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
    .select('*, test_case:ai_agent_test_cases(id,name,expected_behavior)')
    .eq('regression_batch_id', batchId)
    .order('created_at', { ascending: true });
  // Sort failed/errored first, then passed, preserving created_at order within group.
  const order = (s: string) => (s === 'errored' ? 0 : s === 'failed' ? 1 : 2);
  const sortedRuns = [...(runs || [])].sort((a: any, b: any) => order(a.status) - order(b.status));
  // Find retry children (other batches whose metadata.retry_of_batch_id === this id).
  const { data: children } = await sb
    .from('ai_agent_regression_batches')
    .select('id,status,passed,failed,errored,pass_rate,created_at,trigger_type')
    .eq('workspace_id', (batch as any).workspace_id)
    .contains('metadata', { retry_of_batch_id: batchId } as any)
    .order('created_at', { ascending: false });
  return { batch: batch as RegressionBatch, runs: sortedRuns, retryChildren: children || [] } as any;
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
  const c = await computeNextRunAt(sb, cur as RegressionSchedule);
  const newNext = c.next_run_at?.toISOString() ?? null;
  const nowIso = new Date().toISOString();
  const meta = { ...((cur as any).metadata || {}) };
  meta.resolved_timezone = c.resolved_timezone;
  if (c.warning) meta.warning = c.warning; else delete meta.warning;
  const { data: claimed } = await sb
    .from('ai_agent_regression_schedules')
    .update({ next_run_at: newNext, last_run_at: nowIso, metadata: meta })
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
  const retryIds = Array.isArray((batch.metadata as any)?.retry_case_ids)
    ? ((batch.metadata as any).retry_case_ids as string[]) : null;
  // Hard guard: a retry batch must NEVER fall back to the full enabled-case set.
  if (retryIds !== null) {
    if (retryIds.length === 0) {
      await sb.from('ai_agent_regression_batches').update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        last_error: 'no_retry_cases_found',
      }).eq('id', batchId);
      return { ok: false, total: 0, passed: 0, failed: 0, errored: 0, error: 'no_retry_cases_found' };
    }
    q = q.in('id', retryIds);
  }
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
  if (retryIds !== null && list.length === 0) {
    await sb.from('ai_agent_regression_batches').update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_error: 'no_retry_cases_found',
    }).eq('id', batchId);
    return { ok: false, total: 0, passed: 0, failed: 0, errored: 0, error: 'no_retry_cases_found' };
  }
  const startedAtMs = Date.now();
  const baseMeta = { ...((batch.metadata as Record<string, unknown>) || {}) };
  baseMeta.current_case_index = 0;
  baseMeta.current_test_case_id = null;
  baseMeta.last_progress_at = new Date().toISOString();
  await sb.from('ai_agent_regression_batches').update({
    total_cases: list.length, metadata: baseMeta,
  }).eq('id', batchId);

  let passed = 0, failed = 0, errored = 0;
  let cancelled = false;
  for (let i = 0; i < list.length; i++) {
    const tc = list[i];
    // Cooperative cancellation: re-check status before each case.
    if (i > 0 && i % 1 === 0) {
      const { data: cur } = await sb
        .from('ai_agent_regression_batches')
        .select('status,metadata')
        .eq('id', batchId).maybeSingle();
      if (cur?.status === 'cancelled') { cancelled = true; break; }
    }
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
      const elapsed = Date.now() - startedAtMs;
      const avg = total > 0 ? Math.round(elapsed / total) : 0;
      const progressMeta = {
        ...baseMeta,
        current_case_index: i + 1,
        current_test_case_id: tc.id,
        current_test_case_name: tc.name || null,
        last_progress_at: new Date().toISOString(),
        duration_ms: elapsed,
        avg_case_duration_ms: avg,
      };
      if (total % 5 === 0 || total === list.length || i === 0) {
        const passRate = total > 0 ? passed / total : null;
        await sb.from('ai_agent_regression_batches').update({
          passed, failed, errored, pass_rate: passRate, metadata: progressMeta,
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
  const finalMeta = {
    ...baseMeta,
    current_case_index: total,
    last_progress_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAtMs,
    avg_case_duration_ms: total > 0 ? Math.round((Date.now() - startedAtMs) / total) : 0,
  };
  if (cancelled) {
    // Preserve cancellation status; just update counters + final metadata.
    await sb.from('ai_agent_regression_batches').update({
      passed, failed, errored, pass_rate: passRate,
      finished_at: new Date().toISOString(),
      metadata: finalMeta,
    }).eq('id', batchId);
    return { ok: true, total, passed, failed, errored, error: 'cancelled' };
  }
  await sb.from('ai_agent_regression_batches').update({
    status: 'completed',
    passed, failed, errored,
    pass_rate: passRate,
    finished_at: new Date().toISOString(),
    metadata: finalMeta,
  }).eq('id', batchId);

  // E11 — internal alert event for failed scheduled batches.
  // Self-host only: writes to ai_agent_debug_events. NO external webhook,
  // NO email, NO MCP, NO Edge Function. UI/observability use only.
  try {
    // E11.1 — only emit for SCHEDULED batches with at least one failure/error.
    // Manual batches must never trigger this alert.
    if (batch.trigger_type === 'scheduled' && (failed + errored) > 0) {
      await recordAiAgentDebugEvent(config, sb, {
        workspaceId: batch.workspace_id,
        eventType: 'regression_batch_failed',
        metadata: {
          batch_id: batchId,
          schedule_id: batch.schedule_id || null,
          trigger_type: batch.trigger_type,
          total, passed, failed, errored,
          pass_rate: passRate,
        },
      });
    }
  } catch { /* best-effort, non-blocking */ }

  return { ok: true, total, passed, failed, errored };
}

// ──────────────────────────────────────────────────────────────────────
// E10.1 — Cancel + Retry-failed
// ──────────────────────────────────────────────────────────────────────

export async function cancelRegressionBatch(
  config: ServerConfig,
  batchId: string,
  actorId: string,
): Promise<{ ok: boolean; status: RegressionBatch['status']; idempotent?: boolean; error?: string }> {
  const sb = getServiceClient(config);
  const { data: cur } = await sb.from('ai_agent_regression_batches')
    .select('id,status,metadata').eq('id', batchId).maybeSingle();
  if (!cur) return { ok: false, status: 'failed', error: 'not_found' };
  if (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'cancelled') {
    return { ok: true, status: cur.status as RegressionBatch['status'], idempotent: true };
  }
  const meta = { ...((cur.metadata as Record<string, unknown>) || {}) };
  meta.cancelled_at = new Date().toISOString();
  meta.cancelled_by = actorId;
  const { data: upd, error } = await sb.from('ai_agent_regression_batches')
    .update({ status: 'cancelled', finished_at: new Date().toISOString(), metadata: meta })
    .eq('id', batchId)
    .in('status', ['queued', 'running'])
    .select('status').maybeSingle();
  if (error) return { ok: false, status: cur.status as RegressionBatch['status'], error: error.message };
  return { ok: true, status: (upd?.status as RegressionBatch['status']) || 'cancelled' };
}

export async function retryFailedRegressionBatch(
  config: ServerConfig,
  batchId: string,
  actorId: string,
): Promise<{ ok: boolean; batch?: RegressionBatch; error?: string }> {
  const sb = getServiceClient(config);
  const { data: orig } = await sb.from('ai_agent_regression_batches')
    .select('*').eq('id', batchId).maybeSingle();
  if (!orig) return { ok: false, error: 'not_found' };
  // Find latest run per test_case in this batch where status is failed/errored.
  const { data: runs } = await sb.from('ai_agent_test_runs')
    .select('test_case_id,status,created_at')
    .eq('regression_batch_id', batchId)
    .order('created_at', { ascending: false });
  const seen = new Set<string>();
  const failedCaseIds: string[] = [];
  for (const r of (runs || []) as any[]) {
    if (!r.test_case_id || seen.has(r.test_case_id)) continue;
    seen.add(r.test_case_id);
    if (r.status === 'failed' || r.status === 'errored') failedCaseIds.push(r.test_case_id);
  }
  if (!failedCaseIds.length) return { ok: false, error: 'no_failed_cases' };
  const { data: created, error } = await sb.from('ai_agent_regression_batches')
    .insert({
      workspace_id: orig.workspace_id,
      schedule_id: orig.schedule_id || null,
      status: 'queued',
      trigger_type: 'manual',
      created_by: actorId,
      metadata: {
        retry_of_batch_id: batchId,
        retry_case_ids: failedCaseIds,
      },
    }).select('*').single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, batch: created as RegressionBatch };
}

// ──────────────────────────────────────────────────────────────────────
// E11 — Observability: overview + CSV export
// ──────────────────────────────────────────────────────────────────────

export interface RegressionOverview {
  total_schedules: number;
  enabled_schedules: number;
  last_batch: RegressionBatch | null;
  last_24h_batches: number;
  last_24h_pass_rate: number | null;
  last_7d_pass_rate: number | null;
  // last 7d, status='failed' OR has failed/errored runs (cancelled NOT counted)
  failed_batches_count: number;
  cancelled_batches_count: number;
  // failed + cancelled + with failed/errored runs (deduped)
  problematic_batches_count: number;
  errored_runs_count: number;   // last 7d
  top_failure_reasons: { reason: string; count: number }[];
  coverage_by_source_type: { source_type: string; runs: number }[];
  next_due_schedule: { id: string; name: string; next_run_at: string | null; timezone: string } | null;
}

export async function getRegressionOverview(
  config: ServerConfig,
  workspaceId: string,
): Promise<RegressionOverview> {
  const sb = getServiceClient(config);
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

  const [{ data: schedules }, { data: lastBatchRow }, { data: batches7d }, { data: nextDue }] = await Promise.all([
    sb.from('ai_agent_regression_schedules').select('id,enabled,name,next_run_at,timezone').eq('workspace_id', workspaceId),
    sb.from('ai_agent_regression_batches').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('ai_agent_regression_batches').select('*').eq('workspace_id', workspaceId).gte('created_at', since7d).order('created_at', { ascending: false }).limit(500),
    sb.from('ai_agent_regression_schedules').select('id,name,next_run_at,timezone').eq('workspace_id', workspaceId).eq('enabled', true).neq('frequency', 'manual').not('next_run_at', 'is', null).order('next_run_at', { ascending: true }).limit(1).maybeSingle(),
  ]);

  const schedList = (schedules || []) as any[];
  const all7d = (batches7d || []) as RegressionBatch[];
  const all24h = all7d.filter((b) => new Date(b.created_at).getTime() >= now - 24 * 3600 * 1000);
  const computeRate = (rows: RegressionBatch[]) => {
    let p = 0, t = 0;
    for (const b of rows) { p += b.passed || 0; t += (b.passed || 0) + (b.failed || 0) + (b.errored || 0); }
    return t > 0 ? p / t : null;
  };

  const failedSet = new Set<string>();
  const cancelledSet = new Set<string>();
  const problematicSet = new Set<string>();
  for (const b of all7d) {
    const hasFailedRuns = ((b.failed || 0) + (b.errored || 0)) > 0;
    if (b.status === 'cancelled') {
      cancelledSet.add(b.id);
      problematicSet.add(b.id);
      continue;
    }
    if (b.status === 'failed' || hasFailedRuns) {
      failedSet.add(b.id);
      problematicSet.add(b.id);
    }
  }
  const batchIds7d = all7d.map((b) => b.id);

  let topFailure: { reason: string; count: number }[] = [];
  let coverage: { source_type: string; runs: number }[] = [];
  let erroredRunsCount = 0;
  if (batchIds7d.length) {
    const { data: runs } = await sb
      .from('ai_agent_test_runs')
      .select('status,failure_reasons,selected_sources')
      .in('regression_batch_id', batchIds7d)
      .limit(2000);
    const counts = new Map<string, number>();
    const cov = new Map<string, number>();
    for (const r of (runs || []) as any[]) {
      if (r.status === 'errored') erroredRunsCount += 1;
      for (const reason of (r.failure_reasons || []) as string[]) {
        const key = String(reason).split(':')[0] || String(reason);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const seen = new Set<string>();
      for (const s of (r.selected_sources || []) as any[]) {
        const t = s?.source_type;
        if (t && !seen.has(t)) { seen.add(t); cov.set(t, (cov.get(t) || 0) + 1); }
      }
    }
    topFailure = [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8);
    coverage = [...cov.entries()].map(([source_type, runs]) => ({ source_type, runs })).sort((a, b) => b.runs - a.runs);
  }

  return {
    total_schedules: schedList.length,
    enabled_schedules: schedList.filter((s) => s.enabled).length,
    last_batch: (lastBatchRow as RegressionBatch) || null,
    last_24h_batches: all24h.length,
    last_24h_pass_rate: computeRate(all24h),
    last_7d_pass_rate: computeRate(all7d),
    failed_batches_count: failedSet.size,
    cancelled_batches_count: cancelledSet.size,
    problematic_batches_count: problematicSet.size,
    errored_runs_count: erroredRunsCount,
    top_failure_reasons: topFailure,
    coverage_by_source_type: coverage,
    next_due_schedule: (nextDue as any) || null,
  };
}

// E11.1 — strip any value/key containing storage paths, URLs, tokens, or
// credentials. Defense-in-depth so titles or future fields cannot leak file
// URLs / signed URLs / secrets into exported CSV.
const FORBIDDEN_RX = /(storage_path|storage_url|signed_url|public_url|token|secret|password|credential|api_key|access_key|bucket|x-amz|\/storage\/v1\/object)/i;
function sanitizeString(s: string): string {
  if (!s) return s;
  if (FORBIDDEN_RX.test(s)) return '[redacted]';
  // Strip any URL-ish path that looks like an object path even without keywords above.
  if (/https?:\/\/\S+/i.test(s) && /\/(storage|object|sign)\//i.test(s)) return '[redacted]';
  return s;
}
function sanitizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return sanitizeString(v);
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_RX.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = sanitizeValue(val);
    }
    return out;
  }
  return v;
}
function csvEscape(v: unknown): string {
  const sv = sanitizeValue(v);
  if (sv === null || sv === undefined) return '';
  const s = typeof sv === 'string' ? sv : Array.isArray(sv) ? sv.map((x) => (typeof x === 'string' ? x : String(x))).join('|') : String(sv);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportRegressionBatchCsv(
  config: ServerConfig,
  batchId: string,
): Promise<{ workspaceId: string; filename: string; csv: string } | null> {
  const sb = getServiceClient(config);
  const { data: batch } = await sb.from('ai_agent_regression_batches').select('id,workspace_id,created_at').eq('id', batchId).maybeSingle();
  if (!batch) return null;
  const { data: runs } = await sb
    .from('ai_agent_test_runs')
    .select('test_case_id,status,actual_status,confidence,failure_reasons,selected_sources,created_at,test_case:ai_agent_test_cases(name,expected_behavior)')
    .eq('regression_batch_id', batchId)
    .order('created_at', { ascending: true })
    .limit(2000);

  const header = [
    'test_case_id', 'test_name', 'status', 'expected_behavior', 'actual_status',
    'confidence', 'failure_reasons', 'selected_source_types', 'selected_source_titles', 'created_at',
  ];
  const lines: string[] = [header.join(',')];
  for (const r of (runs || []) as any[]) {
    const tc = r.test_case || {};
    const types = Array.from(new Set((r.selected_sources || []).map((s: any) => s?.source_type).filter(Boolean)));
    const titles = (r.selected_sources || []).map((s: any) => s?.title).filter(Boolean).slice(0, 8);
    lines.push([
      csvEscape(r.test_case_id),
      csvEscape(tc.name || ''),
      csvEscape(r.status),
      csvEscape(tc.expected_behavior || ''),
      csvEscape(r.actual_status),
      csvEscape(r.confidence ?? ''),
      csvEscape(r.failure_reasons || []),
      csvEscape(types),
      csvEscape(titles),
      csvEscape(r.created_at),
    ].join(','));
  }
  return {
    workspaceId: (batch as any).workspace_id,
    filename: `regression-batch-${batchId.slice(0, 8)}.csv`,
    csv: lines.join('\n'),
  };
}