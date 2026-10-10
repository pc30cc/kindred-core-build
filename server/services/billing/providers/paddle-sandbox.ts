import type { BillingProviderHandler, BillingProviderConfig } from '../types.js';
import { paddleProvider, paddleCredentialProblem, isPaddleSandboxFlag } from './paddle.js';
import { PADDLE_SANDBOX_PROVIDER } from '../../../../shared/testGateways.js';

// ─────────────────────────────────────────────────────────────────────
// PADDLE SANDBOX (`paddle_sandbox`)
//
// Paddle Billing's sandbox as a gateway of its own, next to live `paddle`:
// its own credentials (a separate account at sandbox-vendors.paddle.com),
// its own webhook (`/api/billing/webhook/paddle_sandbox`, its own secret) and
// its own row in Finance → Gateways, so it can be switched on to test
// payments without touching the live account's settings.
//
// Same wire protocol and code as `paddle` (providers/paddle.ts), with the
// sandbox forced on: every API call goes to sandbox-api.paddle.com and the
// browser initialises Paddle.js with Environment.set('sandbox'). No real money
// moves; the checkout shows Paddle's "Test Mode" watermark.
//
// Credentials are checked for their environment (paddleCredentialProblem): a
// live API key or client-side token is refused here, so a sandbox gateway can
// never charge a real card.
//
// Automatic card renewal (simple billing phase 3b) works here exactly as on
// live Paddle: a card-setup checkout (`recurring` price) goes through
// createCheckoutSession below, card events through verifyWebhook, the
// `card_auto_renew` switch is checked by testConnection, and the card code
// calls the subscription API through paddleSubscriptions.ts with
// `paddleConfigFor('paddle_sandbox', …)`, which forces the sandbox and refuses
// live credentials the same way.
// ─────────────────────────────────────────────────────────────────────

/**
 * Whether every customer may see and pay with the sandbox. Off by default:
 * a test card buys a real plan for nothing, so only platform admins get the
 * gateway until the Super Admin switches "Open to customers" on.
 */
export function paddleSandboxOpenToCustomers(config: BillingProviderConfig): boolean {
  return isPaddleSandboxFlag(config.open_to_customers);
}

/** Forces the sandbox, whatever was stored. */
function sandboxConfig(config: BillingProviderConfig): BillingProviderConfig {
  return { ...config, sandbox: true };
}

function assertSandboxCredentials(config: BillingProviderConfig): void {
  const problem = paddleCredentialProblem(config, PADDLE_SANDBOX_PROVIDER);
  if (problem) throw new Error(problem);
}

export const paddleSandboxProvider: BillingProviderHandler = {
  name: PADDLE_SANDBOX_PROVIDER,
  capabilities: { ...paddleProvider.capabilities },
  supportedCurrencies: paddleProvider.supportedCurrencies,

  async createCheckoutSession(config, req) {
    assertSandboxCredentials(config);
    const result = await paddleProvider.createCheckoutSession(sandboxConfig(config), req);
    return {
      ...result,
      // The payment page opens it with Paddle.js in the sandbox environment.
      ...(result.clientCheckout
        ? { clientCheckout: { ...result.clientCheckout, provider: PADDLE_SANDBOX_PROVIDER, environment: 'sandbox' } }
        : {}),
    };
  },

  verifyPayment(config, params) {
    return paddleProvider.verifyPayment!(sandboxConfig(config), params);
  },

  closeCheckout(config, transactionId) {
    return paddleProvider.closeCheckout!(sandboxConfig(config), transactionId);
  },

  /** Verified with THIS gateway's notification secret (Paddle-Signature, 5-minute window). */
  verifyWebhook(config, headers, body) {
    return paddleProvider.verifyWebhook(sandboxConfig(config), headers, body);
  },

  cancelSubscription(config, subscriptionId) {
    return paddleProvider.cancelSubscription!(sandboxConfig(config), subscriptionId);
  },

  getPortalUrl(config, customerId, returnUrl) {
    return paddleProvider.getPortalUrl!(sandboxConfig(config), customerId, returnUrl);
  },

  validateConfig(config) {
    return paddleCredentialProblem(config, PADDLE_SANDBOX_PROVIDER);
  },

  async testConnection(config) {
    const problem = paddleCredentialProblem(config, PADDLE_SANDBOX_PROVIDER);
    if (problem) return { success: false, latencyMs: 0, error: problem };
    return paddleProvider.testConnection(sandboxConfig(config));
  },
};
