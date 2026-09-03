// ============================================================
// APPLYING A VERIFIED PAYMENT — the only place where money becomes a
// subscription period or a customer payment record.
//
// Everything here is IDEMPOTENT and keyed by the payment intent:
//
//   * the subscription period is applied at most once per intent — enforced by
//     a DURABLE application ledger (`billing_subscription_applications`, UNIQUE
//     on payment_intent_id) written in the SAME transaction as the
//     subscription mutation by the `billing_apply_subscription_payment` RPC.
//     `metadata.last_payment_intent_id` only remembered the LAST intent, so an
//     old crashed intent recovered after a newer payment could apply twice;
//     that field is now debug-only and never the idempotency source of truth;
//   * the customer payment row is unique per intent (unique index
//     `uq_billing_payments_intent`) and per provider reference
//     (`uq_billing_payments_provider_ref`), so a replayed callback cannot
//     create a second transaction in the customer's history.
//
// This is what makes the `pending → processing → succeeded` intent state
// machine safe: a crash after the gateway verify leaves a recoverable
// `processing` row, and re-running this module completes the payment without
// double-applying anything.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { BillingInterval, PlanActionType, PurchaseActionType } from './periods.js';
import { handleWorkspaceEntitlementChanged } from './entitlementChange.js';

export interface CustomerPaymentInput {
  workspaceId: string;
  providerName: string;
  providerPaymentId?: string | null;
  paymentIntentId?: string | null;
  invoiceNumber?: string | null;
  amount: number;
  currency: string;
  purchaseType: 'subscription' | 'ai_credit_topup' | 'wallet_deposit';
  actionType: PurchaseActionType;
  planId?: string | null;
  planNameSnapshot?: string | null;
  billingInterval?: BillingInterval | null;
  paidAt?: Date;
  metadata?: Record<string, unknown>;
}

function isUniqueViolation(error: { code?: string | null; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '23505' || /duplicate key value/i.test(error.message || '');
}

/**
 * Writes the customer-facing transaction row. Returns the row id, or `null`
 * when an equivalent row already exists (replay).
 */
export async function recordCustomerPayment(
  config: ServerConfig,
  input: CustomerPaymentInput,
): Promise<{ id: string | null; duplicate: boolean }> {
  const supabase = getServiceClient(config);
  const paidAt = (input.paidAt ?? new Date()).toISOString();
  const { data, error } = await supabase
    .from('billing_payments')
    .insert({
      workspace_id: input.workspaceId,
      provider_name: input.providerName,
      provider_payment_id: input.providerPaymentId ?? null,
      payment_intent_id: input.paymentIntentId ?? null,
      invoice_number: input.invoiceNumber ?? null,
      amount: input.amount,
      currency: input.currency,
      status: 'succeeded',
      purchase_type: input.purchaseType,
      action_type: input.actionType,
      plan_id: input.planId ?? null,
      plan_name_snapshot: input.planNameSnapshot ?? null,
      billing_interval: input.billingInterval ?? null,
      paid_at: paidAt,
      metadata: input.metadata || {},
    })
    .select('id')
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error as any)) return { id: null, duplicate: true };
    throw new Error(`payment_record_failed:${error.message}`);
  }
  return { id: (data as { id?: string } | null)?.id ?? null, duplicate: false };
}

export interface AppliedSubscription {
  actionType: PlanActionType;
  planId: string;
  planName: string | null;
  interval: BillingInterval;
  periodStart: string;
  periodEnd: string;
  /** True when the new period was stacked after unused paid time. */
  stacked: boolean;
  /** True when this intent had already been applied (replay). */
  alreadyApplied: boolean;
}

/**
 * Applies a paid plan checkout to `workspace_subscriptions`.
 *
 * Period rules (see ./periods.ts):
 *   - renewal of the SAME plan while the current period is still running
 *     stacks: the new period starts at `current_period_end`, so early renewal
 *     never burns remaining days;
 *   - new / upgrade / downgrade start now. No proration exists in the product
 *     and none is faked here.
 */
/**
 * Applies a paid plan checkout to `workspace_subscriptions`.
 *
 * Delegates to the `billing_apply_subscription_payment` RPC so that the
 * durable application marker and the subscription row commit atomically. The
 * RPC also locks the subscription row, so two concurrent finalizations cannot
 * stack two periods from the same `current_period_end`.
 *
 * Period rules (mirrored in SQL, see migration 106):
 *   - renewal of the SAME plan while the current period is still running
 *     stacks: the new period starts at `current_period_end`, so early renewal
 *     never burns remaining days;
 *   - new / upgrade / downgrade start now. No proration exists in the product
 *     and none is faked here.
 */
export async function applySubscriptionPayment(
  config: ServerConfig,
  input: {
    workspaceId: string;
    planId: string;
    interval: BillingInterval;
    providerName: string;
    /** REQUIRED: the durable idempotency key for this application. */
    paymentIntentId: string;
    now?: Date;
  },
): Promise<AppliedSubscription> {
  if (!input.paymentIntentId) throw new Error('subscription_apply_failed:missing_payment_intent_id');
  const supabase = getServiceClient(config);

  const { data, error } = await supabase.rpc('billing_apply_subscription_payment', {
    p_workspace_id: input.workspaceId,
    p_payment_intent_id: input.paymentIntentId,
    p_plan_id: input.planId,
    p_interval: input.interval,
    p_provider_name: input.providerName,
    p_now: (input.now ?? new Date()).toISOString(),
  });
  if (error) throw new Error(`subscription_apply_failed:${error.message}`);
  const row = (data || {}) as Record<string, unknown>;

  const applied: AppliedSubscription = {
    actionType: (row.actionType as PlanActionType) || 'plan_new',
    planId: (row.planId as string) || input.planId,
    planName: (row.planName as string | null) ?? null,
    interval: (row.interval as BillingInterval) || input.interval,
    periodStart: String(row.periodStart ?? ''),
    periodEnd: String(row.periodEnd ?? ''),
    stacked: Boolean(row.stacked),
    alreadyApplied: Boolean(row.alreadyApplied),
  };

  // Entitlements are recomputed even on replay: the recovery path may be the
  // first time the fan-out actually ran.
  await handleWorkspaceEntitlementChanged(config, {
    workspaceId: input.workspaceId,
    source: applied.actionType === 'plan_renewal' ? 'subscription_renewed' : 'subscription_created',
  });

  return applied;
}
