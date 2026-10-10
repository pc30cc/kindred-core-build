// ============================================
// BILLING SERVICE TYPES (server-side only)
// ============================================

export interface BillingProviderConfig {
  provider: string;
  [key: string]: unknown;
}

export interface CheckoutRequest {
  workspaceId: string;
  planId: string;
  interval: 'monthly' | 'yearly';
  /** ISO 4217 code of the price being charged (`metadata.amount` is in its minor units). */
  currency: string;
  callbackUrl: string;
  customerEmail?: string;
  customerName?: string;
  /**
   * Payment intent this checkout collects for. Card providers carry it in the
   * provider's signed custom metadata so a webhook can settle exactly this
   * intent (and through it, exactly one invoice).
   */
  intentId?: string;
  /** Billing Engine invoice the intent pays, echoed in provider metadata for support. */
  invoiceId?: string;
  /** What the customer is buying, as shown on the provider's checkout page. */
  description?: string;
  metadata?: Record<string, string>;
  /**
   * Paddle only: the checkout saves the card. Its price recurs every
   * `interval` (`billing_cycle`), so paying it creates a Paddle subscription
   * that later renewals are charged through (simple billing, phase 3b).
   */
  recurring?: { interval: 'monthly' | 'yearly' };
  /** Paddle only: an existing Paddle customer (`ctm_…`) to bill, reused from an earlier card. */
  customerId?: string;
  /** Paddle only: the price's own `custom_data` (copied onto every renewal's item). */
  priceCustomData?: Record<string, unknown>;
  /** Paddle only: marks the transaction as a card setup (`custom_data.card_setup = '1'`). */
  cardSetup?: boolean;
}

export interface CheckoutResult {
  paymentUrl: string;
  sessionId?: string;
  authority?: string; // Iranian gateways
  providerRef?: string;
  /**
   * A checkout the browser opens itself instead of navigating to `paymentUrl`
   * (Paddle Billing: an overlay opened by Paddle.js for this transaction).
   * Holds only public values (client-side token, transaction id, URLs).
   */
  clientCheckout?: { provider: string } & Record<string, unknown>;
}

/** Answer of a provider's server-to-server payment lookup. */
export interface PaymentVerification {
  verified: boolean;
  /** The checkout reference the lookup was made for (session / order / transaction id). */
  providerRef: string;
  /** Amount the provider captured, in the minor units of `currency` (Rial for IRR). */
  amount?: number;
  /** ISO 4217 code of the captured amount, when the provider reports it. */
  currency?: string;
  /** The provider's id of the captured payment (refunds are keyed by it). */
  paymentId?: string;
  /**
   * `canceled` / `failed` / `expired` are definitive; `pending` means the
   * customer may still complete the payment, so nothing may be failed yet.
   */
  status?: string;
}

/**
 * What the provider actually took from the customer when that differs from
 * the amount compared with the invoice (Lemon Squeezy adds tax on top of the
 * price). Minor units of `currency`; recorded on the payment for reference.
 */
export interface ProviderCharge {
  total?: number;
  tax?: number;
  currency?: string;
}

