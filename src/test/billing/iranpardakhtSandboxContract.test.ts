import { describe, expect, it, vi } from 'vitest';
import { iranPardakhtSandboxProvider } from '../../../server/services/billing/providers/iranpardakht-sandbox';

describe('IranDargah sandbox contract', () => {
  it('creates a payment with TEST merchant and documented camelCase fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 200,
      message: 'ok',
      authority: '20230912094118ZY',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await iranPardakhtSandboxProvider.createCheckoutSession(
      { provider: 'iranpardakht_sandbox', currency: 'IRT' },
      {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        planId: 'pro',
        interval: 'monthly',
        currency: 'IRT',
        callbackUrl: 'https://example.com/callback',
        metadata: { amount: '5000', phone: '09120000000' },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith('https://dargaah.com/sandbox/payment', expect.objectContaining({
      method: 'POST',
      headers: expect.not.objectContaining({ Authorization: expect.anything() }),
    }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      merchantID: 'TEST',
      amount: 50_000,
      callbackURL: 'https://example.com/callback',
      mobile: '09120000000',
    });
    expect(result.paymentUrl).toBe('https://dargaah.com/sandbox/ird/startpay/20230912094118ZY');
    vi.unstubAllGlobals();
  });

  it('verifies with the documented verification payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 100,
      refId: '1234567890',
      orderId: 'ORDER-1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await iranPardakhtSandboxProvider.verifyPayment?.(
      { provider: 'iranpardakht_sandbox' },
      { code: '100', authority: 'AUTH-1', amount: '50000', orderId: 'ORDER-1' },
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://dargaah.com/sandbox/verification');
    expect(JSON.parse(String(request.body))).toEqual({
      merchantID: 'TEST', authority: 'AUTH-1', amount: 50_000, orderId: 'ORDER-1',
    });
    expect(result).toMatchObject({ verified: true, providerRef: '1234567890', status: 'success' });
    vi.unstubAllGlobals();
  });
});