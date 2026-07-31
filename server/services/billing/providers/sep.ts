import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

// Local, SEP-specific readers for the token-request (create) and
// test-connection responses only. They do not model verify/webhook payloads and
// do not touch amounts, status mapping, currency or callback handling.
export function readSepRecord(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) {
    // Preserve previous runtime behaviour: property access on a nullish body threw.
    throw new TypeError("Cannot read properties of null (reading 'status')");
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

// Raw value: the success condition stays a strict `=== 1` numeric comparison.
export function readSepStatus(body: Record<string, unknown>): unknown {
  return body.status;
}

export function readSepErrorDescription(body: Record<string, unknown>): string | undefined {
  const desc = body.errorDesc;
  return typeof desc === 'string' && desc.length > 0 ? desc : undefined;
}

export function readSepToken(body: Record<string, unknown>): string | undefined {
  const token = body.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

// Keeps the previous `errorDesc || status` fallback, but never interpolates a
// non-primitive value into the message.
function describeSepFailure(body: Record<string, unknown>): string {
  const desc = readSepErrorDescription(body);
  if (desc) return desc;
  const status = readSepStatus(body);
  if (typeof status === 'string' || typeof status === 'number' || typeof status === 'boolean') {
    return String(status);
  }
  return 'unknown status';
}

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
    const body = readSepRecord(data);
    if (readSepStatus(body) !== 1) throw new Error(`SEP error: ${describeSepFailure(body)}`);
    const token = readSepToken(body);
    if (!token) throw new Error('SEP error: missing token in response');
    return {
      paymentUrl: `https://sep.shaparak.ir/OnlinePG/SendToken?token=${token}`,
      sessionId: token,
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
      const body = readSepRecord(data);
      if (readSepStatus(body) === -1) return { success: false, latencyMs: Date.now() - start, error: 'Invalid terminal ID' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
