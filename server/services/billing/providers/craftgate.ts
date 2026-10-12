import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import { majorToMinor, minorToMajorString, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';
import { isSettingOn, missingSettings, providerFetch, settingText } from './providerHttp.js';
import crypto from 'crypto';

// --- Local runtime narrowing for Craftgate JSON bodies (no shared helper, no casts) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Craftgate error envelope: `{ errors: { errorCode, errorDescription, errorGroup } }`.
 * Returns null when the body carries no `errors` object (i.e. not an error response).
 */
function readCraftgateError(body: unknown): { errorDescription: string | null; errorGroup: string | null } | null {
  const root = asRecord(body);
  if (root === null) return null;
  const errors = asRecord(root.errors);
  if (errors === null) return null;
  const description = errors.errorDescription;
  const group = errors.errorGroup;
  return {
    errorDescription: typeof description === 'string' ? description : null,
    errorGroup: typeof group === 'string' ? group : null,
  };
}

/** Checkout init success envelope: only `data.pageUrl` and `data.token` are consumed. */
function readCraftgateCheckoutInit(body: unknown): { pageUrl: string; token: string } | null {
  const root = asRecord(body);
  if (root === null) return null;
  const data = asRecord(root.data);
  if (data === null) return null;
  const { pageUrl, token } = data;
  if (typeof pageUrl !== 'string' || pageUrl.length === 0) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  return { pageUrl, token };
}

/** Refund success envelope: only `data.id` is consumed (Craftgate returns it as a number). */
function readCraftgateRefundId(body: unknown): string | undefined {
  const root = asRecord(body);
  if (root === null) return undefined;
  const data = asRecord(root.data);
  if (data === null) return undefined;
  const id = data.id;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return id.toString();
  return undefined;
}

const baseUrl = (config: BillingProviderConfig) =>
  isSettingOn(config.sandbox) ? 'https://sandbox-api.craftgate.io' : 'https://api.craftgate.io';

/**
 * Craftgate's request signature (as its official craftgate-node-client signs):
 * base64(SHA-256(fullUrl + apiKey + secretKey + randomKey + body)), with
 * `x-auth-version: 1`. The earlier HMAC over path + body + randomKey with
 * `x-auth-version: v1` was refused as unauthenticated.
 */
export function craftgateHeaders(
  config: BillingProviderConfig,
  fullUrl: string,
  body?: string,
  randomKey: string = crypto.randomBytes(8).toString('hex'),
): Record<string, string> {
  const apiKey = settingText(config.api_key);
  const hashStr = [fullUrl, apiKey, settingText(config.secret_key), randomKey, body || ''].join('');
  const signature = crypto.createHash('sha256').update(hashStr).digest('base64');
  return {
    'x-auth-version': '1',
    'x-rnd-key': randomKey,
    'x-api-key': apiKey,
    'x-signature': signature,
    'Content-Type': 'application/json',
  };
}

/** What stops Craftgate from taking a payment with these settings, or null. */
export function craftgateSettingsProblem(config: BillingProviderConfig | null | undefined): string | null {
  return missingSettings('Craftgate', config, [['api_key', 'API Key'], ['secret_key', 'Secret Key']]);
}

/** Test Modu on (read strictly): sandbox-api.craftgate.io. */
export function craftgateTestMode(config: BillingProviderConfig | null | undefined): boolean {
  return isSettingOn(config?.sandbox);
}

/** Currencies Craftgate's checkout charges (`currency`). */
export const CRAFTGATE_CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'] as const;

export const craftgateProvider: BillingProviderHandler = {
  name: 'craftgate',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: false,
  },
  supportedCurrencies: CRAFTGATE_CURRENCIES,
  fallbackCurrency: 'TRY',

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    // The amount is priced in `req.currency`; it is sent under that code only.
    const currency = requireSupportedCurrency('Craftgate', req.currency, CRAFTGATE_CURRENCIES);
    // `metadata.amount` is in minor units (kuruş / cents); this API takes a decimal amount.
    const amount = Number(minorToMajorString(req.metadata?.amount));
    const orderId = `${req.workspaceId}_${Date.now()}`;
    const path = '/payment/v1/checkout-payments/init';
    const bodyObj = {
      price: amount,
      paidPrice: amount,
      currency,
      // Craftgate's PaymentGroup is PRODUCT or LISTING_OR_SUBSCRIPTION ('SUBSCRIPTION_PAYMENT' was refused).
      paymentGroup: 'LISTING_OR_SUBSCRIPTION',
      conversationId: orderId,
      callbackUrl: req.callbackUrl,
      items: [{ name: `Plan ${req.planId}`, price: amount }],
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await providerFetch('Craftgate', `${baseUrl(config)}${path}`, {
      method: 'POST',
      headers: craftgateHeaders(config, `${baseUrl(config)}${path}`, bodyStr),
      body: bodyStr,
    });
    const data = await res.json();
    const errors = readCraftgateError(data);
    if (errors !== null) throw new Error(errors.errorDescription || 'Craftgate checkout failed');
    const init = readCraftgateCheckoutInit(data);
    if (init === null) throw new Error('Craftgate checkout failed');
    return { paymentUrl: init.pageUrl, sessionId: init.token };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.paymentStatus === 'SUCCESS') {
      return {
        type: 'payment_succeeded',
        providerEventId: data.paymentId?.toString() || data.conversationId,
        providerPaymentId: data.paymentId?.toString(),
        amount: majorToMinor(data.paidPrice) ?? 0,
        currency: normalizeCurrencyCode(data.currency) || 'TRY',
        raw: data,
      };
    }
    return null;
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const path = '/payment/v1/refund-payments';
    const bodyObj: { paymentId: number; refundPrice?: number } = { paymentId: parseInt(paymentId) };
    if (amount) bodyObj.refundPrice = amount / 100;
    const bodyStr = JSON.stringify(bodyObj);

    const res = await providerFetch('Craftgate', `${baseUrl(config)}${path}`, {
      method: 'POST',
      headers: craftgateHeaders(config, `${baseUrl(config)}${path}`, bodyStr),
      body: bodyStr,
    });
    const data = await res.json();
    const errors = readCraftgateError(data);
    return { success: errors === null, refundId: readCraftgateRefundId(data) };
  },

  /** A signed installment lookup: success only when Craftgate answers without errors. */
  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    const problem = craftgateSettingsProblem(config);
    if (problem) return { success: false, latencyMs: 0, error: problem };
    try {
      const url = `${baseUrl(config)}/installment/v1/installments?binNumber=487074&price=100`;
      const res = await providerFetch('Craftgate', url, { headers: craftgateHeaders(config, url) });
      const data = await res.json();
      const errors = readCraftgateError(data);
      if (errors === null && res.ok !== false) return { success: true, latencyMs: Date.now() - start };
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: `Craftgate: ${errors?.errorDescription || (errors?.errorGroup === 'NOT_AUTHENTICATED' ? 'invalid credentials' : `HTTP ${res.status}`)}`,
      };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
