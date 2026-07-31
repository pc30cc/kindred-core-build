import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readPayPalAccessToken(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const token = record.access_token;
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

export function readPayPalOAuthError(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const description = record.error_description;
  if (typeof description === 'string' && description.length > 0) return description;
  return null;
}

async function getAccessToken(config: BillingProviderConfig): Promise<string> {
  const res = await fetch(`${baseUrl(config)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(readPayPalOAuthError(data) || 'PayPal auth failed');
  const token = readPayPalAccessToken(data);
  if (!token) throw new Error('PayPal auth failed');
  return token;
}

export const paypalProvider: BillingProviderHandler = {
  name: 'paypal',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: true,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const token = await getAccessToken(config);
    // Create a subscription
    const res = await fetch(`${baseUrl(config)}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: req.planId,
        application_context: {
          return_url: `${req.callbackUrl}?success=true`,
          cancel_url: `${req.callbackUrl}?success=false`,
          brand_name: req.metadata?.brand_name || 'Platform',
        },
        custom_id: req.workspaceId,
        subscriber: req.customerEmail ? { email_address: req.customerEmail } : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'PayPal subscription creation failed');
    const approveLink = data.links?.find((l: any) => l.rel === 'approve');
    return { paymentUrl: approveLink?.href || '', sessionId: data.id };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const event = JSON.parse(body);
    const typeMap: Record<string, WebhookEvent['type']> = {
      'BILLING.SUBSCRIPTION.CREATED': 'subscription_created',
      'BILLING.SUBSCRIPTION.ACTIVATED': 'subscription_updated',
      'BILLING.SUBSCRIPTION.CANCELLED': 'subscription_canceled',
      'BILLING.SUBSCRIPTION.SUSPENDED': 'subscription_updated',
      'PAYMENT.SALE.COMPLETED': 'payment_succeeded',
      'PAYMENT.SALE.DENIED': 'payment_failed',
      'PAYMENT.SALE.REFUNDED': 'refund_processed',
    };
    const mapped = typeMap[event.event_type];
    if (!mapped) return null;
    return {
      type: mapped,
      providerEventId: event.id,
      providerSubscriptionId: event.resource?.billing_agreement_id || event.resource?.id,
      providerCustomerId: event.resource?.payer?.payer_info?.payer_id,
      workspaceId: event.resource?.custom_id,
      amount: parseFloat(event.resource?.amount?.total || '0') * 100,
      currency: event.resource?.amount?.currency,
      raw: event,
    };
  },

  async cancelSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const token = await getAccessToken(config);
    const res = await fetch(`${baseUrl(config)}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer requested cancellation' }),
    });
    return { success: res.status === 204 || res.ok };
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const token = await getAccessToken(config);
    const body: any = {};
    if (amount) body.amount = { value: (amount / 100).toFixed(2), currency_code: 'USD' };
    const res = await fetch(`${baseUrl(config)}/v2/payments/captures/${paymentId}/refund`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { success: res.ok, refundId: data.id };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      await getAccessToken(config);
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
