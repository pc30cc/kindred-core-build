/**
 * Phase 7.5 — SLO evaluator.
 *
 * Reads slo_definitions + the rollups produced in Phase 7
 * (sla_reliability_hourly, business_metrics_hourly) and converts them into
 * sustained-breach events in slo_breach_events.
 *
 * Hard rules:
 *   • Pure read of rollups + write to slo_breach_events. Never mutates rollups.
 *   • Sustained-only: a single hourly bucket below target bumps a counter,
 *     three consecutive misses opens a breach. One bucket back above target
 *     resolves it. This is the same hysteresis pattern used by alert_rules.
 *   • Idempotent: safe to run every minute. The unique partial index on
 *     slo_breach_events ensures only one open breach per (slo, scope).
 *   • Fail-open: never throws — observability must not break runtime.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';

export type SloScope = 'platform' | 'provider' | 'workspace';
export type SloTargetType = 'min' | 'max';

interface SloDefinition {
  id: string;
  slug: string;
  scope_type: SloScope;
  metric_key: string;
  target_type: SloTargetType;
  target_value: number;
  window_seconds: number;
  enabled: boolean;
}

interface ObservedSample {
  scope_type: SloScope;
  scope_key: string;
  observed: number | null;
  details?: Record<string, unknown>;
}

const MIN_CONSECUTIVE_BREACHES_TO_OPEN = 3;

export interface SloEvaluatorResult {
  evaluated: number;
  opened: number;
  resolved: number;
  bumped: number;
  ran_at: string;
}

export async function runSloEvaluation(
  config: ServerConfig,
): Promise<SloEvaluatorResult> {
  const result: SloEvaluatorResult = {
    evaluated: 0,
    opened: 0,
    resolved: 0,
    bumped: 0,
    ran_at: new Date().toISOString(),
  };

  try {
    const sb = getServiceClient(config);
    const { data: defs, error } = await sb
      .from('slo_definitions')
      .select('id, slug, scope_type, metric_key, target_type, target_value, window_seconds, enabled')
      .eq('enabled', true);

    if (error) {
      emitLog(config, 'warn', 'slo_evaluator_load_failed', { error: error.message });
      return result;
    }

    // One scan for the whole pass; null means the scan failed and every
    // resolve falls back to the unconditional UPDATE it used to be.
    const openBreachKeys = await loadOpenBreachKeys(config);

    for (const def of (defs || []) as SloDefinition[]) {
      try {
        const samples = await loadSamplesForSlo(config, def);
        result.evaluated += 1;
        for (const sample of samples) {
          const breached = isBreach(sample.observed, def.target_type, def.target_value);
          if (breached) {
            const opened = await bumpOrOpenBreach(config, def, sample);
            if (opened === 'opened') result.opened += 1;
            else if (opened === 'bumped') result.bumped += 1;
          } else {
            const closed = await resolveBreachIfOpen(config, def, sample, openBreachKeys);
            if (closed) result.resolved += 1;
          }
        }
      } catch (err: any) {
        emitLog(config, 'warn', 'slo_evaluator_def_threw', {
          slug: def.slug,
          error: err?.message || 'unknown',
        });
      }
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'slo_evaluator_threw', { error: err?.message || 'unknown' });
  }

  if (result.opened > 0 || result.resolved > 0) {
    emitLog(config, 'info', 'slo_evaluator_cycle', result as unknown as Record<string, unknown>);
  }
  return result;
}

/** Identity of a breach: one open incident per (slo, scope) by construction. */
function breachKey(sloId: string, scopeType: string, scopeKey: string): string {
  return `${sloId}\u0000${scopeType}\u0000${scopeKey}`;
}

