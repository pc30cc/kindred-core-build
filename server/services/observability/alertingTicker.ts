/**
 * Phase 4 — In-process alerting ticker.
 * Runs runAlertCycle() every 60s. Best-effort, never throws to caller.
 * Same pattern as rollupTicker so we never depend on pg_cron in self-host.
 */
import type { ServerConfig } from '../../config.js';
import { runAlertCycle } from './alerting.js';
import { emitLog } from './metrics.js';

const TICK_MS = 60 * 1000; // 60s
let timer: ReturnType<typeof setInterval> | null = null;

export function startAlertingTicker(config: ServerConfig): void {
  if (timer) return;
  // First run shortly after boot (gives the rollup ticker a head start).
  setTimeout(() => runOnce(config), 45_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

async function runOnce(config: ServerConfig): Promise<void> {
  try {
    const r = await runAlertCycle(config);
    if (r.state_changes > 0) {
      emitLog(config, 'info', 'alert_cycle_ran', {
        evaluated: r.evaluated,
        state_changes: r.state_changes,
      });
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'alert_cycle_threw', { error: err?.message || 'unknown' });
  }
}

export function __stopAlertingTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}