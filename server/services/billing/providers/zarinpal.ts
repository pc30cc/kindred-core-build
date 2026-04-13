import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://sandbox.zarinpal.com/pg/v4/payment' : 'https://api.zarinpal.com/pg/v4/payment';

const gatewayUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://sandbox.zarinpal.com/pg/StartPay' : 'https://www.zarinpal.com/pg/StartPay';

export const zarinpalProvider: BillingProviderHandler = {
  name: 'zarinpal',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const currency = (config.currency as string) || 'IRR';
    const res = await fetch(`${baseUrl(config)}/request.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: config.merchant_id,
        amount: currency === 'IRT' ? amount : amount, // amount in rials or tomans
        callback_url: req.callbackUrl,
        description: `Plan ${req.planId} for workspace ${req.workspaceId}`,
        metadata: { email: req.customerEmail, workspace_id: req.workspaceId, plan_id: req.planId },
        currency,
      }),
    });
    const data = await res.json();
    if (data.data?.code !== 100) throw new Error(data.errors?.message || `ZarinPal error code: ${data.data?.code}`);
    return {
      paymentUrl: `${gatewayUrl(config)}/${data.data.authority}`,
      authority: data.data.authority,
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const amount = parseInt(params.amount || '0');
    const res = await fetch(`${baseUrl(config)}/verify.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: config.merchant_id,
        authority: params.Authority || params.authority,
        amount,
      }),
    });
    const data = await res.json();
    const code = data.data?.code;
    return {
      verified: code === 100 || code === 101,
      providerRef: String(data.data?.ref_id || ''),
      amount,
      status: code === 100 ? 'success' : code === 101 ? 'already_verified' : 'failed',
    };
  },

  // ZarinPal uses callback-based verification, not webhooks
  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    // Parse callback params as webhook
    const params = JSON.parse(body);
    if (params.Status === 'OK') {
      return {
        type: 'payment_succeeded',
        providerEventId: params.Authority,
        providerPaymentId: params.Authority,
        workspaceId: params.workspace_id,
        raw: params,
      };
    }
    return null;
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // Test with a minimal request that will fail gracefully
      const res = await fetch(`${baseUrl(config)}/request.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchant_id: config.merchant_id,
          amount: 1000,
          callback_url: 'https://test.localhost/callback',
          description: 'Connection test',
        }),
      });
      const data = await res.json();
      // Code 100 = success, or any non-auth error means credentials work
      if (data.data?.code === 100 || data.data?.code === -9) {
        return { success: true, latencyMs: Date.now() - start };
      }
      // Auth errors
      if (data.errors?.code === -1 || data.errors?.code === -2) {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid merchant ID' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
