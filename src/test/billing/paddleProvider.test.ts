import { describe, it, expect, vi, afterEach } from 'vitest';
import { paddleProvider } from '../../../server/services/billing/providers/paddle.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const MOCK_API_KEY = 'mock-paddle-key-not-real';

const config: BillingProviderConfig = { provider: 'paddle', sandbox: true, api_key: MOCK_API_KEY };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'pri_01mockpriceid',
  interval: 'monthly',
  currency: 'usd',
  callbackUrl: 'https://app.test.localhost/callback',
  customerEmail: 'buyer@test.localhost',
  customerName: 'Test Buyer',
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

function firstCall(fn: ReturnType<typeof mockFetch>) {
  const call = fn.mock.calls[0] as unknown as [string, { method?: string; headers: Record<string, string>; body?: string }];
  return { url: call[0], init: call[1] };
}

afterEach(() => vi.unstubAllGlobals());

describe('paddle createCheckoutSession', () => {
  it('returns the checkout url and transaction id, request payload unchanged', async () => {
    const fetchMock = mockFetch(200, {
      data: { id: 'txn_01mock', checkout: { url: 'https://sandbox-checkout.paddle.com/pay/txn_01mock' } },
    });
    const result = await paddleProvider.createCheckoutSession(config, req);

    expect(result.paymentUrl).toBe('https://sandbox-checkout.paddle.com/pay/txn_01mock');
    expect(result.sessionId).toBe('txn_01mock');

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://sandbox-api.paddle.com/transactions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${MOCK_API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ price_id: 'pri_01mockpriceid', quantity: 1 }],
      checkout: { url: 'https://app.test.localhost/callback' },
      custom_data: { workspace_id: 'ws-1' },
      currency_code: 'USD',
      customer: { email: 'buyer@test.localhost' },
    });
  });

  it('keeps the existing fallback checkout url when the response has no checkout object', async () => {
    mockFetch(200, { data: { id: 'txn_02mock' } });
    const result = await paddleProvider.createCheckoutSession(config, req);
    expect(result.paymentUrl).toBe('https://checkout.paddle.com/pay/txn_02mock');
    expect(result.sessionId).toBe('txn_02mock');
  });

  it('keeps the fallback url when checkout.url has the wrong type', async () => {
    mockFetch(200, { data: { id: 'txn_03mock', checkout: { url: 42 } } });
    const result = await paddleProvider.createCheckoutSession(config, req);
    expect(result.paymentUrl).toBe('https://checkout.paddle.com/pay/txn_03mock');
  });

  it('throws the provider error detail on an error envelope', async () => {
    mockFetch(400, { error: { code: 'invalid_price', detail: 'Price not found' } });
    await expect(paddleProvider.createCheckoutSession(config, req)).rejects.toThrow('Price not found');
  });

  it('falls back to the generic message when the error envelope has no detail', async () => {
    mockFetch(400, { error: { code: 'invalid_price' } });
    await expect(paddleProvider.createCheckoutSession(config, req)).rejects.toThrow('Paddle checkout failed');
  });

  it.each([
    ['null body', null],
    ['missing data', {}],
    ['missing id', { data: { checkout: { url: 'https://x.test' } } }],
    ['wrong id type', { data: { id: 123, checkout: { url: 'https://x.test' } } }],
    ['empty id', { data: { id: '' } }],
  ])('rejects malformed success response: %s', async (_label, body) => {
    mockFetch(200, body);
    await expect(paddleProvider.createCheckoutSession(config, req)).rejects.toThrow('Paddle checkout failed');
  });

  it('does not leak the api key, authorization header or request body in the error', async () => {
    mockFetch(200, { data: {} });
    await expect(paddleProvider.createCheckoutSession(config, req)).rejects.toSatisfy((e: Error) => {
      return !e.message.includes(MOCK_API_KEY)
        && !e.message.includes('Bearer')
        && !e.message.includes('price_id');
    });
  });
});

describe('paddle testConnection', () => {
  it('succeeds on a valid event-types response', async () => {
    const fetchMock = mockFetch(200, { data: [{ name: 'transaction.completed' }] });
    const result = await paddleProvider.testConnection?.(config);
    expect(result?.success).toBe(true);
    expect(firstCall(fetchMock).url).toBe('https://sandbox-api.paddle.com/event-types');
  });

  it('fails with the provider detail on an error envelope', async () => {
    mockFetch(403, { error: { code: 'forbidden', detail: 'Invalid API key' } });
    const result = await paddleProvider.testConnection?.(config);
    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Invalid API key');
  });

  it('treats a malformed body without an error envelope as reachable', async () => {
    mockFetch(200, null);
    const result = await paddleProvider.testConnection?.(config);
    expect(result?.success).toBe(true);
  });

  it('fails without leaking the api key when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await paddleProvider.testConnection?.(config);
    expect(result?.success).toBe(false);
    expect(result?.error).not.toContain(MOCK_API_KEY);
  });
});
