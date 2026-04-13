import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://api.idpay.ir/v1.1' : 'https://api.idpay.ir/v1.1';

export const idpayProvider: BillingProviderHandler = {
  name: 'idpay',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await fetch(`${baseUrl(config)}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.api_key as string,
        'X-SANDBOX': config.sandbox ? '1' : '0',
      },
      body: JSON.stringify({
        order_id: `${req.workspaceId}_${req.planId}_${Date.now()}`,
        amount,
        callback: req.callbackUrl,
        desc: `Plan ${req.planId}`,
        mail: req.customerEmail,
        name: req.customerName,
      }),
    });
    const data = await res.json();
    if (data.error_code) throw new Error(data.error_message || `IDPay error: ${data.error_code}`);
    return { paymentUrl: data.link, sessionId: data.id };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const res = await fetch(`${baseUrl(config)}/payment/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.api_key as string,
        'X-SANDBOX': config.sandbox ? '1' : '0',
      },
      body: JSON.stringify({ id: params.id, order_id: params.order_id }),
    });
    const data = await res.json();
    return {
      verified: data.status === 100 || data.status === 101,
      providerRef: String(data.track_id || ''),
      amount: data.amount,
      status: data.status === 100 ? 'success' : 'failed',
    };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.status && parseInt(data.status) >= 100) {
      return {
        type: 'payment_succeeded',
        providerEventId: data.id,
        providerPaymentId: data.track_id?.toString(),
        workspaceId: data.order_id?.split('_')[0],
        amount: data.amount,
        currency: 'IRR',
        raw: data,
      };
    }
    return null;
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // IDPay doesn't have a dedicated test endpoint; we check auth by making a minimal call
      const res = await fetch(`${baseUrl(config)}/payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': config.api_key as string,
          'X-SANDBOX': config.sandbox ? '1' : '0',
        },
        body: JSON.stringify({ order_id: 'test', amount: 1000, callback: 'https://test.localhost' }),
      });
      const data = await res.json();
      // Error 11 = user blocked, 12 = API key not found — auth errors
      if (data.error_code === 12 || data.error_code === 11) {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid API key' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
