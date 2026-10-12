import type { BillingProviderHandler, BillingProviderConfig } from '../types.js';
import { idpayHandler } from './idpay.js';

// IDPay sandbox (آزمایشگاه) — https://idpay.ir/web-service/v1.1/
// The same wire protocol as live IDPay with X-SANDBOX: 1 always, so no real
// money moves. Any valid-looking API key is accepted by IDPay in sandbox
// mode; IDPay's documented sample key is used when none is stored.
const SANDBOX_SAMPLE_KEY = '6a7f99eb-7c20-4412-a972-6dfb7cd253a4';

const wire = idpayHandler('idpay_test', true);

function sandboxConfig(config: BillingProviderConfig): BillingProviderConfig {
  return {
    ...config,
    api_key: (typeof config.api_key === 'string' && config.api_key.trim().length > 0)
      ? config.api_key
      : SANDBOX_SAMPLE_KEY,
  };
}

export const idpayTestProvider: BillingProviderHandler = {
  name: 'idpay_test',
  capabilities: { ...wire.capabilities },
  createCheckoutSession: (config, req) => wire.createCheckoutSession(sandboxConfig(config), req),
  verifyPayment: (config, params) => wire.verifyPayment!(sandboxConfig(config), params),
  verifyWebhook: (config, headers, body) => wire.verifyWebhook(sandboxConfig(config), headers, body),
  testConnection: (config) => wire.testConnection(sandboxConfig(config)),
};
