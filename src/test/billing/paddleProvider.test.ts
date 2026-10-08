import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { paddleProvider } from '../../../server/services/billing/providers/paddle.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const MOCK_API_KEY = 'mock-paddle-key-not-real';

const config: BillingProviderConfig = {
  provider: 'paddle',
  sandbox: true,
  api_key: MOCK_API_KEY,
  client_token: 'test_client_token',
};

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-uuid',
  interval: 'monthly',
  currency: 'usd',
  callbackUrl: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle',
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

describe('paddle createCheckoutSession', () => {
  it('creates a transaction priced at exactly the invoice amount, tax-inclusive, naming workspace, intent and invoice', async () => {
    const fetchMock = mockFetch(200, {
      data: { id: 'txn_01mock', checkout: { url: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle&_ptxn=txn_01mock' } },
    });
    const result = await paddleProvider.createCheckoutSession(config, req);

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://sandbox-api.paddle.com/transactions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${MOCK_API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{
        quantity: 1,
        price: {
          description: 'Pro (monthly) — invoice AB12345678',
          name: 'Pro (monthly) — invoice AB12345678',
          // Lowest denomination, as Paddle wants it: $29.00.
          unit_price: { amount: '2900', currency_code: 'USD' },
          // The customer pays the quoted price; Paddle takes its tax out of it.
          tax_mode: 'internal',
          product: { name: 'Pro (monthly) — invoice AB12345678', tax_category: 'standard' },
        },
      }],
      currency_code: 'USD',
      collection_mode: 'automatic',
      custom_data: { workspace_id: 'ws-1', intent_id: 'pi-1', invoice_id: 'inv-1' },
      checkout: { url: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle' },
    });

    expect(result).toEqual({
      paymentUrl: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle&_ptxn=txn_01mock',
      sessionId: 'txn_01mock',
      clientCheckout: {
        provider: 'paddle',
        transactionId: 'txn_01mock',
        clientToken: 'test_client_token',
        environment: 'sandbox',
        successUrl: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle&_ptxn=txn_01mock',
        customerEmail: 'buyer@test.localhost',
      },
    });
  });

  it('attaches the price to the configured catalog product when one is set', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_p' } });
    await paddleProvider.createCheckoutSession({ ...config, product_id: 'pro_01abc' }, req);
    const price = JSON.parse(firstCall(fetchMock).init.body as string).items[0].price;
    expect(price.product_id).toBe('pro_01abc');
    expect(price.product).toBeUndefined();
  });

  it('never sends a customer object (not a create-transaction field) — the e-mail is prefilled in Paddle.js', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_e' } });
    await paddleProvider.createCheckoutSession(config, req);
    expect(JSON.parse(firstCall(fetchMock).init.body as string).customer).toBeUndefined();
  });

  it('builds the return URL itself when Paddle sends no checkout url', async () => {
    mockFetch(200, { data: { id: 'txn_02mock' } });
    const result = await paddleProvider.createCheckoutSession(config, req);
    expect(result.paymentUrl).toBe('https://app.test.localhost/pay?intent=pi-1&provider=paddle&_ptxn=txn_02mock');
    expect(result.sessionId).toBe('txn_02mock');
  });

  it('uses production for a live configuration', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_live' } });
    const result = await paddleProvider.createCheckoutSession({ ...config, sandbox: false }, req);
    expect(firstCall(fetchMock).url).toBe('https://api.paddle.com/transactions');
    expect(result.clientCheckout?.environment).toBe('production');
  });

  it('refuses a checkout it could not open: no client-side token', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_x' } });
    await expect(paddleProvider.createCheckoutSession({ ...config, client_token: '' }, req))
      .rejects.toThrow('Paddle client-side token is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['IRR'], ['XYZ']])('refuses %s before calling Paddle', async (currency) => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_x' } });
    await expect(paddleProvider.createCheckoutSession(config, { ...req, currency })).rejects.toThrow(/Paddle cannot charge/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a missing amount', async () => {
    mockFetch(200, { data: { id: 'txn_x' } });
    await expect(paddleProvider.createCheckoutSession(config, { ...req, metadata: {} }))
      .rejects.toThrow('Paddle checkout needs a positive amount');
  });

  it('throws the provider error detail on an error envelope', async () => {
    mockFetch(400, { error: { code: 'invalid_field', detail: 'Invalid price' } });
    await expect(paddleProvider.createCheckoutSession(config, req)).rejects.toThrow('Invalid price');
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
        && !e.message.includes('unit_price');
    });
  });
});

