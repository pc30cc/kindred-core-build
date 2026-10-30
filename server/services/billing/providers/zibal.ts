import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, PaymentVerification, WebhookEvent } from '../types.js';
import { asRecord, errorText, missingSettings, probeCallbackUrl, providerFetch, readProviderJson, settingText } from './providerHttp.js';

// Zibal IPG (gateway.zibal.ir, API v1). Amounts are Rial.
//
//   request  POST /v1/request {merchant, amount, callbackUrl, orderId, …} → {result: 100, trackId}
//   pay      GET  /start/{trackId}
//   callback GET  callbackUrl?success=1|0&trackId=…&orderId=…&status=…
//   verify   POST /v1/verify {merchant, trackId} → {result: 100, amount, refNumber, status: 1, …}
//            result 201 = already verified (no amount guaranteed), 202 = not paid / failed
//   inquiry  POST /v1/inquiry {merchant, trackId} → {result: 100, status, amount, refNumber, …}
//
// The merchant "zibal" is Zibal's sandbox: every payment "succeeds" and no
// money moves, so the live gateway refuses it (zibalSettingsProblem). Live and
// sandbox are two gateways, as for ZarinPal and IDPay: live `zibal` sends the
// stored merchant code; `zibal_test` (zibal-test.ts) always sends "zibal".
//
// Probed from the production server (5.39.70.213) on 2026-10-30 with the
// sandbox merchant: request answered 100 in 0.4 s; the start page's "pay"
// returned to the callback with Zibal's fields appended to our own query
// (…&provider=zibal&success=1&status=2&trackId=…&orderId=…); verify answered
// 100 with the amount (refNumber null in the sandbox), a second verify 201
// with no amount, and inquiry status 1 with the amount.

export const ZIBAL_API = 'https://gateway.zibal.ir';
export const ZIBAL_SANDBOX_MERCHANT = 'zibal';

/** Zibal `result` codes, for errors the Super Admin and the customer read. */
const ZIBAL_RESULTS: Record<number, string> = {
  102: 'merchant not found',
  103: 'merchant is inactive',
  104: 'merchant is invalid',
  105: 'amount is below the minimum',
  106: 'callbackUrl is invalid (it must be on the domain registered for the gateway)',
  113: 'amount is above the maximum',
  115: 'this server\'s IP is not registered in the Zibal panel',
  140: 'callbackUrl is missing',
  201: 'already verified',
  202: 'not paid, or the payment failed',
  203: 'trackId is invalid',
};

