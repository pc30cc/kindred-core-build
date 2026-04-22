/**
 * Phase 5C — In-process auto-actions ticker.
 * Runs runAutoActionCycle() every 60s. Best-effort, never throws.
 * Same pattern as alertingTicker / rollupTicker — no pg_cron dependency.
 */
import type { ServerConfig } from '../../config.js';
import { runAutoActionCycle } from './autoActions.js';
import { emitLog } from './metrics.js';

const TICK_MS = 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoActionsTicker(config: ServerConfig): void {
  if (timer) return;
  // First run shortly after the alerting ticker so alerts exist before
  // the auto-action engine looks for them.
  setTimeout(() => runOnce(config), 75_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

async function runOnce(config: ServerConfig): Promise<void> {
  try {
    await runAutoActionCycle(config);
  } catch (err: any) {
    emitLog(config, 'warn', 'auto_action_cycle_threw', { error: err?.message || 'unknown' });
  }
}

export function __stopAutoActionsTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}