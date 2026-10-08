// ============================================================
// PROVIDER REFUNDS — a refund reported by a payment provider's webhook.
//
// The refund is recorded on the customer payment it belongs to, matched by
// the provider's payment id (Stripe PaymentIntent, PayPal capture, Paddle
// transaction, Lemon Squeezy order) or by the payment intent. Amounts are
// minor units of the payment's own currency; `refund_amount` is the TOTAL
// refunded so far, capped at the payment amount.
//
// A refund only changes the money record. Taking back a service period that
// was paid for is a support decision and is not automated here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebhookEvent } from './types.js';

export interface RefundablePayment {
  id: string;
  amount: number | string | null;
  refund_amount?: number | string | null;
  metadata?: Record<string, unknown> | null;
}

/** Payment metadata key: amount of each provider refund, by refund id (Paddle adjustments). */
export const PROVIDER_REFUNDS_KEY = 'provider_refunds';

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function refundsById(payment: RefundablePayment): Record<string, number> {
  const raw = payment.metadata?.[PROVIDER_REFUNDS_KEY];
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, amount] of Object.entries(raw as Record<string, unknown>)) out[id] = num(amount);
  return out;
}

/**
 * The payment's refund state after this event. Providers that report the
 * running total (Stripe `amount_refunded`, PayPal `total_refunded_amount`,
 * Lemon Squeezy `refunded_amount`) set it absolutely. Paddle reports each
 * refund with its own id: the total is the sum over DISTINCT refund ids, so a
 * refund reported twice (adjustment.created and .updated) counts once. No
 * amount at all → the whole payment.
 */
export function nextRefundState(
  payment: RefundablePayment,
  event: Pick<WebhookEvent, 'amount' | 'refundedTotal' | 'refundId'>,
): { refundAmount: number; status: 'refunded' | 'partially_refunded'; refunds?: Record<string, number> } {
  const paid = num(payment.amount);
  let total: number;
  let refunds: Record<string, number> | undefined;
  const perRefund = typeof event.amount === 'number' && Number.isFinite(event.amount) && event.amount > 0;
  if (typeof event.refundedTotal === 'number' && Number.isFinite(event.refundedTotal)) {
    total = event.refundedTotal;
  } else if (perRefund && event.refundId) {
    refunds = { ...refundsById(payment), [event.refundId]: event.amount as number };
    total = Object.values(refunds).reduce((sum, amount) => sum + amount, 0);
  } else if (perRefund) {
    total = num(payment.refund_amount) + (event.amount as number);
  } else {
    total = paid;
  }
  const refundAmount = Math.max(0, Math.min(Math.round(total), paid));
  return { refundAmount, status: refundAmount >= paid ? 'refunded' : 'partially_refunded', ...(refunds ? { refunds } : {}) };
}

/** Applies a provider refund to its payment row. Resolves false when no payment matches. */
export async function recordProviderRefund(
  sb: SupabaseClient,
  providerName: string,
  event: Pick<WebhookEvent, 'providerPaymentId' | 'intentId' | 'amount' | 'refundedTotal' | 'refundId'>,
): Promise<boolean> {
  let query = sb.from('billing_payments').select('id, amount, refund_amount, metadata').eq('provider_name', providerName);
  if (event.providerPaymentId) query = query.eq('provider_payment_id', event.providerPaymentId);
  else if (event.intentId) query = query.eq('payment_intent_id', event.intentId);
  else return false;

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(`refund payment lookup failed: ${error.message}`);
  const payment = data as RefundablePayment | null;
  if (!payment) return false;

  const next = nextRefundState(payment, event);
  const patch: Record<string, unknown> = { refund_amount: next.refundAmount, status: next.status };
  if (next.refunds) patch.metadata = { ...(payment.metadata || {}), [PROVIDER_REFUNDS_KEY]: next.refunds };
  const { error: updateError } = await sb
    .from('billing_payments')
    .update(patch)
    .eq('id', payment.id);
  if (updateError) throw new Error(`refund record failed: ${updateError.message}`);
  return true;
}
