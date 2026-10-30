/**
 * Zibal's sandbox gateway (`zibal_test`, server/services/billing/providers/zibal-test.ts):
 * the live adapter's wire with Zibal's test merchant "zibal" always sent, a
 * test gateway (platform admins only unless opened to customers), and the
 * same trackId binding as live Zibal. The replay below uses the answers
 * Zibal gave the production server (5.39.70.213) on 2026-10-30.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zibalTestProvider } from '../../../server/services/billing/providers/zibal-test';
import { zibalProvider } from '../../../server/services/billing/providers/zibal';
import { getProvider } from '../../../server/services/billing/index';
import { gatewayListing, isIranianGateway } from '../../../server/services/billing/account/gateways';
import { buildBoundVerifyParams, providerRefMatchesIntent } from '../../../server/services/billing/gatewayVerification';
import { gatewayReturnsByPost } from '../../../server/services/billing/providerBinding';
import { isAlwaysTestGateway, isTestPaymentProvider } from '../../../shared/testGateways';
import { isProviderAllowedInEdition } from '../../../shared/edition';
import type { CheckoutRequest } from '../../../server/services/billing/types';

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'topup',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://app.webyar.ai/acme/billing?payment=pay-1&provider=zibal_test',
  intentId: 'pay-1',
  metadata: { amount: '20000' },
};

function mockSequence(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) fetchMock.mockResolvedValueOnce({ json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof vi.fn>, i: number) => JSON.parse(fetchMock.mock.calls[i][1].body);

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('zibal_test: Zibal\'s sandbox merchant, always', () => {
  it('is registered, Iranian, a test gateway, and returns by GET with trackId', () => {
    expect(getProvider('zibal_test')).toBe(zibalTestProvider);
    expect(zibalTestProvider.name).toBe('zibal_test');
    expect(isIranianGateway('zibal_test')).toBe(true);
    expect(isTestPaymentProvider('zibal_test')).toBe(true);
    expect(isAlwaysTestGateway('zibal_test')).toBe(true);
    expect(isProviderAllowedInEdition('zibal_test', 'iran')).toBe(true);
    expect(isProviderAllowedInEdition('zibal_test', 'international')).toBe(false);
    expect(gatewayReturnsByPost('zibal_test')).toBe(false);
    // Live Zibal is unchanged: not a test gateway.
    expect(isTestPaymentProvider('zibal')).toBe(false);
    expect(isAlwaysTestGateway('zibal')).toBe(false);
  });

  it('sends "zibal" on request, verify and inquiry, whatever merchant is stored', async () => {
    const fetchMock = mockSequence(
      { result: 100, trackId: 4880984559 },
      { result: 201, message: 'previously verifed' },
      { result: 100, status: 1, amount: 20000, refNumber: null },
    );
    const config = { provider: 'zibal_test', merchant: 'a-live-merchant-code' };
    await zibalTestProvider.createCheckoutSession(config, req);
    await zibalTestProvider.verifyPayment!(config, { trackId: '4880984559' });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://gateway.zibal.ir/v1/request',
      'https://gateway.zibal.ir/v1/verify',
      'https://gateway.zibal.ir/v1/inquiry',
    ]);
    for (const i of [0, 1, 2]) expect(sent(fetchMock, i).merchant).toBe('zibal');
  });

  it('needs no settings: the Providers screen saves nothing, and Test calls the sandbox', async () => {
    expect(zibalTestProvider.validateConfig!({ provider: 'zibal_test' })).toBeNull();
    expect(zibalTestProvider.validateConfig!({ provider: 'zibal_test', merchant: 'zibal' })).toBeNull();
    const fetchMock = mockSequence({ result: 100, trackId: 1 });
    expect((await zibalTestProvider.testConnection({ provider: 'zibal_test' })).success).toBe(true);
    expect(sent(fetchMock, 0).merchant).toBe('zibal');
  });

  it('live zibal still refuses the sandbox merchant, on save and on Test', async () => {
    expect(zibalProvider.validateConfig!({ provider: 'zibal', merchant: 'zibal' })).toMatch(/sandbox/);
    const fetchMock = mockSequence({ result: 100, trackId: 1 });
    expect((await zibalProvider.testConnection({ provider: 'zibal', merchant: 'ZIBAL' })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is offered to platform admins only, unless its row is opened to customers', () => {
    const row = { provider_name: 'zibal_test', is_active: true, currencies: ['IRR'] };
    expect(gatewayListing(row, 'IRR', { provider: 'zibal_test' }, 'iran', { isPlatformAdmin: true })).toEqual({ listed: true, reasons: [] });
    expect(gatewayListing(row, 'IRR', { provider: 'zibal_test' }, 'iran', { isPlatformAdmin: false }).reasons).toEqual(['test']);
    expect(gatewayListing({ ...row, config: { open_to_customers: true } }, 'IRR', { provider: 'zibal_test' }, 'iran').listed).toBe(true);
    expect(gatewayListing(row, 'USD', { provider: 'zibal_test' }, 'international', { isPlatformAdmin: true }).listed).toBe(false);
  });
});

describe('the 2026-10-30 production probe, replayed', () => {
  // Zibal's own answers to the production server, with the sandbox merchant.
  const REQUEST = { message: 'success', result: 100, trackId: 4880984559 };
  const CALLBACK = { payment: 'pay-1', provider: 'zibal_test', success: '1', status: '2', trackId: '4880984559', orderId: 'pay-1' };
  const VERIFY = { message: 'success', result: 100, refNumber: null, paidAt: '2026-10-30T15:34:03.977000', status: 1, amount: 20000, orderId: 'pay-1', description: 'Plan topup', multiplexingInfos: [], cardNumber: null };
  const VERIFY_AGAIN = { message: 'previously verifed', result: 201 };
  const INQUIRY = { message: 'success', result: 100, refNumber: null, paidAt: '2026-10-30T15:34:03.977000', verifiedAt: '2026-10-30T15:34:04.335000', status: 1, amount: 20000, orderId: 'pay-1', wage: 0 };

  it('binds the callback Zibal sent (its fields after our own query) to the stored trackId', async () => {
    mockSequence(REQUEST);
    const started = await zibalTestProvider.createCheckoutSession({ provider: 'zibal_test' }, req);
    expect(started).toEqual({ paymentUrl: 'https://gateway.zibal.ir/start/4880984559', sessionId: '4880984559' });
    const payment = { provider_name: 'zibal_test', provider_ref: started.sessionId! };
    expect(providerRefMatchesIntent(payment, CALLBACK)).toEqual({ ok: true });
    expect(providerRefMatchesIntent(payment, { ...CALLBACK, trackId: '4880984560' }).ok).toBe(false);
    expect(buildBoundVerifyParams(payment, CALLBACK, 20000)).toMatchObject({ trackId: '4880984559', amount: '20000' });
  });

  it('verify 100 settles with Zibal\'s amount (the sandbox has no refNumber: the trackId is the reference)', async () => {
    const fetchMock = mockSequence(VERIFY);
    expect(await zibalTestProvider.verifyPayment!({ provider: 'zibal_test' }, { trackId: '4880984559' })).toEqual({
      verified: true, providerRef: '4880984559', amount: 20000, status: 'success',
    });
    expect(sent(fetchMock, 0)).toEqual({ merchant: 'zibal', trackId: 4880984559 });
  });

  it('a verify whose answer was lost: 201 with no amount, then the inquiry gives it', async () => {
    mockSequence(VERIFY_AGAIN, INQUIRY);
    expect(await zibalTestProvider.verifyPayment!({ provider: 'zibal_test' }, { trackId: '4880984559' })).toEqual({
      verified: true, providerRef: '4880984559', amount: 20000, status: 'already_verified',
    });
  });

  it('the unpaid payment: verify 202 ends it', async () => {
    mockSequence({ message: 'transaction failed', result: 202 });
    expect(await zibalTestProvider.verifyPayment!({ provider: 'zibal_test' }, { trackId: '4880984559' })).toEqual({
      verified: false, providerRef: '4880984559', status: 'failed',
    });
  });
});
