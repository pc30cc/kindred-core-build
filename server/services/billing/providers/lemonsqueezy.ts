import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';
import { minorFromProvider, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';

/**
 * A Lemon Squeezy store sells in ONE currency (set when the store is created)
 * and `custom_price` is in that currency's cents. These are the `billing_plans.prices`
 * keys a store can have; the configured `currency` (default USD) is the one
 * actually charged.
 */
export const LEMON_SQUEEZY_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

/** Checkout links expire with the payment intent they collect for. */
const CHECKOUT_LINK_TTL_MS = 30 * 60 * 1000;

/** The one currency a configured store charges (`config.currency`, default USD); none when unsupported. */
export function lemonSqueezyStoreCurrencies(config: BillingProviderConfig): readonly string[] {
  const code = normalizeCurrencyCode(config.currency) || 'USD';
  return (LEMON_SQUEEZY_CURRENCIES as readonly string[]).includes(code) ? [code] : [];
}

/**
 * The price an order charged before tax, in cents of the store currency —
 * the number that must equal the invoice (`custom_price`). `total` is not:
 * with tax-exclusive pricing Lemon Squeezy adds the tax on top of the price.
 * Tax-exclusive: `subtotal` less any discount. Tax-inclusive: `total`, which
 * then contains the tax. Discount codes are disabled on our checkouts, so a
 * discount only ever lowers the amount, and lower is parked, never settled.
 */
export function lemonSqueezyOrderPrice(attributes: Record<string, unknown> | null): number | undefined {
  const total = minorFromProvider(attributes?.total);
  if (attributes?.tax_inclusive === true) return total;
  const subtotal = minorFromProvider(attributes?.subtotal);
  if (subtotal === undefined) return undefined;
  return Math.max(0, subtotal - (minorFromProvider(attributes?.discount_total) ?? 0));
}

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

// --- Webhook signature verification -------------------------------------
//
// Lemon Squeezy signs the raw body with HMAC-SHA256 (hex) in `X-Signature`.
// There is no signed timestamp, so replay protection comes exclusively from
// the provider event id plus the database idempotency claim.

/** Length-checked constant-time hex comparison. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const bufA = Buffer.from(a.toLowerCase(), 'hex');
  const bufB = Buffer.from(b.toLowerCase(), 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True when the provided hex signature matches HMAC-SHA256(secret, rawBody). */
export function verifyLemonSqueezySignature(secret: string, signature: string, rawBody: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeHexEqual(expected, signature.trim());
}

export const lemonSqueezyProvider: BillingProviderHandler = {
  name: 'lemon_squeezy',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: true,
    refunds: true, webhooks: true, multiCurrency: false, trialSupport: true,
  },

  supportedCurrencies: LEMON_SQUEEZY_CURRENCIES,
  chargeableCurrencies: lemonSqueezyStoreCurrencies,

  /**
   * A checkout of the configured single-payment variant (`variant_id`) at
   * `custom_price` = exactly the amount being collected (cents of the store
   * currency). The variant's own price is never charged, so one variant
   * serves every plan and interval. `checkout_data.custom` carries workspace,
   * intent and invoice; Lemon Squeezy returns it as `meta.custom_data` on the
   * order webhooks, which are what confirm the payment (the redirect back
   * carries no payment reference). Discount codes are switched off: the
   * customer pays the invoice, not a price lowered at the provider.
   */
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const storeCurrency = normalizeCurrencyCode(config.currency) || 'USD';
    const currency = requireSupportedCurrency('Lemon Squeezy', req.currency, LEMON_SQUEEZY_CURRENCIES);
    if (!lemonSqueezyStoreCurrencies(config).includes(currency)) {
      throw new Error(`Lemon Squeezy store sells in ${storeCurrency}, not ${currency}`);
    }
    const amount = minorFromProvider(req.metadata?.amount);
    if (!amount) throw new Error('Lemon Squeezy checkout needs a positive amount');
    const variantId = config.variant_id !== undefined && config.variant_id !== null ? String(config.variant_id).trim() : '';
    if (!variantId) throw new Error('Lemon Squeezy variant is not configured');

    const custom: Record<string, string> = { workspace_id: req.workspaceId };
    if (req.intentId) custom.intent_id = req.intentId;
    if (req.invoiceId) custom.invoice_id = req.invoiceId;

    const data: unknown = await lsApi(config, '/checkouts', 'POST', {
      data: {
        type: 'checkouts',
        attributes: {
          custom_price: amount,
          checkout_data: {
            ...(req.customerEmail ? { email: req.customerEmail } : {}),
            custom,
          },
          product_options: {
            redirect_url: req.callbackUrl,
            ...(req.description ? { name: req.description } : {}),
          },
          checkout_options: { discount: false },
          expires_at: new Date(Date.now() + CHECKOUT_LINK_TTL_MS).toISOString(),
          ...(config.test_mode ? { test_mode: true } : {}),
        },
        relationships: {
          store: { data: { type: 'stores', id: String(config.store_id) } },
          variant: { data: { type: 'variants', id: variantId } },
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
    const secret = typeof config.webhook_secret === 'string' ? config.webhook_secret : '';
    if (!sig || !secret) return null; // fail-closed: no secret → not verified

    if (!verifyLemonSqueezySignature(secret, sig, body)) {
      throw new Error('Invalid Lemon Squeezy webhook signature');
    }

    const event = JSON.parse(body);
    const meta = asRecord(event?.meta);
    const customData = asRecord(meta?.custom_data);
    const data = asRecord(event?.data);
    const attributes = asRecord(data?.attributes);
    const eventName = typeof meta?.event_name === 'string' ? meta.event_name : '';
    const dataId = data?.id !== undefined && data?.id !== null ? String(data.id) : '';
    const readCustom = (key: string) => {
      const value = customData?.[key];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    const base = {
      // Lemon Squeezy sends no event id: event name + object id is unique per change.
      providerEventId: `${eventName}_${dataId}`,
      workspaceId: readCustom('workspace_id'),
      intentId: readCustom('intent_id'),
      currency: normalizeCurrencyCode(attributes?.currency),
      raw: event,
    };

    if (eventName === 'order_created') {
      // An order can be created before its payment clears; only `paid` is money.
      if (attributes?.status !== 'paid') return { ...base, type: 'ignored' };
      return {
        ...base,
        type: 'payment_succeeded',
        providerPaymentId: dataId || undefined,
        providerCustomerId: attributes?.customer_id !== undefined ? String(attributes.customer_id) : undefined,
        // The pre-tax price, in cents of the store currency like `custom_price`;
        // what was actually charged (tax included) is kept for the record.
        amount: lemonSqueezyOrderPrice(attributes),
        charge: {
          total: minorFromProvider(attributes?.total),
          tax: minorFromProvider(attributes?.tax),
          currency: base.currency,
        },
      };
    }
    if (eventName === 'order_refunded') {
      // Every partial refund re-sends `order_refunded` for the same order:
      // the running refunded amount tells them apart (a retry of one
      // delivery carries the same amount, so it is still a replay).
      const refunded = minorFromProvider(attributes?.refunded_amount);
      const stamp = refunded !== undefined
        ? String(refunded)
        : typeof attributes?.updated_at === 'string' ? attributes.updated_at : '';
      return {
        ...base,
        providerEventId: stamp ? `${base.providerEventId}_${stamp}` : base.providerEventId,
        type: 'refund_processed',
        providerPaymentId: dataId || undefined,
        refundedTotal: refunded,
      };
    }

    // Subscriptions (legacy: this platform no longer creates them).
    const legacyMap: Record<string, WebhookEvent['type']> = {
      'subscription_created': 'subscription_created',
      'subscription_updated': 'subscription_updated',
      'subscription_cancelled': 'subscription_canceled',
      'subscription_payment_success': 'payment_succeeded',
      'subscription_payment_failed': 'payment_failed',
    };
    const mapped = legacyMap[eventName];
    if (!mapped) return { ...base, type: 'ignored' };
    return {
      ...base,
      type: mapped,
      providerSubscriptionId: attributes?.subscription_id !== undefined
        ? String(attributes.subscription_id)
        : dataId || undefined,
      providerCustomerId: attributes?.customer_id !== undefined ? String(attributes.customer_id) : undefined,
      amount: minorFromProvider(attributes?.total),
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
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
