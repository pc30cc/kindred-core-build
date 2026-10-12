import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification, WebhookEvent } from '../types.js';
import { asRecord, errorText, missingSettings, probeCallbackUrl, providerFetch, readProviderJson, settingText } from './providerHttp.js';

// PayPing (api.payping.ir, REST v3; v2 is retired). Amounts are TOMAN in
// every PayPing service: the Rial amount is divided by 10, so it must be a
// whole number of Toman (a multiple of 10 Rial), or the payment is refused
// here rather than charged a few Rial off.
//
//   pay      POST /v3/pay {amount, returnUrl, clientRefId, payerIdentity?, payerName?, description}
//            → {paymentCode, url}
//   start    GET  /v3/pay/start/{paymentCode} (or the `url` answered)
//   callback POST returnUrl, form fields: status (1 = paid), errorCode, data (JSON:
//            {paymentCode, paymentRefId, clientRefId, amount, cardNumber, …});
//            the API's return hop flattens `data` into the page's query
//   verify   POST /v3/pay/verify {paymentRefId, paymentCode, amount} → 200 {amount, paymentRefId, …}
//            409 with metaData.code 110 = already verified; 202 / 502 = still settling
//
// An unverified payment is returned to the payer by PayPing after 10 minutes.

export const PAYPING_API = 'https://api.payping.ir/v3/pay';

/** v3 problem body: `metaData.code` and `metaData.errors[].message`, or a plain title. */
function readPayPingError(body: unknown): { code?: number; message?: string } {
  const record = asRecord(body);
  const meta = asRecord(record?.metaData);
  const code = typeof meta?.code === 'number' ? meta.code : undefined;
  const errors = Array.isArray(meta?.errors) ? meta.errors : [];
  const first = errors.map(asRecord).find((e) => typeof e?.message === 'string' && e.message);
  const message = (first?.message as string | undefined)
    ?? (typeof record?.detail === 'string' && record.detail ? record.detail : undefined)
    ?? (typeof record?.title === 'string' && record.title ? record.title : undefined);
  return { code, message };
}

/** `paymentCode` of a /v3/pay answer (v2 answered `code`). */
function readPaymentCode(body: unknown): string | null {
  const record = asRecord(body);
  const code = record?.paymentCode ?? record?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readTomanAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function headers(config: BillingProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settingText(config.bearer_token)}`,
  };
}

export function paypingSettingsProblem(config: BillingProviderConfig | null | undefined): string | null {
  return missingSettings('PayPing', config, [['bearer_token', 'Bearer token']]);
}

/** Whole Toman for a Rial amount, or an error when it is not a multiple of 10. */
export function paypingToman(amountIrr: number): number {
  if (!Number.isInteger(amountIrr) || amountIrr <= 0) throw new Error('PayPing error: the amount must be a positive whole number of Rial');
  if (amountIrr % 10 !== 0) {
    throw new Error(`PayPing error: PayPing charges whole Toman; ${amountIrr} Rial is not a multiple of 10`);
  }
  return amountIrr / 10;
}

export const paypingProvider: BillingProviderHandler = {
  name: 'payping',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
  // set server-side; PayPing bills in Toman, so it is the one Iranian adapter
  // here that converts (IRR / 10), and only an exact conversion is sent.
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amountIrr = parseInt(String(req.metadata?.amount || '0'));
    const res = await providerFetch('PayPing', PAYPING_API, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        amount: paypingToman(amountIrr),
        returnUrl: req.callbackUrl,
        ...(req.customerEmail ? { payerIdentity: req.customerEmail } : {}),
        ...(req.customerName ? { payerName: req.customerName } : {}),
        description: `Plan ${req.planId}`,
        clientRefId: req.intentId || `${req.workspaceId}_${req.planId}`,
      }),
    });
    const data = await readProviderJson('PayPing', res, 'create payment');
    if (!res.ok) {
      const error = readPayPingError(data);
      throw new Error(`PayPing error: HTTP ${res.status}${error.code ? ` (${error.code})` : ''}${error.message ? `: ${error.message}` : ''}`);
    }
    const code = readPaymentCode(data);
    if (code === null) throw new Error('PayPing error: malformed response (missing payment code)');
    const url = asRecord(data)?.url;
    return {
      paymentUrl: typeof url === 'string' && /^https:\/\//i.test(url) ? url : `${PAYPING_API}/start/${encodeURIComponent(code)}`,
      sessionId: code,
    };
  },

  /**
   * Verifies the STORED payment code (bound before the call) with the
   * callback's payment reference and the SERVER amount. PayPing refuses a
   * reference of another payment code or another amount. 409 code 110 = this
   * payment was verified before (a verify whose answer was lost).
   */
  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
    const paymentCode = (params.paymentCode || params.code || '').trim();
    const refId = (params.paymentRefId || params.refid || params.refId || '').trim();
    const amountIrr = parseInt(params.amount || '0');
    if (!paymentCode) return { verified: false, providerRef: '', status: 'failed' };
    // No payment reference: the payer cancelled or the bank declined (status 0).
    if (!/^\d+$/.test(refId)) return { verified: false, providerRef: paymentCode, status: params.status === '0' ? 'canceled' : 'failed' };
    const res = await providerFetch('PayPing', `${PAYPING_API}/verify`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ paymentRefId: Number(refId), paymentCode, amount: paypingToman(amountIrr) }),
    });
    const data = await readProviderJson('PayPing', res, 'verify payment');
    if (res.status === 200) {
      const toman = readTomanAmount(asRecord(data)?.amount);
      return {
        verified: true,
        providerRef: refId,
        amount: toman === undefined ? undefined : toman * 10,
        paymentId: refId,
        status: 'success',
      };
    }
    if (res.status === 409 && readPayPingError(data).code === 110) {
      const previous = asRecord(asRecord(asRecord(data)?.metaData)?.message);
      const toman = readTomanAmount(previous?.amount);
      return {
        verified: true,
        providerRef: refId,
        amount: toman === undefined ? undefined : toman * 10,
        paymentId: refId,
        status: 'already_verified',
      };
    }
    // 202 / 502: PayPing is still settling; 5xx: try again later. Nothing ends.
    if (res.status === 202 || res.status >= 500) return { verified: false, providerRef: paymentCode, status: 'pending' };
    // 4xx: refused (wrong reference, unpaid, rolled back after 10 minutes).
    return { verified: false, providerRef: paymentCode, status: 'failed' };
  },

  // No signed webhook: the route refuses unsigned providers. Kept for the interface.
  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    return { type: 'payment_succeeded', providerEventId: data.paymentRefId || data.refid || data.code, raw: data };
  },

  /** A real payment request (never paid). Success only when PayPing answers a payment code. */
  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    const problem = paypingSettingsProblem(config);
    if (problem) return { success: false, latencyMs: 0, error: problem };
    try {
      const res = await providerFetch('PayPing', PAYPING_API, {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({ amount: 2_000, returnUrl: probeCallbackUrl(config), description: 'Connection test', clientRefId: `test-${Date.now()}` }),
      });
      const data = await readProviderJson('PayPing', res, 'test connection');
      if (res.ok && readPaymentCode(data)) return { success: true, latencyMs: Date.now() - start };
      if (res.status === 401 || res.status === 403) {
        return { success: false, latencyMs: Date.now() - start, error: `PayPing HTTP ${res.status}: the token is invalid or lacks the payment scope` };
      }
      const error = readPayPingError(data);
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: `PayPing HTTP ${res.status}${error.code ? ` (${error.code})` : ''}${error.message ? `: ${error.message}` : ''}`,
      };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: errorText(e) };
    }
  },
};