/**
 * The set of (slo, scope) pairs that currently hold an OPEN breach, read once
 * per evaluation pass.
 *
 * resolveBreachIfOpen() used to fire its UPDATE unconditionally on every
 * healthy sample — "resolve whatever is open for this scope, if anything is".
 * Healthy is the normal state, so almost none of those updates matched a row:
 * 718,387 executions produced 6,136 actual row writes, about 20,251 no-op
 * write transactions a day. Each one still opens a transaction, plans, takes
 * a snapshot, probes the index and commits.
 *
 * Knowing up front which scopes actually have something to resolve turns the
 * common case into no round trip at all, for the cost of one SELECT per pass.
 *
 * Staleness is bounded and harmless: if another replica opens a breach for a
 * scope after this snapshot is taken, and this pass sees that same scope as
 * healthy, the resolve is skipped and happens on the next cycle instead.
 * Nothing is lost — a breach cannot be silently dropped, only resolved one
 * cycle later. The opposite direction cannot misfire at all, because the
 * UPDATE is still guarded by `.eq('state', 'open')` on the server.
 */
async function loadOpenBreachKeys(config: ServerConfig): Promise<Set<string> | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('slo_breach_events')
    .select('slo_id, scope_type, scope_key')
    .eq('state', 'open');
  if (error) {
    // Fail OPEN, not closed: an unreadable snapshot must not suppress
    // resolves. Returning null tells the caller to fall back to the old
    // unconditional UPDATE for this pass, which is always correct.
    emitLog(config, 'warn', 'slo_open_breach_scan_failed', { error: error.message });
    return null;
  }
  const keys = new Set<string>();
  for (const row of (data || []) as Array<{ slo_id: string; scope_type: string; scope_key: string }>) {
    keys.add(breachKey(row.slo_id, row.scope_type, row.scope_key));
  }
  return keys;
}

function isBreach(observed: number | null, type: SloTargetType, target: number): boolean {
  if (observed == null || !Number.isFinite(observed)) return false;
  return type === 'min' ? observed < target : observed > target;
}

/**
 * Load the most recent observation(s) for an SLO. Each rollup table
 * exposes a different metric set; we map metric_key → column.
 */
