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
