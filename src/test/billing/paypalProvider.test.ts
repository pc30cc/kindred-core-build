import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearPayPalTokenCache,
  paypalProvider,
  readPayPalAccessToken,
  readPayPalOAuthError,
} from '../../../server/services/billing/providers/paypal.js';

const config = { provider: 'paypal', client_id: 'client-id-mock', client_secret: 'client-secret-mock', sandbox: true };

function mockJson(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 401, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // Every case scripts its own token call.
  clearPayPalTokenCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('readPayPalAccessToken', () => {
  it('reads a valid token', () => expect(readPayPalAccessToken({ access_token: 'tok' })).toBe('tok'));
  it.each([null, undefined, 'str', 42, [], {}, { access_token: '' }, { access_token: 7 }, { access_token: {} }])(
    'rejects malformed body %#', (body) => expect(readPayPalAccessToken(body)).toBeNull()
  );
});

describe('readPayPalOAuthError', () => {
  it('reads error_description', () => expect(readPayPalOAuthError({ error_description: 'bad creds' })).toBe('bad creds'));
  it.each([null, [], {}, { error_description: 5 }, { error_description: '' }, { error: 'invalid_client' }])(
    'falls back for %#', (body) => expect(readPayPalOAuthError(body)).toBeNull()
  );
});

describe('paypal testConnection (OAuth token flow)', () => {
  it('succeeds with valid token and uses correct request contract', async () => {
    const fetchMock = mockJson({ access_token: 'tok', token_type: 'Bearer', expires_in: 32400 });
    const res = await paypalProvider.testConnection(config);
    expect(res.success).toBe(true);
    expect(typeof res.latencyMs).toBe('number');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['Authorization']).toBe(`Basic ${Buffer.from('client-id-mock:client-secret-mock').toString('base64')}`);
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('uses production endpoint when sandbox is false', async () => {
    const fetchMock = mockJson({ access_token: 'tok' });
    await paypalProvider.testConnection({ ...config, sandbox: false });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api-m.paypal.com/v1/oauth2/token');
  });

  it('fails with OAuth error_description', async () => {
    mockJson({ error: 'invalid_client', error_description: 'Client Authentication failed' }, false);
    const res = await paypalProvider.testConnection(config);
    expect(res.success).toBe(false);
    expect(res.error).toBe('Client Authentication failed');
  });

  it('falls back to generic message when error_description is wrong type', async () => {
    mockJson({ error_description: 123 }, false);
    const res = await paypalProvider.testConnection(config);
    expect(res).toMatchObject({ success: false, error: 'PayPal auth failed' });
  });

  it.each([[null], [{}], [[]], ['oops'], [{ access_token: '' }], [{ access_token: 9 }], [{ access_token: {} }]])(
    'fails on malformed successful body %#', async (body) => {
      mockJson(body);
      const res = await paypalProvider.testConnection(config);
      expect(res).toMatchObject({ success: false, error: 'PayPal auth failed' });
    }
  );

  it('handles network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await paypalProvider.testConnection(config);
    expect(res).toMatchObject({ success: false, error: 'network down' });
  });

  it('never leaks credentials in the error output', async () => {
    mockJson({ error_description: 'Client Authentication failed' }, false);
    const res = await paypalProvider.testConnection(config);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('client-secret-mock');
    expect(serialized).not.toContain('client-id-mock');
    expect(serialized).not.toContain('Basic ');
    expect(serialized).not.toContain('grant_type=client_credentials');
  });
});

// ── Create order (POST /v2/checkout/orders) ──
import {
  readPayPalSubscriptionError,
  readPayPalSubscriptionId,
  readPayPalApprovalUrl,
  readPayPalIssue,
  readPayPalOrderCapture,
  parsePayPalCustomId,
} from '../../../server/services/billing/providers/paypal.js';

const checkoutReq = {
  workspaceId: 'ws-1',
  planId: 'plan-uuid',
  interval: 'monthly' as const,
  currency: 'USD',
  callbackUrl: 'https://app.test/billing/pay/invoice/inv-1?intent=pi-1&provider=paypal',
  customerEmail: 'buyer@example.com',
  customerName: 'Buyer Name',
  intentId: 'pi-1',
  invoiceId: 'inv-1',
  description: 'Pro (monthly) — invoice AB12345678',
  // The invoice due in minor units: $149.90.
  metadata: { amount: '14990', brand_name: 'Acme' },
};

function mockTokenThen(body: unknown, ok = true) {
  const fn = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
    .mockResolvedValueOnce({ ok, status: ok ? 201 : 422, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const orderCreated = {
  id: 'ORDER-1',
  status: 'PAYER_ACTION_REQUIRED',
  links: [
    { href: 'https://api/self', rel: 'self', method: 'GET' },
    { href: 'https://paypal/checkoutnow?token=ORDER-1', rel: 'payer-action', method: 'GET' },
  ],
};

describe('paypal createCheckoutSession (Orders v2)', () => {
  it('creates a CAPTURE order for exactly the invoice amount, in its currency, naming workspace and intent', async () => {
    const fetchMock = mockTokenThen(orderCreated);
    const out = await paypalProvider.createCheckoutSession(config, checkoutReq);
    expect(out).toEqual({ paymentUrl: 'https://paypal/checkoutnow?token=ORDER-1', sessionId: 'ORDER-1' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Authorization': 'Bearer tok',
      'Content-Type': 'application/json',
      // Idempotent per payment intent.
      'PayPal-Request-Id': 'order-pi-1',
    });
    expect(JSON.parse(init.body)).toEqual({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'inv-1',
        custom_id: 'ws-1:pi-1',
        description: 'Pro (monthly) — invoice AB12345678',
        // PayPal takes a decimal major amount: 14990 minor units → "149.90".
        amount: { currency_code: 'USD', value: '149.90' },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: 'https://app.test/billing/pay/invoice/inv-1?intent=pi-1&provider=paypal',
            cancel_url: 'https://app.test/billing/pay/invoice/inv-1?intent=pi-1&provider=paypal&canceled=1',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            brand_name: 'Acme',
          },
          email_address: 'buyer@example.com',
        },
      },
    });
  });

  it('prices EUR in EUR and prefers the configured brand name', async () => {
    const fetchMock = mockTokenThen(orderCreated);
    await paypalProvider.createCheckoutSession({ ...config, brand_name: 'RESPOK' }, { ...checkoutReq, currency: 'eur' });
    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload.purchase_units[0].amount).toEqual({ currency_code: 'EUR', value: '149.90' });
    expect(payload.payment_source.paypal.experience_context.brand_name).toBe('RESPOK');
  });

  it('omits the e-mail and brand name when there are none', async () => {
    const fetchMock = mockTokenThen(orderCreated);
    await paypalProvider.createCheckoutSession(config, { ...checkoutReq, customerEmail: undefined, metadata: { amount: '100' } });
    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload.payment_source.paypal.email_address).toBeUndefined();
    expect(payload.payment_source.paypal.experience_context.brand_name).toBeUndefined();
  });

  it.each([['TRY'], ['IRR']])('refuses %s (PayPal cannot charge it) before any request', async (currency) => {
    const fetchMock = mockTokenThen(orderCreated);
    await expect(paypalProvider.createCheckoutSession(config, { ...checkoutReq, currency })).rejects.toThrow(/PayPal cannot charge/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a zero amount', async () => {
    mockTokenThen(orderCreated);
    await expect(
      paypalProvider.createCheckoutSession(config, { ...checkoutReq, metadata: { amount: '0' } }),
    ).rejects.toThrow('PayPal checkout needs a positive amount');
  });

  it('throws provider message on HTTP failure', async () => {
    mockTokenThen({ name: 'UNPROCESSABLE_ENTITY', message: 'Invalid amount', debug_id: 'd1' }, false);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('Invalid amount');
  });

  it.each([[{}], [[]], ['oops'], [{ message: 42 }]])('falls back to generic error for %#', async (body) => {
    mockTokenThen(body, false);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('PayPal order creation failed');
  });

  it('throws TypeError on null body', async () => {
    mockTokenThen(null, false);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    [{}],
    [{ id: 'ORDER-1', links: [] }],
    [{ id: '', links: [{ rel: 'payer-action', href: 'https://x' }] }],
    [{ links: [{ rel: 'payer-action', href: 'https://x' }] }],
  ])('a success body without both an order id and an approval link is a failure %#', async (body) => {
    mockTokenThen(body);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('PayPal order creation failed');
  });

  it('propagates network failure without retrying', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fn);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not leak secrets or buyer data in errors', async () => {
    mockTokenThen({ message: 'Invalid amount' }, false);
    const err = await paypalProvider.createCheckoutSession(config, checkoutReq).catch((e: Error) => e);
    const text = String((err as Error).message);
    for (const secret of ['client-secret-mock', 'client-id-mock', 'Basic ', 'tok', 'buyer@example.com', 'Buyer Name']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('paypal verifyPayment (capture on return)', () => {
  const capturedOrder = (status = 'COMPLETED', value = '149.90', currency = 'USD') => ({
    id: 'ORDER-1',
    status: 'COMPLETED',
    purchase_units: [{ payments: { captures: [{ id: 'CAPTURE-1', status, amount: { currency_code: currency, value } }] } }],
  });

  function mockSequence(...responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
    const fn = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) });
    for (const r of responses) fn.mockResolvedValueOnce({ ok: r.ok, status: r.status ?? (r.ok ? 201 : 422), json: async () => r.body });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('captures the stored order idempotently and reports PayPal’s amount in minor units', async () => {
    const fn = mockSequence({ ok: true, body: capturedOrder() });
    const out = await paypalProvider.verifyPayment!(config, { token: 'ORDER-1', PayerID: 'P1', amount: '14990' });
    const [url, init] = fn.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/capture');
    expect(init.method).toBe('POST');
    expect(init.headers['PayPal-Request-Id']).toBe('capture-ORDER-1');
    expect(out).toEqual({
      verified: true, providerRef: 'ORDER-1', amount: 14990, currency: 'USD', paymentId: 'CAPTURE-1', status: 'paid',
    });
  });

  it('rounds decimal values instead of truncating them (19.99 → 1999)', async () => {
    mockSequence({ ok: true, body: capturedOrder('COMPLETED', '19.99') });
    const out = await paypalProvider.verifyPayment!(config, { token: 'ORDER-1' });
    expect(out.amount).toBe(1999);
  });

  it('an order captured earlier is read back, not captured twice', async () => {
    const fn = mockSequence(
      { ok: false, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } },
      { ok: true, status: 200, body: capturedOrder() },
    );
    const out = await paypalProvider.verifyPayment!(config, { token: 'ORDER-1' });
    expect(fn.mock.calls[2][0]).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1');
    expect(out.verified).toBe(true);
    expect(out.paymentId).toBe('CAPTURE-1');
  });

  it.each([
    ['ORDER_NOT_APPROVED', 'canceled'],
    ['INSTRUMENT_DECLINED', 'failed'],
    ['SOMETHING_ELSE', 'pending'],
  ])('capture refused with %s → %s', async (issue, status) => {
    mockSequence({ ok: false, body: { details: [{ issue }] } });
    const out = await paypalProvider.verifyPayment!(config, { token: 'ORDER-1' });
    expect(out).toEqual({ verified: false, providerRef: 'ORDER-1', status });
  });

  it('a PENDING capture is not money yet', async () => {
    mockSequence({ ok: true, body: capturedOrder('PENDING') });
    expect((await paypalProvider.verifyPayment!(config, { token: 'ORDER-1' })).status).toBe('pending');
  });

  it('a DECLINED capture is a failure', async () => {
    mockSequence({ ok: true, body: capturedOrder('DECLINED') });
    expect((await paypalProvider.verifyPayment!(config, { token: 'ORDER-1' })).status).toBe('failed');
  });

  it('a cancel return never captures', async () => {
    const fn = mockSequence({ ok: true, status: 200, body: { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED' } });
    const out = await paypalProvider.verifyPayment!(config, { token: 'ORDER-1', canceled: '1' });
    expect(fn.mock.calls[1][0]).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1');
    expect(fn.mock.calls[1][1].method).toBeUndefined();
    expect(out).toEqual({ verified: false, providerRef: 'ORDER-1', status: 'canceled' });
  });

  it('without an order reference nothing is called', async () => {
    const fn = mockSequence();
    expect(await paypalProvider.verifyPayment!(config, {})).toEqual({ verified: false, providerRef: '', status: 'failed' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('paypal verifyWebhook (verify-webhook-signature API)', () => {
  const webhookConfig = { ...config, webhook_id: 'WH-1' };
  const transmission = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig==',
    'paypal-transmission-time': '2026-10-08T10:00:00Z',
  };
  const capture = {
    id: 'WH-EVT-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: 'CAPTURE-1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '149.90' },
      custom_id: 'ws-1:pi-1',
      supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
    },
  };

  function mockVerification(status: string, ok = true) {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok, status: ok ? 200 : 400, json: async () => ({ verification_status: status }) });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('asks PayPal to verify the delivery with the exact raw body spliced in', async () => {
    const raw = JSON.stringify(capture).replace('"COMPLETED"', '"COMPLETED" ');
    const fn = mockVerification('SUCCESS');
    const event = await paypalProvider.verifyWebhook(webhookConfig, transmission, raw);
    const [url, init] = fn.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(init.body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(init.body)).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: transmission['paypal-cert-url'],
      transmission_id: 'tx-1',
      transmission_sig: 'sig==',
      transmission_time: '2026-10-08T10:00:00Z',
      webhook_id: 'WH-1',
    });
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      providerEventId: 'WH-EVT-1',
      workspaceId: 'ws-1',
      intentId: 'pi-1',
      providerRef: 'ORDER-1',
      providerPaymentId: 'CAPTURE-1',
      amount: 14990,
      currency: 'USD',
    });
  });

  it('throws on a FAILURE verdict', async () => {
    mockVerification('FAILURE');
    await expect(paypalProvider.verifyWebhook(webhookConfig, transmission, JSON.stringify(capture)))
      .rejects.toThrow('Invalid PayPal webhook signature');
  });

  it('is not verified without a configured webhook id or the transmission headers', async () => {
    const fn = mockVerification('SUCCESS');
    await expect(paypalProvider.verifyWebhook(config, transmission, JSON.stringify(capture))).resolves.toBeNull();
    await expect(paypalProvider.verifyWebhook(webhookConfig, {}, JSON.stringify(capture))).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('a refund names the capture it refunds and the running refunded total', async () => {
    mockVerification('SUCCESS');
    const refund = {
      id: 'WH-EVT-2',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REFUND-1',
        amount: { currency_code: 'USD', value: '50.00' },
        seller_payable_breakdown: { total_refunded_amount: { currency_code: 'USD', value: '60.00' } },
        links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAPTURE-1' }],
      },
    };
    const event = await paypalProvider.verifyWebhook(webhookConfig, transmission, JSON.stringify(refund));
    expect(event).toMatchObject({
      type: 'refund_processed',
      providerPaymentId: 'CAPTURE-1',
      amount: 5000,
      refundedTotal: 6000,
      currency: 'USD',
    });
  });

  it('a denied capture fails the intent it names', async () => {
    mockVerification('SUCCESS');
    const event = await paypalProvider.verifyWebhook(
      webhookConfig, transmission, JSON.stringify({ ...capture, event_type: 'PAYMENT.CAPTURE.DENIED' }),
    );
    expect(event).toMatchObject({ type: 'payment_failed', intentId: 'pi-1', status: 'failed' });
  });

  it('other event types are acknowledged as ignored', async () => {
    mockVerification('SUCCESS');
    const event = await paypalProvider.verifyWebhook(
      webhookConfig, transmission, JSON.stringify({ id: 'E', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} }),
    );
    expect(event?.type).toBe('ignored');
  });
});

describe('paypal access token reuse (webhook verification cost)', () => {
  const webhookConfig = { ...config, webhook_id: 'WH-1' };
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig==',
    'paypal-transmission-time': '2026-10-08T10:00:00Z',
  };
  const body = JSON.stringify({ id: 'WH-EVT-9', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} });
  const tokenCalls = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.filter(([url]) => String(url).endsWith('/v1/oauth2/token')).length;

  function mockPayPal(verifyStatus = 200) {
    const fn = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 32400 }) };
      }
      return { ok: verifyStatus === 200, status: verifyStatus, json: async () => ({ verification_status: 'SUCCESS' }) };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('fetches one token for many deliveries while it is valid', async () => {
    const fn = mockPayPal();
    for (let i = 0; i < 3; i += 1) await paypalProvider.verifyWebhook(webhookConfig, headers, body);
    expect(tokenCalls(fn)).toBe(1);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('fetches a new token once the cached one is close to expiry', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fn = mockPayPal();
    await paypalProvider.verifyWebhook(webhookConfig, headers, body);
    clock.mockReturnValue(now + 32400 * 1000 - 60 * 1000);
    await paypalProvider.verifyWebhook(webhookConfig, headers, body);
    expect(tokenCalls(fn)).toBe(2);
    clock.mockRestore();
  });

  it('drops a token PayPal rejects, so the next delivery gets a fresh one', async () => {
    const fn = mockPayPal(401);
    await expect(paypalProvider.verifyWebhook(webhookConfig, headers, body)).rejects.toThrow('Invalid PayPal webhook signature');
    await expect(paypalProvider.verifyWebhook(webhookConfig, headers, body)).rejects.toThrow();
    expect(tokenCalls(fn)).toBe(2);
  });

  it('other credentials never reuse the token', async () => {
    const fn = mockPayPal();
    await paypalProvider.verifyWebhook(webhookConfig, headers, body);
    await paypalProvider.verifyWebhook({ ...webhookConfig, client_secret: 'rotated-secret' }, headers, body);
    expect(tokenCalls(fn)).toBe(2);
  });

  it('a connection test always asks PayPal for a token', async () => {
    const fn = mockPayPal();
    await paypalProvider.verifyWebhook(webhookConfig, headers, body);
    expect((await paypalProvider.testConnection(config)).success).toBe(true);
    expect(tokenCalls(fn)).toBe(2);
  });

  it('declares that its payment lookup captures the money', () => {
    expect(paypalProvider.verifyPaymentCaptures).toBe(true);
  });
});

