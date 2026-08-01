import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

// --- Local runtime narrowing for Lemon Squeezy JSON:API bodies (no casts, no shared helper) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * JSON:API error envelope: `{ errors: [{ detail?, title?, ... }] }`.
 * Mirrors the previous truthiness check on `data.errors`: any truthy `errors`
 * value marks the response as failed. Only `errors[0].detail` is consumed.
 */
function readLemonSqueezyError(body: unknown): { detail: string | undefined } | null {
  const root = asRecord(body);
  if (root === null) return null;
  const errors = root.errors;
  if (!errors) return null;
  const first = Array.isArray(errors) ? asRecord(errors[0]) : null;
  const detail = first === null ? undefined : first.detail;
  return { detail: typeof detail === 'string' ? detail : undefined };
}

/**
 * JSON:API checkout envelope: `{ data: { id, attributes: { url } } }`.
 * Only `data.id` and `data.attributes.url` are consumed by the adapter.
 */
function readLemonSqueezyCheckout(body: unknown): { id: string; url: string } | null {
  const root = asRecord(body);
  if (root === null) return null;
  const data = asRecord(root.data);
  if (data === null) return null;
  const attributes = asRecord(data.attributes);
  if (attributes === null) return null;
  const id = data.id;
  const url = attributes.url;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof url !== 'string' || url.length === 0) return null;
  return { id, url };
}

async function lsApi(config: BillingProviderConfig, path: string, method = 'GET', body?: unknown) {
  // (unchanged)
  const res = await fetch(`https://api.lemonsqueezy.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

export const lemonSqueezyProvider: BillingProviderHandler = {
  name: 'lemon_squeezy',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: true,
    refunds: true, webhooks: true, multiCurrency: false, trialSupport: true,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const data: unknown = await lsApi(config, '/checkouts', 'POST', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: req.customerEmail,
            custom: { workspace_id: req.workspaceId },
          },
          product_options: { redirect_url: req.callbackUrl },
        },
        relationships: {
          store: { data: { type: 'stores', id: config.store_id } },
          variant: { data: { type: 'variants', id: req.planId } },
        },
      },
    });
    const error = readLemonSqueezyError(data);
    if (error !== null) throw new Error(error.detail || 'Lemon Squeezy checkout failed');
    const checkout = readLemonSqueezyCheckout(data);
    if (checkout === null) throw new Error('Lemon Squeezy checkout failed');
    return { paymentUrl: checkout.url, sessionId: checkout.id };
  },

  async verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const sig = headers['x-signature'];
    const secret = config.webhook_secret as string;
    if (!sig || !secret) return null;

    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== sig) throw new Error('Invalid Lemon Squeezy webhook signature');

    const event = JSON.parse(body);
    const typeMap: Record<string, WebhookEvent['type']> = {
      'order_created': 'checkout_completed',
      'subscription_created': 'subscription_created',
      'subscription_updated': 'subscription_updated',
      'subscription_cancelled': 'subscription_canceled',
      'subscription_payment_success': 'payment_succeeded',
      'subscription_payment_failed': 'payment_failed',
    };
    const mapped = typeMap[event.meta?.event_name];
    if (!mapped) return null;

    return {
      type: mapped,
      providerEventId: event.meta?.event_name + '_' + event.data?.id,
      providerSubscriptionId: event.data?.attributes?.subscription_id?.toString() || event.data?.id?.toString(),
      providerCustomerId: event.data?.attributes?.customer_id?.toString(),
      workspaceId: event.meta?.custom_data?.workspace_id,
      amount: event.data?.attributes?.total,
      currency: event.data?.attributes?.currency,
      raw: event,
    };
  },

  async cancelSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const data: unknown = await lsApi(config, `/subscriptions/${subscriptionId}`, 'DELETE');
    if (data === null || data === undefined) {
      // Preserves the previous runtime behaviour exactly: reading `.errors` off a
      // null/undefined JSON body threw a TypeError, surfaced by the caller as 500.
      throw new TypeError("Cannot read properties of null (reading 'errors')");
    }
    // Same truthiness semantics as the previous `!data.errors` check.
    return { success: readLemonSqueezyError(data) === null };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const data: unknown = await lsApi(config, `/stores/${config.store_id}`);
      const error = readLemonSqueezyError(data);
      if (error !== null) return { success: false, latencyMs: Date.now() - start, error: error.detail };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
