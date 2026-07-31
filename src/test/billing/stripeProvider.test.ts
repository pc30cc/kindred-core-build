import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripeProvider } from '../../../server/services/billing/providers/stripe.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const SECRET = 'sk_test_MOCK_SECRET_VALUE';
const WEBHOOK_SECRET = 'whsec_MOCK_VALUE';
const config = { secret_key: SECRET, webhook_secret: WEBHOOK_SECRET } as unknown as BillingProviderConfig;

const checkoutReq: CheckoutRequest = {
  workspaceId: 'ws_123',
  planId: 'price_abc',
  currency: 'USD',
  callbackUrl: 'https://app.example.com/billing/callback',
  customerEmail: 'customer@example.com',
} as unknown as CheckoutRequest;

function mockJson(body: unknown, ok = true, status = ok ? 200 : 400) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('stripe createCheckoutSession', () => {
  it('sends the exact request contract and returns url + id', async () => {
    const fetchMock = mockJson({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const result = await stripeProvider.createCheckoutSession(config, checkoutReq);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);

    const params = new URLSearchParams(init.body);
    expect(Object.fromEntries(params.entries())).toEqual({
      mode: 'subscription',
      success_url: 'https://app.example.com/billing/callback?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://app.example.com/billing/callback',
      'line_items[0][price]': 'price_abc',
      'line_items[0][quantity]': '1',
      currency: 'usd',
      customer_email: 'customer@example.com',
      'metadata[workspace_id]': 'ws_123',
    });

    expect(result).toEqual({ paymentUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' });
  });

  it('omits customer_email when absent', async () => {
    const fetchMock = mockJson({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    await stripeProvider.createCheckoutSession(config, { ...checkoutReq, customerEmail: undefined } as CheckoutRequest);
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.has('customer_email')).toBe(false);
  });

  it('throws the stripe error message on HTTP failure', async () => {
    mockJson({ error: { message: 'No such price', type: 'invalid_request_error' } }, false);
    await expect(stripeProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('No such price');
  });

  it('falls back to a generic message on HTTP failure without a message', async () => {
    mockJson({ error: {} }, false);
    await expect(stripeProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('Stripe checkout failed');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['primitive', 42],
    ['array', []],
    ['empty object', {}],
    ['error wrong type', { error: 'boom' }],
    ['error.message wrong type', { error: { message: { a: 1 } } }],
  ])('HTTP failure with malformed body (%s) still throws generic error', async (_label, body) => {
    mockJson(body, false);
    await expect(stripeProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('Stripe checkout failed');
  });

  it.each([
    ['missing url', { id: 'cs_1' }],
    ['null url', { id: 'cs_1', url: null }],
    ['empty url', { id: 'cs_1', url: '' }],
    ['number url', { id: 'cs_1', url: 123 }],
    ['object url', { id: 'cs_1', url: { href: 'x' } }],
    ['null body', null],
    ['array body', []],
    ['primitive body', 'ok'],
  ])('fails explicitly when success body has no valid url (%s)', async (_label, body) => {
    mockJson(body);
    await expect(stripeProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('Stripe checkout failed');
  });

  it.each([
    ['missing id', { url: 'https://checkout.stripe.com/x' }],
    ['empty id', { id: '', url: 'https://checkout.stripe.com/x' }],
    ['number id', { id: 5, url: 'https://checkout.stripe.com/x' }],
    ['object id', { id: {}, url: 'https://checkout.stripe.com/x' }],
  ])('returns undefined sessionId when id is invalid (%s)', async (_label, body) => {
    mockJson(body);
    const result = await stripeProvider.createCheckoutSession(config, checkoutReq);
    expect(result.paymentUrl).toBe('https://checkout.stripe.com/x');
    expect(result.sessionId).toBeUndefined();
  });
});

describe('stripe getPortalUrl', () => {
  it('sends the exact portal request and returns the url', async () => {
    const fetchMock = mockJson({ id: 'bps_1', url: 'https://billing.stripe.com/session/abc' });
    const result = await stripeProvider.getPortalUrl!(config, 'cus_123', 'https://app.example.com/billing');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(init.body).entries())).toEqual({
      customer: 'cus_123',
      return_url: 'https://app.example.com/billing',
    });
    expect(result).toEqual({ url: 'https://billing.stripe.com/session/abc' });
  });

  it('throws the stripe error message on failure', async () => {
    mockJson({ error: { message: 'No such customer' } }, false);
    await expect(stripeProvider.getPortalUrl!(config, 'cus_123', 'https://app.example.com/billing'))
      .rejects.toThrow('No such customer');
  });

  it.each([
    ['null', null],
    ['empty object', {}],
    ['array', []],
    ['primitive', 7],
    ['malformed error', { error: [1] }],
  ])('falls back to generic message on failure body %s', async (_label, body) => {
    mockJson(body, false);
    await expect(stripeProvider.getPortalUrl!(config, 'cus_123', 'https://app.example.com/billing'))
      .rejects.toThrow('Portal session failed');
  });

  it.each([
    ['missing url', {}],
    ['empty url', { url: '' }],
    ['wrong type url', { url: 12 }],
  ])('fails explicitly when success body has no valid url (%s)', async (_label, body) => {
    mockJson(body);
    await expect(stripeProvider.getPortalUrl!(config, 'cus_123', 'https://app.example.com/billing'))
      .rejects.toThrow('Portal session failed');
  });

  it('propagates network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(stripeProvider.getPortalUrl!(config, 'cus_123', 'https://app.example.com/billing'))
      .rejects.toThrow('network down');
  });
});

describe('stripe testConnection', () => {
  it('hits GET /v1/balance and succeeds on a valid response', async () => {
    const fetchMock = mockJson({ object: 'balance', available: [] });
    const result = await stripeProvider.testConnection(config);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/balance');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(result.success).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.error).toBeUndefined();
  });

  it('returns the stripe error message on failure', async () => {
    mockJson({ error: { message: 'Invalid API Key provided' } }, false);
    const result = await stripeProvider.testConnection(config);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API Key provided');
  });

  it.each([
    ['error wrong type', { error: 'bad' }],
    ['null', null],
    ['array', []],
    ['primitive', 1],
  ])('returns undefined error for malformed failure body %s', async (_label, body) => {
    mockJson(body, false);
    const result = await stripeProvider.testConnection(config);
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns failure on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const result = await stripeProvider.testConnection(config);
    expect(result).toMatchObject({ success: false, error: 'ECONNRESET' });
  });
});

describe('stripe secret leakage', () => {
  it('never exposes secrets in errors or results across the three paths', async () => {
    const forbidden = [SECRET, WEBHOOK_SECRET, 'Bearer ', 'customer@example.com'];

    mockJson({ error: { message: 'No such price' } }, false);
    const createErr = await stripeProvider.createCheckoutSession(config, checkoutReq).catch((e: Error) => e.message);

    mockJson({ error: { message: 'No such customer' } }, false);
    const portalErr = await stripeProvider.getPortalUrl!(config, 'cus_123', 'https://app.example.com/billing')
      .catch((e: Error) => e.message);

    mockJson({ error: { message: 'Invalid API Key provided' } }, false);
    const test = await stripeProvider.testConnection(config);

    const blob = JSON.stringify([createErr, portalErr, test]);
    for (const needle of forbidden) expect(blob).not.toContain(needle);
  });
});

describe('stripe refundPayment', () => {
  it('sends the exact refund contract (partial refund with amount)', async () => {
    const fetchMock = mockJson({ id: 're_MOCK_1' });
    const out = await stripeProvider.refundPayment?.(config, 'pi_MOCK_1', 1500);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/refunds');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(Object.fromEntries(new URLSearchParams(init.body).entries())).toEqual({
      payment_intent: 'pi_MOCK_1',
      amount: '1500',
    });
    expect(out).toEqual({ success: true, refundId: 're_MOCK_1' });
  });

  it('omits amount for a full refund', async () => {
    const fetchMock = mockJson({ id: 're_MOCK_2' });
    await stripeProvider.refundPayment?.(config, 'pi_MOCK_2');
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.has('amount')).toBe(false);
    expect(params.get('payment_intent')).toBe('pi_MOCK_2');
  });

  it('omits amount when amount is 0 (falsy semantics preserved)', async () => {
    const fetchMock = mockJson({ id: 're_MOCK_3' });
    await stripeProvider.refundPayment?.(config, 'pi_MOCK_3', 0);
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).has('amount')).toBe(false);
  });

  it('returns undefined refundId for empty, missing or mistyped id', async () => {
    for (const body of [{ id: '' }, {}, { id: 12 }, { id: { a: 1 } }, { id: true }, { id: null }, [], 'str', 42]) {
      mockJson(body);
      expect(await stripeProvider.refundPayment?.(config, 'pi_MOCK_4')).toEqual({ success: true, refundId: undefined });
    }
  });

  it('returns undefined refundId when body is null', async () => {
    mockJson(null);
    expect(await stripeProvider.refundPayment?.(config, 'pi_MOCK_5')).toEqual({ success: true, refundId: undefined });
  });

  it('keeps success tied to response.ok only', async () => {
    mockJson({ error: { message: 'Charge already refunded.' } }, false);
    expect(await stripeProvider.refundPayment?.(config, 'pi_MOCK_6')).toEqual({ success: false, refundId: undefined });

    mockJson({}, false);
    expect(await stripeProvider.refundPayment?.(config, 'pi_MOCK_7')).toEqual({ success: false, refundId: undefined });

    mockJson({ error: 'weird' }, false);
    expect(await stripeProvider.refundPayment?.(config, 'pi_MOCK_8')).toEqual({ success: false, refundId: undefined });

    mockJson({ id: 're_MOCK_9' }, false);
    expect(await stripeProvider.refundPayment?.(config, 'pi_MOCK_9')).toEqual({ success: false, refundId: 're_MOCK_9' });
  });

  it('propagates network failures without retrying', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(stripeProvider.refundPayment?.(config, 'pi_MOCK_10')).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not leak the secret or payment identifier in the result', async () => {
    mockJson({ id: 're_MOCK_11' });
    const serialized = JSON.stringify(await stripeProvider.refundPayment?.(config, 'pi_MOCK_11', 1500));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain('pi_MOCK_11');
  });
});

