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
//
// A card checkout can outlive its attempt: the customer opens a second
// checkout (which supersedes the first), or pays after the attempt's
// deadline. Money for such an attempt still settles the invoice while the
// invoice is payable for exactly that amount and currency; the superseded
// checkout is also closed at the provider where the provider allows it.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getProvider, resolveNamedBillingConfig } from './index.js';
import {
  IRAN_PROVIDERS,
  SUPERSEDED_BY_NEW_CHECKOUT,
  claimIntentForProcessing,
  claimLapsedIntentForProcessing,
  getPaymentIntent,
  markIntentSucceeded,
  markPaymentIntentFailed,
  noteIntentFailureAttempt,
  type ClaimOutcome,
  type PaymentIntentRow,
} from './paymentIntent.js';
import {
  buildGatewayVerificationMarker,
  evaluateGatewayVerification,
  expectedIntentAmountIrr,
} from './gatewayVerification.js';
import { extractProviderRefCandidates } from './providerBinding.js';
import { recordCustomerPayment } from './applyPayment.js';
import { handleWorkspaceEntitlementChanged } from './entitlementChange.js';
import { InvoiceSettlementError, releaseCollection, settleAndApply } from './invoice/settle.js';
import { recordProviderRefund } from './refunds.js';
import { normalizeCurrencyCode } from './providers/minorAmount.js';
import type { BillingProviderConfig, ProviderCharge, WebhookEvent } from './types.js';

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
 * charges — and, given the account's `config`, the ones THAT account can
 * charge (a Lemon Squeezy store sells in one currency). Anything else (the
 * Turkish gateways, which have no server-side payment confirmation here yet)
 * cannot collect an invoice at all.
 */
export function canCollectInvoice(providerName: string, currency: string, config?: BillingProviderConfig | null): boolean {
  const code = normalizeCurrencyCode(currency);
  if (!code) return false;
  if (IRAN_PROVIDERS.has(providerName)) return code === 'IRR';
  if (!CARD_INVOICE_PROVIDERS.has(providerName)) return false;
  const provider = getProvider(providerName);
  if (!provider?.supportedCurrencies?.includes(code)) return false;
  if (config && provider.chargeableCurrencies) return provider.chargeableCurrencies(config).includes(code);
  return true;
}

