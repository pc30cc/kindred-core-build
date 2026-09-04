// ============================================================
// BILLING ENGINE V2 — PHASE E DUNNING (thin server surface).
//
// Like Phase C, the actual lifecycle lives in SQL (migration 122) because the
// locks, the leases and the money are there. This module only triggers the
// workers and reports what they did.
//
// Two workers, in this order and never the reverse:
//   1. dunning     — reminders, due-day wallet retry, past due + grace start
//   2. graceExpiry — free fallback once the grace deadline passes unpaid
//
// Running grace before dunning would let a workspace fall back on a deadline
// that the same tick was about to clear with a wallet payment.
//
// Runs in the project's own Express backend. No edge function, no pg_cron.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { bumpMetric } from '../rollout.js';

export interface DunningBatchResult {
  past_due?: number;
  paid?: number;
  fallbacks?: number;
  skipped: number;
  failed: number;
}

export interface DunningMetrics {
  open_invoices: number;
  past_due_invoices: number;
  past_due_amount_irr: number;
  grace_subscriptions: number;
  fallbacks_total: number;
  autopay_success: number;
  autopay_insufficient: number;
  notification_backlog: number;
  notification_failures: number;
  retention_signals_pending: number;
  checked_at: string;
}

async function callWorker(
  config: ServerConfig,
  fn: 'billing_v2_run_dunning' | 'billing_v2_run_grace_expiry',
  limit: number,
): Promise<DunningBatchResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc(fn, { p_limit: limit });
  if (error) throw new Error(String(error.message || `${fn}_failed`));
  return (data as DunningBatchResult) ?? { skipped: 0, failed: 0 };
}

/** Worker D — reminders, due-day collection retry, past due + grace start. */
export async function runDunning(config: ServerConfig, limit = 50): Promise<DunningBatchResult> {
  const result = await callWorker(config, 'billing_v2_run_dunning', limit);
  if (result.failed > 0) bumpMetric('billing_v2_dunning_failures', result.failed);
  if (result.past_due) bumpMetric('billing_v2_invoices_past_due', result.past_due);
  return result;
}

/** Worker E — free fallback after an expired grace period. Degrades service only. */
export async function runGraceExpiry(config: ServerConfig, limit = 50): Promise<DunningBatchResult> {
  const result = await callWorker(config, 'billing_v2_run_grace_expiry', limit);
  if (result.failed > 0) bumpMetric('billing_v2_grace_expiry_failures', result.failed);
  if (result.fallbacks) bumpMetric('billing_v2_free_fallbacks', result.fallbacks);
  return result;
}

/** Read-only: this never moves money and never advances a lifecycle. */
export async function readDunningMetrics(config: ServerConfig): Promise<DunningMetrics> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_dunning_metrics');
  if (error) throw new Error(String(error.message || 'billing_v2_dunning_metrics_failed'));
  return data as DunningMetrics;
}

export interface DunningPolicy {
  reminder_days_before_due: number[];
  grace_period_days: number;
  fallback_plan_id: string | null;
  send_invoice_issued_email: boolean;
  send_invoice_issued_sms: boolean;
  notify_on_due: boolean;
  notify_on_past_due: boolean;
  notify_on_fallback: boolean;
  notification_max_attempts: number;
  notification_retry_seconds: number;
  notification_max_per_hour: number;
}

const POLICY_COLUMNS =
  'reminder_days_before_due, grace_period_days, fallback_plan_id, send_invoice_issued_email, ' +
  'send_invoice_issued_sms, notify_on_due, notify_on_past_due, notify_on_fallback, ' +
  'notification_max_attempts, notification_retry_seconds, notification_max_per_hour';

export async function readDunningPolicy(config: ServerConfig): Promise<DunningPolicy> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('billing_v2_policy')
    .select(POLICY_COLUMNS)
    .eq('id', true)
    .maybeSingle();
  if (error) throw new Error(String(error.message || 'billing_v2_policy_read_failed'));
  return data as unknown as DunningPolicy;
}

/**
 * Platform-only policy write. Grace length and the fallback plan are
 * deliberately NOT workspace-overridable, so they only ever change here.
 */
export async function updateDunningPolicy(
  config: ServerConfig,
  patch: Partial<DunningPolicy>,
  actorId: string,
): Promise<DunningPolicy> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('billing_v2_policy')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true)
    .select(POLICY_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(String(error.message || 'billing_v2_policy_update_failed'));

  await sb.from('billing_v2_audit').insert({
    workspace_id: null,
    event: 'dunning_policy_updated',
    actor_id: actorId,
    reason: 'platform_admin',
    details: patch as Record<string, unknown>,
  });

  return data as unknown as DunningPolicy;
}
