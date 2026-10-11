// ============================================================================
// SIMPLE BILLING — what follows a settled gateway payment: the receipt mail,
// and for a payment made for a purpose (plan, renewal, upgrade) the
// entitlement refresh and the plan mail. Runs after the settlement committed;
// never throws (the money is already where it belongs).
//
// A renewal Paddle charged on a saved card (phase 3b) sends no receipt of
// ours: Paddle mails its own invoice, and our renewal mail
// (billing_card_renewed) names the card. A
// card payment that could not be spent on its purpose, or that needs a person
// (payments.review), sends the receipt (the money is in the balance) and is
// logged REVIEW.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { sendBillingEmail } from './notify.js';
import { afterPlanChange } from './plans.js';
import { cardLabel } from './card.js';

export interface SettledPayment {
  replayed?: boolean;
  ledger_id?: string;
  payment_id?: string;
  receipt_number?: string;
  balance_minor?: number;
  purpose?: string;
  purpose_result?: Record<string, unknown> | null;
}

interface PaymentFacts {
  workspace_id: string;
  currency: string;
  amount_minor: number;
  source?: string | null;
  review?: string | null;
  card_id?: string | null;
}

const CARD_SOURCES = new Set(['card_setup', 'card_renewal', 'card_charge']);

/** "Visa •••• 4242" of the card a payment came from; '' when unknown. */
async function cardOf(config: ServerConfig, cardId: string | null | undefined): Promise<string> {
  if (!cardId) return '';
  const { data } = await getServiceClient(config)
    .from('billing_account_cards')
    .select('brand, last4')
    .eq('id', cardId)
    .maybeSingle();
  const card = data as { brand?: string | null; last4?: string | null } | null;
  return card ? cardLabel(card.brand, card.last4) : '';
}

export async function afterAccountSettlement(config: ServerConfig, settled: SettledPayment): Promise<void> {
  if (settled.replayed || !settled.payment_id) return;
  try {
    // The whole row: a database without migration 262's columns reads as a checkout.
    const { data } = await getServiceClient(config)
      .from('billing_account_payments')
      .select('*')
      .eq('id', settled.payment_id)
      .maybeSingle();
    const payment = data as PaymentFacts | null;
    if (!payment) return;
    const result = settled.purpose_result;
    const purposeError = result && typeof result === 'object' && 'error' in result ? String(result.error) : null;
    const source = payment.source ?? 'checkout';
    const onCard = CARD_SOURCES.has(source);
    const review = onCard ? (payment.review ?? purposeError) : null;
    if (review) {
      console.error(`[billing-account] REVIEW payment=${settled.payment_id} source=${source} credited to the balance; ${settled.purpose ?? 'payment'}: ${review}`);
    }

    // A clean card renewal: Paddle's invoice is its receipt.
    if (!(source === 'card_renewal' && !review)) {
      await sendBillingEmail(
        config,
        payment.workspace_id,
        'billing_payment_receipt',
        (ctx) => ({
          receipt_number: settled.receipt_number ?? '',
          amount: ctx.money(Number(payment.amount_minor), payment.currency),
          balance: ctx.money(Number(settled.balance_minor ?? 0), payment.currency),
        }),
        { receiptLedgerId: settled.ledger_id ?? null },
      );
    }
    if (result && typeof result === 'object' && !purposeError && !result.replayed) {
      const card = onCard ? await cardOf(config, payment.card_id).catch(() => '') : '';
      await afterPlanChange(config, payment.workspace_id, result, 'payment_succeeded', card ? { card } : {});
    } else if (purposeError && !onCard) {
      console.warn(`[billing-account] payment ${settled.payment_id} credited; its ${settled.purpose} could not be done: ${purposeError}`);
    }
  } catch (e) {
    console.warn('[billing-account] after settlement:', e instanceof Error ? e.message : e);
  }
}
