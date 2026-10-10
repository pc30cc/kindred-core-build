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
    const result = await paddleProvider.createCheckoutSession({ ...config, sandbox: false, client_token: 'live_client_token' }, req);
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

describe('paddle createCheckoutSession — card setup (recurring price, simple billing 3b)', () => {
  const setup: CheckoutRequest = {
    ...req,
    intentId: 'pay-setup-1',
    invoiceId: undefined,
    description: 'Pro (monthly)',
    metadata: { amount: '2900' },
    recurring: { interval: 'monthly' },
    priceCustomData: { plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 },
    cardSetup: true,
  };

  it('makes the price recur, carries its custom_data and marks the card setup', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_setup' } });
    const result = await paddleProvider.createCheckoutSession(config, setup);
    const { url, init } = firstCall(fetchMock);
    expect(url).toBe('https://sandbox-api.paddle.com/transactions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{
        quantity: 1,
        price: {
          description: 'Pro (monthly)',
          name: 'Pro (monthly)',
          unit_price: { amount: '2900', currency_code: 'USD' },
          tax_mode: 'internal',
          product: { name: 'Pro (monthly)', tax_category: 'standard' },
          billing_cycle: { interval: 'month', frequency: 1 },
          custom_data: { plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 },
        },
      }],
      currency_code: 'USD',
      collection_mode: 'automatic',
      custom_data: { workspace_id: 'ws-1', intent_id: 'pay-setup-1', card_setup: '1' },
    });
    // Opened by Paddle.js like any checkout.
    expect(result.clientCheckout).toMatchObject({ provider: 'paddle', transactionId: 'txn_setup', customerEmail: 'buyer@test.localhost' });
  });

  it('yearly recurs every year and reuses an earlier Paddle customer (no e-mail prefill then)', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_setup_y' } });
    const result = await paddleProvider.createCheckoutSession(config, {
      ...setup, recurring: { interval: 'yearly' }, customerId: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
    });
    const body = JSON.parse(firstCall(fetchMock).init.body as string);
    expect(body.items[0].price.billing_cycle).toEqual({ interval: 'year', frequency: 1 });
    expect(body.customer_id).toBe('ctm_01hv8wt8nffez4p2t6typn4a5j');
    expect(result.clientCheckout?.customerEmail).toBeUndefined();
  });

  it('the one-time request is byte-for-byte unchanged without the new options', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_once' } });
    await paddleProvider.createCheckoutSession(config, req);
    expect(firstCall(fetchMock).init.body).toBe(JSON.stringify({
      items: [{
        quantity: 1,
        price: {
          description: 'Pro (monthly) — invoice AB12345678',
          name: 'Pro (monthly) — invoice AB12345678',
          unit_price: { amount: '2900', currency_code: 'USD' },
          tax_mode: 'internal',
          product: { name: 'Pro (monthly) — invoice AB12345678', tax_category: 'standard' },
        },
      }],
      currency_code: 'USD',
      collection_mode: 'automatic',
      custom_data: { workspace_id: 'ws-1', intent_id: 'pi-1', invoice_id: 'inv-1' },
    }));
  });

  it('refuses an interval other than monthly or yearly before calling Paddle', async () => {
    const fetchMock = mockFetch(200, { data: { id: 'txn_x' } });
    await expect(paddleProvider.createCheckoutSession(config, { ...setup, recurring: { interval: 'weekly' as 'monthly' } }))
      .rejects.toThrow(/monthly or yearly/);
    expect(fetchMock).not.toHaveBeenCalled();
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
    ['a chargeback reversal', { action: 'chargeback_reverse', status: 'approved' }],
    ['a chargeback warning', { action: 'chargeback_warning', status: 'approved' }],
  ])('an adjustment that is %s moves no money', async (_label, fields) => {
    const event = await map({ event_id: 'evt_4', event_type: 'adjustment.created', data: { id: 'adj_2', transaction_id: 'txn_1', ...fields } });
    expect(event?.type).toBe('ignored');
  });

  it('an approved chargeback takes the money back like a refund, marked as a chargeback', async () => {
    const event = await map({
      event_id: 'evt_cb',
      event_type: 'adjustment.created',
      data: {
        id: 'adj_01hvgf2s84dr6reszzg29zbvcm', action: 'chargeback', type: 'full', status: 'approved',
        transaction_id: 'txn_01hv8wnvvtedwjrhfhpr9vkq9w', subscription_id: 'sub_01hchny8h8r5w9xtb514qs6rdy',
        customer_id: 'ctm_01hchnxgrh0wcyngy8q9d1hpkz', reason: 'Dispute lost', currency_code: 'USD',
        totals: { subtotal: '40000', tax: '7600', total: '47600', fee: '2430', earnings: '37570', currency_code: 'USD' },
      },
    });
    expect(event).toMatchObject({
      type: 'refund_processed',
      providerEventId: 'adjustment_adj_01hvgf2s84dr6reszzg29zbvcm_approved',
      refundId: 'adj_01hvgf2s84dr6reszzg29zbvcm',
      providerPaymentId: 'txn_01hv8wnvvtedwjrhfhpr9vkq9w',
      amount: 47600,
      currency: 'USD',
      chargeback: true,
    });
  });

  it('a refund is not marked as a chargeback', async () => {
    const event = await map({
      event_id: 'evt_rf', event_type: 'adjustment.updated',
      data: { id: 'adj_5', action: 'refund', status: 'approved', transaction_id: 'txn_1', currency_code: 'EUR', totals: { total: '1000' } },
    });
    expect(event?.chargeback).toBeUndefined();
  });
});

