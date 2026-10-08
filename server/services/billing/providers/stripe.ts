import type {
  BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification,
  WebhookEvent, SubscriptionStatus,
} from '../types.js';
import crypto from 'crypto';
import { minorFromProvider, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';

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

/** Currencies a checkout may be priced in (the `billing_plans.prices` keys Stripe settles). */
export const STRIPE_CURRENCIES = ['USD', 'EUR', 'GBP', 'TRY'] as const;

/**
 * Stripe accepts a Checkout Session expiry between 30 minutes and 24 hours
 * after creation. The shortest window is used, so a session cannot be paid
 * after the payment intent it collects for (which outlives it — see
 * CARD_INTENT_TTL_MS in ../cardInvoice.ts).
 */
const CHECKOUT_EXPIRY_SECONDS = 31 * 60;

/** Appends one query pair to a URL that may already carry a query string. */
function withQuery(url: string, pair: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${pair}`;
}

/** The id of an expandable Stripe field (a string id, or an expanded object). */
function readStripeId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  const record = asStripeRecord(value);
  const id = record ? record.id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function readStripeMetaString(obj: Record<string, unknown> | null, key: string): string | undefined {
  const meta = obj ? asStripeRecord(obj.metadata) : null;
  const value = meta ? meta[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const stripeProvider: BillingProviderHandler = {
  name: 'stripe',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: true,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: true,
  },
  supportedCurrencies: STRIPE_CURRENCIES,

  /**
   * One-time Checkout Session for exactly the amount being collected
   * (`metadata.amount`, minor units of `req.currency` — the invoice due).
   * The price is inline `price_data`, so nothing has to be mirrored in the
   * Stripe dashboard and the charged amount cannot drift from the plan price.
   * Intent, invoice and workspace ride in the session and PaymentIntent
   * metadata, which Stripe signs into every webhook about them.
   */
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const sk = config.secret_key as string;
    const currency = requireSupportedCurrency('Stripe', req.currency, STRIPE_CURRENCIES);
    const amount = minorFromProvider(req.metadata?.amount);
    if (!amount) throw new Error('Stripe checkout needs a positive amount');

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('line_items[0][quantity]', '1');
    params.set('line_items[0][price_data][currency]', currency.toLowerCase());
    params.set('line_items[0][price_data][unit_amount]', String(amount));
    params.set('line_items[0][price_data][product_data][name]', req.description || 'Subscription');
    // Stripe substitutes {CHECKOUT_SESSION_ID}; form encoding is only transport.
    params.set('success_url', withQuery(req.callbackUrl, 'session_id={CHECKOUT_SESSION_ID}'));
    params.set('cancel_url', withQuery(req.callbackUrl, 'canceled=1'));
    params.set('expires_at', String(Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRY_SECONDS));
    if (req.customerEmail) params.set('customer_email', req.customerEmail);
    if (req.intentId) params.set('client_reference_id', req.intentId);
    const metadata: Array<[string, string | undefined]> = [
      ['workspace_id', req.workspaceId],
      ['intent_id', req.intentId],
      ['invoice_id', req.invoiceId],
    ];
    for (const [key, value] of metadata) {
      if (!value) continue;
      params.set(`metadata[${key}]`, value);
      params.set(`payment_intent_data[metadata][${key}]`, value);
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${sk}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // A retried create for the same payment intent returns the same session.
    if (req.intentId) headers['Idempotency-Key'] = `checkout:${req.intentId}`;

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(readStripeErrorMessage(data) || 'Stripe checkout failed');
    const paymentUrl = readStripeString(data, 'url');
    if (!paymentUrl) throw new Error('Stripe checkout failed');
    const sessionId = readStripeString(data, 'id');
    return { paymentUrl, sessionId };
  },

  /**
   * Server-to-server confirmation of the session bound to the intent
   * (`session_id` is always the STORED reference, see buildBoundVerifyParams).
   * Paid only when Stripe says the session is complete AND paid; the amount
   * and currency returned are Stripe's, for the caller to compare with the
   * invoice. A return through `cancel_url` expires the still-open session, so
   * it can no longer be paid behind the customer's back.
   */
  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
    const sessionId = (params.session_id || '').trim();
    if (!sessionId) return { verified: false, providerRef: '', status: 'failed' };
    const path = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;

    const res = await fetch(path, { headers: { 'Authorization': `Bearer ${config.secret_key}` } });
    const body: unknown = await res.json().catch(() => null);
    // Stripe unreachable or refusing: nothing definitive. The webhook can still
    // settle a paid session, and the customer's screen keeps polling.
    if (!res.ok) return { verified: false, providerRef: sessionId, status: 'pending' };
    const session = asStripeRecord(body);
    const status = session ? session.status : undefined;

    if (status === 'complete' && session?.payment_status === 'paid') {
      return {
        verified: true,
        providerRef: sessionId,
        amount: minorFromProvider(session.amount_total),
        currency: normalizeCurrencyCode(session.currency),
        paymentId: readStripeId(session.payment_intent),
        status: 'paid',
      };
    }
    if (status === 'expired') return { verified: false, providerRef: sessionId, status: 'expired' };
    if (status === 'open' && params.canceled === '1') {
      const expire = await fetch(`${path}/expire`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (expire.ok) return { verified: false, providerRef: sessionId, status: 'canceled' };
    }
    // Still open, or complete with an asynchronous payment not settled yet.
    return { verified: false, providerRef: sessionId, status: 'pending' };
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
    const obj = asStripeRecord(asStripeRecord(event?.data)?.object);
    const eventType = typeof event?.type === 'string' ? event.type : '';
    const base = {
      providerEventId: event.id,
      workspaceId: readStripeMetaString(obj, 'workspace_id'),
      currency: normalizeCurrencyCode(obj?.currency),
      raw: event,
    };

    // Checkout Sessions created by createCheckoutSession above.
    if (eventType.startsWith('checkout.session.')) {
      const session = {
        ...base,
        intentId: readStripeMetaString(obj, 'intent_id') || readStripeString(obj, 'client_reference_id'),
        providerRef: readStripeId(obj?.id),
        providerCustomerId: readStripeId(obj?.customer),
        providerPaymentId: readStripeId(obj?.payment_intent),
        amount: minorFromProvider(obj?.amount_total),
      };
      if (
        (eventType === 'checkout.session.completed' && obj?.payment_status === 'paid') ||
        eventType === 'checkout.session.async_payment_succeeded'
      ) {
        return { ...session, type: 'payment_succeeded' };
      }
      if (eventType === 'checkout.session.async_payment_failed') {
        return { ...session, type: 'payment_failed', status: 'failed' };
      }
      if (eventType === 'checkout.session.expired') {
        return { ...session, type: 'payment_failed', status: 'expired' };
      }
      // A completed session whose asynchronous payment is still unpaid.
      return { ...session, type: 'ignored' };
    }

    if (eventType === 'charge.refunded') {
      return {
        ...base,
        type: 'refund_processed',
        // Payments are recorded under their PaymentIntent id; the refund is matched by it.
        providerPaymentId: readStripeId(obj?.payment_intent) || readStripeId(obj?.id),
        intentId: readStripeMetaString(obj, 'intent_id'),
        // Cumulative amount refunded on the charge, minor units.
        refundedTotal: minorFromProvider(obj?.amount_refunded),
      };
    }

    // Subscription-mode objects: legacy, this platform no longer creates them.
    const legacyMap: Record<string, WebhookEvent['type']> = {
      'invoice.paid': 'invoice_paid',
      'invoice.payment_failed': 'invoice_failed',
      'customer.subscription.created': 'subscription_created',
      'customer.subscription.updated': 'subscription_updated',
      'customer.subscription.deleted': 'subscription_canceled',
    };
    const mapped = legacyMap[eventType];
    if (!mapped) return { ...base, type: 'ignored' };
    return {
      ...base,
      type: mapped,
      providerCustomerId: readStripeId(obj?.customer),
      providerSubscriptionId: readStripeId(obj?.subscription) || readStripeId(obj?.id),
      providerPaymentId: readStripeId(obj?.payment_intent) || readStripeId(obj?.id),
      amount: minorFromProvider(obj?.amount_paid),
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
    // Cancel at period end (the counterpart of resumeSubscription below). A
    // DELETE would end the Stripe subscription immediately, which both throws
    // away the paid remainder and makes a later resume impossible.
    const params = new URLSearchParams();
    params.set('cancel_at_period_end', 'true');
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
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

  /** `paymentId` is the PaymentIntent id; Stripe refunds in the charge's own currency. */
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
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
