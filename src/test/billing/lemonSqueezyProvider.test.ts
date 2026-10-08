import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { lemonSqueezyProvider } from '../../../server/services/billing/providers/lemonsqueezy.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const MOCK_API_KEY = 'mock-ls-key-not-real';
const MOCK_STORE_ID = '12345';

const config: BillingProviderConfig = {
  provider: 'lemon_squeezy',
  sandbox: true,
  api_key: MOCK_API_KEY,
  store_id: MOCK_STORE_ID,
  variant_id: '67890',
};

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-uuid',
  interval: 'monthly',
  currency: 'usd',
  callbackUrl: 'https://app.test.localhost/pay?intent=pi-1&provider=lemon_squeezy',
  customerEmail: 'buyer@test.localhost',
  customerName: 'Test Buyer',
  intentId: 'pi-1',
  invoiceId: 'inv-1',
  description: 'Pro (monthly) — invoice AB12345678',
  // The invoice due, minor units: $29.00.
  metadata: { amount: '2900' },
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
  it('checks out the configured variant at exactly the invoice amount, naming workspace, intent and invoice', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T10:00:00.000Z'));
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
          // Cents of the store currency; the variant's own price is never charged.
          custom_price: 2900,
          checkout_data: {
            email: 'buyer@test.localhost',
            custom: { workspace_id: 'ws-1', intent_id: 'pi-1', invoice_id: 'inv-1' },
          },
          product_options: {
            redirect_url: 'https://app.test.localhost/pay?intent=pi-1&provider=lemon_squeezy',
            name: 'Pro (monthly) — invoice AB12345678',
          },
          // No discount code field: the customer pays the invoice, not a
          // price lowered at Lemon Squeezy.
          checkout_options: { discount: false },
          expires_at: '2026-10-08T10:30:00.000Z',
        },
        relationships: {
          store: { data: { type: 'stores', id: MOCK_STORE_ID } },
          // A platform plan id is not a Lemon Squeezy variant: the configured one is used.
          variant: { data: { type: 'variants', id: '67890' } },
        },
      },
    });
    vi.restoreAllMocks();
  });

  it('marks the checkout as a test in test mode', async () => {
    const fetchMock = mockFetch(201, { data: { id: 'co_t', attributes: { url: 'https://x' } } });
    await lemonSqueezyProvider.createCheckoutSession({ ...config, test_mode: true }, req);
    expect(JSON.parse(firstCall(fetchMock).init.body as string).data.attributes.test_mode).toBe(true);
  });

  it('refuses a currency other than the store’s (the store charges ONE currency)', async () => {
    const fetchMock = mockFetch(201, { data: { id: 'co_t', attributes: { url: 'https://x' } } });
    await expect(lemonSqueezyProvider.createCheckoutSession(config, { ...req, currency: 'EUR' }))
      .rejects.toThrow('Lemon Squeezy store sells in USD, not EUR');
    await expect(lemonSqueezyProvider.createCheckoutSession({ ...config, currency: 'EUR' }, { ...req, currency: 'EUR' }))
      .resolves.toMatchObject({ sessionId: 'co_t' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a checkout without a configured variant or amount', async () => {
    const fetchMock = mockFetch(201, { data: { id: 'co_t', attributes: { url: 'https://x' } } });
    await expect(lemonSqueezyProvider.createCheckoutSession({ ...config, variant_id: '' }, req))
      .rejects.toThrow('Lemon Squeezy variant is not configured');
    await expect(lemonSqueezyProvider.createCheckoutSession(config, { ...req, metadata: { amount: '0' } }))
      .rejects.toThrow('Lemon Squeezy checkout needs a positive amount');
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('lemon squeezy cancelSubscription', () => {
  const cancel = lemonSqueezyProvider.cancelSubscription!;
  const SUB_ID = 'sub_98765';

  it('succeeds on a body without errors and keeps the request contract', async () => {
    const fetchMock = mockFetch(200, {
      data: { type: 'subscriptions', id: SUB_ID, attributes: { status: 'cancelled' } },
    });
    const result = await cancel(config, SUB_ID);
    expect(result).toEqual({ success: true });

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe(`https://api.lemonsqueezy.com/v1/subscriptions/${SUB_ID}`);
    expect(init.method).toBe('DELETE');
    expect(init.headers).toEqual({
      'Authorization': `Bearer ${MOCK_API_KEY}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    });
    expect(init.body).toBeUndefined();
  });

  it('fails on a valid error envelope', async () => {
    mockFetch(404, { errors: [{ status: '404', title: 'Not found', detail: 'Subscription not found' }] });
    expect(await cancel(config, SUB_ID)).toEqual({ success: false });
  });

  it('fails on an error entry without detail', async () => {
    mockFetch(422, { errors: [{ title: 'Validation error' }] });
    expect(await cancel(config, SUB_ID)).toEqual({ success: false });
  });

  it.each([
    ['empty errors array', { errors: [] }, false],
    ['errors with wrong type', { errors: 'boom' }, false],
    ['empty object', {}, true],
    ['array body', [], true],
    ['string body', 'not json api', true],
  ])('keeps previous behaviour for %s', async (_label, body, expected) => {
    mockFetch(200, body);
    expect(await cancel(config, SUB_ID)).toEqual({ success: expected });
  });

  it('throws on a null body, as before', async () => {
    mockFetch(200, null);
    await expect(cancel(config, SUB_ID)).rejects.toThrow(TypeError);
  });

  it('propagates network failures without retrying', async () => {
    const fn = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fn);
    await expect(cancel(config, SUB_ID)).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not leak secrets in the failure path', async () => {
    mockFetch(404, { errors: [{ detail: 'Subscription not found' }] });
    const result = await cancel(config, SUB_ID);
    const text = JSON.stringify(result);
    expect(text).not.toContain(MOCK_API_KEY);
    expect(text).not.toContain('Authorization');
    expect(text).not.toContain('buyer@test.localhost');
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

describe('lemon squeezy verifyWebhook event mapping', () => {
  const secret = 'ls_webhook_secret';
  const map = async (event: unknown) => {
    const body = JSON.stringify(event);
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return lemonSqueezyProvider.verifyWebhook({ ...config, webhook_secret: secret }, { 'x-signature': sig }, body);
  };
  const meta = {
    event_name: 'order_created',
    custom_data: { workspace_id: 'ws-1', intent_id: 'pi-1', invoice_id: 'inv-1' },
  };
  const order = {
    type: 'orders',
    id: '1001',
    attributes: {
      status: 'paid', subtotal: 2900, discount_total: 0, tax: 0, total: 2900, tax_inclusive: false,
      currency: 'USD', customer_id: 77, refunded_amount: 0,
    },
  };
  const withAttributes = (attributes: Record<string, unknown>) => ({ ...order, attributes: { ...order.attributes, ...attributes } });

  it('a paid order settles the intent in custom_data, in cents', async () => {
    const event = await map({ meta, data: order });
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      providerEventId: 'order_created_1001',
      workspaceId: 'ws-1',
      intentId: 'pi-1',
      providerPaymentId: '1001',
      providerCustomerId: '77',
      amount: 2900,
      currency: 'USD',
    });
  });

  it('tax added on top of the price is not compared with the invoice: the pre-tax subtotal is, the charge is recorded', async () => {
    const event = await map({ meta, data: withAttributes({ subtotal: 2900, tax: 580, total: 3480 }) });
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      amount: 2900,
      charge: { total: 3480, tax: 580, currency: 'USD' },
    });
  });

  it('with tax-inclusive pricing the total is the price the invoice asked for', async () => {
    const event = await map({ meta, data: withAttributes({ subtotal: 2417, tax: 483, total: 2900, tax_inclusive: true }) });
    expect(event).toMatchObject({ amount: 2900, charge: { total: 2900, tax: 483 } });
  });

  it('a discount lowers the amount compared with the invoice (so it can never settle it in full)', async () => {
    const event = await map({ meta, data: withAttributes({ subtotal: 2900, discount_total: 500, tax: 480, total: 2880 }) });
    expect(event).toMatchObject({ amount: 2400 });
  });

  it('an order without a readable subtotal reports no amount (recorded for review, never settled)', async () => {
    const event = await map({ meta, data: withAttributes({ subtotal: 'n/a' }) });
    expect(event?.type).toBe('payment_succeeded');
    expect(event?.amount).toBeUndefined();
  });

  it('every partial refund of an order is its own event; a retry of one is the same event', async () => {
    const refund = (refunded: number) => map({
      meta: { ...meta, event_name: 'order_refunded' },
      data: withAttributes({ status: 'partial_refund', refunded_amount: refunded }),
    });
    const first = await refund(1000);
    const second = await refund(1500);
    const retry = await refund(1000);
    expect(first?.providerEventId).toBe('order_refunded_1001_1000');
    expect(second?.providerEventId).toBe('order_refunded_1001_1500');
    expect(retry?.providerEventId).toBe(first?.providerEventId);
    expect(second).toMatchObject({ type: 'refund_processed', refundedTotal: 1500 });
  });

  it('an order whose payment has not cleared is acknowledged, not applied', async () => {
    const event = await map({ meta, data: { ...order, attributes: { ...order.attributes, status: 'pending' } } });
    expect(event?.type).toBe('ignored');
  });

  it('a refunded order reports the running refunded total', async () => {
    const event = await map({
      meta: { ...meta, event_name: 'order_refunded' },
      data: { ...order, attributes: { ...order.attributes, status: 'refunded', refunded_amount: 2900 } },
    });
    expect(event).toMatchObject({ type: 'refund_processed', providerPaymentId: '1001', refundedTotal: 2900, intentId: 'pi-1' });
  });

  it('events this platform does not act on are acknowledged as ignored', async () => {
    const event = await map({ meta: { ...meta, event_name: 'license_key_created' }, data: { id: '5' } });
    expect(event?.type).toBe('ignored');
  });
});