export interface WebhookEvent {
  /**
   * `ignored`: the signature verified but the event needs no action (an event
   * type or state this platform does not act on). It is acknowledged, so the
   * provider stops retrying it, and never reaches the financial pipeline.
   */
  /**
   * `card_event`: Paddle only, an event about a saved card's subscription (a
   * `subscription.*` event, or a transaction Paddle made from a subscription:
   * renewal, one-time charge, card change). Routed by the subscription, never
   * by `custom_data.intent_id`, which Paddle copies from the checkout.
   */
  type: 'payment_succeeded' | 'payment_failed' | 'subscription_created' |
        'subscription_updated' | 'subscription_canceled' | 'refund_processed' |
        'checkout_completed' | 'invoice_paid' | 'invoice_failed' | 'card_event' | 'ignored';
  providerEventId: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  providerPaymentId?: string;
  workspaceId?: string;
  planId?: string;
  /** Billing interval the payment covers. Drives the subscription period end;
   * falls back to a 30-day period when a provider's webhook carries none. */
  interval?: 'monthly' | 'yearly';
  /** Minor units of `currency` (cents / kuruş; Rial for IRR). For a refund: the amount of THIS refund. */
  amount?: number;
  /**
   * `refund_processed` only: the total refunded on the payment so far, in
   * minor units, when the provider reports it (Stripe, PayPal, Lemon Squeezy).
   * Preferred over `amount`, which is per refund.
   */
  refundedTotal?: number;
  /** Upper-case ISO 4217 code. */
  currency?: string;
  status?: string;
  /** Payment intent named in the provider's signed custom metadata. */
  intentId?: string;
  /** Checkout reference (session / order / transaction id) the event belongs to. */
  providerRef?: string;
  /**
   * `refund_processed` only: the provider's id of THIS refund (Paddle
   * adjustment), when `amount` is per refund. Refunds are counted once per id.
   */
  refundId?: string;
  /** Payment events only: the charged total and tax, when `amount` is the pre-tax price. */
  charge?: ProviderCharge;
  /** `card_event` only: what Paddle reported, read into our shape. */
  card?: PaddleCardEvent;
  /** `refund_processed` only: the money was taken back by a chargeback (Paddle adjustment `chargeback`), not a refund. */
  chargeback?: boolean;
  raw: unknown;
}

// ─── Paddle subscriptions (saved card, simple billing phase 3b) ─────────
// Read from Paddle's JSON by providers/paddleSubscriptions.ts. Amounts are
// integer minor units (Paddle sends them as strings), times are ISO 8601,
// currencies upper-case ISO 4217; anything Paddle did not send is null.

