import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification, WebhookEvent } from '../types.js';
import { errorText, missingSettings, probeCallbackUrl, providerFetch, readProviderJson, settingText } from './providerHttp.js';

// IDPay (api.idpay.ir, web service v1.1). Amounts are Rial.
//
//   create   POST /v1.1/payment {order_id, amount, callback, …} → {id, link}
//   callback POST callback (or GET, per the panel's setting), fields: status, track_id, id,
//            order_id. The browser cannot receive a POST on the app's page, so IDPay's
//            callback is the API's return hop (/api/billing/account-return).
//   verify   POST /v1.1/payment/verify {id, order_id} → {status: 100, track_id, amount, …}
//            101 = already verified, 200 = verified and settled to the merchant
//   X-SANDBOX: 1 runs IDPay's sandbox (no money moves).
//
// Live and sandbox are two gateways, as for ZarinPal: live `idpay` ALWAYS
// sends X-SANDBOX: 0, whatever its stored settings say (the Providers screen
// saved the switch as the string 'false', which a truthiness check read as
// on: real customers would have "paid" in the sandbox). Only `idpay_test`
// (idpay-test.ts) sends 1.
//
// IDPay did not answer from the production server (Canada) within 15 s in
// the 2026-10 probe, and the service has been reported shut down; test it
// before switching it on.

