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

  // Snapshot the stale callback rows first. After the invoice recovery RPC
  // runs, only these intents are eligible for lifecycle cleanup below.
  const { data: pendingIntents, error: pendingIntentError } = await sb
    .from('billing_payment_intents')
    .select('id, invoice_id')
    .eq('status', 'processing')
    .not('invoice_id', 'is', null)
    .limit(limit);
  if (pendingIntentError) throw new Error(String(pendingIntentError.message || 'billing_recovery_intent_read_failed'));

  const { data, error } = await sb.rpc('billing_recover_unapplied_invoices', { p_limit: limit });
  if (error) throw new Error(String(error.message || 'billing_recovery_failed'));

  // Applying the paid invoice is the authoritative financial operation, but a
  // callback can crash before it flips its payment intent from `processing` to
  // `succeeded`. Close that second recovery gap here so the customer result
  // screen and future retries converge without needing another bank callback.
  const candidateInvoiceIds = (pendingIntents || [])
    .map((row) => row.invoice_id as string | null)
    .filter((invoiceId): invoiceId is string => Boolean(invoiceId));
  let invoiceIds: string[] = [];

  if (candidateInvoiceIds.length > 0) {
    const { data: applications, error: applicationsError } = await sb
      .from('billing_invoice_applications')
      .select('invoice_id')
      .in('invoice_id', candidateInvoiceIds)
      .eq('application_status', 'applied');
    if (applicationsError) throw new Error(String(applicationsError.message || 'billing_recovery_read_failed'));
    invoiceIds = (applications || [])
      .map((row) => row.invoice_id as string | null)
      .filter((invoiceId): invoiceId is string => Boolean(invoiceId));
  }

  if (invoiceIds.length > 0) {
    const now = new Date().toISOString();
    const intentIds = (pendingIntents || [])
      .filter((row) => typeof row.invoice_id === 'string' && invoiceIds.includes(row.invoice_id))
      .map((row) => row.id as string);

    const { error: intentError } = await sb
      .from('billing_payment_intents')
      .update({ status: 'succeeded', succeeded_at: now, updated_at: now, failure_reason: null })
      .in('invoice_id', invoiceIds)
      .eq('status', 'processing');
    if (intentError) throw new Error(String(intentError.message || 'billing_intent_recovery_failed'));

    // A recovered checkout must not leave the invoice reserved. Releasing is
    // idempotent and scoped only to the intents whose effects are now applied.
    if (intentIds.length > 0) {
      const { error: collectionError } = await sb
        .from('billing_invoice_collections')
        .update({ status: 'released', released_at: now, release_reason: 'payment_recovered' })
        .in('payment_intent_id', intentIds)
        .eq('status', 'active');
      // Older schemas may not expose payment_intent_id here. The collection
      // TTL remains the safe fallback; never fail successful financial
      // recovery for cleanup-only metadata.
      if (collectionError && (collectionError as { code?: string }).code !== '42703') {
        throw new Error(String(collectionError.message || 'billing_collection_recovery_failed'));
      }
    }
  }

  return (data as RecoveryResult) ?? { applied: 0, failed: 0 };
}

/** Releases collection reservations left behind by abandoned checkouts. */
export async function expireStaleCollections(config: ServerConfig): Promise<number> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_expire_stale_collections', { p_invoice_id: null });
  if (error) throw new Error(String(error.message || 'billing_collection_expiry_failed'));
  return Number(data ?? 0);
}
