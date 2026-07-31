import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Returns the raw `code` value only when it is a number or a string; no coercion. */
function readNextPayCode(body: unknown): number | string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const code = record.code;
  if (typeof code === 'number' || typeof code === 'string') return code;
  return undefined;
}

/** Returns `trans_id` only when it is a non-empty string or a number. */
function readNextPayTransactionId(body: unknown): string | number | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const transId = record.trans_id;
  if (typeof transId === 'number') return transId;
  if (typeof transId === 'string' && transId.length > 0) return transId;
  return undefined;
}

/** Returns `Shaparak_Ref_Id` only when it is a string or a number; no coercion. */
function readNextPayShaparakRefId(body: unknown): string | number | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const refId = record.Shaparak_Ref_Id;
  if (typeof refId === 'number' || typeof refId === 'string') return refId;
  return undefined;
}

export const nextpayProvider: BillingProviderHandler = {
  name: 'nextpay',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await fetch('https://nextpay.org/nx/gateway/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.api_key,
        amount,
        order_id: `${req.workspaceId}_${req.planId}_${Date.now()}`,
        callback_uri: req.callbackUrl,
        customer_phone: req.metadata?.phone,
        payer_name: req.customerName,
      }),
    });
    const data = await res.json();
    const code = readNextPayCode(data);
    if (code !== -1) throw new Error(`NextPay error: code ${code}`);
    const transId = readNextPayTransactionId(data);
    if (transId === undefined) throw new Error('NextPay error: missing trans_id');
    return {
      paymentUrl: `https://nextpay.org/nx/gateway/payment/${transId}`,
      sessionId: typeof transId === 'string' ? transId : `${transId}`,
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const res = await fetch('https://nextpay.org/nx/gateway/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.api_key,
        trans_id: params.trans_id,
        amount: parseInt(params.amount || '0'),
      }),
    });
    const data = await res.json();
    if (data === null || data === undefined) {
      // Preserves the previous TypeError raised by property access on a nullish body.
      throw new TypeError(
        `Cannot read properties of ${data === null ? 'null' : 'undefined'} (reading 'code')`,
      );
    }
    const code = readNextPayCode(data);
    const refId = readNextPayShaparakRefId(data);
    return {
      verified: code === 0,
      providerRef: `${refId || params.trans_id}`,
      amount: parseInt(params.amount || '0'),
      status: code === 0 ? 'success' : 'failed',
    };
  },

  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    return {
      type: 'payment_succeeded',
      providerEventId: data.trans_id,
      providerPaymentId: data.trans_id,
      raw: data,
    };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const res = await fetch('https://nextpay.org/nx/gateway/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: config.api_key, amount: 1000, order_id: 'test', callback_uri: 'https://test.localhost' }),
      });
      const data = await res.json();
      if (readNextPayCode(data) === -2) return { success: false, latencyMs: Date.now() - start, error: 'Invalid API key' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
