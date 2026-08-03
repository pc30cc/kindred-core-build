/**
 * ============================================================
 * SHARED WORKSPACE USAGE RESOLVERS
 * ------------------------------------------------------------
 * Single backend source of truth for "how much of <limit> has
 * this workspace consumed in the current period?".
 *
 * Why this exists:
 *   The entitlement enforcement audit (docs/ENFORCEMENT_COVERAGE_AUDIT.md)
 *   identified that `requireLimit(...)` could not be safely attached to
 *   most candidate routes because each route would otherwise ship its
 *   own ad-hoc usage calculation. This module centralises the counting
 *   so middleware and routes can ask one helper and get a consistent
 *   answer.
 *
 * Design rules:
 *   1. Reuse `workspace_usage_counters` (the canonical counter table)
 *      whenever a column already exists for the metric.
 *   2. Only fall back to a derived live-count when (a) the counter
 *      column does not exist, and (b) the source table is small
 *      enough that a `count: 'exact'` query is cheap.
 *   3. Limit keys whose usage cannot yet be resolved safely are
 *      reported as `supported: false` with a `reasonIfUnsupported`
 *      string — never silently treated as zero.
 *   4. This module is BACKEND ONLY. It must not be imported by the
 *      browser bundle.
 * ============================================================
 */

import { createClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import type { ServerConfig } from '../../config.js';
import { countJobsThisMonthDetailed } from '../ai-kb/limits.js';

/** Period source for a usage value. */
export type UsagePeriodKind = 'calendar_month' | 'lifetime' | 'unknown';

/** Where the value came from. */
export type UsageSource =
  | 'workspace_usage_counters' // exact, pre-aggregated
  | 'derived_count'            // live SELECT count(*) on a source table
  | 'derived_sum'              // live SELECT sum(...) on a source table
  | 'unsupported';             // resolver intentionally returns no value

export interface UsageResolution {
  /** Numeric usage value. Always 0 when `supported === false`. */
  value: number;
  /** Period label (e.g. "2026-06" for calendar_month). */
  period: string;
  /** Period kind for downstream consumers. */
  periodKind: UsagePeriodKind;
  /** Where the value came from. */
  source: UsageSource;
  /**
   * Exact === pre-aggregated counter or trustworthy live count.
   * Derived values that may lag (e.g. counters not yet flushed) are
   * marked `false` so middleware can choose whether to fail-closed.
   */
  isExact: boolean;
  /** False when the limit key has no resolver yet. */
  supported: boolean;
  /** Human-readable explanation when `supported === false`. */
  reasonIfUnsupported?: string;
  /** Optional raw note for diagnostics. */
  note?: string;
}

// ─── Period helpers ─────────────────────────────────────────

/** YYYY-MM in UTC — matches `workspace_usage_counters.period`. */
export function currentMonthPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function makeClient(config: ServerConfig) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

// ─── Counter-backed resolver factory ────────────────────────

/**
 * Read a single column of `workspace_usage_counters` for the current
 * calendar month. Missing rows are treated as `0` (the workspace
 * simply hasn't recorded any usage yet this period).
 */
async function readCounterColumn(
  config: ServerConfig,
  workspaceId: string,
  column:
    | 'conversations_count'
    | 'visitors_count'
    | 'storage_bytes'
    | 'messages_count'
    | 'ai_credits_used'
    | 'email_sent_count'
    | 'call_minutes_used',
): Promise<number> {
  const sb = makeClient(config);
  const period = currentMonthPeriod();
  const { data, error } = await sb
    .from('workspace_usage_counters')
    .select(column)
    .eq('workspace_id', workspaceId)
    .eq('period', period)
    .maybeSingle();
  if (error) throw new Error(`counter_read_failed:${column}:${error.message}`);
  const v = (data as Record<string, unknown> | null)?.[column];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ─── Per-limit resolvers ────────────────────────────────────
//
// Each function here MUST be deterministic for a given (workspaceId,
// now). Throwing is OK — the orchestrator wraps it.

async function resolveMaxConversations(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const value = await readCounterColumn(config, workspaceId, 'conversations_count');
  return {
    value,
    period: currentMonthPeriod(),
    periodKind: 'calendar_month',
    source: 'workspace_usage_counters',
    isExact: true,
    supported: true,
  };
}

async function resolveMaxVisitors(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const value = await readCounterColumn(config, workspaceId, 'visitors_count');
  return {
    value,
    period: currentMonthPeriod(),
    periodKind: 'calendar_month',
    source: 'workspace_usage_counters',
    isExact: true,
    supported: true,
  };
}

/**
 * `storage_gb` limit is in GB but the underlying counter is bytes.
 * Return value in GB (rounded down to 4 decimals) so it can be compared
 * directly against `limits.storage_gb`.
 */
async function resolveStorageGb(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const bytes = await readCounterColumn(config, workspaceId, 'storage_bytes');
  const gb = bytes / (1024 * 1024 * 1024);
  return {
    value: Math.round(gb * 10_000) / 10_000,
    period: 'lifetime',
    periodKind: 'lifetime',
    source: 'workspace_usage_counters',
    isExact: true,
    supported: true,
    note: `${bytes} bytes`,
  };
}

async function resolveAiKbJobsPerMonth(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  // `countJobsThisMonthDetailed` lives in services/ai-kb/limits.ts and is the
  // canonical implementation used by aiKb route gating. Phase 6-S5-R7.3 §3 —
  // an unreadable count must NOT resolve to 0, which would hand out unlimited
  // scans during an outage; it is reported as unsupported so the limit check
  // fails closed.
  const read = await countJobsThisMonthDetailed(config, workspaceId);
  if (!read.ok) {
    return {
      value: 0,
      period: currentMonthPeriod(),
      periodKind: 'calendar_month',
      source: 'unsupported',
      isExact: false,
      supported: false,
      reasonIfUnsupported: 'job_usage_status_unavailable',
    };
  }
  const value = read.value;
  return {
    value,
    period: currentMonthPeriod(),
    periodKind: 'calendar_month',
    source: 'derived_count',
    isExact: true,
    supported: true,
    note: 'count(*) on ai_kb_jobs since UTC start of month',
  };
}

async function resolveAiCreditsPerMonth(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const value = await readCounterColumn(config, workspaceId, 'ai_credits_used');
  return {
    value,
    period: currentMonthPeriod(),
    periodKind: 'calendar_month',
    source: 'workspace_usage_counters',
    isExact: true,
    supported: true,
  };
}

/**
 * `max_contacts` — current occupancy of `public.contacts` for the
 * workspace. Live exact count via the service-role client.
 *
 * Semantics (locked in `docs/CONTACTS_LIMIT_POLICY.md`):
 *   - Counts every row scoped by `workspace_id`.
 *   - Deletes free capacity (no soft-delete accounting).
 *   - Edits, tag changes, note changes do NOT consume capacity.
 *   - Identity merges collapse rows; net `count(*)` is what counts.
 * `public.contacts` is workspace-scoped and indexed on `workspace_id`,
 * so an exact count is cheap at expected cardinality.
 */
async function resolveMaxContacts(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const sb = makeClient(config);
  const { count, error } = await sb
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`max_contacts_count_failed:${error.message}`);
  return {
    value: typeof count === 'number' ? count : 0,
    period: 'lifetime',
    periodKind: 'lifetime',
    source: 'derived_count',
    isExact: true,
    supported: true,
    note: 'count(*) on public.contacts where workspace_id = $1 (occupancy)',
  };
}

/**
 * `max_agents` — current seat occupancy of a workspace, defined as
 * `count(*)` on `public.workspace_members` filtered by `workspace_id`.
 *
 * Semantics (locked in `docs/MAX_AGENTS_POLICY.md`):
 *   - One row in `workspace_members` per `(workspace_id, user_id)` =
 *     one seat. Departments do not multiply seats.
 *   - All members count regardless of `role`. The owner counts.
 *   - Pending `workspace_invitations` do NOT consume capacity;
 *     capacity is consumed only when a `workspace_members` row is
 *     inserted (i.e. invite is redeemed via the canonical Express
 *     route).
 *   - Removing a member frees capacity immediately (occupancy, not
 *     monthly throughput).
 *   - `-1` means unlimited (registry-wide convention).
 *
 * Activated by the "Service-Role Companion RPC + Max Agents
 * Activation" phase, gated by the canonical seat-creation route at
 * `POST /api/workspace-members/accept-invitation`. The browser-side
 * RPC bypass was closed in the same migration that introduced this
 * resolver, so this counter is the only seat-counting model.
 */
async function resolveMaxAgents(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const sb = makeClient(config);
  const { count, error } = await sb
    .from('workspace_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`max_agents_count_failed:${error.message}`);
  return {
    value: typeof count === 'number' ? count : 0,
    period: 'lifetime',
    periodKind: 'lifetime',
    source: 'derived_count',
    isExact: true,
    supported: true,
    note: 'count(*) on public.workspace_members where workspace_id = $1 (seat occupancy)',
  };
}

/**
 * `max_concurrent_calls` — workspace-wide live count of currently-active
 * call_sessions. Backed by the canonical partial index
 * `idx_call_sessions_state_active (workspace_id, state)` defined in
 * `supabase/migrations/20260422123023_*.sql`.
 *
 * Active set (canonical — locked by the dual-knob activation pass):
 *   - state IN ('pending','ringing','connecting','active')
 *   - ALL entry_source values (operator, invitation, callback,
 *     call_widget, call_center, …) are counted. This is the
 *     workspace-wide ceiling and is intentionally broader than the
 *     existing widget-scoped admin knob enforcement at
 *     `server/routes/callWidget.ts` (which scopes to
 *     `entry_source = 'call_widget'` and excludes `pending`).
 *
 * Composition policy (`docs/CALL_NUMERIC_LIMITS.md` — Dual-Knob):
 *   the plan-level `max_concurrent_calls` and the widget-scoped admin
 *   knob `platform_call_center_settings.max_concurrent_calls_per_workspace`
 *   are TWO DIFFERENT CEILINGS. Both are checked independently at the
 *   relevant create boundary; the first denial wins. This resolver
 *   only serves the plan-level ceiling.
 *
 * Occupancy semantics:
 *   - call ends (state → 'ended' / 'failed' / 'rejected' / …) free
 *     capacity immediately;
 *   - no settle-time counter column is involved; this is a derived
 *     live count;
 *   - `-1` on the plan limit = unlimited (registry-wide convention).
 */
async function resolveMaxConcurrentCalls(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const sb = makeClient(config);
  const { count, error } = await sb
    .from('call_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('state', ['pending', 'ringing', 'connecting', 'active']);
  if (error) throw new Error(`max_concurrent_calls_count_failed:${error.message}`);
  return {
    value: typeof count === 'number' ? count : 0,
    period: 'lifetime',
    periodKind: 'lifetime',
    source: 'derived_count',
    isExact: true,
    supported: true,
    note: "count(*) on public.call_sessions where workspace_id = $1 AND state IN ('pending','ringing','connecting','active') — canonical active-call set, all entry_source values",
  };
}

function unsupported(reason: string, period = currentMonthPeriod()): UsageResolution {
  return {
    value: 0,
    period,
    periodKind: 'unknown',
    source: 'unsupported',
    isExact: false,
    supported: false,
    reasonIfUnsupported: reason,
  };
}

/**
 * `max_call_minutes_per_month` — monthly aggregate of billable call
 * minutes per workspace.
 *
 * Source of truth: `workspace_usage_counters.call_minutes_used` (UTC
 * YYYY-MM bucket). Sole writer is the DB trigger
 * `tg_call_sessions_bill_minutes` on `public.call_sessions`. Billable
 * policy (locked in docs/CALL_NUMERIC_LIMITS.md):
 *   - connected_at IS NOT NULL AND state transitions to 'ended'
 *   - minutes = CEIL((ended_at - connected_at) / 60)
 *   - non-connected outcomes and zero-duration outcomes do not count
 *
 * Live — enforced at create-time by
 * `server/services/calls/monthlyMinutesLimit.ts#checkPlanMonthlyMinutesCeiling`
 * on `POST /api/calls/create` and `POST /api/widget/calls/request`.
 * The webhook-driven `room_started` path backfills `connected_at`
 * when missing, so every call that actually becomes active feeds
 * the trigger.
 */
async function resolveMaxCallMinutesPerMonth(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const value = await readCounterColumn(config, workspaceId, 'call_minutes_used');
  return {
    value,
    period: currentMonthPeriod(),
    periodKind: 'calendar_month',
    source: 'workspace_usage_counters',
    isExact: true,
    supported: true,
    note: 'CEIL(sum(ended_at - connected_at) / 60) for state=ended calls; UTC month bucket',
  };
}

/**
 * `max_call_recordings` — lifetime occupancy of stored call recordings
 * for the workspace. Live derived count(*) on `public.call_recordings`
 * joined via the canonical FK `call_recordings.call_session_id ->
 * call_sessions.id`. Cheap at expected cardinality (typically O(100s)
 * per workspace) and naturally indexed by the FK.
 *
 * Deletes free capacity (occupancy, not throughput). -1 on the plan
 * = unlimited.
 */
async function resolveMaxCallRecordings(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const sb = makeClient(config);
  const { count, error } = await sb
    .from('call_recordings')
    .select('id, call_sessions!inner(workspace_id)', { count: 'exact', head: true })
    .eq('call_sessions.workspace_id', workspaceId);
  if (error) throw new Error(`max_call_recordings_count_failed:${error.message}`);
  return {
    value: typeof count === 'number' ? count : 0,
    period: 'lifetime',
    periodKind: 'lifetime',
    source: 'derived_count',
    isExact: true,
    supported: true,
    note: 'count(*) on call_recordings INNER JOIN call_sessions where workspace_id = $1',
  };
}

/**
 * `max_call_recording_storage_mb` — lifetime aggregate stored size of
 * call recordings (MiB) for the workspace. Source:
 * SUM(call_recordings.size_bytes) for rows whose owning call_session
 * belongs to the workspace. Deletes free capacity.
 */
async function resolveMaxCallRecordingStorageMb(
  config: ServerConfig,
  workspaceId: string,
): Promise<UsageResolution> {
  const sb = makeClient(config);
  // Page through rows to compute SUM(size_bytes). Recording counts per
  // workspace are small (typically O(100s)); paging keeps memory bounded.
  let totalBytes = 0;
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('call_recordings')
      .select('size_bytes, call_sessions!inner(workspace_id)')
      .eq('call_sessions.workspace_id', workspaceId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`max_call_recording_storage_mb_sum_failed:${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const b = (row as { size_bytes: number | null }).size_bytes;
      if (typeof b === 'number' && Number.isFinite(b) && b > 0) totalBytes += b;
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  const mib = totalBytes / (1024 * 1024);
  return {
    value: Math.round(mib * 100) / 100,
    period: 'lifetime',
    periodKind: 'lifetime',
    source: 'derived_sum',
    isExact: true,
    supported: true,
    note: `SUM(size_bytes)=${totalBytes} bytes; converted to MiB`,
  };
}

// ─── Limit key → resolver registry ──────────────────────────

type Resolver = (config: ServerConfig, workspaceId: string) => Promise<UsageResolution>;

/**
 * Canonical mapping: capability registry limit key → usage resolver.
 *
 * Adding a new limit key:
 *   1. Confirm there is a column in `workspace_usage_counters` OR a
 *      cheap, exact derived query.
 *   2. Implement the resolver above.
 *   3. Register it here.
 *   4. Update docs/USAGE_METRICS.md.
 */
const RESOLVERS: Record<string, Resolver> = {
  max_conversations: resolveMaxConversations,
  max_visitors: resolveMaxVisitors,
  storage_gb: resolveStorageGb,
  ai_kb_jobs_per_month: resolveAiKbJobsPerMonth,
  ai_credits_per_month: resolveAiCreditsPerMonth,
  max_contacts: resolveMaxContacts,
  max_agents: resolveMaxAgents,
  max_concurrent_calls: resolveMaxConcurrentCalls,
  max_call_minutes_per_month: resolveMaxCallMinutesPerMonth,
  max_call_recordings: resolveMaxCallRecordings,
  max_call_recording_storage_mb: resolveMaxCallRecordingStorageMb,
};

/**
 * Limit keys that exist in the registry but are intentionally NOT
 * resolvable yet. Listed explicitly so callers (and the docs) can see
 * the gap rather than silently treating them as 0.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  max_workspaces:
    'Per-account workspace count is enforced at workspace creation; not modelled per-workspace.',
  ai_kb_max_pages:
    'Per-job cap, not a workspace-period usage.',
  ai_kb_max_depth:
    'Per-job cap, not a workspace-period usage.',
  ai_kb_file_size_mb:
    'Per-file cap, not a workspace-period usage.',
  ai_kb_file_count:
    'Lifetime file count not yet aggregated; defer until a counter or cheap query is defined.',
  data_retention_days:
    'Retention cap is enforced by janitor jobs; not a usage-vs-limit gate.',
};

// ─── Public API ─────────────────────────────────────────────

/** Resolve current usage for a single limit key. Never throws. */
export async function resolveUsage(
  config: ServerConfig,
  workspaceId: string,
  limitKey: string,
): Promise<UsageResolution> {
  const fn = RESOLVERS[limitKey];
  if (!fn) {
    const reason = KNOWN_UNSUPPORTED[limitKey] || 'No resolver registered for this limit key.';
    return unsupported(reason);
  }
  try {
    return await fn(config, workspaceId);
  } catch (err: any) {
    return {
      value: 0,
      period: currentMonthPeriod(),
      periodKind: 'unknown',
      source: 'unsupported',
      isExact: false,
      supported: false,
      reasonIfUnsupported: `resolver_error:${err?.message || 'unknown'}`,
    };
  }
}

/** True iff `resolveUsage(limitKey)` will return `supported: true`. */
export function isUsageSupported(limitKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(RESOLVERS, limitKey);
}

/** Snapshot of resolver capability for diagnostics / docs. */
export function listUsageSupport(): Array<{
  key: string;
  supported: boolean;
  reason?: string;
}> {
  const supportedKeys = Object.keys(RESOLVERS);
  const unsupportedKeys = Object.keys(KNOWN_UNSUPPORTED).filter((k) => !RESOLVERS[k]);
  return [
    ...supportedKeys.map((key) => ({ key, supported: true })),
    ...unsupportedKeys.map((key) => ({ key, supported: false, reason: KNOWN_UNSUPPORTED[key] })),
  ];
}

/**
 * Adapter that produces a `currentUsageFn` compatible with the
 * existing `requireLimit(feature, currentUsageFn)` middleware in
 * `server/middleware/featureGating.ts`.
 *
 * Behaviour:
 *   - If the limit key is supported, returns the numeric usage value.
 *   - If the limit key is NOT supported, the function THROWS, which
 *     causes `requireLimit` to fail-closed (matching the middleware's
 *     existing contract). This is intentional: callers that want a
 *     softer fallback must register a resolver instead.
 */
export function usageFnForLimit(limitKey: string) {
  return async (req: Request, workspaceId: string): Promise<number> => {
    const config = (req as any).serverConfig as ServerConfig | undefined;
    if (!config) throw new Error('serverConfig_missing');
    const r = await resolveUsage(config, workspaceId, limitKey);
    if (!r.supported) {
      throw new Error(`usage_unsupported:${limitKey}:${r.reasonIfUnsupported || ''}`);
    }
    return r.value;
  };
}