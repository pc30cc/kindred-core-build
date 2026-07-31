import { describe, it, expect, vi, afterEach } from 'vitest';
import { craftgateProvider } from '../../../server/services/billing/providers/craftgate.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const MOCK_API_KEY = 'mock-api-key-not-real';
const MOCK_SECRET = 'mock-secret-key-not-real';

const config: BillingProviderConfig = {
  provider: 'craftgate',
  sandbox: true,
  api_key: MOCK_API_KEY,
  secret_key: MOCK_SECRET,
};

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-pro',
  interval: 'monthly',
  currency: 'TRY',
  callbackUrl: 'https://app.test.localhost/callback',
  customerEmail: 'buyer@test.localhost',
  customerName: 'Test Buyer',
  metadata: { amount: '149.90' },
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function lastRequest(fn: ReturnType<typeof mockFetch>) {
  const call = fn.mock.calls[0] as unknown as [string, { method?: string; headers: Record<string, string>; body?: string }];
  return { url: call[0], init: call[1] };
}

afterEach(() => vi.unstubAllGlobals());

describe('craftgate createCheckoutSession', () => {
  it('parses a valid success envelope and preserves the request payload', async () => {
    const fetchMock = mockFetch(200, { data: { pageUrl: 'https://sandbox-cpg.craftgate.io/p/abc', token: 'tok-abc' } });
    const result = await craftgateProvider.createCheckoutSession(config, req);

    expect(result.paymentUrl).toBe('https://sandbox-cpg.craftgate.io/p/abc');
    expect(result.sessionId).toBe('tok-abc');

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe('https://sandbox-api.craftgate.io/payment/v1/checkout-payments/init');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe(MOCK_API_KEY);
    expect(init.headers['x-auth-version']).toBe('v1');

    const payload = JSON.parse(init.body as string);
    expect(payload.price).toBe(149.9);
    expect(payload.paidPrice).toBe(149.9);
    expect(payload.currency).toBe('TRY');
    expect(payload.paymentGroup).toBe('SUBSCRIPTION_PAYMENT');
    expect(payload.callbackUrl).toBe('https://app.test.localhost/callback');
    expect(payload.conversationId).toMatch(/^ws-1_\d+$/);
    expect(payload.items).toEqual([{ name: 'Plan plan-pro', price: 149.9 }]);
  });

  it('throws the provider error description on a valid error envelope', async () => {
    mockFetch(400, { errors: { errorCode: '1001', errorDescription: 'Invalid price', errorGroup: 'VALIDATION' } });
    await expect(craftgateProvider.createCheckoutSession(config, req)).rejects.toThrow('Invalid price');
  });

  it('falls back to the generic failure message when the error envelope has no description', async () => {
    mockFetch(400, { errors: { errorGroup: 'VALIDATION' } });
    await expect(craftgateProvider.createCheckoutSession(config, req)).rejects.toThrow('Craftgate checkout failed');
  });

  it.each([
    ['null body', null],
    ['missing data', {}],
    ['missing token', { data: { pageUrl: 'https://sandbox-cpg.craftgate.io/p/abc' } }],
    ['missing pageUrl', { data: { token: 'tok-abc' } }],
    ['wrong pageUrl type', { data: { pageUrl: 123, token: 'tok-abc' } }],
    ['empty token', { data: { pageUrl: 'https://x.test', token: '' } }],
  ])('rejects malformed success response: %s', async (_label, body) => {
    mockFetch(200, body);
    await expect(craftgateProvider.createCheckoutSession(config, req)).rejects.toThrow('Craftgate checkout failed');
  });

  it('does not leak credentials or the request body in the thrown error', async () => {
    mockFetch(200, { data: {} });
    await expect(craftgateProvider.createCheckoutSession(config, req)).rejects.toSatisfy((e: Error) => {
      return !e.message.includes(MOCK_API_KEY)
        && !e.message.includes(MOCK_SECRET)
        && !e.message.includes('buyer@test.localhost')
        && !e.message.includes('callbackUrl');
    });
  });
});

describe('craftgate refundPayment', () => {
  it('reports success and the refund id from a valid envelope', async () => {
    mockFetch(200, { data: { id: 987654 } });
    const result = await craftgateProvider.refundPayment?.(config, '123456', 5000);
    expect(result).toEqual({ success: true, refundId: '987654' });
  });

  it('reports failure when the body carries an error envelope', async () => {
    mockFetch(400, { errors: { errorCode: '2001', errorDescription: 'Refund not allowed' } });
    const result = await craftgateProvider.refundPayment?.(config, '123456');
    expect(result?.success).toBe(false);
  });

  it('does not invent a refund id for a malformed body', async () => {
    mockFetch(200, { data: { id: {} } });
    const result = await craftgateProvider.refundPayment?.(config, '123456');
    expect(result).toEqual({ success: true, refundId: undefined });
  });
});

describe('craftgate testConnection', () => {
  it('succeeds on a valid installments response', async () => {
    mockFetch(200, { data: { installmentPrices: [] } });
    const result = await craftgateProvider.testConnection?.(config);
    expect(result?.success).toBe(true);
  });

  it('fails on a NOT_AUTHENTICATED error group', async () => {
    mockFetch(401, { errors: { errorGroup: 'NOT_AUTHENTICATED', errorDescription: 'bad key' } });
    const result = await craftgateProvider.testConnection?.(config);
    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Invalid credentials');
  });

  it('fails without leaking credentials when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await craftgateProvider.testConnection?.(config);
    expect(result?.success).toBe(false);
    expect(result?.error).not.toContain(MOCK_SECRET);
  });
});
