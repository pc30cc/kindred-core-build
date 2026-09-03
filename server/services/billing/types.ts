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
  currency: string;
  callbackUrl: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  paymentUrl: string;
  sessionId?: string;
  authority?: string; // Iranian gateways
  providerRef?: string;
}

export interface WebhookEvent {
  type: 'payment_succeeded' | 'payment_failed' | 'subscription_created' |
        'subscription_updated' | 'subscription_canceled' | 'refund_processed' |
        'checkout_completed' | 'invoice_paid' | 'invoice_failed';
  providerEventId: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  providerPaymentId?: string;
  workspaceId?: string;
  planId?: string;
  /** Billing interval the payment covers. Drives the subscription period end;
   * falls back to a 30-day period when a provider's webhook carries none. */
  interval?: 'monthly' | 'yearly';
  amount?: number;
  currency?: string;
  status?: string;
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
  createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null>;
  verifyPayment?(config: BillingProviderConfig, params: Record<string, string>): Promise<{ verified: boolean; providerRef: string; amount?: number; status?: string }>;
  getSubscriptionStatus?(config: BillingProviderConfig, subscriptionId: string): Promise<SubscriptionStatus>;
  cancelSubscription?(config: BillingProviderConfig, subscriptionId: string): Promise<{ success: boolean }>;
  resumeSubscription?(config: BillingProviderConfig, subscriptionId: string): Promise<{ success: boolean }>;
  refundPayment?(config: BillingProviderConfig, paymentId: string, amount?: number): Promise<{ success: boolean; refundId?: string }>;
  getPortalUrl?(config: BillingProviderConfig, customerId: string, returnUrl: string): Promise<{ url: string }>;
  testConnection(config: BillingProviderConfig): Promise<{ success: boolean; latencyMs: number; error?: string }>;
}
