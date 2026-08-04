import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest } from '../types.js';
import { idpayProvider } from './idpay.js';

// IDPay sandbox (آزمایشگاه) — https://idpay.ir/web-service/v1.1/
// Identical wire protocol to IDPay, but the X-SANDBOX header is always "1"
// so no real money moves. Any valid-looking API key is accepted by IDPay in
// sandbox mode; we fall back to IDPay's documented sample key.
const SANDBOX_SAMPLE_KEY = '6a7f99eb-7c20-4412-a972-6dfb7cd253a4';

function sandboxConfig(config: BillingProviderConfig): BillingProviderConfig {
  return {
    ...config,
    api_key: (typeof config.api_key === 'string' && config.api_key.length > 0)
      ? config.api_key
      : SANDBOX_SAMPLE_KEY,
    sandbox: true,
  };
}

export const idpayTestProvider: BillingProviderHandler = {
  name: 'idpay_test',
  capabilities: { ...idpayProvider.capabilities },

  createCheckoutSession(config: BillingProviderConfig, req: CheckoutRequest) {
    return idpayProvider.createCheckoutSession(sandboxConfig(config), req);
  },

  verifyPayment(config, params) {
    return idpayProvider.verifyPayment!(sandboxConfig(config), params);
  },

  verifyWebhook(config, headers, body) {
    return idpayProvider.verifyWebhook(sandboxConfig(config), headers, body);
  },

  testConnection(config) {
    return idpayProvider.testConnection(sandboxConfig(config));
  },
};