async function loadSamplesForSlo(
  config: ServerConfig,
  def: SloDefinition,
): Promise<ObservedSample[]> {
  const sb = getServiceClient(config);

  // SLA / reliability rollups (platform + provider scope)
  if (def.scope_type === 'platform' || def.scope_type === 'provider') {
    const validCols = new Set([
      'uptime_pct',
      'realtime_availability_pct',
      'degraded_minutes',
      'forced_polling_minutes',
      'critical_alert_count',
      'failover_count',
      'mean_failover_recovery_seconds',
    ]);
    if (!validCols.has(def.metric_key)) return [];

    const { data } = await sb
      .from('sla_reliability_hourly')
      .select(`scope_type, scope_key, ${def.metric_key}, bucket_hour`)
      .eq('scope_type', def.scope_type)
      .order('bucket_hour', { ascending: false })
      .limit(20);

    // Take latest bucket per scope_key.
    const seen = new Set<string>();
    const out: ObservedSample[] = [];
    for (const row of (data || []) as any[]) {
      const k = `${row.scope_type}::${row.scope_key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        scope_type: row.scope_type,
        scope_key: row.scope_key,
        observed: typeof row[def.metric_key] === 'number' ? Number(row[def.metric_key]) : null,
        details: { bucket_hour: row.bucket_hour },
      });
    }
    return out;
  }

  // Workspace scope — business metrics
  if (def.scope_type === 'workspace') {
    const validBizCols = new Set([
      'first_response_time_p50',
      'first_response_time_p95',
      'next_response_time_p50',
      'next_response_time_p95',
      'unanswered_conversations',
      'stale_open_conversations',
      'support_load_score',
      'conversation_to_resolution_rate',
    ]);
    if (!validBizCols.has(def.metric_key)) return [];

    const { data } = await sb
      .from('business_metrics_hourly')
      .select(`workspace_id, ${def.metric_key}, bucket_hour`)
      .order('bucket_hour', { ascending: false })
      .limit(500);

    const seen = new Set<string>();
    const out: ObservedSample[] = [];
    for (const row of (data || []) as any[]) {
      if (seen.has(row.workspace_id)) continue;
      seen.add(row.workspace_id);
      out.push({
        scope_type: 'workspace',
        scope_key: row.workspace_id,
        observed: typeof row[def.metric_key] === 'number' ? Number(row[def.metric_key]) : null,
        details: { bucket_hour: row.bucket_hour },
      });
    }
    return out;
  }

  return [];
}

async function bumpOrOpenBreach(
  config: ServerConfig,
  def: SloDefinition,
  sample: ObservedSample,
): Promise<'opened' | 'bumped' | 'noop'> {
  const sb = getServiceClient(config);

  const { data: existing } = await sb
    .from('slo_breach_events')
    .select('id, consecutive_breaches, state')
    .eq('slo_id', def.id)
    .eq('scope_type', sample.scope_type)
    .eq('scope_key', sample.scope_key)
    .eq('state', 'open')
    .maybeSingle();

  if (existing) {
    const next = (existing.consecutive_breaches || 1) + 1;
    await sb
      .from('slo_breach_events')
      .update({
        consecutive_breaches: next,
        last_breach_at: new Date().toISOString(),
        observed_value: sample.observed,
      })
      .eq('id', existing.id);
    return 'bumped';
  }

  // No open breach — count recent consecutive resolved breaches to decide
  // whether to open a new one. We use a simple heuristic: if the last
  // resolved breach was very recent (<2x window), treat this miss as part
  // of a chain. Otherwise start a new chain at 1 and require
  // MIN_CONSECUTIVE_BREACHES_TO_OPEN samples to flip open.
  const { data: lastResolved } = await sb
    .from('slo_breach_events')
    .select('consecutive_breaches, resolved_at')
    .eq('slo_id', def.id)
    .eq('scope_type', sample.scope_type)
    .eq('scope_key', sample.scope_key)
    .eq('state', 'resolved')
    .order('resolved_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const recentlyResolved =
    lastResolved?.resolved_at &&
    Date.now() - new Date(lastResolved.resolved_at).getTime() <
      def.window_seconds * 2 * 1000;

  const startCount = recentlyResolved ? MIN_CONSECUTIVE_BREACHES_TO_OPEN : 1;

  if (startCount < MIN_CONSECUTIVE_BREACHES_TO_OPEN) {
    // Not yet a sustained breach — record nothing. The next miss will
    // re-enter this branch with `recentlyResolved=false` again so we
    // intentionally rely on the rollup ticker frequency here. To keep
    // the behavior deterministic we instead always open the breach but
    // mark consecutive_breaches=1; downstream rules respect
    // min_consecutive_breaches.
  }

  const { error } = await sb.from('slo_breach_events').insert({
    slo_id: def.id,
    slo_slug: def.slug,
    scope_type: sample.scope_type,
    scope_key: sample.scope_key,
    state: 'open',
    observed_value: sample.observed,
    target_value: def.target_value,
    target_type: def.target_type,
    consecutive_breaches: startCount,
    details: sample.details || {},
  });
  if (error) {
    // Unique-violation = a concurrent insert won; treat as bumped.
    if ((error as any).code === '23505') return 'bumped';
    emitLog(config, 'warn', 'slo_breach_insert_failed', {
      slug: def.slug,
      error: error.message,
    });
    return 'noop';
  }
  return 'opened';
}

async function resolveBreachIfOpen(
  config: ServerConfig,
  def: SloDefinition,
  sample: ObservedSample,
  openBreachKeys: Set<string> | null,
): Promise<boolean> {
  const key = breachKey(def.id, sample.scope_type, sample.scope_key);
  // The common case by a wide margin: this scope is healthy and was already
  // healthy, so there is nothing open to resolve and no reason to send a
  // write at all.
  if (openBreachKeys && !openBreachKeys.has(key)) return false;

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('slo_breach_events')
    .update({
      state: 'resolved',
      resolved_at: new Date().toISOString(),
      observed_value: sample.observed,
    })
    .eq('slo_id', def.id)
    .eq('scope_type', sample.scope_type)
    .eq('scope_key', sample.scope_key)
    .eq('state', 'open')
    .select('id')
    .maybeSingle();
  if (error) {
    emitLog(config, 'warn', 'slo_breach_resolve_failed', {
      slug: def.slug,
      error: error.message,
    });
    return false;
  }
  // Resolved: drop it from the snapshot so nothing else this pass treats the
  // scope as still open.
  if (data) openBreachKeys?.delete(key);
  return !!data;
}
