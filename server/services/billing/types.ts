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

export interface WebhookEvent {
  /**
   * `ignored`: the signature verified but the event needs no action (an event
   * type or state this platform does not act on). It is acknowledged, so the
   * provider stops retrying it, and never reaches the financial pipeline.
   */
  type: 'payment_succeeded' | 'payment_failed' | 'subscription_created' |
        'subscription_updated' | 'subscription_canceled' | 'refund_processed' |
        'checkout_completed' | 'invoice_paid' | 'invoice_failed' | 'ignored';
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
  raw: unknown;
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
  getSubscriptionStatus?(config: BillingProviderConfig, subscriptionId: string): Promise<SubscriptionStatus>;
  cancelSubscription?(config: BillingProviderConfig, subscriptionId: string): Promise<{ success: boolean }>;
  resumeSubscription?(config: BillingProviderConfig, subscriptionId: string): Promise<{ success: boolean }>;
  /** `amount` in minor units of `currency`; omitted = full refund. */
  refundPayment?(config: BillingProviderConfig, paymentId: string, amount?: number, currency?: string): Promise<{ success: boolean; refundId?: string }>;
  getPortalUrl?(config: BillingProviderConfig, customerId: string, returnUrl: string): Promise<{ url: string }>;
  testConnection(config: BillingProviderConfig): Promise<{ success: boolean; latencyMs: number; error?: string }>;
}
