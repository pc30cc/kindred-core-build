// ============================================================
// PAID-BUT-UNAPPLIED RECOVERY.
//
// A settlement and its effects can straddle a crash: the money commits, the
// grant does not. The settlement therefore writes a durable `pending` work
// item in the same transaction, and this loop is what closes it — so the
// worst case is a delay, never a customer who paid and got nothing.
//
// Runs in the project's own Express backend. Safe to run on several
// instances: every step is an idempotent RPC guarded by the unique
// application row.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';

export interface RecoveryResult {
  applied: number;
  failed: number;
}

export async function recoverUnappliedInvoices(
  config: ServerConfig,
  limit = 25,
): Promise<RecoveryResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_recover_unapplied_invoices', { p_limit: limit });
  if (error) throw new Error(String(error.message || 'billing_recovery_failed'));
  return (data as RecoveryResult) ?? { applied: 0, failed: 0 };
}

/** Releases collection reservations left behind by abandoned checkouts. */
export async function expireStaleCollections(config: ServerConfig): Promise<number> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_expire_stale_collections', { p_invoice_id: null });
  if (error) throw new Error(String(error.message || 'billing_collection_expiry_failed'));
  return Number(data ?? 0);
}
