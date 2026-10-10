import type {
  BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification, WebhookEvent,
} from '../types.js';
import crypto from 'crypto';
import { minorFromProvider, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';

/** Currencies a transaction may be priced in (the `billing_plans.prices` keys Paddle settles). */
export const PADDLE_CURRENCIES = ['USD', 'EUR', 'GBP', 'TRY'] as const;

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

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Amount and currency Paddle collected for a transaction: `details.totals.total`
 * (lowest denomination, as a string) and `currency_code`. With tax-inclusive
 * prices (tax_mode `internal`, see createCheckoutSession) the total equals the
 * price the customer was quoted; Paddle takes its tax out of it.
 */
export function readPaddleTransactionTotal(txn: Record<string, unknown> | null): { amount?: number; currency?: string } {
  const totals = asRecord(asRecord(txn?.details)?.totals);
  return {
    amount: minorFromProvider(totals?.total),
    currency: normalizeCurrencyCode(txn?.currency_code),
  };
}

function withQuery(url: string, pair: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${pair}`;
}

/**
 * The `sandbox` switch as the Providers screen stores it: a toggle saves the
 * strings `'true'` / `'false'`, so the string `'false'` must read as off (a
 * plain truthiness check sent a live account to the sandbox).
 */
export function isPaddleSandboxFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase());
}

export const PADDLE_LIVE_API_BASE = 'https://api.paddle.com';
export const PADDLE_SANDBOX_API_BASE = 'https://sandbox-api.paddle.com';

export const paddleApiBase = (config: BillingProviderConfig) =>
  isPaddleSandboxFlag(config.sandbox) ? PADDLE_SANDBOX_API_BASE : PADDLE_LIVE_API_BASE;

const baseUrl = paddleApiBase;

// --- Credential shapes ---------------------------------------------------
//
// Paddle keeps live and sandbox in separate accounts with separate keys:
//   - API keys:           `pdl_live_apikey_…` / `pdl_sdbx_apikey_…`
//   - client-side tokens: `live_…`           / `test_…`
// A key of the other environment is refused before it reaches Paddle, with a
// message the Super Admin can act on. (API keys made before Paddle added the
// prefixes carry neither marker; a live account may still use one.)

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Why these credentials cannot be used by this gateway, or null when they
 * can. `paddle_sandbox` takes sandbox credentials only. Live `paddle` refuses
 * sandbox credentials unless its own Sandbox Mode switch is on (then it is
 * left as it always was). Empty values are not judged here (a missing key is
 * reported where it is needed).
 */
export function paddleCredentialProblem(
  config: BillingProviderConfig,
  gateway: 'paddle' | 'paddle_sandbox',
): string | null {
  const apiKey = trimmed(config.api_key);
  const clientToken = trimmed(config.client_token);
  if (gateway === 'paddle_sandbox') {
    if (apiKey && !apiKey.includes('_sdbx')) {
      return 'Paddle sandbox: this API key is not a sandbox key (sandbox keys contain "_sdbx"). Create one in sandbox-vendors.paddle.com → Developer tools → Authentication.';
    }
    if (clientToken && !clientToken.startsWith('test_')) {
      return 'Paddle sandbox: this client-side token is not a sandbox token (sandbox tokens start with "test_"). Create one in sandbox-vendors.paddle.com → Developer tools → Authentication.';
    }
    return null;
  }
  if (isPaddleSandboxFlag(config.sandbox)) return null;
  if (apiKey.includes('_sdbx')) {
    return 'Paddle: this is a sandbox API key ("_sdbx"). Use the "Paddle — Sandbox (test)" gateway for sandbox keys, or switch Sandbox Mode on.';
  }
  if (clientToken.startsWith('test_')) {
    return 'Paddle: this is a sandbox client-side token ("test_"). Use the "Paddle — Sandbox (test)" gateway for sandbox tokens, or switch Sandbox Mode on.';
  }
  return null;
}

// --- Webhook signature verification -------------------------------------
//
// `rawBody` MUST be the exact bytes Paddle signed, decoded as utf-8.
// Re-serialising the JSON would change the signed material.

const PADDLE_TOLERANCE_SECONDS = 300; // 5 minutes, both directions

type PaddleSignatureHeader = { timestamp: number; signatures: string[] };

/** Parses `ts=...;h1=...;h1=...`, tolerating whitespace, unknown fields and ordering. */
export function parsePaddleSignatureHeader(header: string): PaddleSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 'ts') {
      if (timestamp !== null) return null; // ambiguous header
      if (!/^\d+$/.test(v)) return null;
      const parsed = Number(v);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      timestamp = parsed;
    } else if (k === 'h1') {
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

/** True when at least one `h1` matches and the timestamp is fresh. */
export function verifyPaddleSignature(
  secret: string,
  header: string,
  rawBody: string,
  nowMs: number = Date.now(),
): boolean {
  const parsed = parsePaddleSignatureHeader(header);
  if (!parsed) return false;
  const ageSeconds = Math.floor(nowMs / 1000) - parsed.timestamp;
  if (Math.abs(ageSeconds) > PADDLE_TOLERANCE_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}:${rawBody}`)
    .digest('hex');
  return parsed.signatures.some((sig) => timingSafeHexEqual(expected, sig));
}

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

  supportedCurrencies: PADDLE_CURRENCIES,

  /**
   * Paddle Billing (API v2) transaction for exactly the amount being
   * collected: one non-catalog, one-time price of `metadata.amount` (lowest
   * denomination of `req.currency`), tax-INCLUSIVE (`tax_mode: internal`) so
   * the customer pays the plan price and Paddle, as merchant of record, takes
   * the tax out of it. `custom_data` carries workspace, intent and invoice.
   *
   * Paddle Billing has no redirect checkout of its own: the browser opens the
   * transaction with Paddle.js (`clientCheckout`), which needs the client-side
   * token, and `checkout.url` must be on a domain approved in Paddle.
   */
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const credentialProblem = paddleCredentialProblem(config, 'paddle');
    if (credentialProblem) throw new Error(credentialProblem);
    const currency = requireSupportedCurrency('Paddle', req.currency, PADDLE_CURRENCIES);
    const amount = minorFromProvider(req.metadata?.amount);
    if (!amount) throw new Error('Paddle checkout needs a positive amount');
    const clientToken = typeof config.client_token === 'string' ? config.client_token.trim() : '';
    if (!clientToken) throw new Error('Paddle client-side token is not configured');

    const name = req.description || 'Subscription';
    const productId = typeof config.product_id === 'string' && config.product_id.trim() ? config.product_id.trim() : '';
    const customData: Record<string, string> = { workspace_id: req.workspaceId };
    if (req.intentId) customData.intent_id = req.intentId;
    if (req.invoiceId) customData.invoice_id = req.invoiceId;

    const data = await paddleApi(config, '/transactions', 'POST', {
      items: [{
        quantity: 1,
        price: {
          description: name,
          name,
          unit_price: { amount: String(amount), currency_code: currency },
          tax_mode: 'internal',
          ...(productId ? { product_id: productId } : { product: { name, tax_category: 'standard' } }),
        },
      }],
      currency_code: currency,
      collection_mode: 'automatic',
      custom_data: customData,
      // No `checkout.url`: Paddle accepts only an approved domain there
      // (`transaction_checkout_url_domain_is_not_approved`), and the payment
      // page opens this transaction with Paddle.js itself (`clientCheckout`),
      // returning to `successUrl` below. Paddle's own links (e-mails) use the
      // account's default payment link.
    });
    const error = readPaddleError(data);
    if (error !== null) throw new Error(error.detail || 'Paddle checkout failed');
    const txn = readPaddleTransaction(data);
    if (txn === null) throw new Error('Paddle checkout failed');
    return {
      // Our own payment page, never Paddle's default payment link.
      paymentUrl: withQuery(req.callbackUrl, `_ptxn=${encodeURIComponent(txn.id)}`),
      sessionId: txn.id,
      clientCheckout: {
        provider: 'paddle',
        transactionId: txn.id,
        clientToken,
        environment: isPaddleSandboxFlag(config.sandbox) ? 'sandbox' : 'production',
        // Paddle.js sends the customer back here once the payment completes;
        // `_ptxn` is the reference the return is verified against.
        successUrl: withQuery(req.callbackUrl, `_ptxn=${encodeURIComponent(txn.id)}`),
        ...(req.customerEmail ? { customerEmail: req.customerEmail } : {}),
      },
    };
  },

  /**
   * Server-to-server lookup of the transaction bound to the intent (`_ptxn`
   * is always the STORED transaction id). `paid` and `completed` both mean the
   * money was collected.
   */
  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
    const txnId = (params._ptxn || '').trim();
    if (!txnId) return { verified: false, providerRef: '', status: 'failed' };
    let body: unknown;
    try {
      body = await paddleApi(config, `/transactions/${encodeURIComponent(txnId)}`);
    } catch {
      return { verified: false, providerRef: txnId, status: 'pending' };
    }
    if (readPaddleError(body) !== null) return { verified: false, providerRef: txnId, status: 'pending' };
    const txn = asRecord(asRecord(body)?.data);
    const status = readString(txn, 'status');
    if (status === 'paid' || status === 'completed') {
      return { verified: true, providerRef: txnId, ...readPaddleTransactionTotal(txn), paymentId: txnId, status: 'paid' };
    }
    if (status === 'canceled') return { verified: false, providerRef: txnId, status: 'canceled' };
    // draft / ready / billed / past_due: the customer may still pay in the open checkout.
    return { verified: false, providerRef: txnId, status: 'pending' };
  },

  /**
   * Cancels a transaction nobody paid yet (`draft` / `ready`), which closes
   * its checkout. Paddle refuses this for a transaction that is already
   * billed, paid or completed.
   */
  async closeCheckout(config: BillingProviderConfig, transactionId: string): Promise<boolean> {
    const id = (transactionId || '').trim();
    if (!id) return false;
    const data: unknown = await paddleApi(config, `/transactions/${encodeURIComponent(id)}`, 'PATCH', { status: 'canceled' });
    return readPaddleError(data) === null && readPaddleTransaction(data) !== null;
  },

  async verifyWebhook(config: BillingProviderConfig, headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const sig = headers['paddle-signature'];
    const secret = typeof config.webhook_secret === 'string' ? config.webhook_secret : '';
    if (!sig || !secret) return null;

    // Paddle v2 signature: ts=...;h1=... — verified over the exact raw body,
    // constant-time, with a 5-minute freshness window.
    if (!verifyPaddleSignature(secret, sig, body)) {
      throw new Error('Invalid Paddle webhook signature');
    }

    const event = JSON.parse(body);
    const data = asRecord(event?.data);
    const customData = asRecord(data?.custom_data);
    const eventType = typeof event?.event_type === 'string' ? event.event_type : '';
    const base = {
      providerEventId: event.event_id,
      workspaceId: readString(customData, 'workspace_id'),
      intentId: readString(customData, 'intent_id'),
      raw: event,
    };

    // `paid` arrives first, `completed` once Paddle finished processing; either
    // settles the intent (the second is an idempotent no-op).
    if (eventType === 'transaction.paid' || eventType === 'transaction.completed') {
      return {
        ...base,
        type: 'payment_succeeded',
        providerRef: readString(data, 'id'),
        providerPaymentId: readString(data, 'id'),
        providerCustomerId: readString(data, 'customer_id'),
        providerSubscriptionId: readString(data, 'subscription_id'),
        ...readPaddleTransactionTotal(data),
      };
    }

    // A refund is an adjustment with action `refund`; it moves money only once
    // approved (it is created as `pending_approval`). Both `adjustment.created`
    // and `adjustment.updated` can report the same approved adjustment, each
    // under its own event id: the event is keyed by the adjustment instead, so
    // the second notification is a replay, and the refund is counted once per
    // adjustment id (refunds.ts).
    if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
      const adjustmentId = readString(data, 'id');
      if (readString(data, 'action') !== 'refund' || readString(data, 'status') !== 'approved' || !adjustmentId) {
        return { ...base, type: 'ignored' };
      }
      return {
        ...base,
        providerEventId: `adjustment_${adjustmentId}_approved`,
        type: 'refund_processed',
        refundId: adjustmentId,
        providerPaymentId: readString(data, 'transaction_id'),
        amount: minorFromProvider(asRecord(data?.totals)?.total),
        currency: normalizeCurrencyCode(data?.currency_code),
      };
    }

    // Subscriptions (legacy: this platform no longer creates them).
    const legacyMap: Record<string, WebhookEvent['type']> = {
      'subscription.created': 'subscription_created',
      'subscription.updated': 'subscription_updated',
      'subscription.canceled': 'subscription_canceled',
    };
    const mapped = legacyMap[eventType];
    // Includes transaction.payment_failed: the checkout stays open and the
    // customer can retry, so a declined attempt fails nothing here.
    if (!mapped) return { ...base, type: 'ignored' };
    return {
      ...base,
      type: mapped,
      providerSubscriptionId: readString(data, 'id'),
      providerCustomerId: readString(data, 'customer_id'),
    };
  },

  async cancelSubscription(config: BillingProviderConfig, subscriptionId: string) {
    const data: unknown = await paddleApi(config, `/subscriptions/${subscriptionId}/cancel`, 'POST', {
      effective_from: 'next_billing_period',
    });
    if (data === null || data === undefined) {
      // Preserves the previous runtime behaviour exactly: reading `.error` off a
      // null/undefined JSON body threw a TypeError, surfaced by the caller as 500.
      throw new TypeError("Cannot read properties of null (reading 'error')");
    }
    // Same truthiness semantics as the previous `!data.error` check.
    return { success: readPaddleError(data) === null };
  },

  async getPortalUrl(_config: BillingProviderConfig, _customerId: string, returnUrl: string) {
    // Paddle customer portal URLs are managed via Paddle dashboard
    return { url: returnUrl };
  },

  validateConfig(config: BillingProviderConfig) {
    return paddleCredentialProblem(config, 'paddle');
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    const credentialProblem = paddleCredentialProblem(config, 'paddle');
    if (credentialProblem) return { success: false, latencyMs: 0, error: credentialProblem };
    try {
      const data = await paddleApi(config, '/event-types');
      const error = readPaddleError(data);
      if (error !== null) return { success: false, latencyMs: Date.now() - start, error: error.detail };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
