// ============================================
// PAYMENT INTENTS — server-authoritative checkout amount/purpose, with a real
// state machine.
//
//   pending ──claim──▶ processing ──side effect ok──▶ succeeded
//      │                    │
//      │                    └── side effect failed ──▶ stays processing
//      │                        (recoverable: retry re-runs the SAME
//      │                         idempotent side effect and then succeeds)
//      ├── gateway said "not verified" ──▶ failed
//      ├── TTL passed ──▶ expired
//      └── user abandoned / canceled ──▶ canceled
//
// Why `processing` exists: the previous flow marked the intent `succeeded`
// immediately after the gateway verify and applied the subscription period /
// AI credit afterwards. A crash in between left the customer charged with
// nothing granted, and every retry looked like a replay. Now `succeeded` is
// written ONLY after the money has actually turned into something.
//
// Checkout amount and purpose must NEVER be trusted from the client. The row
// is created here BEFORE the provider redirect from server-known prices and
// verify-callback re-reads the SAME row.
// ============================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { PurchaseActionType } from './periods.js';
import {
  extractProviderRefCandidates,
  getProviderReferenceContract,
  requiresReferenceBinding,
} from './providerBinding.js';
import { insertWithDocumentNumber } from './invoiceNumber.js';

export type PurchaseType = 'subscription' | 'ai_credit_topup';
export type IntentStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'canceled';

