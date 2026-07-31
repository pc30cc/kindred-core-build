import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

// --- Local runtime narrowing for Paddle JSON bodies (no shared helper, no casts) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Paddle v2 error envelope: `{ error: { code, detail, ... } }`.
 * Mirrors the previous truthiness check on `data.error`: any truthy `error`
 * value marks the response as failed; `detail` is only read when it is a string.
 */
function readPaddleError(body: unknown): { detail: string | undefined } | null {
  const root = asRecord(body);
  if (root === null) return null;
  const error = root.error;
  if (!error) return null;
  const errorRecord = asRecord(error);
  const detail = errorRecord === null ? undefined : errorRecord.detail;
  return { detail: typeof detail === 'string' ? detail : undefined };
}

/**
 * Paddle v2 transaction envelope: `{ data: { id, checkout?: { url } } }`.
 * Only `data.id` and `data.checkout.url` are consumed by the adapter.
 */
function readPaddleTransaction(body: unknown): { id: string; checkoutUrl: string | null } | null {
  const root = asRecord(body);
  if (root === null) return null;
  const data = asRecord(root.data);
  if (data === null) return null;
  const id = data.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const checkout = asRecord(data.checkout);
  const url = checkout === null ? undefined : checkout.url;
  return { id, checkoutUrl: typeof url === 'string' && url.length > 0 ? url : null };
}

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';

async function paddleApi(config: BillingProviderConfig, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${baseUrl(config)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

export const paddleProvider: BillingProviderHandler = {
  name: 'paddle',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: true,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: true,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    // Paddle Billing API v2 — create a transaction
    const data = await paddleApi(config, '/transactions', 'POST', {
      items: [{ price_id: req.planId, quantity: 1 }],
      checkout: { url: req.callbackUrl },
      custom_data: { workspace_id: req.workspaceId },
      currency_code: req.currency.toUpperCase(),
      ...(req.customerEmail ? { customer: { email: req.customerEmail } } : {}),
    });
    const error = readPaddleError(data);
    if (error !== null) throw new Error(error.detail || 'Paddle checkout failed');
    const txn = readPaddleTransaction(data);
    if (txn === null) throw new Error('Paddle checkout failed');
    return {
      paymentUrl: txn.checkoutUrl || `https://checkout.paddle.com/pay/${txn.id}`,
      sessionId: txn.id,
    };
  },

  async verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const sig = headers['paddle-signature'];
    const secret = config.webhook_secret as string;
    if (!sig || !secret) return null;

    // Paddle v2 signature: ts=...;h1=...
    const parts: Record<string, string> = {};
    sig.split(';').forEach((p: string) => { const [k, v] = p.split('='); parts[k] = v; });
    const expected = crypto.createHmac('sha256', secret).update(`${parts['ts']}:${body}`).digest('hex');
    if (expected !== parts['h1']) throw new Error('Invalid Paddle webhook signature');

    const event = JSON.parse(body);
    const typeMap: Record<string, WebhookEvent['type']> = {
      'transaction.completed': 'checkout_completed',
      'transaction.payment_failed': 'payment_failed',
      'subscription.created': 'subscription_created',
      'subscription.updated': 'subscription_updated',
      'subscription.canceled': 'subscription_canceled',
      'adjustment.created': 'refund_processed',
    };
    const mapped = typeMap[event.event_type];
    if (!mapped) return null;

    return {
      type: mapped,
      providerEventId: event.event_id,
      providerSubscriptionId: event.data?.subscription_id || event.data?.id,
      providerCustomerId: event.data?.customer_id,
      workspaceId: event.data?.custom_data?.workspace_id,
      amount: event.data?.details?.totals?.total ? parseInt(event.data.details.totals.total) : undefined,
      currency: event.data?.currency_code,
      raw: event,
    };
  },

  async cancelSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const data = await paddleApi(config, `/subscriptions/${subscriptionId}/cancel`, 'POST', {
      effective_from: 'next_billing_period',
    });
    return { success: !data.error };
  },

  async getPortalUrl(_config: BillingProviderConfig, _customerId: string, returnUrl: string) {
    // Paddle customer portal URLs are managed via Paddle dashboard
    return { url: returnUrl };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const data = await paddleApi(config, '/event-types');
      const error = readPaddleError(data);
      if (error !== null) return { success: false, latencyMs: Date.now() - start, error: error.detail };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
