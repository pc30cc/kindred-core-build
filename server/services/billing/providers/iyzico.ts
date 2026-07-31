import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

// ── Local, iyzico-scoped JSON readers (Create + testConnection only) ──
/** Narrows the response envelope. Nullish bodies keep the previous TypeError behaviour. */
function asIyzicoRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${String(value)} (reading 'status')`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `status` only when it is a string; no casing or trimming changes. */
function readIyzicoStatus(body: unknown): string | undefined {
  const status = asIyzicoRecord(body)?.status;
  return typeof status === 'string' ? status : undefined;
}

/** `errorMessage` only when it is a non-empty string. */
function readIyzicoErrorMessage(body: unknown): string | undefined {
  const message = asIyzicoRecord(body)?.errorMessage;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** `paymentPageUrl` only when it is a non-empty string. */
function readIyzicoCheckoutUrl(body: unknown): string | undefined {
  const url = asIyzicoRecord(body)?.paymentPageUrl;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

/** `token` only when it is a non-empty string. */
function readIyzicoToken(body: unknown): string | undefined {
  const token = asIyzicoRecord(body)?.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** `errorCode` only when it is a string, matching the existing `'1000'` comparison. */
function readIyzicoErrorCode(body: unknown): string | undefined {
  const code = asIyzicoRecord(body)?.errorCode;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Refund only: `paymentTransactionId` as the `refundId?: string` the interface declares.
 * Strings pass through unchanged (including empty, preserving prior runtime); a finite
 * number becomes the string of that same number; anything else is `undefined`.
 */
function readIyzicoRefundTransactionId(body: unknown): string | undefined {
  const id = asIyzicoRecord(body)?.paymentTransactionId;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return `${id}`;
  return undefined;
}

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://sandbox-api.iyzipay.com' : (config.base_url as string || 'https://api.iyzipay.com');

function iyzicoAuth(config: BillingProviderConfig, uri: string, body: string): Record<string, string> {
  const randomStr = Date.now().toString();
  const hashStr = config.secret_key + randomStr;
  const hash = crypto.createHmac('sha256', config.secret_key as string).update(hashStr + body).digest('base64');
  const authStr = `IYZWS ${config.api_key}:${hash}`;
  return {
    'Authorization': authStr,
    'x-iyzi-rnd': randomStr,
    'Content-Type': 'application/json',
  };
}

export const iyzicoProvider: BillingProviderHandler = {
  name: 'iyzico',
  capabilities: {
    subscriptions: true, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = req.metadata?.amount || '0';
    const body = JSON.stringify({
      locale: 'tr',
      conversationId: `${req.workspaceId}_${Date.now()}`,
      price: amount,
      paidPrice: amount,
      currency: 'TRY',
      basketId: `${req.workspaceId}_${req.planId}`,
      paymentGroup: 'SUBSCRIPTION',
      callbackUrl: req.callbackUrl,
      enabledInstallments: [1, 2, 3, 6, 9],
      buyer: {
        id: req.workspaceId,
        name: req.customerName || 'User',
        surname: 'User',
        email: req.customerEmail || 'user@example.com',
        identityNumber: '11111111111',
        registrationAddress: 'Istanbul, Turkey',
        city: 'Istanbul',
        country: 'Turkey',
        ip: '127.0.0.1',
      },
      shippingAddress: { contactName: 'User', city: 'Istanbul', country: 'Turkey', address: 'Istanbul' },
      billingAddress: { contactName: 'User', city: 'Istanbul', country: 'Turkey', address: 'Istanbul' },
      basketItems: [{
        id: req.planId,
        name: `Plan ${req.planId}`,
        category1: 'Subscription',
        itemType: 'VIRTUAL',
        price: amount,
      }],
    });

    const res = await fetch(`${baseUrl(config)}/payment/iyzi-pos/checkoutform/initialize/auth/ecom`, {
      method: 'POST',
      headers: iyzicoAuth(config, '/payment/iyzi-pos/checkoutform/initialize/auth/ecom', body),
      body,
    });
    const data = await res.json();
    if (readIyzicoStatus(data) !== 'success') throw new Error(readIyzicoErrorMessage(data) || 'iyzico checkout failed');
    const paymentUrl = readIyzicoCheckoutUrl(data);
    const token = readIyzicoToken(data);
    if (!paymentUrl) throw new Error('iyzico checkout failed: missing paymentPageUrl');
    if (!token) throw new Error('iyzico checkout failed: missing token');
    return { paymentUrl, sessionId: token };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.status === 'SUCCESS' || data.paymentStatus === 'SUCCESS') {
      return {
        type: 'payment_succeeded',
        providerEventId: data.paymentId || data.token,
        providerPaymentId: data.paymentId,
        amount: parseFloat(data.paidPrice || '0') * 100,
        currency: 'TRY',
        raw: data,
      };
    }
    return null;
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const body = JSON.stringify({
      locale: 'tr',
      paymentTransactionId: paymentId,
      price: amount ? (amount / 100).toFixed(2) : '0',
      currency: 'TRY',
      ip: '127.0.0.1',
    });
    const res = await fetch(`${baseUrl(config)}/payment/refund`, {
      method: 'POST',
      headers: iyzicoAuth(config, '/payment/refund', body),
      body,
    });
    const data = await res.json();
    return { success: readIyzicoStatus(data) === 'success', refundId: readIyzicoRefundTransactionId(data) };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const body = JSON.stringify({ locale: 'tr', conversationId: 'test' });
      const res = await fetch(`${baseUrl(config)}/payment/bin/check`, {
        method: 'POST',
        headers: iyzicoAuth(config, '/payment/bin/check', body),
        body,
      });
      const data = await res.json();
      if (readIyzicoStatus(data) === 'failure' && readIyzicoErrorCode(data) === '1000') {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