describe('stripe getSubscriptionStatus', () => {
  const getStatus = stripeProvider.getSubscriptionStatus!;

  const okSub = {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_abc' } }] },
  };

  it('uses the exact request contract and maps the full adapter output', async () => {
    const fetchMock = mockJson(okSub);
    const result = await getStatus(config, 'sub_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${SECRET}` });

    expect(result).toEqual({
      active: true,
      status: 'active',
      providerSubscriptionId: 'sub_1',
      providerCustomerId: 'cus_1',
      currentPeriodStart: new Date(1700000000 * 1000).toISOString(),
      currentPeriodEnd: new Date(1702592000 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
  });

  it.each([
    ['active', 'active', true],
    ['trialing', 'trialing', true],
    ['past_due', 'past_due', false],
    ['canceled', 'canceled', false],
    ['unpaid', 'unpaid', false],
    ['incomplete', 'incomplete', false],
    ['paused', 'paused', false],
    ['incomplete_expired', 'none', false],
    ['ACTIVE', 'none', false],
    ['', 'none', false],
  ])('maps stripe status %s', async (raw, mapped, active) => {
    mockJson({ ...okSub, status: raw });
    const result = await getStatus(config, 'sub_1');
    expect(result.status).toBe(mapped);
    expect(result.active).toBe(active);
  });

  it.each([
    [undefined],
    [5],
    [true],
    [{ value: 'active' }],
  ])('falls back to none for non-string status %s', async (raw) => {
    mockJson({ ...okSub, status: raw });
    const result = await getStatus(config, 'sub_1');
    expect(result.status).toBe('none');
    expect(result.active).toBe(false);
  });

  it.each([
    [0],
    [-1000],
    ['1700000000'],
    [null],
  ])('preserves the *1000 conversion for period value %s', async (raw) => {
    mockJson({ ...okSub, current_period_start: raw, current_period_end: raw });
    const result = await getStatus(config, 'sub_1');
    expect(result.currentPeriodStart).toBe(new Date(Number(raw) * 1000).toISOString());
    expect(result.currentPeriodEnd).toBe(new Date(Number(raw) * 1000).toISOString());
  });

  it.each([
    [undefined],
    ['abc'],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [{}],
  ])('still throws RangeError for out-of-range period value %s', async (raw) => {
    mockJson({ ...okSub, current_period_start: raw });
    await expect(getStatus(config, 'sub_1')).rejects.toBeInstanceOf(RangeError);
  });

  it.each([
    [true, true],
    [false, false],
    [undefined, undefined],
    [null, undefined],
    ['true', undefined],
    [1, undefined],
    [{}, undefined],
  ])('reads cancel_at_period_end %s', async (raw, expected) => {
    mockJson({ ...okSub, cancel_at_period_end: raw });
    const result = await getStatus(config, 'sub_1');
    expect(result.cancelAtPeriodEnd).toBe(expected);
  });

  it.each([
    ['cus_1', 'cus_1'],
    ['', ''],
    [undefined, undefined],
    [null, undefined],
    [42, undefined],
    [{ id: 'cus_expanded' }, undefined],
  ])('reads customer %s', async (raw, expected) => {
    mockJson({ ...okSub, customer: raw });
    const result = await getStatus(config, 'sub_1');
    expect(result.providerCustomerId).toBe(expected);
  });

  it.each([
    ['sub_9', 'sub_9'],
    ['', ''],
    [undefined, undefined],
    [7, undefined],
    [{}, undefined],
  ])('reads subscription id %s', async (raw, expected) => {
    mockJson({ ...okSub, id: raw });
    const result = await getStatus(config, 'sub_1');
    expect(result.providerSubscriptionId).toBe(expected);
  });

  it.each([
    [{}],
    [{ items: 'x' }],
    [{ items: { data: [] } }],
    [{ items: { data: [null] } }],
    [{ items: { data: [{ price: 1 }] } }],
  ])('ignores items/price shapes %s (never surfaced by the adapter)', async (extra) => {
    mockJson({ ...okSub, ...extra });
    const result = await getStatus(config, 'sub_1');
    expect(result).not.toHaveProperty('planId');
  });

  it.each([
    [null],
    [undefined],
    ['plain'],
    [[]],
    [{}],
  ])('handles malformed body %s without leaking', async (body) => {
    mockJson(body);
    await expect(getStatus(config, 'sub_1')).rejects.toBeInstanceOf(RangeError);
  });

  it('returns the inactive/none envelope for HTTP failures', async () => {
    mockJson({ error: { message: 'No such subscription' } }, false, 404);
    const result = await getStatus(config, 'sub_missing');
    expect(result).toEqual({ active: false, status: 'none' });
  });

  it.each([
    [{ error: {} }],
    [{ error: 'oops' }],
    [null],
  ])('returns the same envelope for malformed errors %s', async (body) => {
    mockJson(body, false, 400);
    const result = await getStatus(config, 'sub_missing');
    expect(result).toEqual({ active: false, status: 'none' });
  });

  it('propagates network rejection without retrying', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getStatus(config, 'sub_1')).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never leaks the secret in the adapter output', async () => {
    mockJson(okSub);
    const result = await getStatus(config, 'sub_1');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(WEBHOOK_SECRET);
  });
});
