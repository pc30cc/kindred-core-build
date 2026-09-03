import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

/**
 * PayPing `POST /v2/pay` success body: only `code` (the payment code) is consumed.
 * Narrowed with a local runtime guard — the response body is never cast.
 */
function readPaymentCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

export const paypingProvider: BillingProviderHandler = {
  name: 'payping',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
  // set server-side from `billing_payment_intents.amount_irr`. PayPing's API
  // is the one Iranian gateway in this file that bills in Toman, so it is the
  // only adapter that converts (IRR / 10) before sending the wire amount.
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amountIrr = parseInt(String(req.metadata?.amount || '0'));
    const res = await fetch('https://api.payping.ir/v2/pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.bearer_token}`,
      },
      body: JSON.stringify({
        amount: Math.round(amountIrr / 10), // PayPing bills in Toman
        returnUrl: req.callbackUrl,
        payerIdentity: req.customerEmail,
        payerName: req.customerName,
        description: `Plan ${req.planId}`,
        clientRefId: `${req.workspaceId}_${req.planId}`,
      }),
    });
    if (res.status === 200) {
      const data = await res.json();
      const code = readPaymentCode(data);
      if (code === null) {
        throw new Error('PayPing error: malformed response (missing payment code)');
      }
      return {
        paymentUrl: `https://api.payping.ir/v2/pay/gotoipg/${code}`,
        sessionId: code,
      };
    }
    const err = await res.text();
    throw new Error(`PayPing error: ${err}`);
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const res = await fetch('https://api.payping.ir/v2/pay/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.bearer_token}`,
      },
      body: JSON.stringify({
        refId: params.refid,
        amount: Math.round(parseInt(params.amount || '0') / 10),
      }),
    });
    return {
      verified: res.ok,
      providerRef: params.refid || '',
      amount: parseInt(params.amount || '0'),
      status: res.ok ? 'success' : 'failed',
    };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    return { type: 'payment_succeeded', providerEventId: data.refid || data.code, raw: data };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // Test auth with a failing payment request
      const res = await fetch('https://api.payping.ir/v2/pay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.bearer_token}`,
        },
        body: JSON.stringify({ amount: 100, returnUrl: 'https://test.localhost', description: 'test' }),
      });
      if (res.status === 401) return { success: false, latencyMs: Date.now() - start, error: 'Invalid token' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
