import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
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
  config.sandbox ? 'https://sandbox-api.craftgate.io' : 'https://api.craftgate.io';

function craftgateHeaders(config: BillingProviderConfig, path: string, body?: string) {
  const randomStr = Date.now().toString();
  const hashStr = path + (body || '') + randomStr;
  const signature = crypto.createHmac('sha256', config.secret_key as string).update(hashStr).digest('base64');
  return {
    'x-auth-version': 'v1',
    'x-rnd-key': randomStr,
    'x-api-key': config.api_key as string,
    'x-signature': signature,
    'Content-Type': 'application/json',
  };
}

export const craftgateProvider: BillingProviderHandler = {
  name: 'craftgate',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: true, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseFloat(String(req.metadata?.amount || '0'));
    const orderId = `${req.workspaceId}_${Date.now()}`;
    const path = '/payment/v1/checkout-payments/init';
    const bodyObj = {
      price: amount,
      paidPrice: amount,
      currency: 'TRY',
      paymentGroup: 'SUBSCRIPTION_PAYMENT',
      conversationId: orderId,
      callbackUrl: req.callbackUrl,
      items: [{ name: `Plan ${req.planId}`, price: amount }],
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${baseUrl(config)}${path}`, {
      method: 'POST',
      headers: craftgateHeaders(config, path, bodyStr),
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
        amount: parseFloat(data.paidPrice || '0') * 100,
        currency: 'TRY',
        raw: data,
      };
    }
    return null;
  },

  async refundPayment(config: BillingProviderConfig, paymentId: string, amount?: number) {
    const path = '/payment/v1/refund-payments';
    const bodyObj: any = { paymentId: parseInt(paymentId) };
    if (amount) bodyObj.refundPrice = amount / 100;
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${baseUrl(config)}${path}`, {
      method: 'POST',
      headers: craftgateHeaders(config, path, bodyStr),
      body: bodyStr,
    });
    const data = await res.json();
    const errors = readCraftgateError(data);
    return { success: errors === null, refundId: readCraftgateRefundId(data) };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const path = '/payment/v1/installments';
      const res = await fetch(`${baseUrl(config)}${path}?binNumber=454360`, {
        headers: craftgateHeaders(config, path),
      });
      const data = await res.json();
      const errors = readCraftgateError(data);
      if (errors !== null && errors.errorGroup === 'NOT_AUTHENTICATED') {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
