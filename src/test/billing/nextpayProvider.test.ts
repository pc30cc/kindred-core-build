import { describe, it, expect, vi, afterEach } from 'vitest';
import { nextpayProvider } from '../../../server/services/billing/providers/nextpay.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const config: BillingProviderConfig = { provider: 'nextpay', api_key: 'mock-api-key-not-real' };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://app.test.localhost/callback',
  customerEmail: 'buyer@test.localhost',
  customerName: 'Test Buyer',
  metadata: { amount: '250000', phone: '09000000000' },
};

function mockFetch(body: unknown) {
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('nextpay createCheckoutSession', () => {
  it('builds the checkout url from trans_id on code -1', async () => {
    const fetchMock = mockFetch({ code: -1, trans_id: 'tx-123' });
    const result = await nextpayProvider.createCheckoutSession(config, req);

    expect(result).toEqual({
      paymentUrl: 'https://nextpay.org/nx/gateway/payment/tx-123',
      sessionId: 'tx-123',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://nextpay.org/nx/gateway/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(init.body);
    expect(Object.keys(payload).sort()).toEqual(['amount', 'api_key', 'callback_uri', 'customer_phone', 'order_id', 'payer_name']);
    expect(payload.amount).toBe(250000);
    expect(payload.callback_uri).toBe('https://app.test.localhost/callback');
    expect(payload.order_id).toMatch(/^ws-1_plan-pro_\d+$/);
    expect(payload.customer_phone).toBe('09000000000');
    expect(payload.payer_name).toBe('Test Buyer');
  });

  it('accepts a numeric trans_id exactly as before', async () => {
    mockFetch({ code: -1, trans_id: 12345 });
    const result = await nextpayProvider.createCheckoutSession(config, req);
    expect(result.paymentUrl).toBe('https://nextpay.org/nx/gateway/payment/12345');
    expect(result.sessionId).toBe('12345');
  });

  it.each([
    ['provider failure code', { code: 0, trans_id: 'tx-1' }],
    ['string -1 is not success', { code: '-1', trans_id: 'tx-1' }],
    ['missing code', { trans_id: 'tx-1' }],
    ['wrong code type', { code: true, trans_id: 'tx-1' }],
    ['null body', null],
    ['empty object', {}],
    ['array body', []],
    ['primitive body', 'oops'],
  ])('throws on %s without producing a url', async (_label, body) => {
    mockFetch(body);
    await expect(nextpayProvider.createCheckoutSession(config, req)).rejects.toThrow(/NextPay error/);
  });

  it.each([
    ['missing trans_id', { code: -1 }],
    ['object trans_id', { code: -1, trans_id: { id: 1 } }],
    ['boolean trans_id', { code: -1, trans_id: true }],
    ['empty trans_id', { code: -1, trans_id: '' }],
  ])('throws on %s instead of building a broken url', async (_label, body) => {
    mockFetch(body);
    await expect(nextpayProvider.createCheckoutSession(config, req)).rejects.toThrow('NextPay error: missing trans_id');
  });

  it('never leaks the api key or customer data in errors', async () => {
    mockFetch({ code: 0 });
    const error = await nextpayProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    const message = String((error as Error).message);
    expect(message).not.toContain('mock-api-key-not-real');
    expect(message).not.toContain('buyer@test.localhost');
    expect(message).not.toContain('09000000000');
  });
});

describe('nextpay testConnection', () => {
  it('reports invalid api key on code -2', async () => {
    mockFetch({ code: -2 });
    const result = await nextpayProvider.testConnection(config);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});

const verifyParams = { trans_id: 'tx-123', amount: '250000' };

describe('nextpay verifyPayment', () => {
  it('verifies a successful payment and posts the exact payload', async () => {
    const fetchMock = mockFetch({ code: 0, Shaparak_Ref_Id: 'shp-9' });
    const result = await nextpayProvider.verifyPayment!(config, verifyParams);
    expect(result).toEqual({ verified: true, providerRef: 'shp-9', amount: 250000, status: 'success' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://nextpay.org/nx/gateway/verify');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ api_key: 'mock-api-key-not-real', trans_id: 'tx-123', amount: 250000 });
  });

  it('stringifies a numeric shaparak reference', async () => {
    mockFetch({ code: 0, Shaparak_Ref_Id: 987654 });
    expect((await nextpayProvider.verifyPayment!(config, verifyParams)).providerRef).toBe('987654');
  });

  it('falls back to trans_id when the reference is missing', async () => {
    mockFetch({ code: 0 });
    const result = await nextpayProvider.verifyPayment!(config, verifyParams);
    expect(result).toEqual({ verified: true, providerRef: 'tx-123', amount: 250000, status: 'success' });
  });

  it.each([
    ['positive code', { code: 12 }],
    ['negative code', { code: -1 }],
    ["string '0'", { code: '0' }],
    ['boolean code', { code: true }],
    ['object code', { code: {} }],
    ['missing code', { Shaparak_Ref_Id: 'shp-1' }],
    ['empty object', {}],
    ['array body', []],
    ['primitive body', 'oops'],
  ])('keeps %s as failed', async (_label, body) => {
    mockFetch(body);
    const result = await nextpayProvider.verifyPayment!(config, verifyParams);
    expect(result.verified).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.amount).toBe(250000);
  });

  it.each([
    ['object reference', { code: 0, Shaparak_Ref_Id: { id: 1 } }],
    ['boolean reference', { code: 0, Shaparak_Ref_Id: true }],
    ['empty string reference', { code: 0, Shaparak_Ref_Id: '' }],
  ])('falls back to trans_id on %s', async (_label, body) => {
    mockFetch(body);
    expect((await nextpayProvider.verifyPayment!(config, verifyParams)).providerRef).toBe('tx-123');
  });

  it('throws on a null body like before', async () => {
    mockFetch(null);
    await expect(nextpayProvider.verifyPayment!(config, verifyParams)).rejects.toThrow(TypeError);
  });

  it('defaults amount to 0 when not provided', async () => {
    mockFetch({ code: 0, Shaparak_Ref_Id: 'shp-2' });
    expect((await nextpayProvider.verifyPayment!(config, { trans_id: 'tx-1' })).amount).toBe(0);
  });

  it('propagates network failures without retrying or leaking the api key', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fetchMock);
    const error = await nextpayProvider.verifyPayment!(config, verifyParams).catch((e: Error) => e);
    expect((error as Error).message).toBe('network down');
    expect((error as Error).message).not.toContain('mock-api-key-not-real');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('nextpay testConnection (continued)', () => {

  it('reports success on other codes', async () => {
    mockFetch({ code: -1, trans_id: 'tx-1' });
    expect((await nextpayProvider.testConnection(config)).success).toBe(true);
  });

  it.each([['null', null], ['empty', {}], ['array', []], ['string code', { code: '-2' }]])(
    'keeps malformed body (%s) as success like before',
    async (_label, body) => {
      mockFetch(body);
      expect((await nextpayProvider.testConnection(config)).success).toBe(true);
    },
  );

  it('returns failure on network error without leaking the api key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await nextpayProvider.testConnection(config);
    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
    expect(JSON.stringify(result)).not.toContain('mock-api-key-not-real');
  });
});
