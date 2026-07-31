import { describe, it, expect, vi, afterEach } from 'vitest';
import { lemonSqueezyProvider } from '../../../server/services/billing/providers/lemonsqueezy.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const MOCK_API_KEY = 'mock-ls-key-not-real';
const MOCK_STORE_ID = '12345';

const config: BillingProviderConfig = {
  provider: 'lemon_squeezy',
  sandbox: true,
  api_key: MOCK_API_KEY,
  store_id: MOCK_STORE_ID,
};

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'var_67890',
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

describe('lemon squeezy createCheckoutSession', () => {
  it('returns the checkout url and id, request contract unchanged', async () => {
    const fetchMock = mockFetch(201, {
      data: { type: 'checkouts', id: 'co_01mock', attributes: { url: 'https://store.lemonsqueezy.com/checkout/co_01mock' } },
    });
    const result = await lemonSqueezyProvider.createCheckoutSession(config, req);
    expect(result).toEqual({
      paymentUrl: 'https://store.lemonsqueezy.com/checkout/co_01mock',
      sessionId: 'co_01mock',
    });

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://api.lemonsqueezy.com/v1/checkouts');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Authorization': `Bearer ${MOCK_API_KEY}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { email: 'buyer@test.localhost', custom: { workspace_id: 'ws-1' } },
          product_options: { redirect_url: 'https://app.test.localhost/callback' },
        },
        relationships: {
          store: { data: { type: 'stores', id: MOCK_STORE_ID } },
          variant: { data: { type: 'variants', id: 'var_67890' } },
        },
      },
    });
  });

  it('throws with errors[0].detail', async () => {
    mockFetch(422, { errors: [{ status: '422', title: 'Validation error', detail: 'variant_id is invalid' }] });
    await expect(lemonSqueezyProvider.createCheckoutSession(config, req)).rejects.toThrow('variant_id is invalid');
  });

  it('falls back to the provider message when detail is missing', async () => {
    mockFetch(422, { errors: [{ title: 'Validation error' }] });
    await expect(lemonSqueezyProvider.createCheckoutSession(config, req)).rejects.toThrow('Lemon Squeezy checkout failed');
  });

  it('treats an incomplete error envelope as failure, not success', async () => {
    mockFetch(500, { errors: 'boom' });
    await expect(lemonSqueezyProvider.createCheckoutSession(config, req)).rejects.toThrow('Lemon Squeezy checkout failed');
  });

  it.each([
    ['null body', null],
    ['string body', 'not json api'],
    ['array body', []],
    ['empty object', {}],
    ['missing data', { meta: {} }],
    ['missing attributes', { data: { id: 'co_01mock' } }],
    ['missing url', { data: { id: 'co_01mock', attributes: {} } }],
    ['wrong url type', { data: { id: 'co_01mock', attributes: { url: 42 } } }],
    ['missing id', { data: { attributes: { url: 'https://store.lemonsqueezy.com/checkout/x' } } }],
    ['wrong id type', { data: { id: 99, attributes: { url: 'https://store.lemonsqueezy.com/checkout/x' } } }],
  ])('rejects malformed success body (%s) instead of producing a fake url/id', async (_label, body) => {
    mockFetch(201, body);
    await expect(lemonSqueezyProvider.createCheckoutSession(config, req)).rejects.toThrow('Lemon Squeezy checkout failed');
  });

  it('does not leak secrets or customer data in the error', async () => {
    mockFetch(422, { errors: [{ detail: 'variant_id is invalid' }] });
    const err = await lemonSqueezyProvider.createCheckoutSession(config, req).catch((e: unknown) => e as Error);
    const text = `${(err as Error).message}\n${(err as Error).stack ?? ''}`;
    expect(text).not.toContain(MOCK_API_KEY);
    expect(text).not.toContain('Authorization');
    expect(text).not.toContain('buyer@test.localhost');
    expect(text).not.toContain('workspace_id');
  });
});

describe('lemon squeezy testConnection', () => {
  it('succeeds on a valid store response and keeps the endpoint', async () => {
    const fetchMock = mockFetch(200, { data: { type: 'stores', id: MOCK_STORE_ID, attributes: { name: 'Mock Store' } } });
    const result = await lemonSqueezyProvider.testConnection!(config);
    expect(result.success).toBe(true);
    const { url, init } = firstCall(fetchMock);
    expect(url).toBe(`https://api.lemonsqueezy.com/v1/stores/${MOCK_STORE_ID}`);
    expect(init.method).toBe('GET');
  });

  it('fails with the error detail', async () => {
    mockFetch(401, { errors: [{ detail: 'Unauthenticated.' }] });
    const result = await lemonSqueezyProvider.testConnection!(config);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unauthenticated.');
  });

  it('fails with undefined detail when the error entry has none', async () => {
    mockFetch(401, { errors: [{ title: 'Unauthorized' }] });
    const result = await lemonSqueezyProvider.testConnection!(config);
    expect(result).toMatchObject({ success: false, error: undefined });
  });

  it.each([
    ['null', null],
    ['empty object', {}],
    ['array', []],
  ])('treats malformed body without errors (%s) as success, as before', async (_label, body) => {
    mockFetch(200, body);
    const result = await lemonSqueezyProvider.testConnection!(config);
    expect(result.success).toBe(true);
  });

  it('returns failure without retrying on network errors', async () => {
    const fn = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fn);
    const result = await lemonSqueezyProvider.testConnection!(config);
    expect(result).toMatchObject({ success: false, error: 'network down' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not leak the api key in the failure result', async () => {
    mockFetch(401, { errors: [{ detail: 'Unauthenticated.' }] });
    const result = await lemonSqueezyProvider.testConnection!(config);
    expect(JSON.stringify(result)).not.toContain(MOCK_API_KEY);
  });
});
