import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { iyzicoProvider } from '../../../server/services/billing/providers/iyzico';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const config: BillingProviderConfig = {
  provider: 'iyzico',
  api_key: 'mock-api-key',
  secret_key: 'mock-secret-key',
};

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'pro',
  interval: 'monthly',
  currency: 'TRY',
  callbackUrl: 'https://app.example.com/callback',
  customerName: 'Mock Buyer',
  customerEmail: 'mock-buyer@example.com',
  metadata: { amount: '99.90' },
};

const FIXED_NOW = 1700000000000;
const RND = String(FIXED_NOW);

function expectedAuth(uri: string, body: string) {
  const hash = crypto
    .createHmac('sha256', 'mock-secret-key')
    .update('mock-secret-key' + RND + body)
    .digest('base64');
  void uri;
  return `IYZWS mock-api-key:${hash}`;
}

function mockJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('iyzico createCheckoutSession', () => {
  const ok = { status: 'success', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com/mock-page', token: 'mock-token' };

  it('returns the payment url and token on success', async () => {
    mockJson(ok);
    const out = await iyzicoProvider.createCheckoutSession(config, req);
    expect(out).toEqual({ paymentUrl: 'https://sandbox-cpp.iyzipay.com/mock-page', sessionId: 'mock-token' });
  });

  it('sends the exact endpoint, method, headers and signed body', async () => {
    const fetchMock = mockJson(ok);
    await iyzicoProvider.createCheckoutSession(config, req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.iyzipay.com/payment/iyzi-pos/checkoutform/initialize/auth/ecom');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-iyzi-rnd']).toBe(RND);
    expect(init.headers['Authorization']).toBe(
      expectedAuth('/payment/iyzi-pos/checkoutform/initialize/auth/ecom', init.body),
    );
    expect(JSON.parse(init.body)).toEqual({
      locale: 'tr',
      conversationId: `ws-1_${FIXED_NOW}`,
      price: '99.90',
      paidPrice: '99.90',
      currency: 'TRY',
      basketId: 'ws-1_pro',
      paymentGroup: 'SUBSCRIPTION',
      callbackUrl: 'https://app.example.com/callback',
      enabledInstallments: [1, 2, 3, 6, 9],
      buyer: {
        id: 'ws-1',
        name: 'Mock Buyer',
        surname: 'User',
        email: 'mock-buyer@example.com',
        identityNumber: '11111111111',
        registrationAddress: 'Istanbul, Turkey',
        city: 'Istanbul',
        country: 'Turkey',
        ip: '127.0.0.1',
      },
      shippingAddress: { contactName: 'User', city: 'Istanbul', country: 'Turkey', address: 'Istanbul' },
      billingAddress: { contactName: 'User', city: 'Istanbul', country: 'Turkey', address: 'Istanbul' },
      basketItems: [{ id: 'pro', name: 'Plan pro', category1: 'Subscription', itemType: 'VIRTUAL', price: '99.90' }],
    });
  });

  it('uses the sandbox base url when configured', async () => {
    const fetchMock = mockJson(ok);
    await iyzicoProvider.createCheckoutSession({ ...config, sandbox: true }, req);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sandbox-api.iyzipay.com/payment/iyzi-pos/checkoutform/initialize/auth/ecom',
    );
  });

  it('keeps amount as-is and defaults it to "0"', async () => {
    const fetchMock = mockJson(ok);
    await iyzicoProvider.createCheckoutSession(config, { ...req, metadata: undefined });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.price).toBe('0');
    expect(payload.paidPrice).toBe('0');
    expect(payload.basketItems[0].price).toBe('0');
    expect(payload.currency).toBe('TRY');
  });

  it('throws with the provider error message on failure', async () => {
    mockJson({ status: 'failure', errorMessage: 'invalid request' });
    await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('invalid request');
  });

  it('falls back when errorMessage is missing or malformed', async () => {
    for (const body of [
      { status: 'failure' },
      { status: 'failure', errorMessage: '' },
      { status: 'failure', errorMessage: { tr: 'hata' } },
      { status: 'failure', errorMessage: ['hata'] },
    ]) {
      mockJson(body);
      await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('iyzico checkout failed');
    }
  });

  it('does not accept a different status casing or type as success', async () => {
    for (const status of ['SUCCESS', 'Success', 1, true, {}, undefined]) {
      mockJson({ status, paymentPageUrl: 'https://mock', token: 'mock-token' });
      await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('iyzico checkout failed');
    }
  });

  it('fails explicitly when the success payload is incomplete', async () => {
    for (const paymentPageUrl of [undefined, '', 123, {}, true]) {
      mockJson({ status: 'success', paymentPageUrl, token: 'mock-token' });
      await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('missing paymentPageUrl');
    }
    for (const token of [undefined, '', 123, {}, true]) {
      mockJson({ status: 'success', paymentPageUrl: 'https://mock', token });
      await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('missing token');
    }
  });

  it('never falls back to the callback url as the payment url', async () => {
    mockJson({ status: 'success', token: 'mock-token' });
    const err = await iyzicoProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('app.example.com');
  });

  it('handles malformed bodies', async () => {
    for (const body of ['oops', 42, [], {}]) {
      mockJson(body);
      await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('iyzico checkout failed');
    }
  });

  it('keeps the previous TypeError for nullish bodies', async () => {
    for (const body of [null, undefined]) {
      mockJson(body);
      await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('propagates network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(iyzicoProvider.createCheckoutSession(config, req)).rejects.toThrow('network down');
  });

  it('does not leak credentials, buyer identity or the request body in errors', async () => {
    mockJson({ status: 'failure', errorMessage: 'invalid request' });
    const err = await iyzicoProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    const text = String((err as Error).message);
    for (const secret of [
      'mock-api-key', 'mock-secret-key', 'IYZWS', RND,
      'mock-buyer@example.com', 'Mock Buyer', '11111111111', 'Istanbul', 'basketItems',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('iyzico testConnection', () => {
  it('sends the unchanged BIN check request with a valid signature', async () => {
    const fetchMock = mockJson({ status: 'success' });
    const out = await iyzicoProvider.testConnection(config);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.iyzipay.com/payment/bin/check');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ locale: 'tr', conversationId: 'test' }));
    expect(init.headers['x-iyzi-rnd']).toBe(RND);
    expect(init.headers['Authorization']).toBe(expectedAuth('/payment/bin/check', init.body));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.success).toBe(true);
    expect(typeof out.latencyMs).toBe('number');
  });

  it('reports invalid credentials only for failure + errorCode "1000"', async () => {
    mockJson({ status: 'failure', errorCode: '1000' });
    const bad = await iyzicoProvider.testConnection(config);
    expect(bad).toMatchObject({ success: false, error: 'Invalid credentials' });
    expect(bad.error).not.toContain('mock-secret-key');
  });

  it('does not coerce a numeric errorCode or a different status', async () => {
    mockJson({ status: 'failure', errorCode: 1000 });
    expect((await iyzicoProvider.testConnection(config)).success).toBe(true);
    mockJson({ status: 'FAILURE', errorCode: '1000' });
    expect((await iyzicoProvider.testConnection(config)).success).toBe(true);
    mockJson({ status: 'failure', errorCode: '5001' });
    expect((await iyzicoProvider.testConnection(config)).success).toBe(true);
  });

  it('treats malformed bodies as reachable', async () => {
    for (const body of ['oops', 7, [], {}]) {
      mockJson(body);
      expect((await iyzicoProvider.testConnection(config)).success).toBe(true);
    }
  });

  it('reports nullish bodies and network failures without leaking secrets', async () => {
    mockJson(null);
    const nullish = await iyzicoProvider.testConnection(config);
    expect(nullish.success).toBe(false);
    expect(nullish.error).not.toContain('mock-secret-key');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const out = await iyzicoProvider.testConnection(config);
    expect(out).toMatchObject({ success: false, error: 'socket hang up' });
  });
});

describe('iyzico refundPayment', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW));
  afterEach(() => vi.restoreAllMocks());

  it('posts the refund payload and returns the transaction id', async () => {
    const fetchMock = mockJson({ status: 'success', paymentTransactionId: 'TXN-123' });
    const out = await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1', 14990);
    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.iyzipay.com/payment/refund');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-iyzi-rnd']).toBe(RND);
    expect(init.headers['Authorization']).toBe(expectedAuth('/payment/refund', init.body));
    expect(JSON.parse(init.body)).toEqual({
      locale: 'tr',
      paymentTransactionId: 'PAY-MOCK-1',
      price: '149.90',
      currency: 'TRY',
      ip: '127.0.0.1',
    });
    expect(out).toEqual({ success: true, refundId: 'TXN-123' });
  });

  it('sends price 0 when no amount is provided', async () => {
    const fetchMock = mockJson({ status: 'success' });
    await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).price).toBe('0');
  });

  it('keeps provider failures as failures', async () => {
    mockJson({ status: 'failure', errorMessage: 'refund rejected' });
    expect(await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).toEqual({
      success: false,
      refundId: undefined,
    });
    mockJson({ status: 'SUCCESS', paymentTransactionId: 'TXN-9' });
    expect(await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).toEqual({
      success: false,
      refundId: 'TXN-9',
    });
  });

  it('handles malformed bodies without inventing a refund id', async () => {
    for (const body of [{}, 'oops', 7, [], { status: { ok: true } }]) {
      mockJson(body);
      expect(await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).toEqual({
        success: false,
        refundId: undefined,
      });
    }
    mockJson({ status: 'success' });
    expect(await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).toEqual({
      success: true,
      refundId: undefined,
    });
  });

  it('narrows the refund id by type', async () => {
    const cases: Array<[unknown, string | undefined]> = [
      ['', ''],
      [12345, '12345'],
      [{ id: 1 }, undefined],
      [true, undefined],
      [null, undefined],
    ];
    for (const [value, expected] of cases) {
      mockJson({ status: 'success', paymentTransactionId: value });
      expect(await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).toEqual({
        success: true,
        refundId: expected,
      });
    }
  });

  it('keeps nullish TypeError and network rejection behaviour', async () => {
    mockJson(null);
    await expect(iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).rejects.toBeInstanceOf(TypeError);

    const failing = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', failing);
    await expect(iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1')).rejects.toThrow('socket hang up');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('does not leak credentials in the refund result', async () => {
    mockJson({ status: 'success', paymentTransactionId: 'TXN-123' });
    const serialized = JSON.stringify(await iyzicoProvider.refundPayment?.(config, 'PAY-MOCK-1', 14990));
    expect(serialized).not.toContain('mock-secret-key');
    expect(serialized).not.toContain('mock-api-key');
    expect(serialized).not.toContain('IYZWS');
    expect(serialized).not.toContain(RND);
  });
});
