// ============================================================
// BILLING V2 — Phase E dunning surface (thin server wrapper).
//
// The lifecycle itself is SQL (migration 121), because that is where the row
// locks, the leases and the money are. This module only triggers the bounded
// workers and reports what they did, so restarting the process cannot lose or
// duplicate a step.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { bumpMetric } from '../rollout.js';

export interface DunningBatchResult {
  paid?: number;
  past_due?: number;
  skipped: number;
  failed: number;
}

export interface GraceBatchResult {
  fallback?: number;
  restored?: number;
  skipped: number;
  failed: number;
}

/** Due-day pass: lock → recheck → wallet auto-pay → past_due. */
export async function runDunning(config: ServerConfig, limit = 50): Promise<DunningBatchResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_run_dunning', { p_limit: limit });
  if (error) throw new Error(String(error.message || 'billing_v2_run_dunning_failed'));
  const result = (data as DunningBatchResult) ?? { skipped: 0, failed: 0 };
  if (result.failed > 0) bumpMetric('billing_v2_dunning_failures', result.failed);
  if (result.past_due) bumpMetric('billing_v2_invoices_past_due', result.past_due);
  return result;
}

/** Grace pass: only the database clock decides that grace is over. */
export async function runGraceExpiry(config: ServerConfig, limit = 25): Promise<GraceBatchResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_run_grace_expiry', { p_limit: limit });
  if (error) throw new Error(String(error.message || 'billing_v2_run_grace_expiry_failed'));
  const result = (data as GraceBatchResult) ?? { skipped: 0, failed: 0 };
  if (result.failed > 0) bumpMetric('billing_v2_grace_expiry_failures', result.failed);
  if (result.fallback) bumpMetric('billing_v2_free_fallbacks', result.fallback);
  return result;
}

/** Read-only operational counters for the Super Admin dashboard. */
export async function readDunningMetrics(config: ServerConfig): Promise<Record<string, unknown>> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_v2_dunning_metrics');
  if (error) throw new Error(String(error.message || 'billing_v2_dunning_metrics_failed'));
  return (data as Record<string, unknown>) ?? {};
}

export { runNotificationWorker } from './notifications.js';
