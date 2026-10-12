import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';
import {
  errorText, missingSettings, probeCallbackUrl, providerFetch, readProviderJson, settingText,
  PROVIDER_TIMEOUT_MS, PROVIDER_VERIFY_TIMEOUT_MS,
} from './providerHttp.js';

// SEP (Saman Electronic Payment, sep.shaparak.ir, OnlinePG REST). Amounts are Rial.
//
//   token    POST /onlinepg/onlinepg {action: 'token', TerminalId, Amount, ResNum, RedirectUrl, CellNumber?}
//            → {status: 1, token} | {status: -1, errorCode, errorDesc}
//   pay      GET  /OnlinePG/SendToken?token=…
//   callback POST RedirectUrl, form fields: MID, State ('OK' when paid), Status, RefNum, ResNum,
//            TerminalId, TraceNo, Amount, SecurePan, Token. The browser cannot receive a POST
//            on the app's page, so SEP's callback is the API's return hop
//            (/api/billing/account-return), which hands the fields to the page.
//   verify   POST /verifyTxnRandomSessionkey/ipg/VerifyTransaction {RefNum, TerminalNumber}
//            → {Success, ResultCode, ResultDescription, TransactionDetail: {OrginalAmount, AffectiveAmount, RRN, …}}
//            ResultCode 0 = verified, 2 = already verified; a payment not verified within
//            30 minutes is reversed to the payer by SEP.
//
// SEP answers only registered server IPs, and in practice only from inside Iran:
// from the production server (Canada) it did not answer within 15 s.

export const SEP_API = 'https://sep.shaparak.ir';

export function sepSettingsProblem(config: BillingProviderConfig | null | undefined): string | null {
  const missing = missingSettings('SEP', config, [['terminal_id', 'Terminal number']]);
  if (missing) return missing;
  if (!/^\d{4,12}$/.test(settingText(config?.terminal_id))) return 'SEP: the terminal number must be the digits SEP issued (e.g. 12345678).';
  return null;
}

function sepPost(path: string, body: unknown, timeoutMs: number = PROVIDER_TIMEOUT_MS): Promise<Response> {
  return providerFetch('SEP', `${SEP_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs);
}

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
  const detail = readSepTransactionDetail(body);
  // SEP's documents spell it `OrginalAmount`; some terminals answer `OriginalAmount`.
  for (const key of ['OrginalAmount', 'OriginalAmount', 'AffectiveAmount']) {
    const amount = detail?.[key];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return amount;
  }
  return undefined;
}

// SEP (Saman Electronic Payment / SamanKish) — Shaparak gateway
export const sepProvider: BillingProviderHandler = {
  name: 'sep_shaparak',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
  // set server-side from the payment amount in Rial. SEP's API
  // expects amounts in Rial, so no conversion is needed here.
  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await sepPost('/onlinepg/onlinepg', {
      action: 'token',
      TerminalId: settingText(config.terminal_id),
      Amount: amount,
      ResNum: req.intentId || `${req.workspaceId}_${req.planId}_${Date.now()}`,
      RedirectUrl: req.callbackUrl,
      ...(req.metadata?.phone ? { CellNumber: req.metadata.phone } : {}),
    });
    const data = await readProviderJson('SEP', res, 'create payment');
    const body = readSepRecord(data);
    if (readSepStatus(body) !== 1) throw new Error(`SEP error: ${describeSepFailure(body)}`);
    const token = readSepToken(body);
    if (!token) throw new Error('SEP error: missing token in response');
    return {
      paymentUrl: `${SEP_API}/OnlinePG/SendToken?token=${encodeURIComponent(token)}`,
      sessionId: token,
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const refNum = (params.RefNum || params.refNum || '').trim();
    // No RefNum: the payer cancelled or the bank declined; there is nothing to verify.
    if (!refNum) {
      const state = (params.State || params.state || '').trim();
      return { verified: false, providerRef: '', status: /cancel/i.test(state) ? 'canceled' : 'failed' };
    }
    // The long deadline: a verify SEP completes after we stopped waiting takes
    // the money, and the retry then only gets ResultCode 2 (already verified),
    // which settles nothing on its own (verifyAccountPayment logs REVIEW).
    const res = await sepPost('/verifyTxnRandomSessionkey/ipg/VerifyTransaction', {
      RefNum: refNum,
      TerminalNumber: Number(settingText(config.terminal_id)) || settingText(config.terminal_id),
    }, PROVIDER_VERIFY_TIMEOUT_MS);
    const data: unknown = await readProviderJson('SEP', res, 'verify payment');
    const outcome = classifySepVerifyResult(data);
    return {
      verified: outcome !== 'failed',
      providerRef: refNum,
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

  /**
   * A real token request (never paid) with this platform's callback. Success
   * only when SEP issues a token; otherwise SEP's errorCode and errorDesc (an
   * unknown terminal, this server's IP not registered). From outside Iran SEP
   * usually does not answer at all: the error then says so.
   */
  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    const problem = sepSettingsProblem(config);
    if (problem) return { success: false, latencyMs: 0, error: problem };
    try {
      const res = await sepPost('/onlinepg/onlinepg', {
        action: 'token',
        TerminalId: settingText(config.terminal_id),
        Amount: 20_000,
        ResNum: `test-${Date.now()}`,
        RedirectUrl: probeCallbackUrl(config),
      });
      const body = readSepRecord(await readProviderJson('SEP', res, 'test connection'));
      if (readSepStatus(body) === 1 && readSepToken(body)) return { success: true, latencyMs: Date.now() - start };
      const code = body.errorCode;
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: `SEP${typeof code === 'number' || typeof code === 'string' ? ` ${code}` : ''}: ${describeSepFailure(body)}`,
      };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: errorText(e) };
    }
  },
};
