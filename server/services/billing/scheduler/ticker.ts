/**
 * Billing Engine V2 — Phase C/E tick.
 *
 * The ticker is ONLY a trigger. It holds no queue and no state: every unit of
 * work is a `billing_v2_jobs` / `billing_notification_jobs` row with a lease,
 * so losing this process loses nothing and a second replica picks the work up
 * on its own next tick (SKIP LOCKED claiming makes concurrent runs safe by
 * construction).
 *
 * Order matters within a tick:
 *   issue → collect → activate → dunning → grace → notify
 *
 * An invoice paid by the wallet can start its period in the same pass when it
 * is already due; dunning runs before grace so a deadline the wallet just
 * cleared can never trigger a fallback in the same tick; and notifications go
 * last so every message reflects the state the tick finished in.
 */
import type { ServerConfig } from '../../../config.js';
import { runRenewalInvoiceScheduler, runWalletAutoPay, runPeriodActivation } from './index.js';
import { runDunning, runGraceExpiry } from '../dunning/index.js';
import { dispatchBillingNotifications } from '../notifications/dispatcher.js';
import { expireStaleCollections, recoverUnappliedInvoices } from '../worker/recovery.js';
import { getServiceClient } from '../../../supabase.js';

/**
 * Trial lifecycle: expire trials whose end date has passed (the subscription
 * trigger turns that into a "trial ended" message) and enqueue the
 * "trial ends soon" warning for the last three days. Both calls are idempotent.
 */
async function runTrialLifecycle(config: ServerConfig): Promise<unknown> {
  const supabase = getServiceClient(config);
  const expired = await supabase.rpc('expire_stale_trials' as any);
  const ending = await supabase.rpc('billing_notify_trial_ending' as any);
  return {
    expired: expired.error ? `error: ${expired.error.message}` : expired.data,
    endingSoon: ending.error ? `error: ${ending.error.message}` : ending.data,
  };
}

const TICK_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastRun: {
  at: string;
  recovery: unknown;
  expiredCollections: unknown;
  renewal: unknown;
  wallet: unknown;
  activation: unknown;
  dunning: unknown;
  grace: unknown;
  trials?: unknown;
  notifications: unknown;
} | null = null;
let lastError: { at: string; message: string } | null = null;

export function startBillingV2Schedulers(config: ServerConfig): void {
  if (timer) return;
  setTimeout(() => void tick(config), FIRST_RUN_DELAY_MS);
  timer = setInterval(() => void tick(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

export function stopBillingV2Schedulers(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

export function getBillingV2SchedulerStatus() {
  return { scheduled: !!timer, running, lastRun, lastError };
}

export async function tick(config: ServerConfig): Promise<void> {
  if (running) return; // process-local single flight; the DB lease is the real one
  running = true;
  try {
    // Recover verified money before ordinary scheduled work. This is the path
    // that completes a checkout after a process crash or a transient failure
    // while granting the purchased plan/credit.
    const recovery = await recoverUnappliedInvoices(config);
    const expiredCollections = await expireStaleCollections(config);
    const renewal = await runRenewalInvoiceScheduler(config);
    const wallet = await runWalletAutoPay(config);
    const activation = await runPeriodActivation(config);
    const dunning = await runDunning(config);
    const grace = await runGraceExpiry(config);
    const trials = await runTrialLifecycle(config).catch((err: any) => ({
      error: String(err?.message || err),
    }));
    // Delivery last, and isolated: a dead SMS provider must not make the tick
    // look like the financial workers failed.
    let notifications: unknown;
    try {
      notifications = await dispatchBillingNotifications(config);
    } catch (err: any) {
      notifications = { error: String(err?.message || err) };
      console.warn('[billing] notification dispatch failed:', String(err?.message || err));
    }
    lastRun = {
      at: new Date().toISOString(),
      recovery,
      expiredCollections,
      renewal,
      wallet,
      activation,
      dunning,
      grace,
      trials,
      notifications,
    };
    lastError = null;
  } catch (err: any) {
    lastError = { at: new Date().toISOString(), message: String(err?.message || err) };
    console.warn('[billing] scheduler tick failed:', lastError.message);
  } finally {
    running = false;
  }
}