export interface PaymentIntentRow {
  id: string;
  workspace_id: string;
  purchase_type: PurchaseType;
  action_type: PurchaseActionType | null;
  plan_id: string | null;
  billing_interval: 'monthly' | 'yearly' | null;
  provider_name: string;
  amount_irr: number;
  status: IntentStatus;
  provider_ref: string | null;
  invoice_number: string | null;
  plan_name_snapshot: string | null;
  workspace_name_snapshot: string | null;
  discount_irr: number | null;
  final_amount_irr: number | null;
  period_start: string | null;
  period_end: string | null;
  metadata: Record<string, unknown>;
  expires_at: string;
  processing_at: string | null;
  succeeded_at: string | null;
  attempt_count: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

const INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * A `processing` intent older than this is considered a crashed finalization
 * and may be re-claimed by a retry. The side effects behind it are idempotent
 * (AI credit uses `commandKey`, payments use a unique index on the intent id),
 * so re-running them cannot double-charge anything.
 */
const PROCESSING_RECLAIM_MS = 60 * 1000;

/** Iranian one-time gateways: their checkout amount is fully server-derived. */
export const IRAN_PROVIDERS = new Set([
  'zarinpal', 'zarinpal_test', 'idpay', 'idpay_test', 'iranpardakht_sandbox',
  'nextpay', 'payping', 'zibal', 'sep_shaparak',
]);

export async function createSubscriptionIntent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    planId: string;
    interval: 'monthly' | 'yearly';
    providerName: string;
    amountIrr: number;
    actionType?: PurchaseActionType;
    /** Immutable proforma snapshot — the invoice must never change later. */
    planNameSnapshot?: string | null;
    workspaceNameSnapshot?: string | null;
    discountIrr?: number;
    periodStart?: string | null;
    periodEnd?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRow> {
  const supabase = getServiceClient(config);
  const discount = Math.max(0, Math.round(input.discountIrr || 0));
  return insertWithDocumentNumber<PaymentIntentRow>(async (documentNumber) => {
    const { data, error } = await supabase
      .from('billing_payment_intents')
      .insert({
        workspace_id: input.workspaceId,
        purchase_type: 'subscription',
        action_type: input.actionType ?? null,
        plan_id: input.planId,
        billing_interval: input.interval,
        provider_name: input.providerName,
        amount_irr: input.amountIrr,
        invoice_number: documentNumber,
        plan_name_snapshot: input.planNameSnapshot ?? null,
        workspace_name_snapshot: input.workspaceNameSnapshot ?? null,
        discount_irr: discount,
        final_amount_irr: Math.max(0, input.amountIrr - discount),
        period_start: input.periodStart ?? null,
        period_end: input.periodEnd ?? null,
        metadata: input.metadata || {},
        expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
      })
      .select('*')
      .single();
    return { data: data as PaymentIntentRow | null, error };
  });
}

export async function createAiCreditTopupIntent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    providerName: string;
    amountIrr: number;
    workspaceNameSnapshot?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRow> {
  const supabase = getServiceClient(config);
  return insertWithDocumentNumber<PaymentIntentRow>(async (documentNumber) => {
    const { data, error } = await supabase
      .from('billing_payment_intents')
      .insert({
        workspace_id: input.workspaceId,
        purchase_type: 'ai_credit_topup',
        action_type: 'ai_credit_topup',
        provider_name: input.providerName,
        amount_irr: input.amountIrr,
        invoice_number: documentNumber,
        workspace_name_snapshot: input.workspaceNameSnapshot ?? null,
        discount_irr: 0,
        final_amount_irr: input.amountIrr,
        metadata: input.metadata || {},
        expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
      })
      .select('*')
      .single();
    return { data: data as PaymentIntentRow | null, error };
  });
}

/**
 * Customer-initiated abandonment, recorded ONLY when the cancellation is
 * explicit and the customer was never handed to the bank: an intent that
 * already carries a provider reference may be mid-payment at the gateway, so
 * it stays `pending` and expires on its TTL instead of being guessed as
 * canceled. Returns whether the transition actually happened.
 */
export async function markPaymentIntentCanceled(
  config: ServerConfig,
  intentId: string,
  reason = 'customer_canceled',
): Promise<boolean> {
  const supabase = getServiceClient(config);
  const { data, error } = await supabase
    .from('billing_payment_intents')
    .update({ status: 'canceled', failure_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .eq('status', 'pending')
    .is('provider_ref', null)
    .select('id');
  if (error) throw new Error(error.message);
  return (data || []).length > 0;
}


export async function getPaymentIntent(
  config: ServerConfig,
  intentId: string,
): Promise<PaymentIntentRow | null> {
  const supabase = getServiceClient(config);
  const { data } = await supabase
    .from('billing_payment_intents')
    .select('*')
    .eq('id', intentId)
    .maybeSingle();
  return (data as PaymentIntentRow | null) ?? null;
}

/**
 * Persists the gateway's checkout reference on the intent. Throws when the DB
 * write fails or matches no row: an unbound intent can never be finalized for
 * a binding provider, so the caller MUST treat this as a failed checkout
 * instead of redirecting the customer to a bank page they cannot complete.
 */
export async function setPaymentIntentProviderRef(
  config: ServerConfig,
  intentId: string,
  providerRef: string,
): Promise<void> {
  const ref = (providerRef || '').trim();
  if (!ref) throw new Error('provider_reference_missing');
  const supabase = getServiceClient(config);
  const { data, error } = await supabase
    .from('billing_payment_intents')
    .update({ provider_ref: ref, updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`provider_reference_persist_failed:${error.message}`);
  if (!data) throw new Error('provider_reference_persist_failed:no_row');
}

export type ClaimOutcome =
  | { claimed: true; resumed: boolean }
  | { claimed: false; reason: 'already_finalized' | 'in_flight' };

/**
 * Atomically moves an intent from `pending` to `processing`. Resolves
 * `claimed: true` for exactly one concurrent caller.
 *
 * A `processing` row whose finalization crashed (older than
 * PROCESSING_RECLAIM_MS) can be re-claimed — that is the recovery path, and it
 * is safe because every side effect behind it is idempotent.
 */
export async function claimIntentForProcessing(
  config: ServerConfig,
  intentId: string,
  opts: { now?: Date } = {},
): Promise<ClaimOutcome> {
  const supabase = getServiceClient(config);
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const { data, error } = await supabase
    .from('billing_payment_intents')
    .update({ status: 'processing', processing_at: nowIso, updated_at: nowIso })
    .eq('id', intentId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return { claimed: true, resumed: false };

  // Lost the pending race, or a previous attempt crashed mid-finalization.
  const current = await getPaymentIntent(config, intentId);
  if (!current) return { claimed: false, reason: 'already_finalized' };
  if (current.status !== 'processing') return { claimed: false, reason: 'already_finalized' };

  const startedAt = current.processing_at ? new Date(current.processing_at).getTime() : 0;
  if (now.getTime() - startedAt < PROCESSING_RECLAIM_MS) {
    return { claimed: false, reason: 'in_flight' };
  }

  const { data: retaken, error: retakeError } = await supabase
    .from('billing_payment_intents')
    .update({ processing_at: nowIso, updated_at: nowIso })
    .eq('id', intentId)
    .eq('status', 'processing')
    .eq('processing_at', current.processing_at)
    .select('id')
    .maybeSingle();
  if (retakeError) throw new Error(retakeError.message);
  return retaken ? { claimed: true, resumed: true } : { claimed: false, reason: 'in_flight' };
}

/** Final success — written ONLY after the financial side effect landed. */
export async function markIntentSucceeded(
  config: ServerConfig,
  intentId: string,
): Promise<void> {
  const supabase = getServiceClient(config);
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('billing_payment_intents')
    .update({ status: 'succeeded', succeeded_at: nowIso, updated_at: nowIso })
    .eq('id', intentId)
    .in('status', ['pending', 'processing']);
  if (error) throw new Error(error.message);
}

export async function markPaymentIntentFailed(
  config: ServerConfig,
  intentId: string,
  reason?: string,
): Promise<void> {
  const supabase = getServiceClient(config);
  await supabase
    .from('billing_payment_intents')
    .update({
      status: 'failed',
      failure_reason: reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', intentId)
    .in('status', ['pending', 'processing']);
}

export async function markPaymentIntentExpired(
  config: ServerConfig,
  intentId: string,
): Promise<void> {
  const supabase = getServiceClient(config);
  await supabase
    .from('billing_payment_intents')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .eq('status', 'pending');
}

/** Records that the finalization attempt failed but the intent stays recoverable. */
export async function noteIntentFailureAttempt(
  config: ServerConfig,
  intent: PaymentIntentRow,
  reason: string,
): Promise<void> {
  const supabase = getServiceClient(config);
  await supabase
    .from('billing_payment_intents')
    .update({
      attempt_count: (intent.attempt_count || 0) + 1,
      failure_reason: reason.slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    .eq('id', intent.id);
}

export function isIntentUsable(intent: PaymentIntentRow): boolean {
  return intent.status === 'pending' && new Date(intent.expires_at).getTime() > Date.now();
}

/**
 * Provider identity binding. An intent may only be finalized with the payment
 * reference (ZarinPal `Authority`, IDPay/Zibal `trackId`, ...) that the
 * gateway handed back when THIS intent's checkout session was created.
 * Fails closed whenever a reference is present on both sides and they differ,
 * so intent A can never be finalized with payment B.
 */
export function extractProviderRef(params: unknown, providerName?: string): string | null {
  return extractProviderRefCandidates(providerName || '', params)[0] ?? null;
}

/**
 * Fail-closed binding check.
 *
 *   - binding provider without a stored reference  -> reject (checkout was
 *     never bound; finalizing it would trust the callback blindly);
 *   - callback without any reference               -> reject;
 *   - reference present but different              -> reject;
 *   - exact match                                  -> accept.
 */
export function providerRefMatchesIntent(
  intent: PaymentIntentRow,
  params: unknown,
): { ok: true } | { ok: false; reason: string } {
  const providerName = intent.provider_name;
  const contract = getProviderReferenceContract(providerName);
  const stored = (intent.provider_ref || '').trim();

  if (!stored) {
    if (requiresReferenceBinding(providerName)) {
      return { ok: false, reason: 'missing_stored_provider_reference' };
    }
    // Explicitly declared as having no bindable checkout reference.
    return { ok: true };
  }

  const candidates = extractProviderRefCandidates(providerName, params);
  if (candidates.length === 0) return { ok: false, reason: 'missing_provider_reference' };
  if (!candidates.includes(stored)) return { ok: false, reason: 'provider_reference_mismatch' };
  void contract;
  return { ok: true };
}


/**
 * TTL sweep: a `pending` intent whose deadline passed becomes `expired`.
 *
 * Closing the browser is NOT a cancellation — nothing is guessed here. The
 * intent simply runs out its TTL and is recorded as expired, which is exactly
 * what the customer's history should show for an attempt that never reached a
 * definitive gateway answer.
 */
export async function expireStalePaymentIntents(
  config: ServerConfig,
  workspaceId?: string,
): Promise<number> {
  const supabase = getServiceClient(config);
  let query = supabase
    .from('billing_payment_intents')
    .update({ status: 'expired', failure_reason: 'ttl_expired', updated_at: new Date().toISOString() })
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString());
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, error } = await query.select('id');
  if (error) return 0;
  return (data || []).length;
}
