import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

// ─────────────────────────────────────────────────────────────────────
// IranPardakht — Sandbox (IranDargah IPG v2)
// Docs: https://docs.irandargah.com/
//
// Auth : single Bearer token, `idg_test_...` for sandbox / `idg_live_...`
// Base : https://ipg.irandargah.com/v2
// Flow : POST /payments -> data.transaction.gateway_url
//        user pays -> callback (GET or POST) with
//        authority / status_code / amount / order_id / ref_id / card_pan
//        status_code 201 => verify, 100 => already verified (direct_verify)
//        POST /verifications { authority, amount } -> data.verification.ref_id
// Amount is in RIALS (min 100_000, max 4_000_000_000).
// ─────────────────────────────────────────────────────────────────────

const API_BASE = 'https://ipg.irandargah.com/v2';
const MIN_AMOUNT_RIALS = 100_000;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function section(body: unknown, ...path: string[]): Record<string, unknown> | null {
  let cur = record(body);
  for (const key of path) {
    if (!cur) return null;
    cur = record(cur[key]);
  }
  return cur;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function errorMessage(body: unknown): string | undefined {
  const err = section(body, 'error');
  return str(err?.message) || str(record(body)?.message);
}

/** The gateway (or an upstream WAF) may answer HTML; never let JSON.parse blow up. */
async function readJson(res: Response, context: string): Promise<unknown> {
  const text = (await res.text()).trim();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(
      `IranPardakht gateway unreachable: ${context} returned a non-JSON response (HTTP ${res.status})` +
      (snippet ? `: ${snippet}` : ''),
    );
  }
}

function token(config: BillingProviderConfig): string {
  const t = typeof config.api_token === 'string' ? config.api_token.trim()
    : typeof config.api_key === 'string' ? (config.api_key as string).trim() : '';
  if (!t) throw new Error('IranPardakht sandbox: API token (idg_test_...) is not configured');
  // HTTP headers are ByteStrings: any non-ASCII char (e.g. a masked "••••"
  // placeholder accidentally saved from the admin UI, or RTL/zero-width chars
  // pasted with the token) would throw a cryptic ByteString conversion error.
  if (!/^[\x21-\x7E]+$/.test(t)) {
    throw new Error(
      'IranPardakht sandbox: the saved API token contains invalid (non-ASCII or masked) characters. ' +
      'Re-enter the full sandbox token (idg_test_...) in provider settings.',
    );
  }
  return t;
}

function headers(config: BillingProviderConfig, idempotencyKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token(config)}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Idempotency-Key': idempotencyKey.replace(/[^\x21-\x7E]/g, '') || `idem-${Date.now()}`,
  };
}

/** order_id must be <= 50 chars of [A-Za-z0-9_-]. */
function buildOrderId(req: CheckoutRequest): string {
  const raw = String(req.metadata?.order_id || `${req.workspaceId}-${Date.now()}`);
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50) || `ORDER-${Date.now()}`;
}

/** Normalises the configured amount to rials (config.currency IRT = tomans). */
function amountInRials(config: BillingProviderConfig, raw: number): number {
  const currency = (config.currency as string) || 'IRR';
  return currency === 'IRT' ? raw * 10 : raw;
}

export const iranPardakhtSandboxProvider: BillingProviderHandler = {
  name: 'iranpardakht_sandbox',
  capabilities: {
    subscriptions: false, oneTimePayments: true, customerPortal: false,
    refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
  },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
    const amount = amountInRials(config, parseInt(String(req.metadata?.amount || '0'), 10) || 0);
    if (amount < MIN_AMOUNT_RIALS) {
      throw new Error(`IranPardakht sandbox: minimum amount is ${MIN_AMOUNT_RIALS} rials (10,000 tomans)`);
    }
    const orderId = buildOrderId(req);
    const res = await fetch(`${API_BASE}/payments`, {
      method: 'POST',
      headers: headers(config, `create-${orderId}`),
      body: JSON.stringify({
        amount,
        order_id: orderId,
        callback_url: req.callbackUrl,
        description: `Plan ${req.planId} - workspace ${req.workspaceId}`.slice(0, 255),
        ...(req.metadata?.mobile ? { mobile: req.metadata.mobile } : {}),
        action: 'GET',
      }),
    });
    const body = await readJson(res, 'create payment');
    const tx = section(body, 'data', 'transaction');
    const gatewayUrl = str(tx?.gateway_url);
    const authority = str(tx?.authority);
    if (!res.ok || record(body)?.success !== true || !gatewayUrl || !authority) {
      throw new Error(errorMessage(body) || `IranPardakht sandbox: payment creation failed (HTTP ${res.status})`);
    }
    return { paymentUrl: gatewayUrl, authority, sessionId: orderId, providerRef: authority };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const authority = params.authority || params.Authority || '';
    const amount = parseInt(params.amount || '0', 10) || 0;
    const statusCode = parseInt(params.status_code || '', 10);

    if (!authority) return { verified: false, providerRef: '', amount, status: 'failed' };
    if (Number.isFinite(statusCode) && statusCode !== 201 && statusCode !== 100) {
      return { verified: false, providerRef: authority, amount, status: 'canceled' };
    }

    const res = await fetch(`${API_BASE}/verifications`, {
      method: 'POST',
      headers: headers(config, `verify-${authority}`),
      body: JSON.stringify({
        authority,
        amount,
        ...(params.order_id ? { order_id: params.order_id } : {}),
      }),
    });
    const body = await readJson(res, 'verify payment');
    const verification = section(body, 'data', 'verification');
    const verified = res.ok && record(body)?.success === true && !!verification;
    return {
      verified,
      providerRef: str(verification?.ref_id) || str(params.ref_id) || '',
      amount: Number(verification?.amount) || amount,
      status: verified ? 'success' : 'failed',
    };
  },

  // Callback-based gateway: no signed webhooks. The callback payload is
  // surfaced as an event so the shared pipeline can record it.
  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    let params: Record<string, unknown>;
    try { params = JSON.parse(body) as Record<string, unknown>; } catch { return null; }
    const authority = str(params.authority);
    const statusCode = Number(params.status_code);
    if (!authority) return null;
    if (statusCode !== 201 && statusCode !== 100) {
      return {
        type: 'payment_failed',
        providerEventId: authority,
        providerPaymentId: authority,
        workspaceId: str(params.workspace_id),
        raw: params,
      };
    }
    return {
      type: 'payment_succeeded',
      providerEventId: authority,
      providerPaymentId: str(params.ref_id) || authority,
      workspaceId: str(params.workspace_id),
      amount: Number(params.amount) || undefined,
      currency: 'IRR',
      raw: params,
    };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      // A verification request with a bogus authority: auth problems answer
      // 401/403, a working token answers with a business-logic error instead.
      const res = await fetch(`${API_BASE}/verifications`, {
        method: 'POST',
        headers: headers(config, `conn-test-${Date.now()}`),
        body: JSON.stringify({ authority: 'CONNECTIONTEST0000', amount: MIN_AMOUNT_RIALS }),
      });
      const body = await readJson(res, 'test connection');
      if (res.status === 401 || res.status === 403) {
        return { success: false, latencyMs: Date.now() - start, error: errorMessage(body) || 'Invalid API token' };
      }
      return { success: true, latencyMs: Date.now() - start };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