describe('paypal create parsers', () => {
  it.each([null, [], {}, 'x', { message: '' }, { message: 3 }])('error message rejects %#', (b) => expect(readPayPalSubscriptionError(b)).toBeNull());
  it('error message reads message', () => expect(readPayPalSubscriptionError({ message: 'm' })).toBe('m'));
  it.each([null, [], {}, { id: '' }, { id: 1 }, { id: {} }])('resource id rejects %#', (b) => expect(readPayPalSubscriptionId(b)).toBeUndefined());
  it('resource id reads string', () => expect(readPayPalSubscriptionId({ id: 'I' })).toBe('I'));
  it.each([null, {}, { links: {} }, { links: [{ rel: 'self', href: 'h' }] }, { links: [{ rel: 'approve' }] }])('approval url rejects %#', (b) => expect(readPayPalApprovalUrl(b)).toBeUndefined());
  it('approval url reads href', () => expect(readPayPalApprovalUrl({ links: [{ rel: 'approve', href: 'h' }] })).toBe('h'));
  it('approval url reads the payer-action link of an Orders v2 order', () =>
    expect(readPayPalApprovalUrl({ links: [{ rel: 'self', href: 's' }, { rel: 'payer-action', href: 'p' }] })).toBe('p'));
  it('issue reads details[0].issue', () => expect(readPayPalIssue({ details: [{ issue: 'X' }] })).toBe('X'));
  it.each([null, {}, { details: [] }, { details: 'x' }])('issue rejects %#', (b) => expect(readPayPalIssue(b)).toBeUndefined());
  it('order capture reads the first capture', () =>
    expect(readPayPalOrderCapture({ purchase_units: [{ payments: { captures: [{ id: 'C' }] } }] })).toEqual({ id: 'C' }));
  it.each([null, {}, { purchase_units: [] }, { purchase_units: [{}] }])('order capture rejects %#', (b) =>
    expect(readPayPalOrderCapture(b)).toBeNull());
  it('custom_id carries workspace and intent; a bare value is a legacy workspace id', () => {
    expect(parsePayPalCustomId('ws-1:pi-1')).toEqual({ workspaceId: 'ws-1', intentId: 'pi-1' });
    expect(parsePayPalCustomId('ws-1')).toEqual({ workspaceId: 'ws-1', intentId: undefined });
    expect(parsePayPalCustomId(undefined)).toEqual({});
  });
});

