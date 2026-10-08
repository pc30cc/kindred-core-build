// ============================================================
// CARD GATEWAYS ON THE INVOICE ENGINE — Stripe, PayPal, Paddle, Lemon Squeezy.
//
// Every workspace is on the invoice engine: a payment never grants anything by
// itself, it settles an invoice, and only the paid invoice applies its frozen
// effect (period, plan, AI allowance). The card gateways follow exactly the
// road the Iranian gateways take:
//
//   invoice (currency + amount due, frozen)  →  payment intent (expected amount,
//   currency in metadata)  →  provider checkout for exactly that amount  →
//   provider confirmation  →  settleVerifiedCardPayment()  →  invoice paid  →
//   effects applied.
//
// The confirmation is either the customer's return (a server-to-server lookup
// of the stored checkout reference: Stripe session, PayPal capture, Paddle
// transaction) or the provider's signed webhook, which names the intent in
// its custom metadata. Both may arrive, in any order and more than once; the
// intent claim, the unique payment per intent and the settlement command key
// make every repeat a no-op.
//
// Money that cannot settle its intent (wrong amount or currency, an intent
// that is no longer collecting, an invoice that is no longer payable) is
// recorded as an UNAPPLIED payment for reconciliation — never discarded, never
// applied to something the customer did not buy.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getProvider } from './index.js';
import {
  IRAN_PROVIDERS,
  claimIntentForProcessing,
  markIntentSucceeded,
  markPaymentIntentFailed,
  noteIntentFailureAttempt,
  type PaymentIntentRow,
} from './paymentIntent.js';
import { buildGatewayVerificationMarker, evaluateGatewayVerification } from './gatewayVerification.js';
import { extractProviderRefCandidates } from './providerBinding.js';
import { recordCustomerPayment } from './applyPayment.js';
import { handleWorkspaceEntitlementChanged } from './entitlementChange.js';
import { InvoiceSettlementError, releaseCollection, settleAndApply } from './invoice/settle.js';
import { recordProviderRefund } from './refunds.js';
import { normalizeCurrencyCode } from './providers/minorAmount.js';
import type { WebhookEvent } from './types.js';

/** Card gateways that collect invoices (any currency their handler supports). */
export const CARD_INVOICE_PROVIDERS = new Set(['stripe', 'paypal', 'paddle', 'lemon_squeezy']);

/**
 * A card checkout lives longer than an Iranian bank redirect: Stripe's
 * shortest session is 30 minutes, and the customer may type card details
 * slowly. The intent outlives the provider's checkout, so a checkout can never
 * be paid after its intent stopped collecting.
 */
export const CARD_INTENT_TTL_MS = 45 * 60 * 1000;
/** The invoice's collection reservation for a card checkout (same window). */
export const CARD_COLLECTION_TTL_SECONDS = 45 * 60;

export function isCardInvoiceProvider(providerName: string): boolean {
  return CARD_INVOICE_PROVIDERS.has(providerName);
}

/**
 * Whether a gateway can collect an invoice in this currency: the Iranian
 * gateways collect IRR only; a card gateway, the currencies its handler
 * charges. Anything else (the Turkish gateways, which have no server-side
 * payment confirmation here yet) cannot collect an invoice at all.
 */
export function canCollectInvoice(providerName: string, currency: string): boolean {
  const code = normalizeCurrencyCode(currency);
  if (!code) return false;
  if (IRAN_PROVIDERS.has(providerName)) return code === 'IRR';
  if (!CARD_INVOICE_PROVIDERS.has(providerName)) return false;
  return Boolean(getProvider(providerName)?.supportedCurrencies?.includes(code));
}

/** Currency an intent collects: recorded in its metadata by card checkouts; IRR otherwise. */
export function intentCurrency(intent: Pick<PaymentIntentRow, 'metadata'>): string {
  return normalizeCurrencyCode(intent.metadata?.currency) || 'IRR';
}

/** The intent columns written by the invoice engine that `PaymentIntentRow` does not declare. */
export type InvoiceIntent = PaymentIntentRow & {
  invoice_id?: string | null;
  expected_amount_irr?: number | string | null;
  billing_engine_version?: string | null;
};

/**
 * A callback naming a checkout reference other than the one stored for the
 * intent is never trusted. A callback naming none is fine: card payments are
 * confirmed by looking up the STORED reference, never one from the URL.
 */
