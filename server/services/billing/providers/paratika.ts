import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import { majorToMinor, minorToMajorString, normalizeCurrencyCode, requireSupportedCurrency } from './minorAmount.js';

// ─── Local, minimal parsers (Create/session + testConnection only) ───
// Deliberately scoped: no shared billing helper, no verify/refund parsing.
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readParatikaResponseCode(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  return typeof record.responseCode === 'string' ? record.responseCode : undefined;
}

function readParatikaError(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  return typeof record.responseMsg === 'string' ? record.responseMsg : undefined;
}

function readParatikaSessionToken(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  return typeof record.sessionToken === 'string' ? record.sessionToken : undefined;
}

/**
 * Refund envelope: only `pgTranId` is consumed as the refund reference.
 * Paratika returns it as a string; a numeric value is rendered with an explicit
 * `.toString()` so the declared `refundId?: string` contract holds. Any other
 * type (object, boolean, null, missing) yields `undefined`, exactly as before.
 */
function readParatikaPgTranId(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const id = record.pgTranId;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return id.toString();
  return undefined;
}

/** Currencies Paratika's payment session charges (`CURRENCY`). */
export const PARATIKA_CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

export const paratikaProvider: BillingProviderHandler = {
  name: 'paratika',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: true, trialSupport: false,
  },
  supportedCurrencies: PARATIKA_CURRENCIES,
  fallbackCurrency: 'TRY',

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    // The amount is priced in `req.currency`; it is sent under that code only.
    const currency = requireSupportedCurrency('Paratika', req.currency, PARATIKA_CURRENCIES);
    // `metadata.amount` is in minor units (kuruş / cents); this API takes a decimal amount.
    const amount = minorToMajorString(req.metadata?.amount);
    const orderId = `${req.workspaceId}_${Date.now()}`;

    const params = new URLSearchParams();
    params.set('ACTION', 'SESSIONTOKEN');
    params.set('MERCHANTUSER', config.merchant_user as string);
    params.set('MERCHANTPASSWORD', config.merchant_password as string);
    params.set('MERCHANT', config.merchant_code as string);
    params.set('SESSIONTYPE', 'PAYMENTSESSION');
    params.set('RETURNURL', req.callbackUrl);
    params.set('AMOUNT', String(amount));
    params.set('CURRENCY', currency);
    params.set('MERCHANTPAYMENTID', orderId);
    params.set('CUSTOMER', req.customerEmail || '');

    const res = await fetch('https://entegrasyon.asseco-see.com.tr/fim/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (readParatikaResponseCode(data) !== '00') {
      throw new Error(readParatikaError(data) || 'Paratika session failed');
    }
    const sessionToken = readParatikaSessionToken(data);
    if (!sessionToken) throw new Error(readParatikaError(data) || 'Paratika session failed');
    return {
      paymentUrl: `https://entegrasyon.asseco-see.com.tr/fim/paymentPage?sessiontoken=${sessionToken}`,
      sessionId: sessionToken,
    };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.responseCode === '00') {
      return {
        type: 'payment_succeeded',
        providerEventId: data.pgTranId || data.merchantPaymentId,
        providerPaymentId: data.pgTranId,
        amount: majorToMinor(data.amount) ?? 0,
        currency: normalizeCurrencyCode(data.currency) || 'TRY',
        raw: data,
      };
    }
    return null;
  },

  /** `currency` must be the payment's own. Default TRY. */
  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number, currency?: string) {
    const params = new URLSearchParams();
    params.set('ACTION', 'REFUND');
    params.set('MERCHANTUSER', config.merchant_user as string);
    params.set('MERCHANTPASSWORD', config.merchant_password as string);
    params.set('MERCHANT', config.merchant_code as string);
    params.set('PGTRANID', paymentId);
    if (amount) params.set('AMOUNT', (amount / 100).toFixed(2));
    params.set('CURRENCY', normalizeCurrencyCode(currency) || 'TRY');

    const res = await fetch('https://entegrasyon.asseco-see.com.tr/fim/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    return { success: readParatikaResponseCode(data) === '00', refundId: readParatikaPgTranId(data) };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      if (!config.merchant_code || !config.merchant_user || !config.merchant_password) {
        return { success: false, latencyMs: Date.now() - start, error: 'Missing credentials' };
      }
      const params = new URLSearchParams();
      params.set('ACTION', 'SESSIONTOKEN');
      params.set('MERCHANTUSER', config.merchant_user as string);
      params.set('MERCHANTPASSWORD', config.merchant_password as string);
      params.set('MERCHANT', config.merchant_code as string);
      params.set('SESSIONTYPE', 'PAYMENTSESSION');
      params.set('RETURNURL', 'https://test.localhost');
      params.set('AMOUNT', '1.00');
      params.set('CURRENCY', 'TRY');

      const res = await fetch('https://entegrasyon.asseco-see.com.tr/fim/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const data = await res.json();
      if (readParatikaResponseCode(data) === '99') return { success: false, latencyMs: Date.now() - start, error: 'Auth failed' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