/** The card of a payment attempt (`payments[].method_details.card`). */
export interface PaddleCardDetails {
  /** Paddle's card type: `visa`, `mastercard`, `american_express`, … */
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/** One recurring item of a subscription (`items[].price`). */
export interface PaddleSubscriptionItem {
  priceId: string | null;
  /** `price.unit_price.amount` */
  amountMinor: number | null;
  currency: string | null;
  /** `price.billing_cycle.interval`; null for anything but month / year. */
  interval: 'month' | 'year' | null;
  frequency: number | null;
  /** `price.custom_data`; {} when Paddle has none. */
  customData: Record<string, unknown>;
}

export interface PaddleSubscription {
  id: string;
  /** 'active' | 'past_due' | 'paused' | 'canceled' | 'trialing' */
  status: string;
  customerId: string | null;
  currency: string | null;
  /** When Paddle charges next; null once canceled or paused. */
  nextBilledAt: string | null;
  /** `current_billing_period.ends_at`; null for paused and canceled subscriptions. */
  currentPeriodEnd: string | null;
  /** A cancel / pause / resume Paddle will apply at `effectiveAt`. */
  scheduledChange: { action: string; effectiveAt: string | null } | null;
  items: PaddleSubscriptionItem[];
  customData: Record<string, unknown>;
  canceledAt: string | null;
}

export interface PaddleTransaction {
  id: string;
  /** 'draft' | 'ready' | 'billed' | 'paid' | 'completed' | 'canceled' | 'past_due' */
  status: string;
  /** 'api' | 'web' (checkouts) | 'subscription_recurring' | 'subscription_charge' | 'subscription_update' | 'subscription_payment_method_change' */
  origin: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  currency: string | null;
  /** `details.totals.total`: after discount and tax. */
  totalMinor: number | null;
  /** `details.totals.grand_total`: what is charged (after Paddle credit). */
  grandTotalMinor: number | null;
  /** `details.totals.credit`: Paddle customer credit applied. */
  creditMinor: number | null;
  /** items[].price.custom_data, in order ({} for an item without any). */
  itemCustomData: Record<string, unknown>[];
  customData: Record<string, unknown>;
  /** The card of the newest payment attempt that has one (`payments[]` is newest first). */
  card: PaddleCardDetails | null;
  /** The newest payment attempt's `error_code` (`declined`, `expired_card`, `authentication_failed`, …). */
  errorCode: string | null;
  createdAt: string | null;
  billedAt: string | null;
}

export interface PaddleCardEvent {
  /** Paddle's event type, e.g. 'transaction.paid', 'subscription.updated'. */
  eventType: string;
  entity: 'transaction' | 'subscription';
  occurredAt: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  /** transaction events: the transaction id; subscription.created: data.transaction_id (the checkout's). */
  transactionId: string | null;
  /** Transaction events. */
  transaction: PaddleTransaction | null;
  /** Subscription events. */
  subscription: PaddleSubscription | null;
  customData: Record<string, unknown>;
}

export interface SubscriptionStatus {
  active: boolean;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'expired' | 'incomplete' | 'paused' | 'none';
  planId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  providerSubscriptionId?: string;
  providerCustomerId?: string;
}

export interface ProviderCapabilities {
  subscriptions: boolean;
  oneTimePayments: boolean;
  customerPortal: boolean;
  refunds: boolean;
  webhooks: boolean;
  multiCurrency: boolean;
  trialSupport: boolean;
}

export interface BillingProviderHandler {
  name: string;
  capabilities: ProviderCapabilities;
  /**
   * Currencies this gateway can charge. A checkout in any other currency is
   * refused by the provider itself — never sent with another currency label.
   * Absent: the provider has no fixed list (legacy handlers).
   */
  supportedCurrencies?: readonly string[];
  /**
   * The currencies one configured account can charge, when that is narrower
   * than `supportedCurrencies` (a Lemon Squeezy store sells in the single
   * currency it was created with).
   */
  chargeableCurrencies?(config: BillingProviderConfig): readonly string[];
  /**
   * `verifyPayment` TAKES the money instead of only looking it up (PayPal
   * captures the approved order). It may only be called for an attempt that
   * can still settle its invoice; otherwise the order is left to lapse.
   */
  verifyPaymentCaptures?: boolean;
  /**
   * The currency a checkout falls back to when the requested one is not
   * supported (Turkish gateways: TRY). The caller must then charge the plan's
   * price in THIS currency — see ../chargeCurrency.ts.
   */
  fallbackCurrency?: string;
  /**
   * Exact plain-text body the provider requires as the acknowledgement of a
   * webhook delivery (PayTR: `OK`, otherwise it keeps re-sending the
   * notification). Absent: a JSON acknowledgement.
   */
  webhookAckBody?: string;
  createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null>;
  verifyPayment?(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification>;
  /**
   * Closes a checkout that can no longer settle anything (its attempt was
   * superseded by a newer checkout), so the customer cannot pay it any more.
   * Resolves whether the provider confirmed it. Best effort: callers ignore
   * failures, and money that still arrives is settled or parked as usual.
   */
  closeCheckout?(config: BillingProviderConfig, checkoutRef: string): Promise<boolean>;
  getSubscriptionStatus?(config: BillingProviderConfig, subscriptionId: string): Promise<SubscriptionStatus>;
  cancelSubscription?(config: BillingProviderConfig, subscriptionId: string): Promise<{ success: boolean }>;
  resumeSubscription?(config: BillingProviderConfig, subscriptionId: string): Promise<{ success: boolean }>;
  /** `amount` in minor units of `currency`; omitted = full refund. */
  refundPayment?(config: BillingProviderConfig, paymentId: string, amount?: number, currency?: string): Promise<{ success: boolean; refundId?: string }>;
  getPortalUrl?(config: BillingProviderConfig, customerId: string, returnUrl: string): Promise<{ url: string }>;
  testConnection(config: BillingProviderConfig): Promise<{ success: boolean; latencyMs: number; error?: string }>;
  /**
   * Why this configuration cannot be saved or used (an admin-facing message,
   * e.g. a sandbox key on a live gateway), or null when it can. Checked when
   * the Super Admin saves the provider's credentials.
   */
  validateConfig?(config: BillingProviderConfig): string | null;
}