/** Whether a gateway's currencies depend on the account's configuration (see canCollectInvoice). */
export function collectionDependsOnAccount(providerName: string): boolean {
  return Boolean(getProvider(providerName)?.chargeableCurrencies);
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

/**
 * An attempt that stopped collecting without a payment, but whose card
 * checkout may still have been paid: superseded by a newer checkout of the
 * same invoice, or past its deadline.
 */
export function isLapsedCardIntent(intent: Pick<PaymentIntentRow, 'status' | 'failure_reason'>): boolean {
  return intent.status === 'expired' || (intent.status === 'canceled' && intent.failure_reason === SUPERSEDED_BY_NEW_CHECKOUT);
}

const PAYABLE_INVOICE_STATUSES = new Set(['open', 'partially_paid', 'past_due']);

/**
 * Whether the intent's invoice can still take exactly the intent's money: it
 * is payable, it still owes the amount the intent was created for, in the
 * intent's currency. Throws on a read failure (a retry decides, not a guess).
 */
export async function invoiceStillCollects(config: ServerConfig, intent: InvoiceIntent): Promise<boolean> {
  if (!intent.invoice_id) return false;
  const { data, error } = await getServiceClient(config)
    .from('billing_invoices')
    .select('status, amount_due_irr, currency')
    .eq('id', intent.invoice_id)
    .maybeSingle();
  if (error) throw new Error(`billing invoice read failed: ${error.message}`);
  const invoice = data as { status?: string; amount_due_irr?: number | string; currency?: string } | null;
  if (!invoice || !PAYABLE_INVOICE_STATUSES.has(String(invoice.status))) return false;
  if (Number(invoice.amount_due_irr) !== expectedIntentAmountIrr(intent)) return false;
  return (normalizeCurrencyCode(invoice.currency) || 'IRR') === intentCurrency(intent);
}

/**
 * Whether money for this attempt was recorded for review (an unapplied
 * payment bound to it, or naming it in its metadata). The return page shows
 * "under review" for such an attempt, never "payment failed".
 */
export async function hasUnappliedPayment(
  config: ServerConfig,
  intent: Pick<PaymentIntentRow, 'id' | 'workspace_id'>,
): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('billing_payments')
    .select('id')
    .eq('workspace_id', intent.workspace_id)
    .eq('reconciliation_state', 'unapplied')
    .or(`payment_intent_id.eq.${intent.id},metadata->>intentId.eq.${intent.id}`)
    .limit(1);
  if (error) throw new Error(`billing payment read failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Attempts on an invoice that hold an open provider checkout. Read before a
 * new checkout is reserved, so the ones it supersedes can be closed after.
 */
export async function openCheckoutAttempts(config: ServerConfig, invoiceId: string): Promise<string[]> {
  const { data, error } = await getServiceClient(config)
    .from('billing_payment_intents')
    .select('id, provider_ref')
    .eq('invoice_id', invoiceId)
    .eq('status', 'pending');
  if (error) throw new Error(`billing intent read failed: ${error.message}`);
  return ((data || []) as Array<{ id: string; provider_ref: string | null }>)
    .filter((row) => Boolean(row.provider_ref))
    .map((row) => row.id);
}

/**
 * Best effort: closes the provider checkout of every attempt among
 * `intentIds` that a newer checkout superseded (Stripe expires the session,
 * Paddle cancels the transaction), so the customer cannot pay a checkout the
 * invoice no longer waits for. Failures are logged and ignored: money that
 * still arrives settles the invoice or is recorded for review. Resolves the
 * number of checkouts the providers confirmed closed.
 */
export async function closeSupersededCheckouts(
  config: ServerConfig,
  workspaceId: string,
  intentIds: string[],
): Promise<number> {
  if (intentIds.length === 0) return 0;
  const { data, error } = await getServiceClient(config)
    .from('billing_payment_intents')
    .select('id, provider_name, provider_ref, status, failure_reason')
    .in('id', intentIds);
  if (error) {
    console.warn('[billing] superseded checkouts not closed: intent read failed');
    return 0;
  }
  type Row = { id: string; provider_name: string; provider_ref: string | null; status: string; failure_reason: string | null };
  let closed = 0;
  for (const row of (data || []) as Row[]) {
    if (row.status !== 'canceled' || row.failure_reason !== SUPERSEDED_BY_NEW_CHECKOUT || !row.provider_ref) continue;
    if (!getProvider(row.provider_name)?.closeCheckout) continue;
    try {
      const resolved = await resolveNamedBillingConfig(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        row.provider_name,
      );
      if (resolved?.provider.closeCheckout && (await resolved.provider.closeCheckout(resolved.config, row.provider_ref))) {
        closed += 1;
        continue;
      }
    } catch {
      /* logged below */
    }
    console.warn('[billing] superseded checkout left open', { intentId: row.id, providerName: row.provider_name });
  }
  return closed;
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
  /** What the provider actually charged, when `amount` is the pre-tax price (recorded only). */
  charge?: ProviderCharge;
}

/** Settlement refusals that a retry cannot change. */
const DETERMINISTIC_REFUSALS = new Set(['amount_mismatch', 'overpayment', 'not_payable', 'unknown_invoice']);

/** The provider id the payment is recorded under (refunds are matched by it). */
function providerPaymentIdOf(input: VerifiedCardPayment): string | null {
  return input.paymentId || input.providerRef || input.intent.provider_ref || null;
}

function paymentMetadata(input: VerifiedCardPayment, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: input.intent.id,
    providerRef: input.providerRef ?? null,
    invoiceId: input.intent.invoice_id ?? null,
    ...(input.charge ? { providerCharge: input.charge } : {}),
    ...extra,
  };
}

/**
 * Records verified money that cannot settle this intent as an UNAPPLIED
 * payment. `bindToIntent: false` keeps it off the intent's unique payment
 * slot (`uq_billing_payments_intent`), which may already hold another
 * payment: a second payment is its own row, never merged into that one. A
 * payment that settled an invoice (`invoice_id` set) is never marked
 * unapplied, whatever replay reaches it.
 */
async function parkPayment(
  config: ServerConfig,
  input: VerifiedCardPayment,
  reason: string,
  opts: { bindToIntent?: boolean } = {},
): Promise<CardSettlement> {
  const { intent } = input;
  const bindToIntent = opts.bindToIntent !== false;
  const payment = await recordCustomerPayment(config, {
    workspaceId: intent.workspace_id,
    providerName: input.providerName,
    providerPaymentId: bindToIntent ? input.paymentId || input.providerRef || null : providerPaymentIdOf(input),
    paymentIntentId: bindToIntent ? intent.id : null,
    invoiceNumber: intent.invoice_number,
    amount: typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : 0,
    currency: normalizeCurrencyCode(input.currency) || intentCurrency(intent),
    purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
    actionType: intent.action_type || 'plan_new',
    metadata: paymentMetadata(input, { parked: reason }),
  });
  if (payment.id) {
    await getServiceClient(config)
      .from('billing_payments')
      .update({ reconciliation_state: 'unapplied', reconciliation_reason: reason.slice(0, 500) })
      .eq('id', payment.id)
      .is('invoice_id', null);
  }
  if (intent.status === 'pending' || intent.status === 'processing') {
    await markPaymentIntentFailed(config, intent.id, reason);
    await releaseIntentCollections(config, intent.id, reason);
  }
  return { outcome: 'parked', reason };
}

/**
 * Money confirmed for an intent that already SUCCEEDED: a repeat of the
 * payment that settled it (same provider payment id) changes nothing; any
 * other payment is a second charge, recorded as unapplied for review.
 */
async function settledIntentRepeat(
  config: ServerConfig,
  input: VerifiedCardPayment,
  intent: InvoiceIntent,
): Promise<CardSettlement> {
  // Nothing tells this money apart from the payment already recorded.
  if (!input.paymentId && !input.providerRef) return { outcome: 'duplicate' };
  const { data, error } = await getServiceClient(config)
    .from('billing_payments')
    .select('provider_payment_id')
    .eq('payment_intent_id', intent.id)
    .maybeSingle();
  if (error) throw new Error(`billing payment read failed: ${error.message}`);
  const recorded = (data as { provider_payment_id?: string | null } | null)?.provider_payment_id ?? null;
  if (recorded && recorded === providerPaymentIdOf({ ...input, intent })) return { outcome: 'duplicate' };
  return parkPayment(config, { ...input, intent }, 'second_payment_for_paid_intent', { bindToIntent: false });
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
  if (intent.status === 'succeeded') return settledIntentRepeat(config, input, intent);
  if (!intent.invoice_id) return parkPayment(config, input, 'intent_without_invoice');
  const lapsed = isLapsedCardIntent(intent);
  if (intent.status === 'failed' || ((intent.status === 'canceled' || intent.status === 'expired') && !lapsed)) {
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

  // A superseded or expired attempt that was paid after all settles while its
  // invoice still owes exactly this amount in this currency (settlement
  // itself refuses anything beyond that); otherwise the money is parked.
  if (lapsed && !(await invoiceStillCollects(config, intent))) {
    return parkPayment(config, input, `payment_after_intent_${intent.status}`);
  }

  const claimOpts = {
    verification: buildGatewayVerificationMarker(input.providerRef || null, amount),
    baseMetadata: intent.metadata,
  };
  const claim: ClaimOutcome = lapsed && (await claimLapsedIntentForProcessing(config, intent, claimOpts))
    ? { claimed: true, resumed: false }
    : await claimIntentForProcessing(config, intent.id, claimOpts);
  if (claim.claimed === false) {
    if (claim.reason === 'in_flight') return { outcome: 'in_flight' };
    // Finalized by someone else meanwhile: a repeat only if THIS payment is
    // the one that settled it. Any other money is recorded for review, never
    // reported as a duplicate and dropped.
    const current = (await getPaymentIntent(config, intent.id)) as InvoiceIntent | null;
    if (current?.status === 'succeeded') return settledIntentRepeat(config, input, current);
    return parkPayment(config, { ...input, intent: current ?? intent }, `payment_after_intent_${current?.status ?? 'missing'}`, {
      bindToIntent: false,
    });
  }

  try {
    const payment = await recordCustomerPayment(config, {
      workspaceId: intent.workspace_id,
      providerName: input.providerName,
      providerPaymentId: providerPaymentIdOf(input),
      paymentIntentId: intent.id,
      invoiceNumber: intent.invoice_number,
      amount,
      currency: expectedCurrency,
      purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
      actionType: intent.action_type || 'plan_new',
      planId: intent.plan_id,
      planNameSnapshot: intent.plan_name_snapshot,
      billingInterval: intent.billing_interval,
      metadata: paymentMetadata(input),
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
        charge: event.charge,
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
