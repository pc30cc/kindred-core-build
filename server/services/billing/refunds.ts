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
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The payment's refund state after this event. Providers that report the
 * running total (Stripe `amount_refunded`, PayPal `total_refunded_amount`,
 * Lemon Squeezy `refunded_amount`) set it absolutely; Paddle reports each
 * refund, which is added. No amount at all → the whole payment.
 */
export function nextRefundState(
  payment: RefundablePayment,
  event: Pick<WebhookEvent, 'amount' | 'refundedTotal'>,
): { refundAmount: number; status: 'refunded' | 'partially_refunded' } {
  const paid = num(payment.amount);
  let total: number;
  if (typeof event.refundedTotal === 'number' && Number.isFinite(event.refundedTotal)) {
    total = event.refundedTotal;
  } else if (typeof event.amount === 'number' && Number.isFinite(event.amount) && event.amount > 0) {
    total = num(payment.refund_amount) + event.amount;
  } else {
    total = paid;
  }
  const refundAmount = Math.max(0, Math.min(Math.round(total), paid));
  return { refundAmount, status: refundAmount >= paid ? 'refunded' : 'partially_refunded' };
}

/** Applies a provider refund to its payment row. Resolves false when no payment matches. */
export async function recordProviderRefund(
  sb: SupabaseClient,
  providerName: string,
  event: Pick<WebhookEvent, 'providerPaymentId' | 'intentId' | 'amount' | 'refundedTotal'>,
): Promise<boolean> {
  let query = sb.from('billing_payments').select('id, amount, refund_amount').eq('provider_name', providerName);
  if (event.providerPaymentId) query = query.eq('provider_payment_id', event.providerPaymentId);
  else if (event.intentId) query = query.eq('payment_intent_id', event.intentId);
  else return false;

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(`refund payment lookup failed: ${error.message}`);
  const payment = data as RefundablePayment | null;
  if (!payment) return false;

  const next = nextRefundState(payment, event);
  const { error: updateError } = await sb
    .from('billing_payments')
    .update({ refund_amount: next.refundAmount, status: next.status })
    .eq('id', payment.id);
  if (updateError) throw new Error(`refund record failed: ${updateError.message}`);
  return true;
}
