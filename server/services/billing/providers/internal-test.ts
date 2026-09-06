import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  BillingProviderHandler,
  BillingProviderConfig,
  CheckoutRequest,
  CheckoutResult,
  WebhookEvent,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────
// INTERNAL TEST GATEWAY (`internal_test`)
//
// A fully local, self-hosted simulated payment gateway used to exercise the
// real financial pipeline (intent → gateway redirect → callback → verify →
// invoice/period/credit) WITHOUT any external network call and WITHOUT moving
// real money.
//
// It is NOT a mock inside the billing service: the flow goes through the same
// redirect + reference-binding + verify contract every real gateway uses. The
// only difference is that the "bank page" is served by this deployment
// (`/api/billing/test-gateway`) and the operator decides the outcome.
//
// Safety:
//   • every redirect is HMAC-signed, so a browser cannot fabricate a success
//     callback for an arbitrary reference/amount;
//   • the callback still has to match the server-created payment intent, so
//     it can never finalize another order.
// ─────────────────────────────────────────────────────────────────────

export const INTERNAL_TEST_PROVIDER = 'internal_test';

/** Signing key for the simulated gateway. Never a payment credential. */
function signingKey(): string {
  return (
    process.env.INTERNAL_TEST_GATEWAY_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET ||
    process.env.CORE_INTERNAL_SECRET ||
    'webyar-internal-test-gateway'
  );
}

function sign(parts: string[]): string {
  return createHmac('sha256', signingKey()).update(parts.join('|')).digest('hex').slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a || '');
  const y = Buffer.from(b || '');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Signature of the "open the gateway page" request. */
export function signCheckout(ref: string, amount: number, callbackUrl: string): string {
  return sign(['checkout', ref, String(amount), callbackUrl]);
}

export function verifyCheckoutSignature(
  ref: string,
  amount: string,
  callbackUrl: string,
  sig: string,
): boolean {
  return safeEqual(sign(['checkout', ref, amount, callbackUrl]), sig);
}

/** Signature of the outcome the gateway page redirects back with. */
// The amount is deliberately NOT part of this signature: the verify step
// re-derives the authoritative amount from the payment intent, and the
// gateway page must stay valid for it.
export function signOutcome(ref: string, status: string): string {
  return sign(['outcome', ref, status]);
}

function verifyOutcomeSignature(ref: string, status: string, sig: string): boolean {
  return safeEqual(signOutcome(ref, status), sig);
}

/**
 * The gateway page is a route on THIS Express deployment
 * (`/api/billing/test-gateway`), which is not necessarily the same origin as
 * the browser/app that started checkout in a split app/API topology.
 *
 * `config.gateway_base_url` is always the canonical PUBLIC API origin by the
 * time it reaches here — `resolveNamedBillingConfig`/`resolveBillingConfig`
 * (server/services/billing/index.ts) populate it server-side from
 * `platform_domains.api_base_url` (never from the caller's callback URL).
 * A provider must never fall back to deriving its own page's host from the
 * bank-return callback URL: that was the exact bug that broke split
 * deployments where the app host does not proxy `/api/*`.
 */
function gatewayBase(config: BillingProviderConfig): string {
  const configured = typeof config.gateway_base_url === 'string' ? config.gateway_base_url.trim() : '';
  if (!configured) {
    throw new Error(
      'Internal test gateway: no API origin configured (platform_domains.api_base_url or API_BASE_URL)',
    );
  }
  return `${configured.replace(/\/+$/, '')}/api/billing/test-gateway`;
}

export const internalTestProvider: BillingProviderHandler = {
  name: INTERNAL_TEST_PROVIDER,
  capabilities: {
    subscriptions: false,
    oneTimePayments: true,
    customerPortal: false,
    refunds: false,
    webhooks: false,
    multiCurrency: false,
    trialSupport: false,
  },

  async createCheckoutSession(
    config: BillingProviderConfig,
    req: CheckoutRequest,
  ): Promise<CheckoutResult> {
    // The billing provider contract always supplies metadata.amount in IRR.
    // Provider display preferences must not convert this authoritative amount
    // a second time (an IRT config previously made the simulator show 10×).
    const amount = parseInt(String(req.metadata?.amount || '0'), 10) || 0;
    if (amount <= 0) {
      throw new Error('Internal test gateway: amount must be greater than zero');
    }
    const ref = `TESTGW-${randomBytes(10).toString('hex').toUpperCase()}`;
    const url = new URL(gatewayBase(config));
    url.searchParams.set('ref', ref);
    url.searchParams.set('amount', String(amount));
    url.searchParams.set('cb', req.callbackUrl);
    url.searchParams.set('sig', signCheckout(ref, amount, req.callbackUrl));
    return {
      paymentUrl: url.toString(),
      authority: ref,
      sessionId: ref,
      providerRef: ref,
    };
  },

  async verifyPayment(_config: BillingProviderConfig, params: Record<string, string>) {
    const ref = params.authority || params.Authority || '';
    const status = (params.status || params.Status || '').toUpperCase();
    const amount = parseInt(params.amount || '0', 10) || 0;
    const sig = params.rsig || '';

    if (!ref || !verifyOutcomeSignature(ref, status, sig)) {
      return { verified: false, providerRef: ref, amount, status: 'failed' };
    }
    if (status !== 'OK') {
      return { verified: false, providerRef: ref, amount, status: 'canceled' };
    }
    return { verified: true, providerRef: ref, amount, status: 'success' };
  },

  // Redirect-based simulator: no signed webhooks.
  async verifyWebhook(): Promise<WebhookEvent | null> {
    return null;
  },

  async testConnection() {
    return { success: true, latencyMs: 0 };
  },
};
