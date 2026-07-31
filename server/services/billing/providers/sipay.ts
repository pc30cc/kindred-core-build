import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

// ─── Local response parsers (checkout/create path only) ───────────
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Preserves the previous truthiness check on `data.success`. */
function readSipaySuccess(body: unknown): boolean {
  const record = asRecord(body);
  if (record === null) return false;
  return Boolean(record.success);
}

/** Error message from `data.message`, only when it is a string. */
function readSipayError(body: unknown): string | null {
  const record = asRecord(body);
  if (record === null) return null;
  return typeof record.message === 'string' && record.message.length > 0 ? record.message : null;
}

/** Payment URL, preserving the existing `paymentUrl || url_3d` precedence. */
function readSipayCheckoutUrl(body: unknown): string | null {
  const record = asRecord(body);
  if (record === null) return null;
  if (typeof record.paymentUrl === 'string' && record.paymentUrl.length > 0) return record.paymentUrl;
  if (typeof record.url_3d === 'string' && record.url_3d.length > 0) return record.url_3d;
  return null;
}

// ─── Local response parsers (refund path only) ────────────────────
/** Raw `data.status_code` for refunds; compared strictly against '100' as before. */
function readSipayRefundStatusCode(body: unknown): string | number | undefined {
  const record = asRecord(body);
  if (record === null) return undefined;
  const value = record.status_code;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

/** `data.refund_id`, narrowed to the declared `string | undefined` return shape. */
function readSipayRefundId(body: unknown): string | undefined {
  const record = asRecord(body);
  if (record === null) return undefined;
  const value = record.refund_id;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  return undefined;
}

export const sipayProvider: BillingProviderHandler = {
  name: 'sipay',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = req.metadata?.amount || '0';
    const orderId = `${req.workspaceId}_${Date.now()}`;
    const hashKey = crypto.createHmac('sha256', config.app_secret as string)
      .update(`${config.merchant_key}${amount}TRY${orderId}`)
      .digest('base64');

    const res = await fetch('https://app.sipay.com.tr/ccpayment/api/paySmart3D', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_key: config.merchant_key,
        app_key: config.app_key,
        hash_key: hashKey,
        invoice_id: orderId,
        total: amount,
        currency: 'TRY',
        return_url: req.callbackUrl,
        cancel_url: req.callbackUrl,
        bill_email: req.customerEmail,
        bill_fname: req.customerName || 'User',
        bill_lname: 'User',
        items: JSON.stringify([{ name: `Plan ${req.planId}`, price: amount, quantity: 1 }]),
      }),
    });
    const data = await res.json();
    if (data === null || data === undefined) {
      throw new TypeError("Cannot read properties of null (reading 'success')");
    }
    if (!readSipaySuccess(data)) throw new Error(readSipayError(data) || 'Sipay checkout failed');
    const paymentUrl = readSipayCheckoutUrl(data);
    if (paymentUrl === null) throw new Error('Sipay checkout failed');
    return { paymentUrl, sessionId: orderId };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.status_code === '100' || data.status === 'success') {
      return {
        type: 'payment_succeeded',
        providerEventId: data.invoice_id || data.order_id,
        providerPaymentId: data.invoice_id,
        amount: parseFloat(data.total || '0') * 100,
        currency: 'TRY',
        raw: data,
      };
    }
    return null;
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const hashKey = crypto.createHmac('sha256', config.app_secret as string)
      .update(`${config.merchant_key}${paymentId}`)
      .digest('base64');
    const res = await fetch('https://app.sipay.com.tr/ccpayment/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_key: config.merchant_key,
        hash_key: hashKey,
        invoice_id: paymentId,
        refund_amount: amount ? (amount / 100).toFixed(2) : undefined,
      }),
    });
    const data = await res.json();
    if (data === null || data === undefined) {
      throw new TypeError("Cannot read properties of null (reading 'status_code')");
    }
    return { success: readSipayRefundStatusCode(data) === '100', refundId: readSipayRefundId(data) };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      if (!config.merchant_key || !config.app_key || !config.app_secret) {
        return { success: false, latencyMs: Date.now() - start, error: 'Missing credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
