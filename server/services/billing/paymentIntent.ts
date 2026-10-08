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
import { extractProviderRefCandidates } from './providerBinding.js';
import {
  GATEWAY_VERIFICATION_METADATA_KEY,
  type GatewayVerificationMarker,
} from './gatewayVerification.js';
import { insertWithDocumentNumber } from './invoiceNumber.js';

export type PurchaseType = 'subscription' | 'ai_credit_topup' | 'wallet_deposit';
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
export const PROCESSING_RECLAIM_MS = 60 * 1000;

/**
 * A `processing` intent whose finalization may still be running (claimed less
 * than PROCESSING_RECLAIM_MS ago). An older one is a crashed finalization that
 * claimIntentForProcessing re-claims.
 */
export function isProcessingInFlight(
  intent: Pick<PaymentIntentRow, 'status' | 'processing_at'>,
  now: Date = new Date(),
): boolean {
  if (intent.status !== 'processing') return false;
  const startedAt = intent.processing_at ? new Date(intent.processing_at).getTime() : 0;
  return Number.isFinite(startedAt) && now.getTime() - startedAt < PROCESSING_RECLAIM_MS;
}

/** Iranian one-time gateways: their checkout amount is fully server-derived. */
export const IRAN_PROVIDERS = new Set([
  'zarinpal', 'zarinpal_test', 'idpay', 'idpay_test', 'iranpardakht_sandbox',
  'nextpay', 'payping', 'zibal', 'sep_shaparak',
  // Internal simulated gateway: same redirect + intent contract, no real money.
  'internal_test',
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
 * Checkout intent for an OPEN INVOICE (Billing Engine V2).
 *
 * The invoice is the pricing authority: `expected_amount_irr` is copied from
 * `amount_due_irr` here and is immutable afterwards, so gateway verification
 * can assert gateway_amount = intent.expected = invoice.due. The engine stamp
 * is written at insert time and can never change (migration 117 trigger), so
 * the callback routes on the intent's OWN engine, not on today's rollout state.
 */
export async function createInvoiceIntent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    invoiceId: string;
    amountIrr: number;
    providerName: string;
    planId?: string | null;
    interval?: 'monthly' | 'yearly' | null;
    actionType?: PurchaseActionType | null;
    planNameSnapshot?: string | null;
    workspaceNameSnapshot?: string | null;
    invoiceNumber?: string | null;
    /**
     * The invoice's currency. `amountIrr` / `expected_amount_irr` are minor
     * units of it (whole Rial for IRR); the intent has no currency column, so
     * it is recorded in `metadata.currency` for verification and receipts.
     */
    currency?: string | null;
    /** Lifetime of the attempt; defaults to the bank-redirect TTL. */
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRow> {
  const supabase = getServiceClient(config);
  const currency = (input.currency || 'IRR').trim().toUpperCase();
  const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : INTENT_TTL_MS;
  // The invoice's frozen effect names the business act ('ai_credit_purchase',
  // 'wallet_deposit', 'plan_*'); the attempt stores the canonical purchase
  // vocabulary. Plan-less purchases must never carry a plan or an interval.
  const rawAction = String(input.actionType ?? '');
  const purchaseType =
    rawAction === 'ai_credit_topup' || rawAction === 'ai_credit_purchase'
      ? 'ai_credit_topup'
      : rawAction === 'wallet_deposit'
        ? 'wallet_deposit'
        : 'subscription';
  const actionType =
    purchaseType === 'ai_credit_topup'
      ? 'ai_credit_topup'
      : purchaseType === 'wallet_deposit'
        ? 'wallet_deposit'
        : (input.actionType ?? null);
  const planLess = purchaseType !== 'subscription';
  return insertWithDocumentNumber<PaymentIntentRow>(async (documentNumber) => {
    const { data, error } = await supabase
      .from('billing_payment_intents')
      .insert({
        workspace_id: input.workspaceId,
        purchase_type: purchaseType,
        action_type: actionType,
        plan_id: planLess ? null : (input.planId ?? null),
        billing_interval: planLess ? null : (input.interval ?? null),

        provider_name: input.providerName,
        amount_irr: input.amountIrr,
        // Every checkout attempt needs its own unique document number. Reusing
        // the parent invoice number makes retries collide with the globally
        // unique payment-intent index before any provider is called.
        invoice_number: documentNumber,
        plan_name_snapshot: input.planNameSnapshot ?? null,
        workspace_name_snapshot: input.workspaceNameSnapshot ?? null,
        discount_irr: 0,
        final_amount_irr: input.amountIrr,
        invoice_id: input.invoiceId,
        expected_amount_irr: input.amountIrr,
        billing_engine_version: 'v2',
        metadata: { ...(input.metadata || {}), currency },
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      })
      .select('*')
      .single();
    return { data: data as PaymentIntentRow | null, error };
  });
}

/**
 * Checkout intent for a WALLET DEPOSIT — the one purchase in V2 that is not
 * invoice-driven, because a deposit buys no service: it only converts gateway
 * money into wallet balance. It is bound 1:1 to its deposit document.
 */
export async function createWalletDepositIntent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    depositId: string;
    documentNumber: string;
    amountIrr: number;
    providerName: string;
    workspaceNameSnapshot?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRow> {
  const supabase = getServiceClient(config);
  const { data, error } = await supabase
    .from('billing_payment_intents')
    .insert({
      workspace_id: input.workspaceId,
      purchase_type: 'wallet_deposit',
      action_type: 'wallet_deposit',
      provider_name: input.providerName,
      amount_irr: input.amountIrr,
      invoice_number: input.documentNumber,
      workspace_name_snapshot: input.workspaceNameSnapshot ?? null,
      discount_irr: 0,
      final_amount_irr: input.amountIrr,
      expected_amount_irr: input.amountIrr,
      wallet_deposit_id: input.depositId,
      billing_engine_version: 'v2',
      metadata: input.metadata || {},
      expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as PaymentIntentRow;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The intent could not be read (the database answered with an error). Not "absent". */
export class PaymentIntentReadError extends Error {
  constructor(message: string) {
    super(`payment_intent_read_failed:${message}`);
    this.name = 'PaymentIntentReadError';
  }
}

/**
 * getPaymentIntent for callers that must tell "this database has no such
 * intent" from "the read failed": resolves null only when the intent is
 * definitively absent — an id that is not a UUID (never queried: no intent
 * can have it) or a read that found no row — and throws
 * PaymentIntentReadError when the read itself failed, so a provider webhook
 * is answered 5xx and retried instead of being acknowledged and lost.
 */
export async function readPaymentIntent(
  config: ServerConfig,
  intentId: string,
): Promise<PaymentIntentRow | null> {
  if (typeof intentId !== 'string' || !UUID_RE.test(intentId)) return null;
  const { data, error } = await getServiceClient(config)
    .from('billing_payment_intents')
    .select('*')
    .eq('id', intentId)
    .maybeSingle();
  if (error) throw new PaymentIntentReadError(error.message || 'unknown');
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
  opts: {
    now?: Date;
    /**
     * Gateway verification that justified this claim. Persisted on the
     * `pending → processing` transition (merged into `baseMetadata`), so a
     * later "already verified" gateway answer can be proven to belong to THIS
     * intent.
     */
    verification?: GatewayVerificationMarker;
    baseMetadata?: Record<string, unknown> | null;
  } = {},
): Promise<ClaimOutcome> {
  const supabase = getServiceClient(config);
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const claimPatch: Record<string, unknown> = { status: 'processing', processing_at: nowIso, updated_at: nowIso };
  if (opts.verification) {
    claimPatch.metadata = {
      ...(opts.baseMetadata || {}),
      [GATEWAY_VERIFICATION_METADATA_KEY]: opts.verification,
    };
  }

  const { data, error } = await supabase
    .from('billing_payment_intents')
    .update(claimPatch)
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

/**
 * `failure_reason` of an attempt that billing_begin_collection canceled
 * because the customer opened a newer checkout for the same invoice.
 */
export const SUPERSEDED_BY_NEW_CHECKOUT = 'superseded_by_new_checkout';

/**
 * Takes an attempt that stopped collecting WITHOUT being paid — superseded by
 * a newer checkout, or past its deadline — to `processing`, because its
 * provider has since confirmed money for it (a card checkout outlives that
 * moment). Atomic: the update only matches the exact state that was read, so
 * at most one caller revives it; anyone else falls back to the regular claim.
 * The caller decides whether the invoice can still take this money.
 */
export async function claimLapsedIntentForProcessing(
  config: ServerConfig,
  intent: Pick<PaymentIntentRow, 'id' | 'status' | 'failure_reason'>,
  opts: {
    now?: Date;
    verification?: GatewayVerificationMarker;
    baseMetadata?: Record<string, unknown> | null;
  } = {},
): Promise<boolean> {
  if (intent.status !== 'expired' && !(intent.status === 'canceled' && intent.failure_reason === SUPERSEDED_BY_NEW_CHECKOUT)) {
    return false;
  }
  const nowIso = (opts.now ?? new Date()).toISOString();
  const metadata: Record<string, unknown> = {
    ...(opts.baseMetadata || {}),
    revived_from: { status: intent.status, failure_reason: intent.failure_reason ?? null, at: nowIso },
  };
  if (opts.verification) metadata[GATEWAY_VERIFICATION_METADATA_KEY] = opts.verification;

  let query = getServiceClient(config)
    .from('billing_payment_intents')
    .update({ status: 'processing', processing_at: nowIso, failure_reason: null, metadata, updated_at: nowIso })
    .eq('id', intent.id)
    .eq('status', intent.status);
  if (intent.status === 'canceled') query = query.eq('failure_reason', SUPERSEDED_BY_NEW_CHECKOUT);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
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

// Fail-closed binding check (pure; lives with the other verification rules).
export { providerRefMatchesIntent } from './gatewayVerification.js';

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
