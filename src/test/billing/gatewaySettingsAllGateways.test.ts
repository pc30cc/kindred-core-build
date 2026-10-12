/**
 * Part C (inactive gateways, to be switched on later): every gateway's
 * required credentials are checked (gatewaySettingsProblem), so an active
 * gateway with missing settings is hidden with `not_configured` and the
 * readiness card names the field; a gateway whose settings put it in the
 * provider's test mode is offered to platform admins only (`test`); stored
 * switches are read strictly (the string 'false' is off).
 */
import { describe, expect, it } from 'vitest';
import {
  gatewayListing,
  gatewayNeedsConfig,
  gatewayNote,
  gatewaySettingsProblem,
  gatewayTestMode,
} from '../../../server/services/billing/account/gateways.js';
import { gatewayReturnsByPost } from '../../../server/services/billing/providerBinding.js';

const ACTIVE = (provider_name: string, currencies: string[]) => ({ provider_name, is_active: true, currencies });
const ADMIN = { isPlatformAdmin: true };

const COMPLETE: Record<string, Record<string, unknown>> = {
  zibal: { merchant: 'abc123merchant' },
  payping: { bearer_token: 'token' },
  nextpay: { api_key: 'b11ee9c3-d23d-414e-8b6e-f2370baac97b' },
  sep_shaparak: { terminal_id: '12345678' },
  idpay: { api_key: '6a7f99eb-7c20-4412-a972-6dfb7cd253a4' },
  stripe: { secret_key: 'sk_live_x', webhook_secret: 'whsec_x' },
  paypal: { client_id: 'id', client_secret: 'secret', webhook_id: 'WH-1' },
  lemon_squeezy: { api_key: 'k', store_id: '1', variant_id: '2', webhook_secret: 's' },
  iyzico: { api_key: 'k', secret_key: 's' },
  paytr: { merchant_id: '1', merchant_key: 'k', merchant_salt: 's' },
  sipay: { merchant_key: 'm', app_key: 'a', app_secret: 's' },
  paratika: { merchant_code: 'c', merchant_user: 'u', merchant_password: 'p' },
  craftgate: { api_key: 'k', secret_key: 's' },
};

describe('gatewaySettingsProblem: every gateway names its missing credentials', () => {
  it.each(Object.keys(COMPLETE))('%s: empty settings are a problem; complete settings are not', (name) => {
    expect(gatewayNeedsConfig(name)).toBe(true);
    expect(gatewaySettingsProblem(name, { provider: name })).toMatch(/empty\.$/);
    expect(gatewaySettingsProblem(name, { provider: name, ...COMPLETE[name] })).toBeNull();
  });

  it('names each missing field, as the Providers screen labels it', () => {
    expect(gatewaySettingsProblem('stripe', { provider: 'stripe', secret_key: 'sk_live_x' })).toBe('Stripe: Webhook Signing Secret is empty.');
    expect(gatewaySettingsProblem('paypal', { provider: 'paypal', client_id: 'x' })).toBe('PayPal: Client Secret, Webhook ID are empty.');
    expect(gatewaySettingsProblem('sep_shaparak', { provider: 'sep_shaparak', terminal_id: '  ' })).toBe('SEP: Terminal number is empty.');
  });

  it('refuses a credential of the wrong kind on a live gateway', () => {
    expect(gatewaySettingsProblem('zibal', { provider: 'zibal', merchant: 'zibal' })).toMatch(/sandbox/);
    expect(gatewaySettingsProblem('zibal', { provider: 'zibal', merchant: ' ZIBAL ' })).toMatch(/sandbox/);
    expect(gatewaySettingsProblem('stripe', { provider: 'stripe', secret_key: 'pk_live_x', webhook_secret: 'whsec_x' })).toMatch(/publishable/);
    expect(gatewaySettingsProblem('stripe', { provider: 'stripe', secret_key: 'sk_live_x', webhook_secret: 'abc' })).toMatch(/whsec_/);
    expect(gatewaySettingsProblem('sep_shaparak', { provider: 'sep_shaparak', terminal_id: 'abc' })).toMatch(/digits/);
  });
});

