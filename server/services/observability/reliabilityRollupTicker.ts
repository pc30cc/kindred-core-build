/**
 * Phase 7 — In-process reliability + business rollup ticker.
 * Calls two SQL functions every 10 minutes. Each only rolls up the
 * previous full hour, so running it more often is safe and idempotent.
 * No pg_cron dependency (self-host friendly).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';

const TICK_MS = 10 * 60 * 1000; // 10 minutes
let timer: ReturnType<typeof setInterval> | null = null;

export function startReliabilityRollup(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => runOnce(config), 45_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

async function runOnce(config: ServerConfig): Promise<void> {
  await runRpc(config, 'sla_reliability_rollup_and_prune', 'sla_reliability_rollup');
  await runRpc(config, 'business_metrics_rollup_and_prune', 'business_metrics_rollup');
}

async function runRpc(config: ServerConfig, fn: string, logSlug: string): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await (sb as any).rpc(fn);
    if (error) {
      emitLog(config, 'warn', `${logSlug}_failed`, { error: error.message });
      return;
    }
    emitLog(config, 'debug', `${logSlug}_ran`, (data as Record<string, unknown>) || {});
  } catch (err: any) {
    emitLog(config, 'warn', `${logSlug}_threw`, { error: err?.message || 'unknown' });
  }
}

export function __stopReliabilityRollupForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}