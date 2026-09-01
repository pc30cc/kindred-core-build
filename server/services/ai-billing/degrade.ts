/**
 * AI billing — degradation telemetry.
 *
 * The financial domain is deliberately NOT on the critical path in
 * METER_ONLY: if the billing database (or one of its RPCs) is unavailable, the
 * AI product must keep answering. That is only acceptable when the loss is
 * VISIBLE, so every swallowed billing failure is:
 *
 *   1. counted in-process and exposed on /api/ai-billing/admin/health, and
 *   2. best-effort persisted to ai_billing_audit_log with enough identity
 *      (workspace, entry point, operation key) to reconcile later.
 *
 * In ENFORCED the same failures are never swallowed — the caller fails closed
 * before any billable provider call.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface BillingDegradationEntry {
  at: string;
  stage: 'begin_run' | 'record_usage' | 'settle_run' | 'recovery';
  workspaceId: string | null;
  entryPoint: string | null;
  operationKey: string | null;
  message: string;
}

const MAX_RECENT = 50;
let total = 0;
const byStage: Record<string, number> = {};
const recent: BillingDegradationEntry[] = [];

export function getBillingDegradation(): {
  total: number;
  byStage: Record<string, number>;
  recent: BillingDegradationEntry[];
} {
  return { total, byStage: { ...byStage }, recent: [...recent] };
}

export function resetBillingDegradation(): void {
  total = 0;
  recent.length = 0;
  for (const k of Object.keys(byStage)) delete byStage[k];
}

/**
 * Records a billing-persistence failure that did NOT stop the AI operation.
 * Never throws: telemetry must not become the next outage.
 */
export async function recordBillingFailure(
  config: ServerConfig,
  entry: Omit<BillingDegradationEntry, 'at'>,
): Promise<void> {
  const full: BillingDegradationEntry = { ...entry, at: new Date().toISOString() };
  total += 1;
  byStage[entry.stage] = (byStage[entry.stage] ?? 0) + 1;
  recent.unshift(full);
  if (recent.length > MAX_RECENT) recent.pop();
  console.warn(
    `[ai-billing] degraded (${entry.stage}) ws=${entry.workspaceId ?? '-'} op=${entry.operationKey ?? '-'}: ${entry.message}`,
  );
  try {
    const sb = getServiceClient(config);
    await sb.from('ai_billing_audit_log').insert({
      action: 'billing_unavailable',
      workspace_id: entry.workspaceId,
      details: {
        stage: entry.stage,
        entry_point: entry.entryPoint,
        operation_key: entry.operationKey,
        message: entry.message,
      },
    });
  } catch {
    // The billing DB is exactly what is failing here — in-process counters and
    // the log line remain the signal.
  }
}