describe('gatewayListing: an active gateway with incomplete settings is hidden, with the reason', () => {
  it.each([
    ['zibal', 'IRR', 'iran'],
    ['payping', 'IRR', 'iran'],
    ['nextpay', 'IRR', 'iran'],
    ['sep_shaparak', 'IRR', 'iran'],
    ['idpay', 'IRR', 'iran'],
    ['stripe', 'USD', 'international'],
    ['paypal', 'USD', 'international'],
  ] as const)('%s', (name, currency, edition) => {
    const missing = gatewayListing(ACTIVE(name, [currency]), currency, { provider: name }, edition);
    expect(missing.listed).toBe(false);
    expect(missing.reasons).toEqual(['not_configured']);
    expect(missing.problem).toMatch(/empty/);
    expect(gatewayListing(ACTIVE(name, [currency]), currency, { provider: name, ...COMPLETE[name] }, edition)).toEqual({ listed: true, reasons: [] });
  });

  it('gateways without a server-side lookup stay `cannot_confirm` for accounts', () => {
    for (const name of ['lemon_squeezy', 'iyzico', 'paytr', 'sipay', 'paratika', 'craftgate']) {
      const currency = name === 'lemon_squeezy' ? 'USD' : 'TRY';
      expect(gatewayListing(ACTIVE(name, [currency]), currency, { provider: name, ...COMPLETE[name] }, null).reasons).toEqual(['cannot_confirm']);
    }
  });
});

describe('test mode in a live gateway\'s settings: platform admins only', () => {
  it('a Stripe test key is offered to admins, not to customers', () => {
    const testKey = { provider: 'stripe', secret_key: 'sk_test_x', webhook_secret: 'whsec_x' };
    expect(gatewayTestMode('stripe', testKey)).toBe(true);
    expect(gatewayListing(ACTIVE('stripe', ['USD']), 'USD', testKey, 'international').reasons).toEqual(['test']);
    expect(gatewayListing(ACTIVE('stripe', ['USD']), 'USD', testKey, 'international', ADMIN)).toEqual({ listed: true, reasons: [] });
  });

  it('PayPal Sandbox Mode is read strictly: the stored string "false" is live', () => {
    const base = { provider: 'paypal', ...COMPLETE.paypal };
    expect(gatewayTestMode('paypal', { ...base, sandbox: 'false' })).toBe(false);
    expect(gatewayListing(ACTIVE('paypal', ['USD']), 'USD', { ...base, sandbox: 'false' }, 'international')).toEqual({ listed: true, reasons: [] });
    expect(gatewayListing(ACTIVE('paypal', ['USD']), 'USD', { ...base, sandbox: 'true' }, 'international').reasons).toEqual(['test']);
    expect(gatewayListing(ACTIVE('paypal', ['USD']), 'USD', { ...base, sandbox: true }, 'international', ADMIN).listed).toBe(true);
  });

  it('the Turkish gateways and Lemon Squeezy read their switches strictly too', () => {
    for (const [name, key] of [['iyzico', 'sandbox'], ['paytr', 'sandbox'], ['craftgate', 'sandbox'], ['lemon_squeezy', 'test_mode']] as const) {
      expect(gatewayTestMode(name, { provider: name, [key]: 'false' })).toBe(false);
      expect(gatewayTestMode(name, { provider: name, [key]: '0' })).toBe(false);
      expect(gatewayTestMode(name, { provider: name, [key]: 'true' })).toBe(true);
    }
  });
});

describe('readiness notes and the return hop', () => {
  it('IDPay and SEP carry a warning that they did not answer from the production server', () => {
    expect(gatewayNote('idpay')).toMatch(/did not answer/);
    expect(gatewayNote('sep_shaparak')).toMatch(/did not answer/);
    expect(gatewayNote('zarinpal')).toBeNull();
  });

  it('the gateways that post their result come back through the API hop', () => {
    for (const name of ['sep_shaparak', 'idpay', 'idpay_test', 'payping']) expect(gatewayReturnsByPost(name)).toBe(true);
    for (const name of ['zarinpal', 'zibal', 'nextpay', 'stripe', 'paypal', 'paddle']) expect(gatewayReturnsByPost(name)).toBe(false);
  });
});
