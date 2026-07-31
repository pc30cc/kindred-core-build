import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  idpayProvider,
  readIdPayRecord,
  readIdPayErrorCode,
  readIdPayErrorMessage,
  readIdPayCheckoutLink,
  readIdPayCheckoutId,
} from '../../../server/services/billing/providers/idpay';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const API_KEY = 'test-api-key-MOCK';
const config: BillingProviderConfig = { provider: 'idpay', api_key: API_KEY, sandbox: true };

const checkoutReq: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://example.test/callback',
  customerEmail: 'buyer@example.test',
  customerName: 'Buyer Name',
  metadata: { amount: '150000', phone: '09120000000' },
};

function mockJson(body: unknown) {
  const fn = vi.fn(async () => ({ ok: true, json: async () => body }));
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

let originalFetch: unknown;
beforeEach(() => {
  originalFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
});
afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('idpay readers', () => {
  it('throws on nullish body (previous runtime behaviour)', () => {
    expect(() => readIdPayRecord(null)).toThrow(TypeError);
    expect(() => readIdPayRecord(undefined)).toThrow(TypeError);
  });
  it('returns empty record for primitives and arrays', () => {
    expect(readIdPayRecord('x')).toEqual({});
    expect(readIdPayRecord(7)).toEqual({});
    expect(readIdPayRecord([1, 2])).toEqual({});
  });
  it('preserves error_code truthiness semantics', () => {
    expect(readIdPayErrorCode({ error_code: 0 })).toBe(0);
    expect(readIdPayErrorCode({})).toBeUndefined();
    expect(readIdPayErrorCode({ error_code: '34' })).toBe('34');
    expect(readIdPayErrorCode({ error_code: 12 })).toBe(12);
  });
  it('only accepts string error_message / link / id', () => {
    expect(readIdPayErrorMessage({ error_message: 'bad' })).toBe('bad');
    expect(readIdPayErrorMessage({ error_message: { a: 1 } })).toBeUndefined();
    expect(readIdPayErrorMessage({ error_message: '' })).toBeUndefined();
    expect(readIdPayCheckoutLink({ link: 'https://idpay.ir/p/1' })).toBe('https://idpay.ir/p/1');
    expect(readIdPayCheckoutLink({ link: 123 })).toBeUndefined();
    expect(readIdPayCheckoutLink({ link: '' })).toBeUndefined();
    expect(readIdPayCheckoutId({ id: 'abc' })).toBe('abc');
    expect(readIdPayCheckoutId({ id: 999 })).toBeUndefined();
    expect(readIdPayCheckoutId({ id: '' })).toBeUndefined();
  });
});

describe('idpay createCheckoutSession', () => {
  it('posts the exact payload and returns link + id', async () => {
    const fetchMock = mockJson({ id: 'idp-123', link: 'https://idpay.ir/p/idp-123' });
    const result = await idpayProvider.createCheckoutSession(config, checkoutReq);

    expect(result).toEqual({ paymentUrl: 'https://idpay.ir/p/idp-123', sessionId: 'idp-123' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.idpay.ir/v1.1/payment');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-API-KEY': API_KEY,
      'X-SANDBOX': '1',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      order_id: 'ws-1_pro_1700000000000',
      amount: 150000,
      callback: 'https://example.test/callback',
      desc: 'Plan pro',
      mail: 'buyer@example.test',
      name: 'Buyer Name',
    });
  });

  it('sends X-SANDBOX 0 in production mode', async () => {
    const fetchMock = mockJson({ id: 'a', link: 'https://idpay.ir/p/a' });
    await idpayProvider.createCheckoutSession({ provider: 'idpay', api_key: API_KEY, sandbox: false }, checkoutReq);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SANDBOX']).toBe('0');
  });

  it('defaults amount to 0 when metadata amount is absent', async () => {
    const fetchMock = mockJson({ id: 'a', link: 'https://idpay.ir/p/a' });
    await idpayProvider.createCheckoutSession(config, { ...checkoutReq, metadata: undefined });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).amount).toBe(0);
  });

  it.each([
    [{ error_code: 34, error_message: 'amount too low' }, 'amount too low'],
    [{ error_code: '34' }, 'IDPay error: 34'],
    [{ error_code: 34 }, 'IDPay error: 34'],
    [{ error_code: 34, error_message: { nested: true } }, 'IDPay error: 34'],
  ])('fails on provider error %#', async (body, message) => {
    mockJson(body);
    await expect(idpayProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow(message);
  });

  it('does not treat error_code 0 as failure', async () => {
    mockJson({ error_code: 0, id: 'x', link: 'https://idpay.ir/p/x' });
    await expect(idpayProvider.createCheckoutSession(config, checkoutReq)).resolves.toEqual({
      paymentUrl: 'https://idpay.ir/p/x',
      sessionId: 'x',
    });
  });

  it.each([[null], [undefined]])('throws on nullish body (%#)', async (body) => {
    mockJson(body);
    await expect(idpayProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow(TypeError);
  });

  it.each([
    [{}],
    [[]],
    ['oops'],
    [{ id: 'x' }],
    [{ link: '', id: 'x' }],
    [{ link: 123, id: 'x' }],
    [{ link: { href: 'x' } }],
  ])('fails explicitly on malformed create body %#', async (body) => {
    mockJson(body);
    await expect(idpayProvider.createCheckoutSession(config, checkoutReq)).rejects.toThrow(
      'IDPay error: missing payment link in response'
    );
  });

  it.each([[{ link: 'https://idpay.ir/p/z' }], [{ link: 'https://idpay.ir/p/z', id: '' }], [{ link: 'https://idpay.ir/p/z', id: 5 }]])(
    'returns undefined sessionId for invalid id %#',
    async (body) => {
      mockJson(body);
      await expect(idpayProvider.createCheckoutSession(config, checkoutReq)).resolves.toEqual({
        paymentUrl: 'https://idpay.ir/p/z',
        sessionId: undefined,
      });
    }
  );

  it('never leaks credentials or customer data in errors', async () => {
    mockJson({ error_code: 12 });
    let err: Error | undefined;
    try {
      await idpayProvider.createCheckoutSession(config, checkoutReq);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    const text = `${err?.message}${err?.stack ?? ''}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('buyer@example.test');
    expect(text).not.toContain('09120000000');
    expect(text).not.toContain('Buyer Name');
  });
});

describe('idpay testConnection', () => {
  it('succeeds when no auth error code is present', async () => {
    mockJson({ id: 'test', link: 'https://idpay.ir/p/test' });
    const r = await idpayProvider.testConnection(config);
    expect(r.success).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
  });

  it.each([[11], [12]])('reports invalid API key for error_code %s', async (code) => {
    mockJson({ error_code: code });
    const r = await idpayProvider.testConnection(config);
    expect(r).toEqual({ success: false, latencyMs: 0, error: 'Invalid API key' });
  });

  it('treats string error codes as success (unchanged strict-equality semantics)', async () => {
    mockJson({ error_code: '12' });
    await expect(idpayProvider.testConnection(config)).resolves.toMatchObject({ success: true });
  });

  it.each([[{}], [[]], ['oops'], [{ error_code: { a: 1 } }], [{ error_code: 34 }]])(
    'treats non-auth/malformed bodies as success %#',
    async (body) => {
      mockJson(body);
      await expect(idpayProvider.testConnection(config)).resolves.toMatchObject({ success: true });
    }
  );

  it('returns failure on nullish body', async () => {
    mockJson(null);
    const r = await idpayProvider.testConnection(config);
    expect(r.success).toBe(false);
  });

  it('returns failure on network error without leaking the API key', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await idpayProvider.testConnection(config);
    expect(r).toEqual({ success: false, latencyMs: 0, error: 'network down' });
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });
});

describe('idpay verifyPayment', () => {
  const verifyParams = { id: 'pay-MOCK-1', order_id: 'ws-1_pro_1700000000000' };

  it('verifies status 100 with exact request contract and output', async () => {
    const fetchMock = mockJson({ status: 100, track_id: 'trk-MOCK', amount: 150000 });
    const r = await idpayProvider.verifyPayment!(config, verifyParams);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.idpay.ir/v1.1/payment/verify');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-API-KEY': API_KEY,
      'X-SANDBOX': '1',
    });
    expect(JSON.parse(init.body as string)).toEqual({ id: 'pay-MOCK-1', order_id: 'ws-1_pro_1700000000000' });
    expect(r).toEqual({ verified: true, providerRef: 'trk-MOCK', amount: 150000, status: 'success' });
  });

  it('keeps status 101 distinct from 100', async () => {
    mockJson({ status: 101, track_id: 'trk-MOCK', amount: 150000 });
    await expect(idpayProvider.verifyPayment!(config, verifyParams)).resolves.toEqual({
      verified: true,
      providerRef: 'trk-MOCK',
      amount: 150000,
      status: 'failed',
    });
  });

  it('sends X-SANDBOX 0 in production mode', async () => {
    const fetchMock = mockJson({ status: 100 });
    await idpayProvider.verifyPayment!({ provider: 'idpay', api_key: API_KEY, sandbox: false }, verifyParams);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SANDBOX']).toBe('0');
  });

  it.each([[200], [0], [-1], ['100'], ['101'], [{ code: 100 }], [true], [undefined]])(
    'treats non-numeric/other status %# as unverified failure',
    async (status) => {
      mockJson({ status, track_id: 'trk-MOCK' });
      await expect(idpayProvider.verifyPayment!(config, verifyParams)).resolves.toMatchObject({
        verified: false,
        status: 'failed',
      });
    }
  );

  it.each([
    [{ status: 100, track_id: 'trk-MOCK' }, 'trk-MOCK'],
    [{ status: 100, track_id: 12345 }, '12345'],
    [{ status: 100, track_id: 0 }, ''],
    [{ status: 100, track_id: '' }, ''],
    [{ status: 100 }, ''],
    [{ status: 100, track_id: { a: 1 } }, ''],
    [{ status: 100, track_id: true }, ''],
    [{ status: 100, track_id: null }, ''],
  ])('maps track_id %# to providerRef', async (body, expected) => {
    mockJson(body);
    await expect(idpayProvider.verifyPayment!(config, verifyParams)).resolves.toMatchObject({ providerRef: expected });
  });

  it.each([
    [{ status: 100, amount: 150000 }, 150000],
    [{ status: 100, amount: 0 }, 0],
    [{ status: 100, amount: -5 }, -5],
    [{ status: 100, amount: '150000' }, undefined],
    [{ status: 100, amount: NaN }, undefined],
    [{ status: 100, amount: Infinity }, undefined],
    [{ status: 100 }, undefined],
  ])('forwards only finite numeric amounts %#', async (body, expected) => {
    mockJson(body);
    await expect(idpayProvider.verifyPayment!(config, verifyParams)).resolves.toMatchObject({ amount: expected });
  });

  it.each([[{}], [[]], ['oops'], [7], [{ error_code: 12, error_message: 'bad key' }]])(
    'handles malformed verify bodies %#',
    async (body) => {
      mockJson(body);
      await expect(idpayProvider.verifyPayment!(config, verifyParams)).resolves.toEqual({
        verified: false,
        providerRef: '',
        amount: undefined,
        status: 'failed',
      });
    }
  );

  it.each([[null], [undefined]])('throws TypeError on nullish verify body (%#)', async (body) => {
    mockJson(body);
    await expect(idpayProvider.verifyPayment!(config, verifyParams)).rejects.toThrow(TypeError);
  });

  it('ignores HTTP failure status and only parses the body', async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ status: 100, track_id: 't' }) }));
    (globalThis as unknown as { fetch: unknown }).fetch = fn;
    await expect(idpayProvider.verifyPayment!(config, verifyParams)).resolves.toMatchObject({ verified: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates network failure without retrying', async () => {
    const fn = vi.fn(async () => {
      throw new Error('network down');
    });
    (globalThis as unknown as { fetch: unknown }).fetch = fn;
    await expect(idpayProvider.verifyPayment!(config, verifyParams)).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never leaks credentials or identifiers on failure', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    let err: Error | undefined;
    try {
      await idpayProvider.verifyPayment!(config, verifyParams);
    } catch (e) {
      err = e as Error;
    }
    const text = `${err?.message}${err?.stack ?? ''}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('pay-MOCK-1');
    expect(text).not.toContain('ws-1_pro_1700000000000');
  });
});
