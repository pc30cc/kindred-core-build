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

// Live and sandbox are two gateways: live `zarinpal` ALWAYS talks to the live
// hosts, whatever its stored settings say, and only `zarinpal_test`
// (zarinpal-test.ts, through zarinpalSandboxWire below) reaches the sandbox.
// A stored `sandbox` switch on the live gateway is ignored: the Providers
// screen saved it as the string 'false', which a truthiness check read as on
// and sent real customers to the sandbox, where any merchant id "pays".
type ZarinpalHosts = { api: string; startPay: string };
export const ZARINPAL_LIVE_HOSTS: ZarinpalHosts = {
  api: 'https://api.zarinpal.com/pg/v4/payment',
  startPay: 'https://www.zarinpal.com/pg/StartPay',
};
export const ZARINPAL_SANDBOX_HOSTS: ZarinpalHosts = {
  api: 'https://sandbox.zarinpal.com/pg/v4/payment',
  startPay: 'https://sandbox.zarinpal.com/pg/StartPay',
};

/** Every ZarinPal call gives up after this long (a verify that hangs is retried by the customer). */
export const ZARINPAL_TIMEOUT_MS = 20_000;

async function zarinpalFetch(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZARINPAL_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`ZarinPal gateway unreachable: no answer within ${ZARINPAL_TIMEOUT_MS / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function isZarinpalMerchantId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function zarinpalCurrency(config: Record<string, unknown>): string {
  return (typeof config.currency === 'string' && config.currency.trim() ? config.currency.trim() : 'IRR').toUpperCase();
}

/**
 * What stops the live gateway from taking a payment with these settings, or
 * null. Named for the Super Admin (the readiness card and the save check).
 * `requireMerchant` false: an empty merchant id is not judged (a save of
 * other fields); the readiness card always asks for it.
 */
export function zarinpalSettingsProblem(config: BillingProviderConfig | null | undefined, requireMerchant = true): string | null {
  const merchant = typeof config?.merchant_id === 'string' ? config.merchant_id.trim() : '';
  if (!merchant) {
    return requireMerchant
      ? 'ZarinPal: Merchant ID is empty. Enter the 36-character merchant id (UUID) from the ZarinPal panel → Gateway (terminal) settings.'
      : null;
  }
  if (!isZarinpalMerchantId(merchant)) {
    return 'ZarinPal: Merchant ID must be the 36-character UUID from the ZarinPal panel (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
  }
  const currency = config ? zarinpalCurrency(config) : 'IRR';
  if (currency !== 'IRR' && currency !== 'IRT') return 'ZarinPal: currency must be IRR (Rial) or IRT (Toman).';
  return null;
}

/** ZarinPal v4 terminal errors, for the Test button. */
const ZARINPAL_TEST_ERRORS: Record<number, string> = {
  [-9]: 'validation error',
  [-10]: 'terminal is not valid: check the merchant id, and that this server\'s IP and the callback domain are allowed on the terminal',
  [-11]: 'terminal is not active: ZarinPal has not activated it yet, or it was suspended',
  [-12]: 'too many attempts: wait a few minutes and test again',
  [-15]: 'terminal is suspended',
};

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

/**
 * The ZarinPal v4 wire protocol against one set of hosts. `zarinpalProvider`
 * (live) and `zarinpalSandboxWire` (used by zarinpal_test) are the same code,
 * so live behaves exactly like the sandbox that was tested end to end.
 */
function zarinpalHandler(name: string, hosts: ZarinpalHosts): BillingProviderHandler {
  return {
    name,
    capabilities: {
      subscriptions: false, oneTimePayments: true, customerPortal: false,
      refunds: false, webhooks: false, multiCurrency: false, trialSupport: false,
    },

    // Unit contract: `req.metadata.amount` is ALWAYS a whole-Rial (IRR) integer,
    // set server-side from the payment amount in Rial — never a
    // client-supplied or Toman value. ZarinPal's v4 API amount unit is decided
    // by the `currency` field: 'IRR' (default) or 'IRT' (Toman); when the
    // merchant config selects IRT, the Rial amount must be converted down.
    async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest): Promise<CheckoutResult> {
      const amountIrr = parseInt(String(req.metadata?.amount || '0'));
      const currency = zarinpalCurrency(config);
      const amount = currency === 'IRT' ? Math.round(amountIrr / 10) : amountIrr;
      const res = await zarinpalFetch(`${hosts.api}/request.json`, {
        merchant_id: config.merchant_id,
        amount,
        callback_url: req.callbackUrl,
        description: `Plan ${req.planId} for workspace ${req.workspaceId}`,
        metadata: { email: req.customerEmail, workspace_id: req.workspaceId, plan_id: req.planId },
        currency,
      });
      const data = await readZarinpalJson(res, 'create payment');
      const code = readZarinpalCreateCode(data);
      if (code !== 100) throw new Error(readZarinpalErrorMessage(data) || `ZarinPal error code: ${code}`);
      const authority = readZarinpalAuthority(data);
      if (!authority) throw new Error('ZarinPal error: missing authority in gateway response');
      return {
        paymentUrl: `${hosts.startPay}/${authority}`,
        authority,
      };
    },

    // `params.amount` is the same server-computed whole-Rial (IRR) amount the
    // checkout intent was created with — never client-supplied. The returned
    // `amount` is normalized back to IRR regardless of the wire currency.
    // Code 101 ("already verified") is reported as `already_verified`: the
    // verify is keyed by the stored authority (bound fail-closed), so the
    // account code may settle a pending payment of that authority with it.
    async verifyPayment(config: BillingProviderConfig, params: Record<string, string>) {
      const amountIrr = parseInt(params.amount || '0');
      const currency = zarinpalCurrency(config);
      const wireAmount = currency === 'IRT' ? Math.round(amountIrr / 10) : amountIrr;
      const res = await zarinpalFetch(`${hosts.api}/verify.json`, {
        merchant_id: config.merchant_id,
        authority: params.Authority || params.authority,
        amount: wireAmount,
      });
      const data = await readZarinpalJson(res, 'verify payment');
      const code = readZarinpalVerifyCode(data);
      return {
        verified: code === 100 || code === 101,
        providerRef: readZarinpalRefId(data) ?? '',
        amount: amountIrr,
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

    /**
     * A real payment request (nothing is charged: the authority is never
     * paid). Success only when ZarinPal answers code 100: a wrong or
     * inactive merchant (-10 / -11), a refused callback domain or any other
     * error is a failure with ZarinPal's own message. `config.probe_callback_url`
     * (set by the Test route to this platform's app) is the callback sent,
     * so a domain the terminal does not allow is caught here.
     */
    async testConnection(config: BillingProviderConfig) {
      const start = Date.now();
      const elapsed = () => Date.now() - start;
      const problem = zarinpalSettingsProblem(config);
      if (problem) return { success: false, latencyMs: 0, error: problem };
      try {
        const currency = zarinpalCurrency(config);
        const callback = typeof config.probe_callback_url === 'string' && /^https:\/\//i.test(config.probe_callback_url)
          ? config.probe_callback_url
          : 'https://test.localhost/callback';
        const res = await zarinpalFetch(`${hosts.api}/request.json`, {
          merchant_id: (config.merchant_id as string).trim(),
          // 20,000 Rial: above ZarinPal's minimum, in the configured unit.
          amount: currency === 'IRT' ? 2_000 : 20_000,
          callback_url: callback,
          description: 'Connection test',
          currency,
        });
        const data = await readZarinpalJson(res, 'test connection');
        if (readZarinpalCreateCode(data) === 100) return { success: true, latencyMs: elapsed() };
        const errorCode = readZarinpalErrorCode(data);
        const message = readZarinpalErrorMessage(data);
        if (errorCode !== undefined) {
          const meaning = ZARINPAL_TEST_ERRORS[errorCode];
          return {
            success: false,
            latencyMs: elapsed(),
            error: `ZarinPal ${errorCode}${meaning ? ` (${meaning})` : ''}${message ? `: ${message}` : ''}`,
          };
        }
        return { success: false, latencyMs: elapsed(), error: `ZarinPal: unexpected answer (HTTP ${res.status})${message ? `: ${message}` : ''}` };
      } catch (e: unknown) {
        return { success: false, latencyMs: elapsed(), error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Live ZarinPal: always api.zarinpal.com / www.zarinpal.com, whatever is stored. */
export const zarinpalProvider: BillingProviderHandler = {
  ...zarinpalHandler('zarinpal', ZARINPAL_LIVE_HOSTS),
  /** Refuses a malformed merchant id or currency on save (an empty one is reported by the readiness card). */
  validateConfig(config: BillingProviderConfig) {
    return zarinpalSettingsProblem(config, false);
  },
};

/** The same protocol on sandbox.zarinpal.com; only zarinpal_test (zarinpal-test.ts) uses it. */
export const zarinpalSandboxWire: BillingProviderHandler = zarinpalHandler('zarinpal_test', ZARINPAL_SANDBOX_HOSTS);
