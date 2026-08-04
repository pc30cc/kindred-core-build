import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

// ── Local, ZarinPal-scoped readers (Create + testConnection only) ─────
/** Narrows the top-level envelope. Nullish bodies keep the previous TypeError behaviour. */
function asZarinpalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${String(value)} (reading 'data')`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asZarinpalSection(body: unknown, key: 'data' | 'errors'): Record<string, unknown> | null {
  const section = asZarinpalRecord(body)?.[key];
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return null;
  return section as Record<string, unknown>;
}

/** `data.code` only when it is a real number; never coerces '100' → 100. */
function readZarinpalCreateCode(body: unknown): number | undefined {
  const code = asZarinpalSection(body, 'data')?.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

/** `data.authority` only when it is a non-empty string. */
function readZarinpalAuthority(body: unknown): string | undefined {
  const authority = asZarinpalSection(body, 'data')?.authority;
  return typeof authority === 'string' && authority.length > 0 ? authority : undefined;
}

/** `errors.message` only when it is a non-empty string. */
function readZarinpalErrorMessage(body: unknown): string | undefined {
  const message = asZarinpalSection(body, 'errors')?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** `errors.code` only when it is a real number. */
function readZarinpalErrorCode(body: unknown): number | undefined {
  const code = asZarinpalSection(body, 'errors')?.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

// ── Verify-only readers ───────────────────────────────────────────────
/** Verify `data.code`, kept raw so the existing `=== 100 / === 101` checks are unchanged. */
function readZarinpalVerifyCode(body: unknown): unknown {
  return asZarinpalSection(body, 'data')?.code;
}

/**
 * Verify `data.ref_id` as the `providerRef: string` the interface declares.
 * Mirrors the previous `String(ref_id || '')`: falsy values (0, '', null, undefined,
 * false) stay `undefined` so the caller keeps emitting `''`; non-empty strings pass
 * through and finite numbers become the string of that same number.
 */
function readZarinpalRefId(body: unknown): string | undefined {
  const refId = asZarinpalSection(body, 'data')?.ref_id;
  if (typeof refId === 'string') return refId.length > 0 ? refId : undefined;
  if (typeof refId === 'number' && Number.isFinite(refId) && refId !== 0) return `${refId}`;
  return undefined;
}

const baseUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://sandbox.zarinpal.com/pg/v4/payment' : 'https://api.zarinpal.com/pg/v4/payment';

const gatewayUrl = (config: BillingProviderConfig) =>
  config.sandbox ? 'https://sandbox.zarinpal.com/pg/StartPay' : 'https://www.zarinpal.com/pg/StartPay';

// ZarinPal (or an upstream WAF / filtering proxy) can answer with an HTML page
// instead of JSON. res.json() would then throw a cryptic "Unexpected token '<'"
// SyntaxError, so read the body as text and raise a descriptive error instead.
async function readZarinpalJson(res: Response, context: string): Promise<unknown> {
  const text = (await res.text()).trim();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(
      `ZarinPal gateway unreachable: ${context} returned a non-JSON response (HTTP ${res.status})` +
      (snippet ? `: ${snippet}` : ''),
    );
  }
}

export const zarinpalProvider: BillingProviderHandler = {
  name: 'zarinpal',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = parseInt(String(req.metadata?.amount || '0'));
    const currency = (config.currency as string) || 'IRR';
    const res = await fetch(`${baseUrl(config)}/request.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: config.merchant_id,
        amount: currency === 'IRT' ? amount : amount, // amount in rials or tomans
        callback_url: req.callbackUrl,
        description: `Plan ${req.planId} for workspace ${req.workspaceId}`,
        metadata: { email: req.customerEmail, workspace_id: req.workspaceId, plan_id: req.planId },
        currency,
      }),
    });
    const data = await readZarinpalJson(res, 'create payment');
    const code = readZarinpalCreateCode(data);
    if (code !== 100) throw new Error(readZarinpalErrorMessage(data) || `ZarinPal error code: ${code}`);
    const authority = readZarinpalAuthority(data);
    if (!authority) throw new Error('ZarinPal error: missing authority in gateway response');
    return {
      paymentUrl: `${gatewayUrl(config)}/${authority}`,
      authority,
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const amount = parseInt(params.amount || '0');
    const res = await fetch(`${baseUrl(config)}/verify.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: config.merchant_id,
        authority: params.Authority || params.authority,
        amount,
      }),
    });
    const data = await readZarinpalJson(res, 'verify payment');
    const code = readZarinpalVerifyCode(data);
    return {
      verified: code === 100 || code === 101,
      providerRef: readZarinpalRefId(data) ?? '',
      amount,
      status: code === 100 ? 'success' : code === 101 ? 'already_verified' : 'failed',
    };
  },

  // ZarinPal uses callback-based verification, not webhooks
  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    // Parse callback params as webhook
    const params = JSON.parse(body);
    if (params.Status === 'OK') {
      return {
        type: 'payment_succeeded',
        providerEventId: params.Authority,
        providerPaymentId: params.Authority,
        workspaceId: params.workspace_id,
        raw: params,
      };
    }
    return null;
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // Test with a minimal request that will fail gracefully
      const res = await fetch(`${baseUrl(config)}/request.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchant_id: config.merchant_id,
          amount: 1000,
          callback_url: 'https://test.localhost/callback',
          description: 'Connection test',
        }),
      });
      const data = await readZarinpalJson(res, 'test connection');
      const createCode = readZarinpalCreateCode(data);
      // Code 100 = success, or any non-auth error means credentials work
      if (createCode === 100 || createCode === -9) {
        return { success: true, latencyMs: Date.now() - start };
      }
      // Auth errors
      const errorCode = readZarinpalErrorCode(data);
      if (errorCode === -1 || errorCode === -2) {
        return { success: false, latencyMs: Date.now() - start, error: 'Invalid merchant ID' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { success: false, latencyMs: Date.now() - start, error: e.message };
    }
  },
};