export function cardCallbackRefConflicts(intent: Pick<PaymentIntentRow, 'provider_name' | 'provider_ref'>, params: unknown): boolean {
  const stored = (intent.provider_ref || '').trim();
  if (!stored) return false;
  return extractProviderRefCandidates(intent.provider_name, params).some((ref) => ref !== stored);
}

/** Ends every active invoice reservation owned by a payment attempt. */
export async function releaseIntentCollections(config: ServerConfig, intentId: string, reason: string): Promise<void> {
  const { data, error } = await getServiceClient(config)
    .from('billing_invoice_collections')
    .select('id')
    .eq('payment_intent_id', intentId)
    .eq('status', 'active');
  if (error) throw new Error(`billing collection lookup failed: ${error.message}`);
  await Promise.all((data || []).map((row) => releaseCollection(config, row.id as string, reason)));
}

export type CardSettlement =
  | { outcome: 'succeeded' }
  /** Already succeeded earlier (repeat callback / webhook). */
  | { outcome: 'duplicate' }
  /** Another request is finalizing this intent right now. */
  | { outcome: 'in_flight' }
  /** Verified money; applying it failed transiently. The intent stays recoverable. */
  | { outcome: 'pending'; reason: string }
  /** Verified money that cannot settle this intent; recorded as unapplied. */
  | { outcome: 'parked'; reason: string };

export interface VerifiedCardPayment {
  intent: InvoiceIntent;
  providerName: string;
  /** Checkout reference the provider confirmed (session / order / transaction id). */
  providerRef?: string | null;
  /** The provider's payment id (refunds are matched by it). */
  paymentId?: string | null;
  /** Captured amount, minor units of `currency`. */
  amount?: number;
  currency?: string;
}

/** Settlement refusals that a retry cannot change. */
const DETERMINISTIC_REFUSALS = new Set(['amount_mismatch', 'overpayment', 'not_payable', 'unknown_invoice']);

async function parkPayment(
  config: ServerConfig,
  input: VerifiedCardPayment,
  reason: string,
): Promise<CardSettlement> {
  const { intent } = input;
  const payment = await recordCustomerPayment(config, {
    workspaceId: intent.workspace_id,
    providerName: input.providerName,
    providerPaymentId: input.paymentId || input.providerRef || null,
    paymentIntentId: intent.id,
    invoiceNumber: intent.invoice_number,
    amount: typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : 0,
    currency: normalizeCurrencyCode(input.currency) || intentCurrency(intent),
    purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
    actionType: intent.action_type || 'plan_new',
    metadata: { intentId: intent.id, providerRef: input.providerRef ?? null, invoiceId: intent.invoice_id ?? null, parked: reason },
  });
  if (payment.id) {
    await getServiceClient(config)
      .from('billing_payments')
      .update({ reconciliation_state: 'unapplied', reconciliation_reason: reason.slice(0, 500) })
      .eq('id', payment.id);
  }
  if (intent.status === 'pending' || intent.status === 'processing') {
    await markPaymentIntentFailed(config, intent.id, reason);
    await releaseIntentCollections(config, intent.id, reason);
  }
  return { outcome: 'parked', reason };
}

/**
 * Turns money a card provider CONFIRMED into a settled invoice — or into a
 * recorded, unapplied payment when it cannot be. The caller must have
 * verified the payment with the provider (server-to-server lookup or a
 * verified webhook signature); nothing here trusts a browser.
 */
