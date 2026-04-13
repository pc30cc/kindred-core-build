import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

async function lsApi(config: BillingProviderConfig, path: string, method = 'GET', body?: unknown) {
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
    const data = await lsApi(config, '/checkouts', 'POST', {
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
    if (data.errors) throw new Error(data.errors[0]?.detail || 'Lemon Squeezy checkout failed');
    return { paymentUrl: data.data.attributes.url, sessionId: data.data.id };
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
    const data = await lsApi(config, `/subscriptions/${subscriptionId}`, 'DELETE');
    return { success: !data.errors };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const data = await lsApi(config, `/stores/${config.store_id}`);
      if (data.errors) return { success: false, latencyMs: Date.now() - start, error: data.errors[0]?.detail };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
