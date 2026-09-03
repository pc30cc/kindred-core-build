// ============================================================
// BILLING ENGINE V2 — PHASE C SCHEDULERS (thin server surface).
//
// The three workers live in SQL (migration 118) because that is where the
// locks, the leases and the money are. This module is only the trigger and the
// observability wrapper: every unit of work is a durable row in
// `billing_v2_jobs`, so a crashed or restarted process resumes exactly where
// it stopped and a second instance cannot run the same item twice.
//
// Runs in the project's own Express backend. No edge function, no pg_cron.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { bumpMetric } from '../rollout.js';

export interface SchedulerBatchResult {
  issued?: number;
  paid?: number;
  activated?: number;
  skipped: number;
  failed: number;
}

async function callWorker(
  config: ServerConfig,
  fn: 'billing_v2_run_invoice_scheduler' | 'billing_v2_run_wallet_autopay' | 'billing_v2_run_period_activation',
  limit: number,
): Promise<SchedulerBatchResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc(fn, { p_limit: limit });
  if (error) throw new Error(String(error.message || `${fn}_failed`));
  return (data as SchedulerBatchResult) ?? { skipped: 0, failed: 0 };
}

/** Worker A — issues the next renewal invoice at the policy lead time. */
export async function runRenewalInvoiceScheduler(
  config: ServerConfig,
  limit = 50,
): Promise<SchedulerBatchResult> {
  const result = await callWorker(config, 'billing_v2_run_invoice_scheduler', limit);
  if (result.failed > 0) bumpMetric('billing_v2_invoice_scheduler_failures', result.failed);
  return result;
}

/** Worker B — pays a due invoice in full from the wallet, or not at all. */
export async function runWalletAutoPay(
  config: ServerConfig,
  limit = 50,
): Promise<SchedulerBatchResult> {
  const result = await callWorker(config, 'billing_v2_run_wallet_autopay', limit);
  if (result.failed > 0) bumpMetric('billing_v2_wallet_autopay_failures', result.failed);
  return result;
}

/** Worker C — activates a paid, scheduled period at its start, exactly once. */
export async function runPeriodActivation(
  config: ServerConfig,
  limit = 50,
): Promise<SchedulerBatchResult> {
  const result = await callWorker(config, 'billing_v2_run_period_activation', limit);
  if (result.failed > 0) bumpMetric('billing_v2_period_activation_failures', result.failed);
  return result;
}

export interface SchedulerHealth {
  workers: Array<Record<string, unknown>>;
  due_invoices: number;
  scheduled_periods_pending: number;
  unapplied_active_periods: number;
  failed_jobs: number;
  checked_at: string;
}

/** Read-only: this endpoint may never move money. */
export async function readSchedulerHealth(config: ServerConfig): Promise<SchedulerHealth> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_scheduler_health');
  if (error) throw new Error(String(error.message || 'billing_v2_scheduler_health_failed'));
  return data as SchedulerHealth;
}
