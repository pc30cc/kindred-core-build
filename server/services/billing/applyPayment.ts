// ============================================================
// APPLYING A VERIFIED PAYMENT — the only place where money becomes a
// subscription period or a customer payment record.
//
// Everything here is IDEMPOTENT and keyed by the payment intent:
//
//   * the subscription period is applied at most once per intent
//     (`workspace_subscriptions.metadata.last_payment_intent_id` marker), so a
//     retried finalization cannot stack two periods for one payment;
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
import {
  classifyPlanAction,
  computeSubscriptionWindow,
  type BillingInterval,
  type PlanActionType,
  type PurchaseActionType,
} from './periods.js';
import { handleWorkspaceEntitlementChanged } from './entitlementChange.js';

export interface CustomerPaymentInput {
  workspaceId: string;
  providerName: string;
  providerPaymentId?: string | null;
  paymentIntentId?: string | null;
  amount: number;
  currency: string;
  purchaseType: 'subscription' | 'ai_credit_topup';
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
export async function applySubscriptionPayment(
  config: ServerConfig,
  input: {
    workspaceId: string;
    planId: string;
    interval: BillingInterval;
    providerName: string;
    paymentIntentId?: string | null;
    providerSubscriptionId?: string | null;
    providerCustomerId?: string | null;
    now?: Date;
  },
): Promise<AppliedSubscription> {
  const supabase = getServiceClient(config);
  const now = input.now ?? new Date();

  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('plan_id, status, current_period_end, metadata')
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();

  const currentMetadata = (sub?.metadata as Record<string, unknown> | null) || {};

  const { data: nextPlan } = await supabase
    .from('billing_plans')
    .select('id, name, sort_order')
    .eq('id', input.planId)
    .maybeSingle();

  let currentRank: number | null = null;
  if (sub?.plan_id) {
    const { data: currentPlan } = await supabase
      .from('billing_plans')
      .select('sort_order')
      .eq('id', sub.plan_id)
      .maybeSingle();
    currentRank = typeof currentPlan?.sort_order === 'number' ? currentPlan.sort_order : null;
  }

  const actionType = classifyPlanAction({
    currentPlanId: sub?.plan_id ?? null,
    currentPlanRank: currentRank,
    currentStatus: sub?.status ?? null,
    nextPlanId: input.planId,
    nextPlanRank: typeof nextPlan?.sort_order === 'number' ? nextPlan.sort_order : null,
  });

  // Replay guard — this exact intent already produced a period.
  if (
    input.paymentIntentId &&
    currentMetadata.last_payment_intent_id === input.paymentIntentId
  ) {
    return {
      actionType,
      planId: input.planId,
      planName: (nextPlan?.name as string | undefined) ?? null,
      interval: input.interval,
      periodStart: String(currentMetadata.last_period_start ?? ''),
      periodEnd: String(currentMetadata.last_period_end ?? ''),
      stacked: Boolean(currentMetadata.last_period_stacked),
      alreadyApplied: true,
    };
  }

  const window = computeSubscriptionWindow({
    now,
    interval: input.interval,
    action: actionType,
    currentPeriodEnd: sub?.current_period_end ? new Date(sub.current_period_end) : null,
  });

  const metadata: Record<string, unknown> = {
    ...currentMetadata,
    last_payment_intent_id: input.paymentIntentId ?? null,
    last_action_type: actionType,
    last_period_start: window.start.toISOString(),
    last_period_end: window.end.toISOString(),
    last_period_stacked: window.stacked,
  };

  const { error } = await supabase.from('workspace_subscriptions').upsert(
    {
      workspace_id: input.workspaceId,
      provider_name: input.providerName,
      provider_subscription_id: input.providerSubscriptionId ?? null,
      provider_customer_id: input.providerCustomerId ?? null,
      status: 'active',
      plan_id: input.planId,
      billing_interval: input.interval,
      cancel_at_period_end: false,
      current_period_start: window.start.toISOString(),
      current_period_end: window.end.toISOString(),
      metadata,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id' },
  );
  if (error) throw new Error(`subscription_apply_failed:${error.message}`);

  await handleWorkspaceEntitlementChanged(config, {
    workspaceId: input.workspaceId,
    source: actionType === 'plan_renewal' ? 'subscription_renewed' : 'subscription_created',
  });

  return {
    actionType,
    planId: input.planId,
    planName: (nextPlan?.name as string | undefined) ?? null,
    interval: input.interval,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    stacked: window.stacked,
    alreadyApplied: false,
  };
}
