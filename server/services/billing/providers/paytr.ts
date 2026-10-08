import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import { minorToMajorString, requireSupportedCurrency } from './minorAmount.js';
import crypto from 'crypto';

// Local, PayTR-specific parsers for the get-token response only.
// They do not touch hashing, callback verification or amount handling.
export function readPayTrRecord(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) {
    // Preserve previous runtime behaviour: property access on a nullish body threw.
    throw new TypeError("Cannot read properties of null (reading 'status')");
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

export function readPayTrCreateStatus(body: Record<string, unknown>): string | undefined {
  const status = body.status;
  return typeof status === 'string' ? status : undefined;
}

export function readPayTrCreateToken(body: Record<string, unknown>): string | undefined {
  const token = body.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

export function readPayTrCreateError(body: Record<string, unknown>): string | undefined {
  const reason = body.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

// --- Callback hash verification -----------------------------------------
//
// The hash string, algorithm and field order are unchanged; only the
// comparison is hardened (constant-time, length-checked, malformed rejected).

/** Length-checked constant-time base64 comparison. */
export function timingSafeBase64Equal(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return false; // malformed hash
  const bufA = Buffer.from(a, 'base64');
  const bufB = Buffer.from(b, 'base64');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Currencies PayTR's iFrame API charges (`currency`: TL, USD, EUR, GBP). */
export const PAYTR_CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'] as const;

/** PayTR spells Turkish lira `TL`; every other code is ISO. */
function paytrCurrencyParam(code: string): string {
  return code === 'TRY' ? 'TL' : code;
}

/**
 * PayTR order ids must be alphanumeric: the workspace id without its hyphens,
 * then the timestamp. `workspaceIdFromPaytrOid` reverses it.
 */
export function paytrMerchantOid(workspaceId: string, now: number = Date.now()): string {
  return `${workspaceId.replace(/[^A-Za-z0-9]/g, '')}${now}`;
}

/** The workspace an order id belongs to (also reads the older `<workspace>_<ts>` form). */
export function workspaceIdFromPaytrOid(oid: string): string | undefined {
  if (oid.includes('_')) return oid.split('_')[0] || undefined;
  const hex = /^([0-9a-f]{32})\d+$/i.exec(oid)?.[1]?.toLowerCase();
  if (!hex) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const paytrProvider: BillingProviderHandler = {
  name: 'paytr',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: true, multiCurrency: true, trialSupport: false,
  },
  supportedCurrencies: PAYTR_CURRENCIES,
  fallbackCurrency: 'TRY',
  // PayTR re-sends a notification until the response body is exactly "OK".
  webhookAckBody: 'OK',

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const merchantId = config.merchant_id as string;
    const merchantKey = config.merchant_key as string;
    const merchantSalt = config.merchant_salt as string;
    // The amount is priced in `req.currency`; it is sent under that code only.
    const currency = paytrCurrencyParam(requireSupportedCurrency('PayTR', req.currency, PAYTR_CURRENCIES));
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const orderId = paytrMerchantOid(req.workspaceId);
    const userIp = req.metadata?.ip || '127.0.0.1';
    const email = req.customerEmail || 'user@example.com';
    // Installments exist for lira cards only.
    const noInstallment = currency === 'TL' ? '0' : '1';
    const maxInstallment = currency === 'TL' ? '12' : '0';
    const testMode = config.sandbox ? '1' : '0';

    // `payment_amount` is the minor unit (kuruş / cent); a basket line price is decimal.
    const basketJson = Buffer.from(JSON.stringify([[`Plan ${req.planId}`, minorToMajorString(amount), 1]])).toString('base64');
    // PayTR iFrame API token: HMAC-SHA256(merchant_key) over merchant_id, user_ip,
    // merchant_oid, email, payment_amount, user_basket, no_installment,
    // max_installment, currency, test_mode — then merchant_salt.
    const hashStr = `${merchantId}${userIp}${orderId}${email}${amount}${basketJson}${noInstallment}${maxInstallment}${currency}${testMode}${merchantSalt}`;
    const token = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');

    const params = new URLSearchParams();
    params.set('merchant_id', merchantId);
    params.set('user_ip', userIp);
    params.set('merchant_oid', orderId);
    params.set('email', email);
    params.set('payment_amount', String(amount));
    params.set('paytr_token', token);
    params.set('user_basket', basketJson);
    params.set('debug_on', config.sandbox ? '1' : '0');
    params.set('no_installment', noInstallment);
    params.set('max_installment', maxInstallment);
    params.set('currency', currency);
    params.set('test_mode', testMode);
    params.set('merchant_ok_url', req.callbackUrl);
    params.set('merchant_fail_url', req.callbackUrl);
    params.set('user_name', req.customerName || 'User');
    params.set('user_phone', req.metadata?.phone || '');
    params.set('user_address', 'Turkey');

    const res = await fetch('https://www.paytr.com/odeme/api/get-token', {
      method: 'POST',
      body: params,
    });
    const data = await res.json();
    const record = readPayTrRecord(data);
    if (readPayTrCreateStatus(record) !== 'success') {
      throw new Error(readPayTrCreateError(record) || 'PayTR token failed');
    }
    const iframeToken = readPayTrCreateToken(record);
    if (!iframeToken) throw new Error('PayTR token failed');
    return {
      paymentUrl: `https://www.paytr.com/odeme/guvenli/${iframeToken}`,
      sessionId: iframeToken,
    };
  },

  async verifyWebhook(config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const params = new URLSearchParams(body);
    const hash = params.get('hash');
    const merchantOid = params.get('merchant_oid') || '';
    const status = params.get('status');
    const totalAmount = params.get('total_amount') || '0';

    // Verify hash
    const merchantKey = typeof config.merchant_key === 'string' ? config.merchant_key : '';
    const merchantSalt = typeof config.merchant_salt === 'string' ? config.merchant_salt : '';
    // Fail-closed on missing credentials, missing hash or missing order id.
    if (!merchantKey || !merchantSalt || !hash || !merchantOid) return null;
    const hashStr = `${merchantOid}${merchantSalt}${status}${totalAmount}`;
    const expected = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');
    if (!timingSafeBase64Equal(expected, hash)) throw new Error('Invalid PayTR webhook hash');

    const currency = (params.get('currency') || 'TL').toUpperCase();
    return {
      type: status === 'success' ? 'payment_succeeded' : 'payment_failed',
      providerEventId: merchantOid,
      providerPaymentId: merchantOid,
      workspaceId: workspaceIdFromPaytrOid(merchantOid),
      // `total_amount` is in minor units of the order's currency.
      amount: parseInt(totalAmount),
      currency: currency === 'TL' ? 'TRY' : currency,
      raw: Object.fromEntries(params),
    };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // PayTR doesn't have a health endpoint; validate credentials format
      if (!config.merchant_id || !config.merchant_key || !config.merchant_salt) {
        return { success: false, latencyMs: Date.now() - start, error: 'Missing required credentials' };
      }
      // Try a minimal token request
      const res = await fetch('https://www.paytr.com/odeme/api/get-token', { method: 'POST', body: new URLSearchParams({ merchant_id: config.merchant_id as string }) });
      const data = await res.json();
      // Any response means endpoint is reachable
      const record = readPayTrRecord(data);
      const reason = readPayTrCreateError(record);
      if (readPayTrCreateStatus(record) === 'error' && reason?.includes('Üye işyeri')) {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid merchant credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
