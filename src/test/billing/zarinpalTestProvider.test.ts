import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zarinpalTestProvider } from '../../../server/services/billing/providers/zarinpal-test';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

// The `zarinpal_test` gateway is the ZarinPal SANDBOX contract: same wire
// protocol as production, forced onto sandbox.zarinpal.com with a throwaway
// merchant id, and no local simulation of the gateway itself — only the
// external ZarinPal HTTP boundary is mocked, never our own billing pipeline.

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://api.example.com/api/billing/return?intent=abc&provider=zarinpal_test',
  metadata: { amount: '250000', phone: '09120000000' },
};

function mockJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify(body) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('zarinpal_test (sandbox) provider', () => {
  it('forces the sandbox endpoint and a valid throwaway merchant id when none is configured', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'S0000000000000000000000000000mock' } });
    const config: BillingProviderConfig = { provider: 'zarinpal_test' };
    const out = await zarinpalTestProvider.createCheckoutSession(config, req);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sandbox.zarinpal.com/pg/v4/payment/request.json');
    expect(JSON.parse(init.body).merchant_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(out.paymentUrl).toBe('https://sandbox.zarinpal.com/pg/StartPay/S0000000000000000000000000000mock');
    // Authority is stored on the intent by the caller (server/routes/billingCustomer.ts).
    expect(out.authority).toBe('S0000000000000000000000000000mock');
  });

  it('keeps an explicitly configured valid UUID merchant id, still routed to sandbox', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'S-mock' } });
    const config: BillingProviderConfig = {
      provider: 'zarinpal_test',
      merchant_id: '11111111-2222-3333-4444-555555555555',
    };
    await zarinpalTestProvider.createCheckoutSession(config, req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sandbox.zarinpal.com/pg/v4/payment/request.json');
    expect(JSON.parse(init.body).merchant_id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('maps a simulated ZarinPal callback (Status=OK + Authority) verify code 100 to success', async () => {
    mockJson({ data: { code: 100, ref_id: 987654321 } });
    const out = await zarinpalTestProvider.verifyPayment!(
      { provider: 'zarinpal_test' },
      { Authority: 'S0000000000000000000000000000mock', amount: '250000' },
    );
    expect(out).toEqual({ verified: true, providerRef: '987654321', amount: 250000, status: 'success' });
  });

  it('maps verify code 101 to already-verified success (replayed callback)', async () => {
    mockJson({ data: { code: 101, ref_id: '987654321' } });
    const out = await zarinpalTestProvider.verifyPayment!(
      { provider: 'zarinpal_test' },
      { Authority: 'S0000000000000000000000000000mock', amount: '250000' },
    );
    expect(out).toEqual({ verified: true, providerRef: '987654321', amount: 250000, status: 'already_verified' });
  });

  it('treats a canceled/failed sandbox authority as unverified, never as a settled payment', async () => {
    mockJson({ data: { code: -51 } });
    const out = await zarinpalTestProvider.verifyPayment!(
      { provider: 'zarinpal_test' },
      { Authority: 'S0000000000000000000000000000mock', amount: '250000' },
    );
    expect(out.verified).toBe(false);
    expect(out.status).toBe('failed');
  });
});
