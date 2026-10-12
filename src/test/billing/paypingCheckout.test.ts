/**
 * PayPing (providers/payping.ts) on its v3 API: v2 (/v2/pay, gotoipg) is
 * retired. Amounts are Toman: the Rial amount is divided by 10, exactly or
 * not at all; the callback's payment reference is verified together with
 * the STORED payment code and the server amount; 409 code 110 is "already
 * verified".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { paypingProvider, paypingToman } from '../../../server/services/billing/providers/payping.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const config: BillingProviderConfig = { provider: 'payping', bearer_token: 'mock-token-not-real' };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://api.test.localhost/api/billing/account-return?payment=p1&provider=payping',
  customerEmail: 'buyer@test.localhost',
  customerName: 'Test Buyer',
  intentId: 'pay-1',
  metadata: { amount: '250000' },
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('payping createCheckoutSession (v3)', () => {
  it('posts to /v3/pay in Toman and returns the start url and the payment code', async () => {
    const fetchMock = mockFetch(200, { paymentCode: 'pc-123', url: 'https://api.payping.ir/v3/pay/start/pc-123' });
    const result = await paypingProvider.createCheckoutSession(config, req);
    expect(result).toEqual({ paymentUrl: 'https://api.payping.ir/v3/pay/start/pc-123', sessionId: 'pc-123' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.payping.ir/v3/pay');
    expect(init.headers.Authorization).toBe('Bearer mock-token-not-real');
    expect(JSON.parse(init.body)).toEqual({
      amount: 25000,
      returnUrl: req.callbackUrl,
      payerIdentity: 'buyer@test.localhost',
      payerName: 'Test Buyer',
      description: 'Plan plan-pro',
      clientRefId: 'pay-1',
    });
  });

  it('builds the start url from the payment code when PayPing sends none', async () => {
    mockFetch(200, { paymentCode: 'pc-9' });
    expect((await paypingProvider.createCheckoutSession(config, req)).paymentUrl).toBe('https://api.payping.ir/v3/pay/start/pc-9');
  });

  it('refuses a Rial amount that is not whole Toman instead of charging it rounded', async () => {
    const fetchMock = mockFetch(200, { paymentCode: 'pc' });
    await expect(paypingProvider.createCheckoutSession(config, { ...req, metadata: { amount: '250005' } })).rejects.toThrow(/whole Toman/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(paypingToman(250000)).toBe(25000);
  });

  it('throws with PayPing\'s problem details on a non-2xx answer, without the token', async () => {
    mockFetch(400, { title: 'Bad Request', metaData: { code: 104, errors: [{ message: 'amount is invalid' }] } });
    const error = await paypingProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    expect((error as Error).message).toBe('PayPing error: HTTP 400 (104): amount is invalid');
    expect((error as Error).message).not.toContain('mock-token-not-real');
  });

  it.each([
    ['missing code', {}],
    ['wrong code type', { paymentCode: 12345 }],
    ['empty code', { paymentCode: '' }],
    ['null body', null],
  ])('rejects malformed success response: %s', async (_label, body) => {
    mockFetch(200, body);
    await expect(paypingProvider.createCheckoutSession(config, req)).rejects.toThrow('PayPing error: malformed response (missing payment code)');
  });
});

const verifyParams = { paymentCode: 'pc-123', paymentRefId: '987654', amount: '250000', status: '1' };

describe('payping verifyPayment (v3)', () => {
  it('verifies the payment code with its reference and the Toman amount', async () => {
    const fetchMock = mockFetch(200, { amount: 25000, paymentRefId: 987654, code: 'pc-123' });
    expect(await paypingProvider.verifyPayment!(config, verifyParams)).toEqual({
      verified: true, providerRef: '987654', amount: 250000, paymentId: '987654', status: 'success',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.payping.ir/v3/pay/verify');
    expect(JSON.parse(init.body)).toEqual({ paymentRefId: 987654, paymentCode: 'pc-123', amount: 25000 });
  });

  it('reports 409 code 110 as already_verified, with the amount PayPing recorded', async () => {
    mockFetch(409, { status: 409, metaData: { code: 110, message: { amount: 25000, paymentRefId: 987654 } } });
    expect(await paypingProvider.verifyPayment!(config, verifyParams)).toEqual({
      verified: true, providerRef: '987654', amount: 250000, paymentId: '987654', status: 'already_verified',
    });
  });

  it('keeps a payment that is still settling pending (202, 5xx)', async () => {
    for (const status of [202, 500, 502]) {
      mockFetch(status, {});
      expect((await paypingProvider.verifyPayment!(config, verifyParams)).status).toBe('pending');
    }
  });

  it('ends a payment PayPing refuses (4xx)', async () => {
    mockFetch(400, { metaData: { code: 15 } });
    expect(await paypingProvider.verifyPayment!(config, verifyParams)).toEqual({ verified: false, providerRef: 'pc-123', status: 'failed' });
  });

  it('a return without a payment reference (cancelled) is not sent to PayPing', async () => {
    const fetchMock = mockFetch(200, {});
    expect((await paypingProvider.verifyPayment!(config, { paymentCode: 'pc-123', amount: '250000', status: '0' })).status).toBe('canceled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payping testConnection', () => {
  it('succeeds only when PayPing answers a payment code', async () => {
    mockFetch(200, { paymentCode: 'pc' });
    expect((await paypingProvider.testConnection(config)).success).toBe(true);
    mockFetch(200, {});
    expect((await paypingProvider.testConnection(config)).success).toBe(false);
  });

  it('names an invalid token', async () => {
    mockFetch(401, {});
    expect((await paypingProvider.testConnection(config)).error).toMatch(/HTTP 401: the token is invalid/);
  });

  it('fails without a token, without calling PayPing', async () => {
    const fetchMock = mockFetch(200, { paymentCode: 'pc' });
    expect((await paypingProvider.testConnection({ provider: 'payping' })).error).toBe('PayPing: Bearer token is empty.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
