import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent, SubscriptionStatus } from '../types.js';
import crypto from 'crypto';

export const stripeProvider: BillingProviderHandler = {
  name: 'stripe',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: true,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: true,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const sk = config.secret_key as string;
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('success_url', `${req.callbackUrl}?session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', req.callbackUrl);
    params.set('line_items[0][price]', req.planId);
    params.set('line_items[0][quantity]', '1');
    params.set('currency', req.currency.toLowerCase());
    if (req.customerEmail) params.set('customer_email', req.customerEmail);
    params.set('metadata[workspace_id]', req.workspaceId);

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Stripe checkout failed');
    return { paymentUrl: data.url, sessionId: data.id };
  },

  async verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const sig = headers['stripe-signature'];
    const secret = config.webhook_secret as string;
    if (!sig || !secret) return null;

    // Stripe signature verification
    const parts = sig.split(',').reduce((acc: Record<string, string>, part: string) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    if (expected !== parts['v1']) throw new Error('Invalid Stripe webhook signature');

    const event = JSON.parse(body);
    const obj = event.data?.object;
    const typeMap: Record<string, WebhookEvent['type']> = {
      'checkout.session.completed': 'checkout_completed',
      'invoice.paid': 'invoice_paid',
      'invoice.payment_failed': 'invoice_failed',
      'customer.subscription.created': 'subscription_created',
      'customer.subscription.updated': 'subscription_updated',
      'customer.subscription.deleted': 'subscription_canceled',
      'charge.refunded': 'refund_processed',
    };
    const mapped = typeMap[event.type];
    if (!mapped) return null;

    return {
      type: mapped,
      providerEventId: event.id,
      providerCustomerId: obj?.customer,
      providerSubscriptionId: obj?.subscription || obj?.id,
      providerPaymentId: obj?.payment_intent || obj?.id,
      workspaceId: obj?.metadata?.workspace_id,
      amount: obj?.amount_total || obj?.amount_paid,
      currency: obj?.currency,
      raw: event,
    };
  },

  async getSubscriptionStatus(config: BillingProviderConfig, subscriptionId: string): Promise<SubscriptionStatus> {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      headers: { 'Authorization': `Bearer ${config.secret_key}` },
    });
    const sub = await res.json();
    if (!res.ok) return { active: false, status: 'none' };
    const statusMap: Record<string, SubscriptionStatus['status']> = {
      active: 'active', trialing: 'trialing', past_due: 'past_due',
      canceled: 'canceled', unpaid: 'unpaid', incomplete: 'incomplete', paused: 'paused',
    };
    return {
      active: sub.status === 'active' || sub.status === 'trialing',
      status: statusMap[sub.status] || 'none',
      providerSubscriptionId: sub.id,
      providerCustomerId: sub.customer,
      currentPeriodStart: new Date(sub.current_period_start * 1000).toISOString(),
      currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  },

  async cancelSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${config.secret_key}` },
    });
    return { success: res.ok };
  },

  async resumeSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const params = new URLSearchParams();
    params.set('cancel_at_period_end', 'false');
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return { success: res.ok };
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const params = new URLSearchParams();
    params.set('payment_intent', paymentId);
    if (amount) params.set('amount', String(amount));
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    return { success: res.ok, refundId: data.id };
  },

  async getPortalUrl(config: BillingProviderConfig, customerId: string, returnUrl: string) {
    const params = new URLSearchParams();
    params.set('customer', customerId);
    params.set('return_url', returnUrl);
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Portal session failed');
    return { url: data.url };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const res = await fetch('https://api.stripe.com/v1/balance', {
        headers: { 'Authorization': `Bearer ${config.secret_key}` },
      });
      const data = await res.json();
      if (!res.ok) return { success: false, latencyMs: Date.now() - start, error: data.error?.message };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
