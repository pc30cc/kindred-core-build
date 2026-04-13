import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

// SEP (Saman Electronic Payment / SamanKish) — Shaparak gateway
export const sepProvider: BillingProviderHandler = {
  name: 'sep_shaparak',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await fetch('https://sep.shaparak.ir/OnlinePG/OnlinePG', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'token',
        TerminalId: config.terminal_id,
        Amount: amount,
        ResNum: `${req.workspaceId}_${req.planId}_${Date.now()}`,
        RedirectUrl: req.callbackUrl,
        CellNumber: req.metadata?.phone,
      }),
    });
    const data = await res.json();
    if (data.status !== 1) throw new Error(`SEP error: ${data.errorDesc || data.status}`);
    return {
      paymentUrl: `https://sep.shaparak.ir/OnlinePG/SendToken?token=${data.token}`,
      sessionId: data.token,
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const res = await fetch('https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        RefNum: params.RefNum,
        TerminalNumber: config.terminal_id,
      }),
    });
    const data = await res.json();
    return {
      verified: data.ResultCode > 0,
      providerRef: params.RefNum || '',
      amount: data.TransactionDetail?.OrginalAmount,
      status: data.ResultCode > 0 ? 'success' : 'failed',
    };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    if (data.State === 'OK' && data.RefNum) {
      return { type: 'payment_succeeded', providerEventId: data.RefNum, providerPaymentId: data.RefNum, raw: data };
    }
    return null;
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const res = await fetch('https://sep.shaparak.ir/OnlinePG/OnlinePG', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'token', TerminalId: config.terminal_id,
          Amount: 10000, ResNum: 'test', RedirectUrl: 'https://test.localhost',
        }),
      });
      const data = await res.json();
      if (data.status === -1) return { success: false, latencyMs: Date.now() - start, error: 'Invalid terminal ID' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
