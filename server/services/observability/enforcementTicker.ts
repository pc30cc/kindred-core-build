/**
 * Phase 7.5 — Enforcement engine ticker.
 * Runs the SLO evaluator + enforcement engine every 60s.
 * Self-host friendly (no pg_cron); same pattern as autoActionsTicker.
 */
import type { ServerConfig } from '../../config.js';
import { runSloEvaluation } from './sloEvaluator.js';
import { runEnforcementCycle } from './enforcementEngine.js';
import { emitLog } from './metrics.js';

const TICK_MS = 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startEnforcementTicker(config: ServerConfig): void {
  if (timer) return;
  // Stagger startup to run after rollups + alerting + auto-actions.
  setTimeout(() => runOnce(config), 90_000);
  timer = setInterval(() => runOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

async function runOnce(config: ServerConfig): Promise<void> {
  try {
    await runSloEvaluation(config);
    await runEnforcementCycle(config);
  } catch (err: any) {
    emitLog(config, 'warn', 'enforcement_ticker_threw', { error: err?.message || 'unknown' });
  }
}

export function __stopEnforcementTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
