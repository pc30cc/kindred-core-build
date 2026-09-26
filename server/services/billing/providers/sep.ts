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

// ── Verify-only readers ───────────────────────────────────────────────
/** Raw `ResultCode`, compared strictly (never coerced). */
function readSepVerifyResultCode(body: unknown): unknown {
  return readSepRecord(body).ResultCode;
}

/** Raw `Success` flag; only an explicit `false` vetoes a success code. */
function readSepVerifySuccess(body: unknown): unknown {
  return readSepRecord(body).Success;
}

/**
 * SEP VerifyTransaction result codes (Saman IPG contract):
 *    0  -> verified now (success)
 *    2  -> duplicate request: this RefNum was ALREADY verified
 *   <0  -> failure (-2 not found, -6 older than 30 min, -104/-105 terminal,
 *          -106 IP not allowed)
 * A duplicate is reported as `already_verified`, so the caller accepts it only
 * for the intent that itself consumed this RefNum, never for another one.
 */
function classifySepVerifyResult(body: unknown): 'success' | 'already_verified' | 'failed' {
  const code = readSepVerifyResultCode(body);
  if (readSepVerifySuccess(body) === false && code !== 2) return 'failed';
  if (code === 0) return 'success';
  if (code === 2) return 'already_verified';
  return 'failed';
}

/** `TransactionDetail` only when it is a plain object. */
function readSepTransactionDetail(body: unknown): Record<string, unknown> | undefined {
  const detail = readSepRecord(body).TransactionDetail;
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined;
  return detail as Record<string, unknown>;
}

/**
 * `TransactionDetail.OrginalAmount` (provider's own spelling) as the `amount?: number`
 * the interface declares. No parsing, rounding or currency conversion is applied.
 */
function readSepOriginalAmount(body: unknown): number | undefined {
  const amount = readSepTransactionDetail(body)?.OrginalAmount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : undefined;
}

// SEP (Saman Electronic Payment / SamanKish) — Shaparak gateway
export const sepProvider: BillingProviderHandler = {
  name: 'sep_shaparak',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
  // set server-side from `billing_payment_intents.amount_irr`. SEP's API
  // expects amounts in Rial, so no conversion is needed here.
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
    const data: unknown = await res.json();
    const outcome = classifySepVerifyResult(data);
    return {
      verified: outcome !== 'failed',
      providerRef: params.RefNum || '',
      // Gateway-reported original amount (Rial): the caller compares it with
      // the intent amount, which is what ties this RefNum to the checkout.
      amount: readSepOriginalAmount(data),
      status: outcome,
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
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