// Local, IDPay-specific readers for the create-payment and test-connection
// responses only. They do not model verify/webhook payloads, and do not touch
// amounts, status mapping, currency or callback handling.
export function readIdPayRecord(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) {
    // Preserve previous runtime behaviour: property access on a nullish body threw.
    throw new TypeError("Cannot read properties of null (reading 'error_code')");
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

// Same truthiness semantics as the previous `if (data.error_code)` check.
export function readIdPayErrorCode(body: Record<string, unknown>): unknown {
  return body.error_code;
}

export function readIdPayErrorMessage(body: Record<string, unknown>): string | undefined {
  const message = body.error_message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

export function readIdPayCheckoutLink(body: Record<string, unknown>): string | undefined {
  const link = body.link;
  return typeof link === 'string' && link.length > 0 ? link : undefined;
}

export function readIdPayCheckoutId(body: Record<string, unknown>): string | undefined {
  const id = body.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

// ── Verify-only readers (separate from the Create/Test readers above) ──
// They model only the three properties verifyPayment consumes.
export function readIdPayVerifyStatus(body: Record<string, unknown>): unknown {
  return body.status;
}

// Reproduces `String(data.track_id || '')`: falsy (0, '', null, undefined,
// false) collapses to '', strings pass through, finite numbers stringify.
export function readIdPayTrackId(body: Record<string, unknown>): string {
  const trackId = body.track_id;
  if (typeof trackId === 'string') return trackId;
  if (typeof trackId === 'number' && Number.isFinite(trackId) && trackId !== 0) return String(trackId);
  return '';
}

// The adapter contract types amount as `number | undefined`, so only finite
// numbers are forwarded; anything else becomes undefined.
export function readIdPayVerifiedAmount(body: Record<string, unknown>): number | undefined {
  const amount = body.amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : undefined;
}

export const IDPAY_API = 'https://api.idpay.ir/v1.1';

// IDPay (or an upstream WAF / filtering proxy) can answer with an HTML error
// page instead of JSON; readProviderJson names the gateway and the HTTP status.
function readIdPayJson(res: Response, context: string): Promise<unknown> {
  return readProviderJson('IDPay', res, context);
}

function idpayHeaders(config: BillingProviderConfig, sandbox: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-KEY': settingText(config.api_key),
    'X-SANDBOX': sandbox ? '1' : '0',
  };
}

function idpayPost(path: string, config: BillingProviderConfig, sandbox: boolean, body: unknown): Promise<Response> {
  return providerFetch('IDPay', `${IDPAY_API}${path}`, {
    method: 'POST',
    headers: idpayHeaders(config, sandbox),
    body: JSON.stringify(body),
  });
}

export function idpaySettingsProblem(config: BillingProviderConfig | null | undefined): string | null {
  return missingSettings('IDPay', config, [['api_key', 'API key']]);
}

/** IDPay's error codes that mean the key or the account, for the Test button. */
const IDPAY_AUTH_ERRORS: Record<number, string> = {
  11: 'the user is blocked',
  12: 'the API key was not found',
  13: 'the request comes from an IP the web service does not allow',
  14: 'the web service is not approved or is suspended',
};

/** The IDPay wire protocol, live (`sandbox` false) or IDPay's sandbox. */
export function idpayHandler(name: string, sandbox: boolean): BillingProviderHandler {
  return {
    name,
    capabilities: {
      subscriptions: false, oneTimePayments: true, customerPortal: false,
      refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
    },

    // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
    // set server-side. IDPay takes Rial: no conversion.
    async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
      const amount = parseInt(String(req.metadata?.amount || '0'));
      const res = await idpayPost('/payment', config, sandbox, {
        order_id: req.intentId || `${req.workspaceId}_${req.planId}_${Date.now()}`,
        amount,
        callback: req.callbackUrl,
        desc: `Plan ${req.planId}`,
        ...(req.customerEmail ? { mail: req.customerEmail } : {}),
        ...(req.customerName ? { name: req.customerName } : {}),
      });
      const data = readIdPayRecord(await readIdPayJson(res, 'create payment'));
      const errorCode = readIdPayErrorCode(data);
      if (errorCode) {
        throw new Error(readIdPayErrorMessage(data) || `IDPay error: ${String(errorCode)}`);
      }
      const link = readIdPayCheckoutLink(data);
      if (!link) throw new Error('IDPay error: missing payment link in response');
      return { paymentUrl: link, sessionId: readIdPayCheckoutId(data) };
    },

    /**
     * Verifies the STORED payment id (bound before the call) with the
     * callback's order_id (IDPay refuses a pair that does not belong
     * together). 100 = verified now; 101 / 200 = verified before. The
     * amount is IDPay's own, compared with the payment by the caller.
     */
    async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
      const id = (params.id || '').trim();
      if (!id) return { verified: false, providerRef: '', status: 'failed' };
      const res = await idpayPost('/payment/verify', config, sandbox, { id, order_id: params.order_id });
      const data = readIdPayRecord(await readIdPayJson(res, 'verify payment'));
      const status = readIdPayVerifyStatus(data);
      const providerRef = readIdPayTrackId(data);
      const amount = readIdPayVerifiedAmount(data);
      if (status === 100) return { verified: true, providerRef, amount, status: 'success' };
      // 101 = "already verified", 200 = verified and settled: reported as
      // `already_verified`, accepted only for the payment that itself
      // already recorded this confirmation, never as a fresh success.
      if (status === 101 || status === 200) return { verified: true, providerRef, amount, status: 'already_verified' };
      // A status below 100 (unpaid, failed, cancelled) or error 53 ("not
      // paid, cannot be verified") ends it; any other error (a key or IP
      // problem on our side, an outage) settles nothing and ends nothing.
      const definitive = typeof status === 'number' || readIdPayErrorCode(data) === 53;
      return { verified: false, providerRef, amount, status: definitive ? 'failed' : 'pending' };
    },

    // No signed webhook: the route refuses unsigned providers. Kept for the interface.
    async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
      const data = JSON.parse(body);
      if (data.status && parseInt(data.status) >= 100) {
        return {
          type: 'payment_succeeded',
          providerEventId: data.id,
          providerPaymentId: data.track_id?.toString(),
          workspaceId: data.order_id?.split('_')[0],
          amount: data.amount,
          currency: 'IRR',
          raw: data,
        };
      }
      return null;
    },

    /**
     * A real payment request (never paid) with this platform's callback.
     * Success only when IDPay answers a payment link; an auth error names
     * the cause; a gateway that does not answer fails after the timeout.
     */
    async testConnection(config: BillingProviderConfig) {
      const start = Date.now();
      if (!sandbox) {
        const problem = idpaySettingsProblem(config);
        if (problem) return { success: false, latencyMs: 0, error: problem };
      }
      try {
        const res = await idpayPost('/payment', config, sandbox, {
          order_id: `test-${Date.now()}`,
          amount: 20_000,
          callback: probeCallbackUrl(config),
        });
        const data = readIdPayRecord(await readIdPayJson(res, 'test connection'));
        if (readIdPayCheckoutLink(data)) return { success: true, latencyMs: Date.now() - start };
        const errorCode = readIdPayErrorCode(data);
        const meaning = typeof errorCode === 'number' ? IDPAY_AUTH_ERRORS[errorCode] : undefined;
        const message = readIdPayErrorMessage(data);
        return {
          success: false,
          latencyMs: Date.now() - start,
          error: `IDPay ${errorCode === undefined ? `HTTP ${res.status}` : String(errorCode)}${meaning ? ` (${meaning})` : ''}${message ? `: ${message}` : ''}`,
        };
      } catch (e: unknown) {
        return { success: false, latencyMs: Date.now() - start, error: errorText(e) };
      }
    },
  };
}

/** Live IDPay: always X-SANDBOX: 0, whatever is stored. */
export const idpayProvider: BillingProviderHandler = idpayHandler('idpay', false);
