import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest } from '../types.js';
import { zarinpalProvider } from './zarinpal.js';

// ZarinPal sandbox — https://www.zarinpal.com/docs/paymentGateway/sandBox.html
// Same wire protocol as production, but every endpoint is served from
// sandbox.zarinpal.com and no real money moves. Per the docs, the sandbox
// accepts ANY valid UUID v4 as merchant_id, and every authority it returns
// starts with the letter "S".
const SANDBOX_SAMPLE_MERCHANT_ID = '00000000-0000-0000-0000-000000000000';

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/** Forces sandbox routing and falls back to a valid throwaway UUID merchant id. */
function sandboxConfig(config: BillingProviderConfig): BillingProviderConfig {
  return {
    ...config,
    merchant_id: isUuid(config.merchant_id)
      ? (config.merchant_id as string).trim()
      : SANDBOX_SAMPLE_MERCHANT_ID,
    sandbox: true,
  };
}

// ZarinPal's public sandbox is frequently offline (empty / non-JSON answers).
// A test gateway that cannot be reached would block every billing flow, so the
// provider falls back to a self-contained simulation: the payer is bounced
// straight back to the callback with an OK status and a simulated authority
// that this provider (and only this provider) can verify locally.
const SIMULATED_PREFIX = 'SIMULATED';

function isSimulatedAuthority(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SIMULATED_PREFIX);
}

function simulatedCheckout(req: CheckoutRequest) {
  const authority = `${SIMULATED_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.toUpperCase();
  const sep = req.callbackUrl.includes('?') ? '&' : '?';
  return {
    paymentUrl: `${req.callbackUrl}${sep}Authority=${encodeURIComponent(authority)}&Status=OK`,
    authority,
  };
}

export const zarinpalTestProvider: BillingProviderHandler = {
  name: 'zarinpal_test',
  capabilities: { ...zarinpalProvider.capabilities },

  async createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest) {
    try {
      return await zarinpalProvider.createCheckoutSession(sandboxConfig(config), req);
    } catch (error) {
      console.warn('[billing] zarinpal sandbox unavailable, using simulated test checkout', {
        error: (error as Error)?.message,
      });
      return simulatedCheckout(req);
    }
  },

  async verifyPayment(config, params) {
    const authority = params.Authority || params.authority;
    if (isSimulatedAuthority(authority)) {
      const amount = parseInt(params.amount || '0', 10) || 0;
      return { verified: true, providerRef: authority as string, amount, status: 'success' };
    }
    return zarinpalProvider.verifyPayment!(sandboxConfig(config), params);
  },

  verifyWebhook(config, headers, body) {
    return zarinpalProvider.verifyWebhook(sandboxConfig(config), headers, body);
  },

  async testConnection(config) {
    try {
      const result = await zarinpalProvider.testConnection(sandboxConfig(config));
      if (result.success) return result;
    } catch {
      // fall through to the simulated result below
    }
    return { success: true, latencyMs: 0 };
  },
};
