import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification, WebhookEvent } from '../types.js';
import { asRecord, errorText, missingSettings, probeCallbackUrl, providerFetch, readProviderJson, settingText } from './providerHttp.js';

// NextPay (nextpay.org, "nx" gateway API).
//
//   token    POST /nx/gateway/token {api_key, amount, order_id, callback_uri, currency, …} → {code: -1, trans_id}
//   pay      GET  /nx/gateway/payment/{trans_id}
//   callback GET  callback_uri?trans_id=…&order_id=…&amount=…
//   verify   POST /nx/gateway/verify {api_key, trans_id, amount} → {code: 0, Shaparak_Ref_Id, …}
//            code -49 = already verified; the amount must equal the token's (-33 otherwise)
//
// UNITS: NextPay's amount is in TOMAN unless `currency` says otherwise. This
// adapter always sends `currency: 'IRR'` with the Rial amount, so the payment
// is created, charged and verified in Rial. (Sending a Rial amount without it
// charged the customer a tenth of the price.)

export const NEXTPAY_API = 'https://nextpay.org/nx/gateway';

/**
 * NextPay result codes whose meaning the published lists agree on (other
 * codes are shown as numbers: the lists in circulation disagree about them).
 */
const NEXTPAY_CODES: Record<number, string> = {
  [-1]: 'token issued, waiting for payment',
  [-2]: 'declined by the bank, or cancelled',
  [-3]: 'payment pending',
  [-20]: 'api key is missing',
  [-21]: 'trans_id is missing',
  [-49]: 'already verified',
};

/** `code` only when it is a real number; never coerces '-1' → -1. */
function readNextPayCode(body: unknown): number | undefined {
  const code = asRecord(body)?.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

/** Returns `trans_id` only when it is a non-empty string or a number. */
function readNextPayTransactionId(body: unknown): string | undefined {
  const transId = asRecord(body)?.trans_id;
  if (typeof transId === 'number' && Number.isFinite(transId)) return `${transId}`;
  if (typeof transId === 'string' && transId.length > 0) return transId;
  return undefined;
}

/** Returns `Shaparak_Ref_Id` only when it is a non-empty string or a number. */
function readNextPayShaparakRefId(body: unknown): string | undefined {
  const refId = asRecord(body)?.Shaparak_Ref_Id;
  if (typeof refId === 'number' && Number.isFinite(refId)) return `${refId}`;
  if (typeof refId === 'string' && refId.length > 0) return refId;
  return undefined;
}

function describeNextPay(body: unknown): string {
  const code = readNextPayCode(body);
  if (code === undefined) return 'no code';
  return NEXTPAY_CODES[code] ? `${code} (${NEXTPAY_CODES[code]})` : `${code}`;
}

function nextpayPost(path: string, body: unknown): Promise<Response> {
  return providerFetch('NextPay', `${NEXTPAY_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function nextpaySettingsProblem(config: BillingProviderConfig | null | undefined): string | null {
  return missingSettings('NextPay', config, [['api_key', 'API key']]);
}

export const nextpayProvider: BillingProviderHandler = {
  name: 'nextpay',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
  // set server-side. It is sent as Rial, named so (`currency: 'IRR'`).
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await nextpayPost('/token', {
      api_key: settingText(config.api_key),
      amount,
      currency: 'IRR',
      order_id: req.intentId || `${req.workspaceId}_${req.planId}_${Date.now()}`,
      callback_uri: req.callbackUrl,
      ...(req.metadata?.phone ? { customer_phone: req.metadata.phone } : {}),
      ...(req.customerName ? { payer_name: req.customerName } : {}),
    });
    const data = await readProviderJson('NextPay', res, 'create payment');
    if (readNextPayCode(data) !== -1) throw new Error(`NextPay error: code ${describeNextPay(data)}`);
    const transId = readNextPayTransactionId(data);
    if (transId === undefined) throw new Error('NextPay error: missing trans_id');
    return {
      paymentUrl: `${NEXTPAY_API}/payment/${encodeURIComponent(transId)}`,
      sessionId: transId,
    };
  },

  /**
   * Verifies the STORED trans_id (bound before the call) for the SERVER amount
   * in Rial; NextPay itself refuses another amount (-33). Code 0 = verified
   * now; -49 = this trans_id was verified before (a verify whose answer was
   * lost), reported as `already_verified` for the account code to settle the
   * pending payment of this trans_id once.
   */
  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
    const transId = (params.trans_id || params.transid || '').trim();
    const amount = parseInt(params.amount || '0');
    if (!transId) return { verified: false, providerRef: '', status: 'failed' };
    const res = await nextpayPost('/verify', { api_key: settingText(config.api_key), trans_id: transId, amount });
    const data = await readProviderJson('NextPay', res, 'verify payment');
    if (data === null || data === undefined) throw new Error('NextPay gateway unreachable: verify payment returned an empty answer');
    const code = readNextPayCode(data);
    const ref = readNextPayShaparakRefId(data) ?? transId;
    if (code === 0) return { verified: true, providerRef: ref, amount, status: 'success' };
    if (code === -49) return { verified: true, providerRef: ref, amount, status: 'already_verified' };
    if (code === -2) return { verified: false, providerRef: transId, status: 'failed' };
    // -3 pending, a key or amount problem, an unknown code: nothing is settled or ended.
    return { verified: false, providerRef: transId, status: 'pending' };
  },

  // No signed webhook: the route refuses unsigned providers. Kept for the interface.
  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    const data = JSON.parse(body);
    return {
      type: 'payment_succeeded',
      providerEventId: data.trans_id,
      providerPaymentId: data.trans_id,
      raw: data,
    };
  },

  /** A real token request (never paid). Success only when NextPay issues a token (code -1). */
  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    const problem = nextpaySettingsProblem(config);
    if (problem) return { success: false, latencyMs: 0, error: problem };
    try {
      const res = await nextpayPost('/token', {
        api_key: settingText(config.api_key),
        amount: 20_000,
        currency: 'IRR',
        order_id: `test-${Date.now()}`,
        callback_uri: probeCallbackUrl(config),
      });
      const data = await readProviderJson('NextPay', res, 'test connection');
      if (readNextPayCode(data) === -1) return { success: true, latencyMs: Date.now() - start };
      return { success: false, latencyMs: Date.now() - start, error: `NextPay code ${describeNextPay(data)}` };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: errorText(e) };
    }
  },
};
