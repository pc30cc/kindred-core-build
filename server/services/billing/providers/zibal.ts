import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

export const zibalProvider: BillingProviderHandler = {
  name: 'zibal',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await fetch('https://gateway.zibal.ir/v1/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant: config.merchant,
        amount,
        callbackUrl: req.callbackUrl,
        description: `Plan ${req.planId}`,
        orderId: `${req.workspaceId}_${req.planId}_${Date.now()}`,
        mobile: req.metadata?.phone,
        ...(config.lazy_mode ? { multiplexingInfos: [] } : {}),
      }),
    });
    const data = await res.json();
    if (data.result !== 100) throw new Error(`Zibal error: ${data.message || data.result}`);
    return {
      paymentUrl: `https://gateway.zibal.ir/start/${data.trackId}`,
      sessionId: String(data.trackId),
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const res = await fetch('https://gateway.zibal.ir/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant: config.merchant,
        trackId: params.trackId,
      }),
    });
    const data = await res.json();
    return {
      verified: data.result === 100,
      providerRef: String(data.refNumber || params.trackId),
      amount: data.amount,
      status: data.result === 100 ? 'success' : 'failed',
    };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.success === '1' || data.status === '1') {
      return { type: 'payment_succeeded', providerEventId: data.trackId, providerPaymentId: data.trackId, raw: data };
    }
    return null;
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const res = await fetch('https://gateway.zibal.ir/v1/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchant: config.merchant, amount: 1000, callbackUrl: 'https://test.localhost' }),
      });
      const data = await res.json();
      if (data.result === 102 || data.result === 103) return { success: false, latencyMs: Date.now() - start, error: 'Invalid merchant' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