describe('paddle verifyWebhook — saved-card events (simple billing 3b)', () => {
  const secret = 'pdl_ntfset_secret';
  const map = async (event: unknown) => {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
    return paddleProvider.verifyWebhook({ ...config, webhook_secret: secret }, { 'paddle-signature': `ts=${ts};h1=${h1}` }, body);
  };
  const SUB = 'sub_01hv8x29kz0t586xy6zn1a62ny';
  // A renewal as Paddle sends it (its example transaction.past_due / completed
  // payloads, trimmed), carrying the custom_data Paddle copied from the
  // checkout through the subscription: intent_id included.
  const renewal = {
    id: 'txn_01hv8wnvvtedwjrhfhpr9vkq9w',
    status: 'completed',
    customer_id: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
    custom_data: { workspace_id: 'ws-1', intent_id: 'pay-setup-1', card_setup: '1' },
    currency_code: 'USD',
    origin: 'subscription_recurring',
    subscription_id: SUB,
    billing_period: { starts_at: '2026-11-08T10:00:00Z', ends_at: '2026-12-08T10:00:00Z' },
    items: [{
      price: {
        id: 'pri_01jcardrecurring0000000000', description: 'Pro (monthly)', name: 'Pro (monthly)',
        billing_cycle: { interval: 'month', frequency: 1 }, tax_mode: 'internal',
        unit_price: { amount: '2900', currency_code: 'USD' },
        custom_data: { plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 },
      },
      quantity: 1,
      proration: null,
    }],
    details: { totals: { subtotal: '2417', tax: '483', discount: '0', total: '2900', grand_total: '2900', credit: '0', balance: '0', currency_code: 'USD' } },
    payments: [{
      amount: '2900', status: 'captured', error_code: null, created_at: '2026-11-07T10:00:02.10Z', captured_at: '2026-11-07T10:00:04.49Z',
      method_details: { type: 'card', card: { type: 'visa', last4: '4242', expiry_month: 1, expiry_year: 2028, cardholder_name: 'Test' } },
    }],
    created_at: '2026-11-07T10:00:01.64Z',
    billed_at: '2026-11-07T10:00:01.53Z',
  };

  it.each([['transaction.paid'], ['transaction.completed'], ['transaction.created'], ['transaction.billed']])(
    'a renewal %s is a card event of its subscription, never the checkout intent it copied',
    async (type) => {
      const event = await map({ event_id: 'evt_r', event_type: type, occurred_at: '2026-11-07T10:00:05.1Z', data: renewal });
      expect(event).toMatchObject({
        type: 'card_event',
        providerEventId: 'evt_r',
        workspaceId: 'ws-1',
        providerSubscriptionId: SUB,
        providerPaymentId: 'txn_01hv8wnvvtedwjrhfhpr9vkq9w',
        card: {
          eventType: type,
          entity: 'transaction',
          occurredAt: '2026-11-07T10:00:05.100Z',
          subscriptionId: SUB,
          transactionId: 'txn_01hv8wnvvtedwjrhfhpr9vkq9w',
          subscription: null,
          transaction: {
            origin: 'subscription_recurring',
            grandTotalMinor: 2900,
            itemCustomData: [{ plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 }],
            card: { brand: 'visa', last4: '4242', expMonth: 1, expYear: 2028 },
          },
        },
      });
      expect(event?.intentId).toBeUndefined();
      expect(event).not.toHaveProperty('intentId');
    },
  );

  it.each([['subscription_charge'], ['subscription_update'], ['subscription_payment_method_change']])(
    'a %s transaction is a card event too',
    async (origin) => {
      const event = await map({ event_id: 'evt_o', event_type: 'transaction.paid', data: { ...renewal, origin } });
      expect(event).toMatchObject({ type: 'card_event', card: { transaction: { origin } } });
    },
  );

  it('a declined renewal is a card event carrying the decline (Paddle’s transaction.payment_failed)', async () => {
    const failed = {
      ...renewal,
      status: 'past_due',
      payments: [{
        amount: '2900', status: 'error', error_code: 'declined', created_at: '2026-11-07T10:00:02.10Z', captured_at: null,
        method_details: { type: 'card', card: { type: 'mastercard', last4: '0002', expiry_month: 3, expiry_year: 2027, cardholder_name: 'Test' } },
      }],
    };
    const event = await map({ event_id: 'evt_f', event_type: 'transaction.payment_failed', data: failed });
    expect(event).toMatchObject({
      type: 'card_event',
      card: { transaction: { status: 'past_due', errorCode: 'declined', card: { brand: 'mastercard', last4: '0002' } } },
    });
  });

  it('the checkout that saved the card keeps today’s mapping (origin web, now with its subscription)', async () => {
    const checkout = { ...renewal, id: 'txn_01hv975mbh902hcyb7mks5kt0n', origin: 'web' };
    const event = await map({ event_id: 'evt_c', event_type: 'transaction.completed', data: checkout });
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      intentId: 'pay-setup-1',
      providerRef: 'txn_01hv975mbh902hcyb7mks5kt0n',
      providerPaymentId: 'txn_01hv975mbh902hcyb7mks5kt0n',
      providerSubscriptionId: SUB,
      amount: 2900,
      currency: 'USD',
    });
    expect(event?.card).toBeUndefined();
    // …also when made through the API.
    expect((await map({ event_id: 'evt_a', event_type: 'transaction.paid', data: { ...checkout, origin: 'api' } }))?.type).toBe('payment_succeeded');
  });

  it('a failed attempt on a checkout is still ignored (the checkout stays open)', async () => {
    const checkout = { ...renewal, origin: 'web', subscription_id: null, status: 'ready' };
    expect((await map({ event_id: 'evt_pf', event_type: 'transaction.payment_failed', data: checkout }))?.type).toBe('ignored');
  });

  it.each([
    ['subscription.created'], ['subscription.activated'], ['subscription.updated'], ['subscription.past_due'],
    ['subscription.paused'], ['subscription.resumed'], ['subscription.canceled'],
  ])('%s is a card event of that subscription', async (type) => {
    const subscription = {
      id: SUB, status: type === 'subscription.canceled' ? 'canceled' : 'active', customer_id: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
      currency_code: 'USD', next_billed_at: '2026-11-07T10:00:00Z', canceled_at: null,
      current_billing_period: { starts_at: '2026-10-08T10:00:00Z', ends_at: '2026-11-08T10:00:00Z' },
      billing_cycle: { interval: 'month', frequency: 1 }, scheduled_change: null,
      items: [{ status: 'active', quantity: 1, recurring: true, price: renewal.items[0].price }],
      custom_data: { workspace_id: 'ws-1', intent_id: 'pay-setup-1', card_setup: '1' },
      ...(type === 'subscription.created' ? { transaction_id: 'txn_01hv975mbh902hcyb7mks5kt0n' } : {}),
    };
    const event = await map({ event_id: 'evt_s', event_type: type, occurred_at: '2026-10-08T10:00:01Z', data: subscription });
    expect(event).toMatchObject({
      type: 'card_event',
      providerEventId: 'evt_s',
      workspaceId: 'ws-1',
      providerSubscriptionId: SUB,
      card: {
        eventType: type,
        entity: 'subscription',
        subscriptionId: SUB,
        customerId: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
        transactionId: type === 'subscription.created' ? 'txn_01hv975mbh902hcyb7mks5kt0n' : null,
        transaction: null,
        subscription: { id: SUB, nextBilledAt: '2026-11-07T10:00:00.000Z', items: [{ amountMinor: 2900, interval: 'month' }] },
      },
    });
    expect(event).not.toHaveProperty('intentId');
    expect(event?.providerPaymentId).toBeUndefined();
  });

  it.each([['subscription.trialing'], ['subscription.imported']])('%s is ignored (never started here)', async (type) => {
    expect((await map({ event_id: 'evt_t', event_type: type, data: { id: SUB, status: 'trialing' } }))?.type).toBe('ignored');
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

  describe('with automatic card renewal on', () => {
    const cardConfig = { ...config, card_auto_renew: 'true' };
    /** event-types answers first, then the subscriptions probe. */
    function replies(probeStatus: number, probeBody: unknown) {
      const fn = vi.fn()
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ data: [] }), text: async () => '{"data":[]}' })
        .mockResolvedValueOnce({
          status: probeStatus, ok: probeStatus < 300, json: async () => probeBody, text: async () => JSON.stringify(probeBody),
        });
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    it('also reads one subscription', async () => {
      const fetchMock = replies(200, { data: [], meta: { pagination: { per_page: 1 } } });
      expect(await paddleProvider.testConnection(cardConfig)).toMatchObject({ success: true });
      expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
        'https://sandbox-api.paddle.com/event-types',
        'https://sandbox-api.paddle.com/subscriptions?per_page=1',
      ]);
    });

    it('names the missing Subscriptions permission on a 403', async () => {
      replies(403, { error: { type: 'request_error', code: 'forbidden', detail: 'You aren\'t permitted to perform this request.' } });
      const result = await paddleProvider.testConnection(cardConfig);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/"Subscriptions" read and write permission/);
    });

    it('reports any other failure of the subscriptions call', async () => {
      replies(500, { error: { code: 'internal_error', detail: 'Something went wrong' } });
      expect(await paddleProvider.testConnection(cardConfig)).toMatchObject({ success: false, error: 'Paddle subscriptions: Something went wrong' });
    });

    it('off (or saved as "false"): only the event types are read', async () => {
      const fetchMock = replies(403, {});
      expect(await paddleProvider.testConnection({ ...config, card_auto_renew: 'false' })).toMatchObject({ success: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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
