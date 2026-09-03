import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

// ── Local, Zibal-scoped readers (no coercion, no fallbacks) ───────────
function readZibalRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** `result` only when it is a real number; never coerces '100' → 100. */
function readZibalResult(body: unknown): number | undefined {
  const rec = readZibalRecord(body);
  const value = rec?.result;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `message` only when it is a non-empty string. */
function readZibalMessage(body: unknown): string | undefined {
  const rec = readZibalRecord(body);
  const value = rec?.message;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `trackId` only from a non-empty string or a finite number. */
function readZibalTrackId(body: unknown): string | undefined {
  const rec = readZibalRecord(body);
  const value = rec?.trackId;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

// ── Verify-only readers (separate from Create/Test helpers) ───────────
/**
 * Narrows the verify envelope. Nullish bodies keep the previous TypeError
 * behaviour of reading `data.result` off null/undefined.
 */
function asZibalVerifyRecord(body: unknown): Record<string, unknown> | null {
  if (body === null || body === undefined) {
    throw new TypeError(`Cannot read properties of ${String(body)} (reading 'result')`);
  }
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** Raw `result`, kept unnarrowed so the existing `=== 100` check is unchanged. */
function readZibalVerifyResult(body: unknown): unknown {
  return asZibalVerifyRecord(body)?.result;
}

/** `refNumber` as a string when it is a non-empty string or a finite non-zero number. */
function readZibalRefNumber(body: unknown): string | undefined {
  const value = asZibalVerifyRecord(body)?.refNumber;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return `${value}`;
  return undefined;
}

/** `amount` only when it is a real number; other types become undefined. */
function readZibalVerifiedAmount(body: unknown): number | undefined {
  const value = asZibalVerifyRecord(body)?.amount;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export const zibalProvider: BillingProviderHandler = {
  name: 'zibal',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
  // set server-side from `billing_payment_intents.amount_irr`. Zibal's API
  // expects amounts in Rial, so no conversion is needed here.
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
    const result = readZibalResult(data);
    if (result !== 100) throw new Error(`Zibal error: ${readZibalMessage(data) || result}`);
    const trackId = readZibalTrackId(data);
    if (!trackId) throw new Error('Zibal error: missing trackId in gateway response');
    return {
      paymentUrl: `https://gateway.zibal.ir/start/${trackId}`,
      sessionId: trackId,
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
    const result = readZibalVerifyResult(data);
    return {
      verified: result === 100,
      providerRef: readZibalRefNumber(data) ?? (params.trackId ?? ''),
      amount: readZibalVerifiedAmount(data),
      status: result === 100 ? 'success' : 'failed',
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
      const result = readZibalResult(data);
      if (result === 102 || result === 103) return { success: false, latencyMs: Date.now() - start, error: 'Invalid merchant' };
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
