import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { paypalProvider, readPayPalAccessToken, readPayPalOAuthError } from '../../../server/services/billing/providers/paypal.js';

const config = { provider: 'paypal', client_id: 'client-id-mock', client_secret: 'client-secret-mock', sandbox: true };

function mockJson(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 401, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());
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

// ── Create subscription (POST /v1/billing/subscriptions) ──
import { readPayPalSubscriptionError, readPayPalSubscriptionId, readPayPalApprovalUrl } from '../../../server/services/billing/providers/paypal.js';

const checkoutReq = {
  workspaceId: 'ws-1',
  planId: 'P-PLAN-123',
  interval: 'monthly' as const,
  currency: 'USD',
  callbackUrl: 'https://app.test/billing/callback',
  customerEmail: 'buyer@example.com',
  customerName: 'Buyer Name',
  metadata: { brand_name: 'Acme' },
};

function mockTokenThen(body: unknown, ok = true) {
  const fn = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
    .mockResolvedValueOnce({ ok, status: ok ? 201 : 422, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('paypal createCheckoutSession', () => {
  it('creates a subscription and returns approval url + id', async () => {
    const fetchMock = mockTokenThen({
      id: 'I-SUB-1',
      links: [
        { href: 'https://api/self', rel: 'self', method: 'GET' },
        { href: 'https://paypal/approve', rel: 'approve', method: 'GET' },
        { href: 'https://api/edit', rel: 'edit', method: 'PATCH' },
        { href: 'https://api/cancel', rel: 'cancel', method: 'POST' },
      ],
    });
    const out = await paypalProvider.createCheckoutSession(config, checkoutReq);
    expect(out).toEqual({ paymentUrl: 'https://paypal/approve', sessionId: 'I-SUB-1' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/billing/subscriptions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      plan_id: 'P-PLAN-123',
      application_context: {
        return_url: 'https://app.test/billing/callback?success=true',
        cancel_url: 'https://app.test/billing/callback?success=false',
        brand_name: 'Acme',
      },
      custom_id: 'ws-1',
      subscriber: { email_address: 'buyer@example.com' },
    });
  });

  it('omits subscriber when no email and defaults brand name', async () => {
    const fetchMock = mockTokenThen({ id: 'I-2', links: [{ href: 'https://a', rel: 'approve' }] });
    await paypalProvider.createCheckoutSession(config, { ...checkoutReq, customerEmail: undefined, metadata: {} });
    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload.subscriber).toBeUndefined();
    expect(payload.application_context.brand_name).toBe('Platform');
  });

  it('picks the first approve link when several exist', async () => {
    mockTokenThen({ id: 'I-3', links: [{ href: 'https://first', rel: 'approve' }, { href: 'https://second', rel: 'approve' }] });
    const out = await paypalProvider.createCheckoutSession(config, checkoutReq);
    expect(out.paymentUrl).toBe('https://first');
  });

  it('throws provider message on HTTP failure', async () => {
    mockTokenThen({ name: 'UNPROCESSABLE_ENTITY', message: 'Plan not active', debug_id: 'd1' }, false);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('Plan not active');
  });

  it.each([[{}], [[]], ['oops'], [{ message: 42 }]])('falls back to generic error for %#', async (body) => {
    mockTokenThen(body, false);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('PayPal subscription creation failed');
  });

  it('throws TypeError on null body', async () => {
    mockTokenThen(null, false);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    [{}, { paymentUrl: '', sessionId: undefined }],
    [[], { paymentUrl: '', sessionId: undefined }],
    ['str', { paymentUrl: '', sessionId: undefined }],
    [{ id: '' }, { paymentUrl: '', sessionId: undefined }],
    [{ id: 7, links: [{ rel: 'approve', href: 'https://x' }] }, { paymentUrl: 'https://x', sessionId: undefined }],
    [{ id: { a: 1 } }, { paymentUrl: '', sessionId: undefined }],
    [{ id: 'I', links: 'nope' }, { paymentUrl: '', sessionId: 'I' }],
    [{ id: 'I', links: ['x', 5, null] }, { paymentUrl: '', sessionId: 'I' }],
    [{ id: 'I', links: [{ href: 'https://x' }] }, { paymentUrl: '', sessionId: 'I' }],
    [{ id: 'I', links: [{ rel: 'approve' }] }, { paymentUrl: '', sessionId: 'I' }],
    [{ id: 'I', links: [{ rel: 'approve', href: 9 }] }, { paymentUrl: '', sessionId: 'I' }],
    [{ id: 'I', links: [{ rel: 'Approve', href: 'https://x' }] }, { paymentUrl: '', sessionId: 'I' }],
  ])('handles malformed success body %#', async (body, expected) => {
    mockTokenThen(body);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).resolves.toEqual(expected);
  });

  it('propagates network failure without retrying', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok' }) })
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fn);
    await expect(paypalProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not leak secrets or subscriber data in errors', async () => {
    mockTokenThen({ message: 'Plan not active' }, false);
    const err = await paypalProvider.createCheckoutSession(config, checkoutReq).catch((e: Error) => e);
    const text = String((err as Error).message);
    for (const secret of ['client-secret-mock', 'client-id-mock', 'Basic ', 'tok', 'buyer@example.com', 'Buyer Name']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('paypal create parsers', () => {
  it.each([null, [], {}, 'x', { message: '' }, { message: 3 }])('subscription error rejects %#', (b) => expect(readPayPalSubscriptionError(b)).toBeNull());
  it('subscription error reads message', () => expect(readPayPalSubscriptionError({ message: 'm' })).toBe('m'));
  it.each([null, [], {}, { id: '' }, { id: 1 }, { id: {} }])('subscription id rejects %#', (b) => expect(readPayPalSubscriptionId(b)).toBeUndefined());
  it('subscription id reads string', () => expect(readPayPalSubscriptionId({ id: 'I' })).toBe('I'));
  it.each([null, {}, { links: {} }, { links: [{ rel: 'self', href: 'h' }] }, { links: [{ rel: 'approve' }] }])('approval url rejects %#', (b) => expect(readPayPalApprovalUrl(b)).toBeUndefined());
  it('approval url reads href', () => expect(readPayPalApprovalUrl({ links: [{ rel: 'approve', href: 'h' }] })).toBe('h'));
});

// ── Refund (POST /v2/payments/captures/{captureId}/refund) ──
import { readPayPalRefundId } from '../../../server/services/billing/providers/paypal.js';

describe('paypal refundPayment', () => {
  it('sends partial refund with amount and returns refund id', async () => {
    const fetchMock = mockTokenThen({ id: 'REF-1', status: 'COMPLETED' });
    const out = await paypalProvider.refundPayment?.(config, 'CAPTURE-9', 14990);
    expect(out).toEqual({ success: true, refundId: 'REF-1' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-9/refund');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ amount: { value: '149.90', currency_code: 'USD' } });
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
    const serialized = JSON.stringify(await paypalProvider.refundPayment?.(config, 'CAPTURE-9', 14990));
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
