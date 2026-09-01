/**
 * AI billing — automatic recovery scheduler.
 *
 * Uses the project's existing in-process ticker pattern (see
 * observability/rollupTicker.ts). No new scheduler framework, no pg_cron, no
 * edge function.
 *
 * Every tick runs the SAME bounded, idempotent recovery pass the Super Admin
 * endpoint runs manually:
 *   - stale reservation release/expiration (a crashed run can never hold a
 *     workspace balance hostage);
 *   - orphaned RUNNING run recovery;
 *   - SETTLEMENT_PENDING / USAGE_RECORDED settlement recovery;
 *   - lot expiration;
 *   - deterministic reconciliation of recoverable ESTIMATED/UNRESOLVED runs.
 *
 * Single-flight has TWO layers:
 *   - process-local: an overlapping tick in this process is skipped;
 *   - cluster-wide: a DB-backed lease (with TTL) elects exactly ONE replica
 *     per pass, so a multi-instance deployment does not run N recovery cycles.
 * Every underlying operation stays command-idempotent in SQL regardless.
 */
import type { ServerConfig } from '../../config.js';
import { runAiBillingRecoveryLeased, type RecoveryReport } from './recovery.js';

const TICK_MS = 5 * 60 * 1000; // every 5 minutes
const FIRST_RUN_DELAY_MS = 60_000; // after boot settles

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastReport: (RecoveryReport & { at: string }) | null = null;
let lastError: { at: string; message: string } | null = null;

export function startAiBillingRecovery(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => void tick(config), FIRST_RUN_DELAY_MS);
  timer = setInterval(() => void tick(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

export function stopAiBillingRecovery(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

export function getAiBillingRecoveryStatus(): {
  scheduled: boolean;
  running: boolean;
  lastReport: (RecoveryReport & { at: string }) | null;
  lastError: { at: string; message: string } | null;
} {
  return { scheduled: !!timer, running, lastReport, lastError };
}

export async function tick(config: ServerConfig): Promise<RecoveryReport | null> {
  if (running) return null; // single-flight
  running = true;
  try {
    const report = await runAiBillingRecoveryLeased(config);
    if (!report) return null; // another replica owns this pass
    lastReport = { ...report, at: new Date().toISOString() };
    lastError = null;
    return report;
  } catch (err: any) {
    lastError = { at: new Date().toISOString(), message: String(err?.message || err) };
    console.warn('[ai-billing] recovery tick failed:', lastError.message);
    return null;
  } finally {
    running = false;
  }
}
