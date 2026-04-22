/**
 * Phase 3 — In-process rollup ticker.
 * Calls realtime_metrics_rollup_and_prune() every 10 minutes. The SQL
 * function only rolls up the *previous* full hour, so running it more
 * often is safe and idempotent. We never want to depend on pg_cron in a
 * self-host context.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';

const TICK_MS = 10 * 60 * 1000; // 10 minutes
let timer: ReturnType<typeof setInterval> | null = null;

export function startMetricsRollup(config: ServerConfig): void {
  if (timer) return;
  // Run once shortly after boot, then on the interval. Best-effort.
  setTimeout(() => runOnce(config), 30_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

async function runOnce(config: ServerConfig): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('realtime_metrics_rollup_and_prune');
    if (error) {
      emitLog(config, 'warn', 'metrics_rollup_failed', { error: error.message });
      return;
    }
    emitLog(config, 'debug', 'metrics_rollup_ran', (data as Record<string, unknown>) || {});
  } catch (err: any) {
    emitLog(config, 'warn', 'metrics_rollup_threw', { error: err?.message || 'unknown' });
  }

  // Phase 5A — also roll up performance samples on the same cadence.
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('perf_metrics_rollup_and_prune');
    if (error) {
      emitLog(config, 'warn', 'perf_rollup_failed', { error: error.message });
      return;
    }
    emitLog(config, 'debug', 'perf_rollup_ran', (data as Record<string, unknown>) || {});
  } catch (err: any) {
    emitLog(config, 'warn', 'perf_rollup_threw', { error: err?.message || 'unknown' });
  }
}

export function __stopMetricsRollupForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
