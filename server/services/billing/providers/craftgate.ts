import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import crypto from 'crypto';

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
    if (data.errors) throw new Error(data.errors.errorDescription || 'Craftgate checkout failed');
    return { paymentUrl: data.data?.pageUrl, sessionId: data.data?.token };
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
    return { success: !data.errors, refundId: data.data?.id?.toString() };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const path = '/payment/v1/installments';
      const res = await fetch(`${baseUrl(config)}${path}?binNumber=454360`, {
        headers: craftgateHeaders(config, path),
      });
      const data = await res.json();
      if (data.errors?.errorGroup === 'NOT_AUTHENTICATED') {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid credentials' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
