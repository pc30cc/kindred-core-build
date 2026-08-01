import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent, SubscriptionStatus } from '../types.js';
import crypto from 'crypto';

/** Local, Stripe-only helpers. Scope: checkout session create, billing portal, test connection. */
function asStripeRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Reads `error.message` from a Stripe error envelope. Returns undefined when absent/mistyped. */
function readStripeErrorMessage(body: unknown): string | undefined {
  const record = asStripeRecord(body);
  const error = record ? asStripeRecord(record.error) : null;
  const message = error ? error.message : undefined;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** Narrows a string field of a Stripe object; undefined when missing, empty or mistyped. */
function readStripeString(body: unknown, key: string): string | undefined {
  const record = asStripeRecord(body);
  const value = record ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Subscription-only readers. Scope: getSubscriptionStatus. No coercion, no fallbacks. */
function readStripeSubscriptionField(body: unknown, key: string): unknown {
  const record = asStripeRecord(body);
  return record ? record[key] : undefined;
}

/** Mirrors the runtime semantics of `value * 1000` (ToNumber) without changing conversion. */
function readStripeSubscriptionPeriodMs(body: unknown, key: string): number {
  return Number(readStripeSubscriptionField(body, key)) * 1000;
}

/**
 * Webhook signature verification helpers.
 *
 * `body` MUST be the exact raw request bytes decoded as utf-8 — never a
 * re-serialized JSON object. Re-stringifying changes byte order/spacing and
 * would either break valid deliveries or (worse) let a forged payload pass.
 */
const STRIPE_TOLERANCE_SECONDS = 300; // 5 minutes, both directions

type StripeSignatureHeader = { timestamp: number; signatures: string[] };

/** Parses `t=...,v1=...,v1=...` tolerating whitespace, unknown fields and ordering. */
export function parseStripeSignatureHeader(header: string): StripeSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      if (timestamp !== null) return null; // ambiguous header
      if (!/^\d+$/.test(v)) return null;
      const parsed = Number(v);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      timestamp = parsed;
    } else if (k === 'v1') {
      if (/^[0-9a-f]+$/i.test(v)) signatures.push(v.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Length-checked constant-time hex comparison. */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True when at least one `v1` signature matches and the timestamp is fresh. */
export function verifyStripeSignature(
  secret: string,
  header: string,
  rawBody: string,
  nowMs: number = Date.now(),
): boolean {
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return false;
  const ageSeconds = Math.floor(nowMs / 1000) - parsed.timestamp;
  if (Math.abs(ageSeconds) > STRIPE_TOLERANCE_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');
  return parsed.signatures.some((sig) => timingSafeHexEqual(expected, sig));
}

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
    if (!res.ok) throw new Error(readStripeErrorMessage(data) || 'Stripe checkout failed');
    const paymentUrl = readStripeString(data, 'url');
    if (!paymentUrl) throw new Error('Stripe checkout failed');
    const sessionId = readStripeString(data, 'id');
    return { paymentUrl, sessionId };
  },

  async verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const sig = headers['stripe-signature'];
    const secret = typeof config.webhook_secret === 'string' ? config.webhook_secret : '';
    if (!sig || !secret) return null;

    // Fail closed: bad header, stale/future timestamp or no matching v1 signature.
    // The error message never contains the secret, the digest or the payload.
    if (!verifyStripeSignature(secret, sig, body)) {
      throw new Error('Invalid Stripe webhook signature');
    }

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
    const statusValue = readStripeSubscriptionField(sub, 'status');
    const statusKey = typeof statusValue === 'string' ? statusValue : '';
    const idValue = readStripeSubscriptionField(sub, 'id');
    const customerValue = readStripeSubscriptionField(sub, 'customer');
    const cancelValue = readStripeSubscriptionField(sub, 'cancel_at_period_end');
    return {
      active: statusValue === 'active' || statusValue === 'trialing',
      status: statusMap[statusKey] || 'none',
      providerSubscriptionId: typeof idValue === 'string' ? idValue : undefined,
      providerCustomerId: typeof customerValue === 'string' ? customerValue : undefined,
      currentPeriodStart: new Date(readStripeSubscriptionPeriodMs(sub, 'current_period_start')).toISOString(),
      currentPeriodEnd: new Date(readStripeSubscriptionPeriodMs(sub, 'current_period_end')).toISOString(),
      cancelAtPeriodEnd: typeof cancelValue === 'boolean' ? cancelValue : undefined,
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
    return { success: res.ok, refundId: readStripeString(data, 'id') };
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
    if (!res.ok) throw new Error(readStripeErrorMessage(data) || 'Portal session failed');
    const url = readStripeString(data, 'url');
    if (!url) throw new Error('Portal session failed');
    return { url };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const res = await fetch('https://api.stripe.com/v1/balance', {
        headers: { 'Authorization': `Bearer ${config.secret_key}` },
      });
      const data = await res.json();
      if (!res.ok) return { success: false, latencyMs: Date.now() - start, error: readStripeErrorMessage(data) };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
