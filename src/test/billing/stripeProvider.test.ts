import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { stripeProvider } from '../../../server/services/billing/providers/stripe.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const SECRET = 'sk_test_MOCK_SECRET_VALUE';
const WEBHOOK_SECRET = 'whsec_MOCK_VALUE';
const config = { secret_key: SECRET, webhook_secret: WEBHOOK_SECRET } as unknown as BillingProviderConfig;

const checkoutReq: CheckoutRequest = {
  workspaceId: 'ws_123',
  planId: 'plan-uuid',
  interval: 'monthly',
  currency: 'USD',
  callbackUrl: 'https://app.example.com/billing/pay/invoice/inv_1?intent=pi_local_1&provider=stripe',
  customerEmail: 'customer@example.com',
  intentId: 'pi_local_1',
  invoiceId: 'inv_1',
  description: 'Pro (monthly) — invoice AB12345678',
  // The invoice due, minor units: $29.00.
  metadata: { amount: '2900', invoiceId: 'inv_1' },
} as unknown as CheckoutRequest;

function mockJson(body: unknown, ok = true, status = ok ? 200 : 400) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('stripe createCheckoutSession', () => {
  it('charges exactly the invoice amount as a one-time payment, with the intent in signed metadata', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const fetchMock = mockJson({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const result = await stripeProvider.createCheckoutSession(config, checkoutReq);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    // A retried create for the same intent returns the same session.
    expect(init.headers['Idempotency-Key']).toBe('checkout:pi_local_1');

    const params = new URLSearchParams(init.body);
    expect(Object.fromEntries(params.entries())).toEqual({
      // One payment per invoice — never a Stripe subscription keyed by a
      // platform plan id Stripe has never heard of.
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '2900',
      'line_items[0][price_data][product_data][name]': 'Pro (monthly) — invoice AB12345678',
      // The return URL already carries a query string: joined with "&".
      success_url:
        'https://app.example.com/billing/pay/invoice/inv_1?intent=pi_local_1&provider=stripe&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://app.example.com/billing/pay/invoice/inv_1?intent=pi_local_1&provider=stripe&canceled=1',
      expires_at: String(1_700_000_000 + 31 * 60),
      customer_email: 'customer@example.com',
      client_reference_id: 'pi_local_1',
      'metadata[workspace_id]': 'ws_123',
      'metadata[intent_id]': 'pi_local_1',
      'metadata[invoice_id]': 'inv_1',
      'payment_intent_data[metadata][workspace_id]': 'ws_123',
      'payment_intent_data[metadata][intent_id]': 'pi_local_1',
      'payment_intent_data[metadata][invoice_id]': 'inv_1',
    });

    expect(result).toEqual({ paymentUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' });
  });

  it('starts the query string when the return URL has none', async () => {
    const fetchMock = mockJson({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    await stripeProvider.createCheckoutSession(config, {
      ...checkoutReq,
      callbackUrl: 'https://app.example.com/billing/callback',
    } as CheckoutRequest);
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('success_url')).toBe('https://app.example.com/billing/callback?session_id={CHECKOUT_SESSION_ID}');
    expect(params.get('cancel_url')).toBe('https://app.example.com/billing/callback?canceled=1');
  });

  it('omits customer_email when absent', async () => {
    const fetchMock = mockJson({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    await stripeProvider.createCheckoutSession(config, { ...checkoutReq, customerEmail: undefined } as CheckoutRequest);
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.has('customer_email')).toBe(false);
  });

  it.each([
    ['IRR (never sent to Stripe)', 'IRR'],
    ['an unknown code', 'XYZ'],
  ])('refuses %s before calling Stripe', async (_label, currency) => {
    const fetchMock = mockJson({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    await expect(
      stripeProvider.createCheckoutSession(config, { ...checkoutReq, currency } as CheckoutRequest),
    ).rejects.toThrow(/Stripe cannot charge/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['0'], [''], ['-5'], ['12.5'], [undefined]])('refuses a missing or non-integer amount %s', async (amount) => {
    const fetchMock = mockJson({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    await expect(
      stripeProvider.createCheckoutSession(config, { ...checkoutReq, metadata: { amount } } as unknown as CheckoutRequest),
    ).rejects.toThrow('Stripe checkout needs a positive amount');
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('stripe verifyPayment (server-to-server session lookup)', () => {
  const session = {
    id: 'cs_1',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 2900,
    currency: 'usd',
    payment_intent: 'pi_stripe_1',
  };

  it('confirms a complete, paid session with Stripe’s own amount, currency and PaymentIntent', async () => {
    const fetchMock = mockJson(session);
    const out = await stripeProvider.verifyPayment!(config, { session_id: 'cs_1', amount: '2900' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(out).toEqual({
      verified: true,
      providerRef: 'cs_1',
      amount: 2900,
      currency: 'USD',
      paymentId: 'pi_stripe_1',
      status: 'paid',
    });
  });

  it('reads an expanded payment_intent object', async () => {
    mockJson({ ...session, payment_intent: { id: 'pi_expanded' } });
    const out = await stripeProvider.verifyPayment!(config, { session_id: 'cs_1' });
    expect(out.paymentId).toBe('pi_expanded');
  });

  it.each([
    ['open', 'unpaid'],
    ['complete', 'unpaid'],
  ])('a %s / %s session is pending — nothing is failed while the customer may still pay', async (status, payment) => {
    mockJson({ ...session, status, payment_status: payment });
    const out = await stripeProvider.verifyPayment!(config, { session_id: 'cs_1' });
    expect(out).toEqual({ verified: false, providerRef: 'cs_1', status: 'pending' });
  });

  it('an expired session is definitive', async () => {
    mockJson({ ...session, status: 'expired', payment_status: 'unpaid' });
    expect(await stripeProvider.verifyPayment!(config, { session_id: 'cs_1' })).toEqual({
      verified: false, providerRef: 'cs_1', status: 'expired',
    });
  });

  it('a return through cancel_url expires the still-open session so it cannot be paid later', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...session, status: 'open', payment_status: 'unpaid' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'cs_1', status: 'expired' }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await stripeProvider.verifyPayment!(config, { session_id: 'cs_1', canceled: '1' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1/expire');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(out).toEqual({ verified: false, providerRef: 'cs_1', status: 'canceled' });
  });

  it('a cancel_url return for a session that was paid meanwhile is still the payment', async () => {
    mockJson(session);
    const out = await stripeProvider.verifyPayment!(config, { session_id: 'cs_1', canceled: '1' });
    expect(out.verified).toBe(true);
  });

  it('a Stripe error is not a verdict on the payment', async () => {
    mockJson({ error: { message: 'boom' } }, false, 500);
    expect(await stripeProvider.verifyPayment!(config, { session_id: 'cs_1' })).toEqual({
      verified: false, providerRef: 'cs_1', status: 'pending',
    });
  });

  it('without a session reference nothing is looked up', async () => {
    const fetchMock = mockJson(session);
    expect(await stripeProvider.verifyPayment!(config, {})).toEqual({ verified: false, providerRef: '', status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('stripe verifyWebhook event mapping', () => {
  function signed(event: unknown) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
    return { body, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } };
  }
  const sessionObject = {
    id: 'cs_1',
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: 2900,
    currency: 'usd',
    customer: 'cus_1',
    payment_intent: 'pi_stripe_1',
    client_reference_id: 'pi_local_1',
    metadata: { workspace_id: 'ws_123', intent_id: 'pi_local_1', invoice_id: 'inv_1' },
  };
  const map = async (event: unknown) => {
    const { body, headers } = signed(event);
    return stripeProvider.verifyWebhook(config, headers, body);
  };

  it('a paid checkout.session.completed settles the intent in its metadata, in minor units', async () => {
    const event = await map({ id: 'evt_1', type: 'checkout.session.completed', data: { object: sessionObject } });
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      providerEventId: 'evt_1',
      workspaceId: 'ws_123',
      intentId: 'pi_local_1',
      providerRef: 'cs_1',
      providerPaymentId: 'pi_stripe_1',
      amount: 2900,
      currency: 'USD',
    });
  });

  it('falls back to client_reference_id for the intent', async () => {
    const event = await map({
      id: 'evt_2', type: 'checkout.session.completed',
      data: { object: { ...sessionObject, metadata: { workspace_id: 'ws_123' } } },
    });
    expect(event?.intentId).toBe('pi_local_1');
  });

  it('an unpaid completion (asynchronous payment pending) is acknowledged, not applied', async () => {
    const event = await map({
      id: 'evt_3', type: 'checkout.session.completed',
      data: { object: { ...sessionObject, payment_status: 'unpaid' } },
    });
    expect(event?.type).toBe('ignored');
  });

  it.each([
    ['checkout.session.async_payment_succeeded', 'payment_succeeded', undefined],
    ['checkout.session.async_payment_failed', 'payment_failed', 'failed'],
    ['checkout.session.expired', 'payment_failed', 'expired'],
  ])('%s → %s', async (type, mapped, status) => {
    const event = await map({ id: 'evt_4', type, data: { object: sessionObject } });
    expect(event?.type).toBe(mapped);
    expect(event?.intentId).toBe('pi_local_1');
    expect(event?.status).toBe(status);
  });

  it('charge.refunded reports the cumulative refund against the PaymentIntent the payment was recorded under', async () => {
    const event = await map({
      id: 'evt_5', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_stripe_1', amount: 2900, amount_refunded: 1000, currency: 'usd', metadata: {} } },
    });
    expect(event).toMatchObject({
      type: 'refund_processed',
      providerPaymentId: 'pi_stripe_1',
      refundedTotal: 1000,
      currency: 'USD',
    });
    expect(event?.amount).toBeUndefined();
  });

  it('an event type the platform does not act on is acknowledged as ignored', async () => {
    const event = await map({ id: 'evt_6', type: 'payment_intent.created', data: { object: { id: 'pi_1' } } });
    expect(event?.type).toBe('ignored');
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