export async function settleVerifiedCardPayment(
  config: ServerConfig,
  input: VerifiedCardPayment,
): Promise<CardSettlement> {
  const { intent } = input;
  if (intent.status === 'succeeded') return { outcome: 'duplicate' };
  if (!intent.invoice_id) return parkPayment(config, input, 'intent_without_invoice');
  if (intent.status === 'failed' || intent.status === 'canceled' || intent.status === 'expired') {
    return parkPayment(config, input, `payment_after_intent_${intent.status}`);
  }
  const expectedCurrency = intentCurrency(intent);
  if (normalizeCurrencyCode(input.currency) !== expectedCurrency) {
    return parkPayment(config, input, 'gateway_currency_mismatch');
  }
  const decision = evaluateGatewayVerification(intent, {
    verified: true,
    providerRef: input.providerRef || '',
    amount: input.amount,
  });
  if ('reason' in decision) return parkPayment(config, input, decision.reason);
  const amount = decision.confirmedAmountIrr;

  const claim = await claimIntentForProcessing(config, intent.id, {
    verification: buildGatewayVerificationMarker(input.providerRef || null, amount),
    baseMetadata: intent.metadata,
  });
  if (claim.claimed === false) {
    return claim.reason === 'in_flight' ? { outcome: 'in_flight' } : { outcome: 'duplicate' };
  }

  try {
    const payment = await recordCustomerPayment(config, {
      workspaceId: intent.workspace_id,
      providerName: input.providerName,
      providerPaymentId: input.paymentId || input.providerRef || intent.provider_ref || null,
      paymentIntentId: intent.id,
      invoiceNumber: intent.invoice_number,
      amount,
      currency: expectedCurrency,
      purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
      actionType: intent.action_type || 'plan_new',
      planId: intent.plan_id,
      planNameSnapshot: intent.plan_name_snapshot,
      billingInterval: intent.billing_interval,
      metadata: { intentId: intent.id, providerRef: input.providerRef ?? null, invoiceId: intent.invoice_id },
    });
    await settleAndApply(config, {
      invoiceId: intent.invoice_id,
      paymentId: payment.id as string,
      amountIrr: amount,
      commandKey: `intent:${intent.id}`,
    });
  } catch (err: unknown) {
    if (err instanceof InvoiceSettlementError && DETERMINISTIC_REFUSALS.has(err.code)) {
      // settleAndApply already recorded the payment as unapplied.
      await markPaymentIntentFailed(config, intent.id, `settlement_refused:${err.code}`);
      await releaseIntentCollections(config, intent.id, `settlement_refused:${err.code}`);
      return { outcome: 'parked', reason: `settlement_refused:${err.code}` };
    }
    // The customer HAS paid: stay recoverable (a retry re-runs the same
    // idempotent steps), never report a failure.
    const message = err instanceof Error ? err.message : String(err);
    await noteIntentFailureAttempt(config, intent, message);
    return { outcome: 'pending', reason: 'finalization_pending' };
  }

  await markIntentSucceeded(config, intent.id);
  await releaseIntentCollections(config, intent.id, 'payment_completed');
  // The paid invoice changed the plan: drop this process's entitlement cache
  // now (not after its TTL) and queue the knowledge-base catch-up. Reports
  // its own failures; never throws into the payment path.
  await handleWorkspaceEntitlementChanged(config, {
    workspaceId: intent.workspace_id,
    source: intent.action_type === 'plan_renewal' ? 'subscription_renewed' : 'payment_succeeded',
  });
  return { outcome: 'succeeded' };
}

/**
 * A verified webhook event that names a payment intent (custom metadata).
 * Throws on a transient failure, so the route answers 5xx, the provider
 * retries and the retry re-processes the event.
 */
export async function handleCardIntentWebhook(
  config: ServerConfig,
  providerName: string,
  event: WebhookEvent,
  intent: InvoiceIntent,
): Promise<void> {
  switch (event.type) {
    case 'payment_succeeded':
    case 'checkout_completed':
    case 'invoice_paid': {
      const result = await settleVerifiedCardPayment(config, {
        intent,
        providerName,
        providerRef: event.providerRef || intent.provider_ref,
        paymentId: event.providerPaymentId,
        amount: event.amount,
        currency: event.currency,
      });
      if (result.outcome === 'pending' || result.outcome === 'in_flight') {
        throw new Error(`card_settlement_${result.outcome}`);
      }
      return;
    }
    case 'payment_failed':
    case 'invoice_failed':
      // Definitive at the provider (declined capture, expired session). Only an
      // attempt that is still waiting is failed; anything further along is not
      // second-guessed by a late failure notice.
      if (intent.status === 'pending') {
        await markPaymentIntentFailed(config, intent.id, `gateway_${event.status || 'failed'}`);
        await releaseIntentCollections(config, intent.id, `gateway_${event.status || 'failed'}`);
      }
      return;
    case 'refund_processed':
      await recordProviderRefund(getServiceClient(config), providerName, { ...event, intentId: intent.id });
      return;
    default:
      return;
  }
}