// ── Refund (POST /v2/payments/captures/{captureId}/refund) ──
import { readPayPalRefundId } from '../../../server/services/billing/providers/paypal.js';

describe('paypal refundPayment', () => {
  it('sends partial refund with amount and returns refund id', async () => {
    const fetchMock = mockTokenThen({ id: 'REF-1', status: 'COMPLETED' });
    const out = await paypalProvider.refundPayment?.(config, 'CAPTURE-9', 14990, 'USD');
    expect(out).toEqual({ success: true, refundId: 'REF-1' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-9/refund');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ amount: { value: '149.90', currency_code: 'USD' } });
  });

  it('refunds a EUR capture in EUR (it used to be labelled USD)', async () => {
    const fetchMock = mockTokenThen({ id: 'REF-E' });
    await paypalProvider.refundPayment?.(config, 'CAPTURE-9', 1000, 'eur');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ amount: { value: '10.00', currency_code: 'EUR' } });
  });

  it('refuses a partial refund without the capture currency instead of guessing USD', async () => {
    const fetchMock = mockTokenThen({ id: 'REF-1' });
    await expect(paypalProvider.refundPayment?.(config, 'CAPTURE-9', 1000)).rejects.toThrow(
      'PayPal partial refund needs the capture currency',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends empty body for full refund', async () => {
    const fetchMock = mockTokenThen({ id: 'REF-2' });
    const out = await paypalProvider.refundPayment?.(config, 'CAPTURE-9');
    expect(out).toEqual({ success: true, refundId: 'REF-2' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({});
  });

  it('treats amount 0 as full refund (falsy), unchanged', async () => {
    const fetchMock = mockTokenThen({ id: 'REF-3' });
    await paypalProvider.refundPayment?.(config, 'CAPTURE-9', 0);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({});
  });

  it('reports failure on HTTP error without inventing a refund id', async () => {
    mockTokenThen({ name: 'UNPROCESSABLE_ENTITY', message: 'Already refunded', debug_id: 'd1' }, false);
    expect(await paypalProvider.refundPayment?.(config, 'CAPTURE-9')).toEqual({ success: false, refundId: undefined });
  });

  it('keeps refund id from a failed HTTP response body as before', async () => {
    mockTokenThen({ id: 'REF-X' }, false);
    expect(await paypalProvider.refundPayment?.(config, 'CAPTURE-9')).toEqual({ success: false, refundId: 'REF-X' });
  });

  it.each([[{}], [[]], ['str'], [{ id: '' }], [{ id: 5 }], [{ id: true }], [{ id: {} }]])(
    'returns undefined refundId for malformed body %#', async (body) => {
      mockTokenThen(body);
      expect(await paypalProvider.refundPayment?.(config, 'CAPTURE-9')).toEqual({ success: true, refundId: undefined });
    }
  );

  it('throws TypeError on null body', async () => {
    mockTokenThen(null);
    await expect(paypalProvider.refundPayment?.(config, 'CAPTURE-9')).rejects.toBeInstanceOf(TypeError);
  });

  it('propagates network failure without retrying the refund', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fn);
    await expect(paypalProvider.refundPayment?.(config, 'CAPTURE-9')).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not leak secrets in the refund output', async () => {
    mockTokenThen({ id: 'REF-1' });
    const serialized = JSON.stringify(await paypalProvider.refundPayment?.(config, 'CAPTURE-9', 14990, 'USD'));
    for (const secret of ['client-secret-mock', 'client-id-mock', 'Basic ', 'tok', 'buyer@example.com']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('readPayPalRefundId', () => {
  it('reads a valid id', () => expect(readPayPalRefundId({ id: 'REF' })).toBe('REF'));
  it.each([null, undefined, 'x', 4, [], {}, { id: '' }, { id: 5 }, { id: true }, { id: {} }])(
    'rejects %#', (b) => expect(readPayPalRefundId(b)).toBeUndefined()
  );
});
