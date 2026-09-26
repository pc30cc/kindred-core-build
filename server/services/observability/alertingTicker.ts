/**
 * Phase 4 — In-process alerting ticker.
 * Runs runAlertCycle() every 60s. Best-effort, never throws to caller.
 * Same pattern as rollupTicker so we never depend on pg_cron in self-host.
 */
import type { ServerConfig } from '../../config.js';
import { loadAlertFlags, runAlertCycle } from './alerting.js';
import { emitLog } from './metrics.js';
import { acquireTickerLease, releaseTickerLease } from './tickerLease.js';

const LEASE_NAME = 'alerting';

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
  // The admin alerting toggle is checked BEFORE the lease: runAlertCycle()
  // returns immediately when it is off, so taking (and releasing) the lease
  // first was two database writes a minute to do nothing. loadAlertFlags()
  // is cached for 60s and falls back to "enabled" on error, so this adds no
  // query to a normal cycle and never skips one by accident.
  const flags = await loadAlertFlags(config);
  if (!flags.alertingEnabled) return;

  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch (err: any) {
    emitLog(config, 'warn', 'alert_ticker_lease_unavailable', { error: err?.message || 'unknown' });
    return; // fail-closed: skip this cycle rather than risk double-evaluating across replicas
  }
  if (!leased) return; // another replica already owns this cycle

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
  } finally {
    await releaseTickerLease(config, LEASE_NAME);
  }
}

export function __stopAlertingTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}