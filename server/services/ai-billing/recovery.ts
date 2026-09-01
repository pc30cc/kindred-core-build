/**
 * AI billing recovery & reconciliation worker.
 *
 * Bounded, idempotent, single-flight-friendly:
 *  - expires stale reservations (releasing the lots they held);
 *  - closes orphaned RUNNING runs that can never settle;
 *  - settles runs left in USAGE_RECORDED / SETTLEMENT_PENDING;
 *  - expires balance lots (never the part still reserved);
 *  - deterministic reconciliation: an ESTIMATED/UNRESOLVED run is promoted to
 *    RECONCILED only when authoritative provider usage is actually available.
 *    Estimated data is NEVER relabelled ACTUAL.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import * as ledger from './ledger.js';
import * as D from './decimal.js';
import { billingCycleId } from './runContext.js';

const BATCH = 50;
const STALE_RUN_MINUTES = 30;

export interface RecoveryReport {
  releasedReservations: number;
  closedRuns: number;
  settledRuns: number;
  expiredLots: number;
  reconciled: number;
}

/**
 * Cluster-wide recovery lease.
 *
 * Process-local single-flight only protects ONE node. With several replicas
 * every instance runs the same timer, so the lease in the database elects a
 * single executor per pass. It carries a TTL, so a crashed owner never blocks
 * recovery forever. The underlying operations stay idempotent regardless —
 * the lease is an efficiency and noise guard, not the correctness mechanism.
 */
const LEASE_TTL_SECONDS = 240;

export const RECOVERY_INSTANCE_ID = `${process.env.HOSTNAME || 'node'}:${process.pid}:${Math.random()
  .toString(36)
  .slice(2, 8)}`;

export async function acquireRecoveryLease(
  config: ServerConfig,
  owner: string = RECOVERY_INSTANCE_ID,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('ai_billing_try_acquire_recovery_lease', {
    _owner: owner,
    _ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) throw new Error(`recovery_lease_unavailable: ${error.message}`);
  return data === true;
}

export async function releaseRecoveryLease(
  config: ServerConfig,
  owner: string = RECOVERY_INSTANCE_ID,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb.rpc('ai_billing_release_recovery_lease', { _owner: owner });
  } catch {
    // TTL expiry releases it anyway; never fail a completed pass on this.
  }
}

/**
 * Runs one recovery pass ONLY if this instance wins the cluster-wide lease.
 * Returns null when another instance already owns the current pass.
 */
export async function runAiBillingRecoveryLeased(
  config: ServerConfig,
  owner: string = RECOVERY_INSTANCE_ID,
): Promise<RecoveryReport | null> {
  if (!(await acquireRecoveryLease(config, owner))) return null;
  try {
    return await runAiBillingRecovery(config);
  } finally {
    await releaseRecoveryLease(config, owner);
  }
}

export async function runAiBillingRecovery(config: ServerConfig): Promise<RecoveryReport> {
  const sb = getServiceClient(config);
  const report: RecoveryReport = {
    releasedReservations: 0,
    closedRuns: 0,
    settledRuns: 0,
    expiredLots: 0,
    reconciled: 0,
  };

  // 1. Stale reservations
  const { data: stale } = await sb
    .from('workspace_ai_reservations')
    .select('id')
    .eq('state', 'ACTIVE')
    .lt('expires_at', new Date().toISOString())
    .limit(BATCH);
  for (const r of stale || []) {
    await ledger.releaseReservation(config, (r as any).id).catch(() => undefined);
    await sb.from('workspace_ai_reservations').update({ state: 'EXPIRED' }).eq('id', (r as any).id);
    report.releasedReservations += 1;
  }

  // 2. Settle runs that recorded usage but never settled
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  const { data: pending } = await sb
    .from('ai_runs')
    .select('id, workspace_id, sell_multiplier, billing_fx_rate')
    .in('status', ['USAGE_RECORDED', 'SETTLEMENT_PENDING'])
    .lt('updated_at', cutoff)
    .limit(BATCH);

  for (const run of pending || []) {
    const { data: events } = await sb
      .from('ai_usage_events')
      .select('provider_cost_usd, internal_cost_irr')
      .eq('run_id', (run as any).id);
    let usd = 0n;
    let irr = 0n;
    for (const e of events || []) {
      usd = D.add(usd, D.fromString(String((e as any).provider_cost_usd)));
      irr = D.add(irr, D.fromString(String((e as any).internal_cost_irr)));
    }
    const charge = D.mul(irr, D.fromString(String((run as any).sell_multiplier ?? '1')));
    await ledger
      .settleRun(config, {
        runId: (run as any).id,
        commandKey: `settle:${(run as any).id}`,
        providerCostUsd: D.toString(usd),
        internalCostIrr: D.toStoredIrr(irr),
        customerChargeIrr: D.toStoredIrr(charge),
        billingCycleId: billingCycleId(),
      })
      .catch(() => undefined);
    report.settledRuns += 1;
  }

  // 3. Orphaned RUNNING runs with no usage at all
  const { data: orphans } = await sb
    .from('ai_runs')
    .select('id, reservation_id')
    .eq('status', 'RUNNING')
    .lt('started_at', cutoff)
    .limit(BATCH);
  for (const run of orphans || []) {
    if ((run as any).reservation_id) {
      await ledger.releaseReservation(config, (run as any).reservation_id).catch(() => undefined);
    }
    await sb
      .from('ai_runs')
      .update({ status: 'CANCELLED', unresolved_reason: 'orphaned_run', finished_at: new Date().toISOString() })
      .eq('id', (run as any).id);
    report.closedRuns += 1;
  }

  // 4. Lot expiration (reserved part is never expired away)
  report.expiredLots = Number((await ledger.expireLots(config).catch(() => 0)) ?? 0);

  // 5. Deterministic reconciliation
  const { data: unresolved } = await sb
    .from('ai_runs')
    .select('id, billing_quality')
    .in('billing_quality', ['ESTIMATED', 'UNRESOLVED'])
    .eq('status', 'SETTLED')
    .limit(BATCH);
  for (const run of unresolved || []) {
    const { data: authoritative } = await sb
      .from('ai_usage_events')
      .select('id, raw_usage_json, provider_cost_usd')
      .eq('run_id', (run as any).id)
      .not('raw_usage_json', 'is', null)
      .limit(1);
    const { count: conflicts } = await sb
      .from('ai_usage_event_conflicts')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', (run as any).id)
      .eq('resolved', false);
    // No authoritative usage, or an open ingestion conflict → stays UNRESOLVED.
    if (!authoritative?.length || (conflicts ?? 0) > 0) continue;
    await sb.from('ai_runs').update({ billing_quality: 'RECONCILED' }).eq('id', (run as any).id);
    report.reconciled += 1;
  }

  return report;
}