describe('paddle verifyPayment (server-to-server transaction lookup)', () => {
  const txn = (status: string) => ({
    data: { id: 'txn_1', status, currency_code: 'USD', details: { totals: { total: '2900', tax: '483', subtotal: '2417' } } },
  });

  it.each([['paid'], ['completed']])('a %s transaction is the payment, with Paddle’s total and currency', async (status) => {
    const fetchMock = mockFetch(200, txn(status));
    const out = await paddleProvider.verifyPayment!(config, { _ptxn: 'txn_1', amount: '2900' });
    expect(firstCall(fetchMock).url).toBe('https://sandbox-api.paddle.com/transactions/txn_1');
    expect(out).toEqual({ verified: true, providerRef: 'txn_1', amount: 2900, currency: 'USD', paymentId: 'txn_1', status: 'paid' });
  });

  it('a canceled transaction is definitive', async () => {
    mockFetch(200, txn('canceled'));
    expect(await paddleProvider.verifyPayment!(config, { _ptxn: 'txn_1' })).toEqual({
      verified: false, providerRef: 'txn_1', status: 'canceled',
    });
  });

  it.each([['draft'], ['ready'], ['billed'], ['past_due']])('a %s transaction is still pending', async (status) => {
    mockFetch(200, txn(status));
    expect((await paddleProvider.verifyPayment!(config, { _ptxn: 'txn_1' })).status).toBe('pending');
  });

  it('a Paddle error or network failure is not a verdict', async () => {
    mockFetch(404, { error: { code: 'not_found', detail: 'nope' } });
    expect((await paddleProvider.verifyPayment!(config, { _ptxn: 'txn_1' })).status).toBe('pending');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect((await paddleProvider.verifyPayment!(config, { _ptxn: 'txn_1' })).status).toBe('pending');
  });

  it('without a transaction reference nothing is looked up', async () => {
    const fetchMock = mockFetch(200, txn('paid'));
    expect(await paddleProvider.verifyPayment!(config, {})).toEqual({ verified: false, providerRef: '', status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('paddle verifyWebhook event mapping', () => {
  const secret = 'pdl_ntfset_secret';
  function signed(event: unknown) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
    return { body, headers: { 'paddle-signature': `ts=${ts};h1=${h1}` } };
  }
  const map = async (event: unknown) => {
    const { body, headers } = signed(event);
    return paddleProvider.verifyWebhook({ ...config, webhook_secret: secret }, headers, body);
  };
  const transaction = {
    id: 'txn_1',
    status: 'completed',
    customer_id: 'ctm_1',
    currency_code: 'EUR',
    custom_data: { workspace_id: 'ws-1', intent_id: 'pi-1', invoice_id: 'inv-1' },
    details: { totals: { total: '4900' } },
  };

  it.each([['transaction.paid'], ['transaction.completed']])('%s settles the intent in custom_data', async (type) => {
    const event = await map({ event_id: 'evt_1', event_type: type, data: transaction });
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      providerEventId: 'evt_1',
      workspaceId: 'ws-1',
      intentId: 'pi-1',
      providerRef: 'txn_1',
      providerPaymentId: 'txn_1',
      amount: 4900,
      currency: 'EUR',
    });
  });

  it('a failed payment attempt fails nothing: the checkout stays open for a retry', async () => {
    const event = await map({ event_id: 'evt_2', event_type: 'transaction.payment_failed', data: transaction });
    expect(event?.type).toBe('ignored');
  });

  it('an approved refund adjustment is recorded against its transaction', async () => {
    const event = await map({
      event_id: 'evt_3',
      event_type: 'adjustment.updated',
      data: { id: 'adj_1', action: 'refund', status: 'approved', transaction_id: 'txn_1', currency_code: 'EUR', totals: { total: '1000' } },
    });
    expect(event).toMatchObject({
      type: 'refund_processed', providerPaymentId: 'txn_1', amount: 1000, currency: 'EUR', refundId: 'adj_1',
    });
  });

  it('created-approved and updated-approved for one adjustment are ONE refund event (keyed by the adjustment)', async () => {
    const adjustment = { id: 'adj_9', action: 'refund', status: 'approved', transaction_id: 'txn_1', currency_code: 'EUR', totals: { total: '1000' } };
    const created = await map({ event_id: 'evt_a', event_type: 'adjustment.created', data: adjustment });
    const updated = await map({ event_id: 'evt_b', event_type: 'adjustment.updated', data: adjustment });
    expect(created?.providerEventId).toBe('adjustment_adj_9_approved');
    expect(updated?.providerEventId).toBe(created?.providerEventId);
    expect(updated).toMatchObject({ type: 'refund_processed', refundId: 'adj_9' });
  });

  it.each([
    ['pending approval', { action: 'refund', status: 'pending_approval' }],
    ['a credit, not a refund', { action: 'credit', status: 'approved' }],
  ])('an adjustment that is %s moves no money', async (_label, fields) => {
    const event = await map({ event_id: 'evt_4', event_type: 'adjustment.created', data: { id: 'adj_2', transaction_id: 'txn_1', ...fields } });
    expect(event?.type).toBe('ignored');
  });
});

describe('paddle closeCheckout (a superseded checkout)', () => {
  it('cancels the transaction, which closes its checkout', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_old', status: 'canceled' } });
    expect(await paddleProvider.closeCheckout!(config, 'txn_old')).toBe(true);
    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://sandbox-api.paddle.com/transactions/txn_old');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'canceled' });
  });

  it('reports a transaction Paddle refuses to cancel (already paid) as not closed', async () => {
    mockFetch(400, { error: { code: 'transaction_immutable', detail: 'Transaction is billed' } });
    expect(await paddleProvider.closeCheckout!(config, 'txn_paid')).toBe(false);
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

describe('paddle cancelSubscription', () => {
  const cancel = paddleProvider.cancelSubscription!;

  it('succeeds and sends the unchanged request contract', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'sub_01mock', status: 'canceled' } });
    const result = await cancel(config, 'sub_01mock');
    expect(result).toEqual({ success: true });

    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://sandbox-api.paddle.com/subscriptions/sub_01mock/cancel');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Authorization': `Bearer ${MOCK_API_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ effective_from: 'next_billing_period' });
  });

  it('uses the production base url when sandbox is off', async () => {
    const fetchMock = mockFetch(200, {});
    await cancel({ ...config, sandbox: false }, 'sub_02mock');
    expect(firstCall(fetchMock).url).toBe('https://api.paddle.com/subscriptions/sub_02mock/cancel');
  });

  it('reports failure for a valid paddle error envelope', async () => {
    mockFetch(400, { error: { code: 'subscription_update_error', detail: 'Subscription is already canceled' } });
    await expect(cancel(config, 'sub_01mock')).resolves.toEqual({ success: false });
  });

  it('reports failure when error detail is missing', async () => {
    mockFetch(400, { error: {} });
    await expect(cancel(config, 'sub_01mock')).resolves.toEqual({ success: false });
  });

  it.each([
    ['empty object', {}],
    ['array', []],
    ['string', 'not json object'],
  ])('treats malformed body (%s) without error as success, as before', async (_label, body) => {
    await mockFetch(200, body);
    await expect(cancel(config, 'sub_01mock')).resolves.toEqual({ success: true });
  });

  it('keeps the previous throwing behaviour for a null json body', async () => {
    mockFetch(200, null);
    await expect(cancel(config, 'sub_01mock')).rejects.toBeInstanceOf(TypeError);
  });

  it('propagates network failures without retrying', async () => {
    const fn = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fn);
    await expect(cancel(config, 'sub_01mock')).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not leak secrets in the failure result', async () => {
    mockFetch(400, { error: { detail: 'Subscription is already canceled' } });
    const result = await cancel(config, 'sub_01mock');
    expect(JSON.stringify(result)).not.toContain(MOCK_API_KEY);
    expect(JSON.stringify(result)).not.toContain('Authorization');
  });
});
