import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

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

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://api.idpay.ir/v1.1' : 'https://api.idpay.ir/v1.1';

// IDPay (or an upstream WAF / filtering proxy) can answer with an HTML error
// page instead of JSON. Parsing that with res.json() throws a cryptic
// "Unexpected token '<'" SyntaxError, so we read the body as text and raise a
// descriptive error that names the gateway and the HTTP status instead.
async function readIdPayJson(res: Response, context: string): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(
      `IDPay gateway unreachable: ${context} returned a non-JSON response (HTTP ${res.status})` +
      (snippet ? `: ${snippet}` : ''),
    );
  }
}

export const idpayProvider: BillingProviderHandler = {
  name: 'idpay',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: true, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const res = await fetch(`${baseUrl(config)}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.api_key as string,
        'X-SANDBOX': config.sandbox ? '1' : '0',
      },
      body: JSON.stringify({
        order_id: `${req.workspaceId}_${req.planId}_${Date.now()}`,
        amount,
        callback: req.callbackUrl,
        desc: `Plan ${req.planId}`,
        mail: req.customerEmail,
        name: req.customerName,
      }),
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

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const res = await fetch(`${baseUrl(config)}/payment/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.api_key as string,
        'X-SANDBOX': config.sandbox ? '1' : '0',
      },
      body: JSON.stringify({ id: params.id, order_id: params.order_id }),
    });
    const data = readIdPayRecord(await readIdPayJson(res, 'verify payment'));
    const status = readIdPayVerifyStatus(data);
    return {
      verified: status === 100 || status === 101,
      providerRef: readIdPayTrackId(data),
      amount: readIdPayVerifiedAmount(data),
      status: status === 100 ? 'success' : 'failed',
    };
  },

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

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // IDPay doesn't have a dedicated test endpoint; we check auth by making a minimal call
      const res = await fetch(`${baseUrl(config)}/payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': config.api_key as string,
          'X-SANDBOX': config.sandbox ? '1' : '0',
        },
        body: JSON.stringify({ order_id: 'test', amount: 1000, callback: 'https://test.localhost' }),
      });
      const data = readIdPayRecord(await readIdPayJson(res, 'test connection'));
      const errorCode = readIdPayErrorCode(data);
      // Error 11 = user blocked, 12 = API key not found — auth errors
      if (errorCode === 12 || errorCode === 11) {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid API key' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
