/**
 * Gateway listing (server/services/billing/account/gateways.ts) reads the
 * settings of the gateways that go live, so customers are never offered one
 * that cannot take a payment, and the readiness card names what is missing:
 *   - live ZarinPal: its merchant id (a UUID);
 *   - live Paddle and the Paddle sandbox: API key, client-side token and
 *     webhook secret, of the right environment.
 * Every other gateway: gatewaySettingsAllGateways.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { gatewayListing, gatewayNeedsConfig, gatewaySettingsProblem } from '../../../server/services/billing/account/gateways.js';

const ACTIVE = (provider_name: string, currencies: string[]) => ({ provider_name, is_active: true, currencies });
const MERCHANT = '11111111-2222-3333-4444-555555555555';
const PADDLE_LIVE = { provider: 'paddle', api_key: 'pdl_live_apikey_x', client_token: 'live_x', webhook_secret: 'secret' };
const PADDLE_SBX = { provider: 'paddle_sandbox', api_key: 'pdl_sdbx_apikey_x', client_token: 'test_x', webhook_secret: 'secret' };

describe('gatewayNeedsConfig', () => {
  it('reads the settings of live ZarinPal and both Paddle gateways', () => {
    expect(gatewayNeedsConfig('zarinpal')).toBe(true);
    expect(gatewayNeedsConfig('paddle')).toBe(true);
    expect(gatewayNeedsConfig('paddle_sandbox')).toBe(true);
  });

  it('leaves the test gateways as they were (the other gateways: gatewaySettingsAllGateways.test.ts)', () => {
    for (const name of ['zarinpal_test', 'internal_test']) {
      expect(gatewayNeedsConfig(name)).toBe(false);
      expect(gatewaySettingsProblem(name, { provider: name })).toBeNull();
    }
  });
});

describe('gatewayListing: an active gateway with incomplete settings', () => {
  it('ZarinPal without a merchant id is not listed, and says so', () => {
    const listing = gatewayListing(ACTIVE('zarinpal', ['IRR']), 'IRR', { provider: 'zarinpal' }, 'iran');
    expect(listing).toEqual({ listed: false, reasons: ['not_configured'], problem: expect.stringMatching(/Merchant ID is empty/) });
    expect(gatewayListing(ACTIVE('zarinpal', ['IRR']), 'IRR', { provider: 'zarinpal', merchant_id: 'abc' }, 'iran').problem).toMatch(/UUID/);
    expect(gatewayListing(ACTIVE('zarinpal', ['IRR']), 'IRR', { provider: 'zarinpal', merchant_id: MERCHANT }, 'iran')).toEqual({ listed: true, reasons: [] });
  });

  it('live Paddle without its webhook secret (or with the wrong kind of key) is not listed', () => {
    const missing = gatewayListing(ACTIVE('paddle', ['USD']), 'USD', { ...PADDLE_LIVE, webhook_secret: '' }, 'international');
    expect(missing).toEqual({ listed: false, reasons: ['not_configured'], problem: 'Paddle: Webhook Secret Key is empty.' });
    const keyAsToken = gatewayListing(ACTIVE('paddle', ['USD']), 'USD', { ...PADDLE_LIVE, client_token: 'pdl_live_apikey_x' }, 'international');
    expect(keyAsToken.reasons).toEqual(['not_configured']);
    expect(keyAsToken.problem).toMatch(/API key/);
    expect(gatewayListing(ACTIVE('paddle', ['USD']), 'USD', PADDLE_LIVE, 'international')).toEqual({ listed: true, reasons: [] });
  });

  it('the Paddle sandbox is checked the same way, next to its admins-only rule', () => {
    const empty = gatewayListing(ACTIVE('paddle_sandbox', ['USD']), 'USD', { provider: 'paddle_sandbox' }, 'international', { isPlatformAdmin: true });
    expect(empty.reasons).toEqual(['not_configured']);
    expect(gatewayListing(ACTIVE('paddle_sandbox', ['USD']), 'USD', PADDLE_SBX, 'international', { isPlatformAdmin: true })).toEqual({ listed: true, reasons: [] });
    expect(gatewayListing(ACTIVE('paddle_sandbox', ['USD']), 'USD', PADDLE_SBX, 'international').reasons).toEqual(['test']);
  });

  it('settings that could not be read stay `cannot_confirm`; not read yet skips the check', () => {
    expect(gatewayListing(ACTIVE('zarinpal', ['IRR']), 'IRR', null, 'iran').reasons).toEqual(['cannot_confirm']);
    expect(gatewayListing(ACTIVE('zarinpal', ['IRR']), 'IRR', undefined, 'iran')).toEqual({ listed: true, reasons: [] });
  });
});

describe('gatewayListing: test gateways are for platform admins', () => {
  it('ZarinPal test and the internal simulator are hidden from customers, shown to admins', () => {
    for (const name of ['zarinpal_test', 'internal_test']) {
      const customer = gatewayListing(ACTIVE(name, ['IRR']), 'IRR', undefined, 'iran');
      expect(customer.listed).toBe(false);
      expect(customer.reasons).toContain('test');
      expect(gatewayListing(ACTIVE(name, ['IRR']), 'IRR', undefined, 'iran', { isPlatformAdmin: true })).toEqual({ listed: true, reasons: [] });
    }
  });

  it('a test gateway opened to customers in Finance → Gateways is listed to them', () => {
    const opened = { ...ACTIVE('zarinpal_test', ['IRR']), config: { open_to_customers: true } };
    expect(gatewayListing(opened, 'IRR', undefined, 'iran')).toEqual({ listed: true, reasons: [] });
    const closed = { ...ACTIVE('zarinpal_test', ['IRR']), config: { open_to_customers: 'false' } };
    expect(gatewayListing(closed, 'IRR', undefined, 'iran').reasons).toEqual(['test']);
  });

  it('a live gateway is not affected', () => {
    const live = gatewayListing(ACTIVE('zarinpal', ['IRR']), 'IRR', { provider: 'zarinpal', merchant_id: MERCHANT }, 'iran');
    expect(live).toEqual({ listed: true, reasons: [] });
  });
});
