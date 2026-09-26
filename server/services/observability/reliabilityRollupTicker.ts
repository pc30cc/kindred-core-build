/**
 * Phase 7 — In-process reliability + business rollup ticker.
 * Wakes every 10 minutes. Each SQL function rolls up only the previous full
 * hour, so running it more often is safe and idempotent — but it is not free.
 * No pg_cron dependency (self-host friendly).
 *
 * Re-running within the same hour recomputes the same bucket, and the
 * business rollup is the heaviest query this API issues (it scans the last
 * seven hours of conversation_messages). Recomputing it six times an hour on
 * every replica bought nothing, so each function now runs when a new bucket
 * is due: the bucket a run reports (the database's own hour boundary, so a
 * non-UTC session time zone cannot skew it) tells the ticker when the next
 * one completes. A failed run is retried on the next tick, as before.
 *
 * The business rollup additionally refreshes within the hour: its
 * unanswered / stale / active counts are "now" snapshots, and a built-in SLO
 * (unanswered_conversation_ratio) watches one of them.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';

const TICK_MS = 10 * 60 * 1000; // 10 minutes
const HOUR_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export interface RollupSpec {
  fn: string;
  logSlug: string;
  /** Re-run within a bucket this often; null = once per bucket. */
  refreshMs: number | null;
}

export const ROLLUPS: readonly RollupSpec[] = [
  { fn: 'sla_reliability_rollup_and_prune', logSlug: 'sla_reliability_rollup', refreshMs: null },
  // 25 minutes on a 10-minute tick: twice an hour, with room for timer jitter.
  { fn: 'business_metrics_rollup_and_prune', logSlug: 'business_metrics_rollup', refreshMs: 25 * 60 * 1000 },
];

interface RollupState {
  /** When the bucket after the last one rolled up is complete. */
  nextBucketAt: number;
  lastRunAt: number;
}

const state = new Map<string, RollupState>();

export function isRollupDue(spec: RollupSpec, now: number = Date.now()): boolean {
  const s = state.get(spec.fn);
  if (!s) return true;
  if (now >= s.nextBucketAt) return true;
  return spec.refreshMs !== null && now - s.lastRunAt >= spec.refreshMs;
}

export function startReliabilityRollup(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => runOnce(config), 45_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  timer.unref?.();
}

export async function runOnce(config: ServerConfig): Promise<void> {
  for (const spec of ROLLUPS) {
    if (isRollupDue(spec)) await runRpc(config, spec);
  }
  // workspace_health_snapshot_compute is deliberately absent: the
  // workspace_health_snapshots family (table, partitions and compute
  // function) was dropped from the database, so calling it only produced a
  // 404 every cycle. See the note in server/routes/adminReliability.ts.
}

async function runRpc(config: ServerConfig, spec: RollupSpec): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const startedAt = Date.now();
    const { data, error } = await sb.rpc(spec.fn);
    if (error) {
      emitLog(config, 'warn', `${spec.logSlug}_failed`, { error: error.message });
      return;
    }
    const report = (data as Record<string, unknown> | null) || {};
    // The bucket just rolled is [bucket, bucket + 1h); the next one is
    // complete an hour after that. No readable bucket: stay due every tick,
    // exactly as before.
    const bucketMs = typeof report.bucket === 'string' ? Date.parse(report.bucket) : NaN;
    if (Number.isFinite(bucketMs)) {
      state.set(spec.fn, { nextBucketAt: bucketMs + 2 * HOUR_MS, lastRunAt: startedAt });
    }
    emitLog(config, 'debug', `${spec.logSlug}_ran`, report);
  } catch (err) {
    emitLog(config, 'warn', `${spec.logSlug}_threw`, { error: err?.message || 'unknown' });
  }
}

export function __stopReliabilityRollupForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  state.clear();
}
