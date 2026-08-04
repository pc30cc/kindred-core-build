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

export const zarinpalTestProvider: BillingProviderHandler = {
  name: 'zarinpal_test',
  capabilities: { ...zarinpalProvider.capabilities },

  createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest) {
    return zarinpalProvider.createCheckoutSession(sandboxConfig(config), req);
  },

  verifyPayment(config, params) {
    return zarinpalProvider.verifyPayment!(sandboxConfig(config), params);
  },

  verifyWebhook(config, headers, body) {
    return zarinpalProvider.verifyWebhook(sandboxConfig(config), headers, body);
  },

  testConnection(config) {
    return zarinpalProvider.testConnection(sandboxConfig(config));
  },
};
