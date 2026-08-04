import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, CheckoutResult, WebhookEvent } from '../types.js';

// ─────────────────────────────────────────────────────────────────────
// IranPardakht — IranDargah REST sandbox
// Docs: https://docs.irandargah.com/#8614460e98
//
// Sandbox authentication is the documented merchantID value "TEST"; there is
// no Authorization/Bearer header. Payment and verification requests use the
// original camelCase field names from IranDargah's REST contract.
// ─────────────────────────────────────────────────────────────────────

const API_BASE = 'https://dargaah.com/sandbox';
const SANDBOX_MERCHANT_ID = 'TEST';
const MIN_AMOUNT_RIALS = 50_000;

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
  return str(record(body)?.message);
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

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Keep the merchant order identifier URL- and callback-safe. */
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
      throw new Error(`IranPardakht sandbox: minimum amount is ${MIN_AMOUNT_RIALS} rials (5,000 tomans)`);
    }
    const orderId = buildOrderId(req);
    const res = await fetch(`${API_BASE}/payment`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        merchantID: SANDBOX_MERCHANT_ID,
        amount,
        callbackURL: req.callbackUrl,
        orderId,
        description: `Plan ${req.planId} - workspace ${req.workspaceId}`.slice(0, 255),
        ...(req.metadata?.phone ? { mobile: req.metadata.phone } : {}),
      }),
    });
    const body = await readJson(res, 'create payment');
    const response = record(body);
    const authority = str(response?.authority);
    const status = Number(response?.status);
    if (!res.ok || status !== 200 || !authority) {
      throw new Error(errorMessage(body) || `IranPardakht sandbox: payment creation failed (HTTP ${res.status})`);
    }
    return {
      paymentUrl: `${API_BASE}/ird/startpay/${encodeURIComponent(authority)}`,
      authority,
      sessionId: orderId,
      providerRef: authority,
    };
  },

  async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
    const authority = params.authority || params.Authority || '';
    const amount = parseInt(params.amount || '0', 10) || 0;
    const orderId = params.orderId || params.order_id || '';
    const callbackCode = parseInt(params.code || params.status || '', 10);

    if (!authority) return { verified: false, providerRef: '', amount, status: 'failed' };
    if (Number.isFinite(callbackCode) && callbackCode !== 100) {
      return { verified: false, providerRef: authority, amount, status: 'canceled' };
    }
    if (!amount || !orderId) {
      return { verified: false, providerRef: authority, amount, status: 'failed' };
    }

    const res = await fetch(`${API_BASE}/verification`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        merchantID: SANDBOX_MERCHANT_ID,
        authority,
        amount,
        orderId,
      }),
    });
    const body = await readJson(res, 'verify payment');
    const response = record(body);
    const verifyStatus = Number(response?.status);
    const verified = res.ok && (verifyStatus === 100 || verifyStatus === 101);
    return {
      verified,
      providerRef: str(response?.refId) || str(params.refId) || authority,
      amount,
      status: verified ? 'success' : 'failed',
    };
  },

  // Callback-based gateway: no signed webhooks. The callback payload is
  // surfaced as an event so the shared pipeline can record it.
  async verifyWebhook(_config: BillingProviderConfig, _headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    let params: Record<string, unknown>;
    try { params = JSON.parse(body) as Record<string, unknown>; } catch { return null; }
    const authority = str(params.authority);
    const statusCode = Number(params.code ?? params.status);
    if (!authority) return null;
    if (statusCode !== 100) {
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
      providerPaymentId: str(params.refId) || authority,
      workspaceId: str(params.workspace_id),
      amount: Number(params.amount) || undefined,
      currency: 'IRR',
      raw: params,
    };
  },

  async testConnection(config: BillingProviderConfig) {
    const start = Date.now();
    try {
      const orderId = `CONNECTIONTEST-${Date.now()}`;
      const res = await fetch(`${API_BASE}/payment`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          merchantID: SANDBOX_MERCHANT_ID,
          amount: MIN_AMOUNT_RIALS,
          callbackURL: 'https://example.com',
          orderId,
        }),
      });
      const body = await readJson(res, 'test connection');
      const success = res.ok && Number(record(body)?.status) === 200 && !!str(record(body)?.authority);
      return {
        success,
        latencyMs: Date.now() - start,
        ...(success ? {} : { error: errorMessage(body) || `IranDargah sandbox returned HTTP ${res.status}` }),
      };
    } catch (e: unknown) {
      return { success: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