/** `result` only when it is a real number; never coerces '100' → 100. */
function readZibalResult(body: unknown): number | undefined {
  const value = asRecord(body)?.result;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readZibalMessage(body: unknown): string | undefined {
  const value = asRecord(body)?.message;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `trackId` only from a non-empty string or a finite number. */
function readZibalTrackId(body: unknown): string | undefined {
  const value = asRecord(body)?.trackId;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `refNumber` as a string when it is a non-empty string or a finite non-zero number. */
function readZibalRefNumber(body: unknown): string | undefined {
  const value = asRecord(body)?.refNumber;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return `${value}`;
  return undefined;
}

function readZibalAmount(body: unknown): number | undefined {
  const value = asRecord(body)?.amount;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describeZibal(body: unknown): string {
  const result = readZibalResult(body);
  const meaning = result === undefined ? undefined : ZIBAL_RESULTS[result];
  const message = readZibalMessage(body);
  return [result ?? 'no result', meaning, message].filter(Boolean).join(': ');
}

/** Zibal's trackId is a number; a numeric string is sent as one. */
function wireTrackId(trackId: string): number | string {
  return /^\d{1,15}$/.test(trackId) ? Number(trackId) : trackId;
}

function zibalPost(path: string, body: unknown): Promise<Response> {
  return providerFetch('Zibal', `${ZIBAL_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** What stops the live gateway from taking a payment with these settings, or null. */
export function zibalSettingsProblem(config: BillingProviderConfig | null | undefined): string | null {
  const missing = missingSettings('Zibal', config, [['merchant', 'Merchant code']]);
  if (missing) return missing;
  if (settingText(config?.merchant).toLowerCase() === ZIBAL_SANDBOX_MERCHANT) {
    return 'Zibal: the merchant "zibal" is Zibal\'s sandbox (no money moves). Enter the merchant code of your live gateway from the Zibal panel.';
  }
  return null;
}

/**
 * The Zibal adapter. `sandbox`: Zibal's sandbox merchant is always sent
 * (whatever is stored), and it is not refused as it is on the live gateway.
 */
export function zibalHandler(name: string, sandbox: boolean): BillingProviderHandler {
  const merchantOf = (config: BillingProviderConfig) => (sandbox ? ZIBAL_SANDBOX_MERCHANT : settingText(config.merchant));
  return {
    name,
    capabilities: {
      subscriptions: false, oneTimePayments: true, customerPortal: false,
      refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
    },

    // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
    // set server-side from the payment amount. Zibal takes Rial: no conversion.
    async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
      const amount = parseInt(String(req.metadata?.amount || '0'));
      const res = await zibalPost('/v1/request', {
        merchant: merchantOf(config),
        amount,
        callbackUrl: req.callbackUrl,
        description: `Plan ${req.planId}`,
        orderId: req.intentId || `${req.workspaceId}_${req.planId}_${Date.now()}`,
        ...(req.metadata?.phone ? { mobile: req.metadata.phone } : {}),
      });
      const data = await readProviderJson('Zibal', res, 'create payment');
      if (readZibalResult(data) !== 100) throw new Error(`Zibal error: ${describeZibal(data)}`);
      const trackId = readZibalTrackId(data);
      if (!trackId) throw new Error('Zibal error: missing trackId in gateway response');
      return {
        paymentUrl: `${ZIBAL_API}/start/${trackId}`,
        sessionId: trackId,
      };
    },

    /**
     * Verifies the STORED trackId (bound before the call). 100 = verified now,
     * with Zibal's own amount. 201 = this trackId was verified before (a verify
     * whose answer was lost): its amount is read from /v1/inquiry, which reports
     * status 1 for a paid and verified payment, so the account code can settle
     * the pending payment of this trackId once. 202 = not paid / failed.
     */
    async verifyPayment(config: BillingProviderConfig, params: Record<string, string>): Promise<PaymentVerification> {
      const trackId = (params.trackId || params.trackid || params.track_id || '').trim();
      if (!trackId) return { verified: false, providerRef: '', status: 'failed' };
      const merchant = merchantOf(config);
      const res = await zibalPost('/v1/verify', { merchant, trackId: wireTrackId(trackId) });
      const data = await readProviderJson('Zibal', res, 'verify payment');
      const result = readZibalResult(data);
      if (result === 100) {
        return {
          verified: true,
          providerRef: readZibalRefNumber(data) ?? trackId,
          amount: readZibalAmount(data),
          status: 'success',
        };
      }
      if (result === 201) {
        let amount = readZibalAmount(data);
        let ref = readZibalRefNumber(data);
        if (amount === undefined) {
          const inquiry = await readProviderJson(
            'Zibal',
            await zibalPost('/v1/inquiry', { merchant, trackId: wireTrackId(trackId) }),
            'payment inquiry',
          );
          const record = asRecord(inquiry);
          if (readZibalResult(inquiry) === 100 && record?.status === 1) {
            amount = readZibalAmount(inquiry);
            ref = ref ?? readZibalRefNumber(inquiry);
          }
        }
        return { verified: true, providerRef: ref ?? trackId, amount, status: 'already_verified' };
      }
      // 202: not paid or failed (the customer cancelled, the card was declined).
      if (result === 202 || result === 203) return { verified: false, providerRef: trackId, status: 'failed' };
      // Anything else (a merchant problem, an unexpected answer) settles nothing and ends nothing.
      return { verified: false, providerRef: trackId, status: 'pending' };
    },

    // No signed webhook: the route refuses unsigned providers. Kept for the interface.
    async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
      const data = JSON.parse(body);
      if (data.success === '1' || data.status === '1') {
        return { type: 'payment_succeeded', providerEventId: data.trackId, providerPaymentId: data.trackId, raw: data };
      }
      return null;
    },

    /**
     * A real payment request (never paid) with this platform's callback. Success
     * only when Zibal answers 100; otherwise Zibal's code and meaning (merchant
     * not found / inactive, callback domain refused, IP not registered).
     */
    async testConnection(config: BillingProviderConfig) {
      const start = Date.now();
      const problem = sandbox ? null : zibalSettingsProblem(config);
      if (problem) return { success: false, latencyMs: 0, error: problem };
      try {
        const res = await zibalPost('/v1/request', {
          merchant: merchantOf(config),
          amount: 20_000,
          callbackUrl: probeCallbackUrl(config),
          description: 'Connection test',
        });
        const data = await readProviderJson('Zibal', res, 'test connection');
        if (readZibalResult(data) === 100) return { success: true, latencyMs: Date.now() - start };
        return { success: false, latencyMs: Date.now() - start, error: `Zibal ${describeZibal(data)}` };
      } catch (e: unknown) {
        return { success: false, latencyMs: Date.now() - start, error: errorText(e) };
      }
    },

    validateConfig(config: BillingProviderConfig) {
      if (sandbox) return null;
      return settingText(config.merchant) ? zibalSettingsProblem(config) : null;
    },
  };
}

export const zibalProvider = zibalHandler('zibal', false);
