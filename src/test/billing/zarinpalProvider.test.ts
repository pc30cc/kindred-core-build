import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zarinpalProvider } from '../../../server/services/billing/providers/zarinpal';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const config: BillingProviderConfig = { provider: 'zarinpal', merchant_id: 'mock-merchant-id-0001' };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://app.example.com/callback',
  customerEmail: 'mock-buyer@example.com',
  metadata: { amount: '250000', phone: '09120000000' },
};

function mockJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('zarinpal createCheckoutSession', () => {
  it('returns checkout url and authority on code 100', async () => {
    mockJson({ data: { code: 100, authority: 'A0000000000000000000000000000mock' } });
    const out = await zarinpalProvider.createCheckoutSession(config, req);
    expect(out).toEqual({
      paymentUrl: 'https://www.zarinpal.com/pg/StartPay/A0000000000000000000000000000mock',
      authority: 'A0000000000000000000000000000mock',
    });
  });

  it('uses sandbox endpoints when config.sandbox is set', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'S-mock' } });
    const out = await zarinpalProvider.createCheckoutSession({ ...config, sandbox: true }, req);
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.zarinpal.com/pg/v4/payment/request.json');
    expect(out.paymentUrl).toBe('https://sandbox.zarinpal.com/pg/StartPay/S-mock');
  });

  it('sends the exact endpoint, method, headers and payload', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-mock' } });
    await zarinpalProvider.createCheckoutSession(config, req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.zarinpal.com/pg/v4/payment/request.json');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      merchant_id: 'mock-merchant-id-0001',
      amount: 250000,
      callback_url: 'https://app.example.com/callback',
      description: 'Plan pro for workspace ws-1',
      metadata: { email: 'mock-buyer@example.com', workspace_id: 'ws-1', plan_id: 'pro' },
      currency: 'IRR',
    });
  });

  it('keeps IRT currency and amount untouched', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-mock' } });
    await zarinpalProvider.createCheckoutSession({ ...config, currency: 'IRT' }, req);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.currency).toBe('IRT');
    expect(payload.amount).toBe(250000);
  });

  it('defaults amount to 0 and currency to IRR', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-mock' } });
    await zarinpalProvider.createCheckoutSession(config, { ...req, metadata: undefined });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.amount).toBe(0);
    expect(payload.currency).toBe('IRR');
  });

  it('throws on a numeric failure code', async () => {
    mockJson({ data: { code: -9 } });
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('ZarinPal error code: -9');
  });

  it('does not coerce string "100" into success', async () => {
    mockJson({ data: { code: '100', authority: 'A-mock' } });
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('ZarinPal error code: undefined');
  });

  it('prefers a valid error message', async () => {
    mockJson({ data: { code: -11 }, errors: { code: -11, message: 'merchant not found' } });
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('merchant not found');
  });

  it('falls back to the code when errors.message is missing or malformed', async () => {
    mockJson({ data: { code: -11 }, errors: { code: -11 } });
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('ZarinPal error code: -11');
    mockJson({ data: { code: -12 }, errors: { message: { fa: 'bad' } } });
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('ZarinPal error code: -12');
    mockJson({ data: { code: -13 }, errors: 'broken' });
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('ZarinPal error code: -13');
  });

  it('fails explicitly when code is 100 but authority is invalid', async () => {
    for (const authority of [undefined, null, '', 12345, {}, true, []]) {
      mockJson({ data: { code: 100, authority } });
      await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('missing authority');
    }
  });

  it('never emits an undefined checkout url', async () => {
    mockJson({ data: { code: 100 } });
    const err = await zarinpalProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('StartPay');
  });

  it('handles malformed bodies', async () => {
    for (const body of ['oops', 42, [], {}, { data: 'nope' }, { data: { authority: 'A-mock' } }, { data: { code: {} } }, { data: { code: true } }]) {
      mockJson(body);
      await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('ZarinPal error code: undefined');
    }
  });

  it('keeps the previous TypeError for nullish bodies', async () => {
    for (const body of [null, undefined]) {
      mockJson(body);
      await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('propagates network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(zarinpalProvider.createCheckoutSession(config, req)).rejects.toThrow('network down');
  });

  it('does not leak merchant id, email, mobile, metadata or authority in errors', async () => {
    mockJson({ data: { code: -11 }, errors: { message: 'merchant not found' } });
    const err = await zarinpalProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    const text = String((err as Error).message);
    for (const secret of ['mock-merchant-id-0001', 'mock-buyer@example.com', '09120000000', 'callback_url', 'workspace_id']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('zarinpal testConnection', () => {
  it('succeeds for data.code 100 and -9', async () => {
    for (const code of [100, -9]) {
      mockJson({ data: { code } });
      const out = await zarinpalProvider.testConnection(config);
      expect(out.success).toBe(true);
      expect(typeof out.latencyMs).toBe('number');
    }
  });

  it('reports invalid merchant for errors.code -1 and -2', async () => {
    for (const code of [-1, -2] as const) {
      mockJson({ errors: { code } });
      const out = await zarinpalProvider.testConnection(config);
      expect(out).toMatchObject({ success: false, error: 'Invalid merchant ID' });
      expect(out.error).not.toContain('mock-merchant-id-0001');
    }
  });

  it('does not coerce string codes', async () => {
    mockJson({ data: { code: '100' } });
    expect((await zarinpalProvider.testConnection(config)).success).toBe(true);
    mockJson({ errors: { code: '-1' } });
    expect((await zarinpalProvider.testConnection(config)).success).toBe(true);
  });

  it('treats other codes as reachable', async () => {
    mockJson({ errors: { code: -11 } });
    expect((await zarinpalProvider.testConnection(config)).success).toBe(true);
  });

  it('sends the unchanged test payload', async () => {
    const fetchMock = mockJson({ data: { code: 100 } });
    await zarinpalProvider.testConnection(config);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.zarinpal.com/pg/v4/payment/request.json');
    expect(JSON.parse(init.body)).toEqual({
      merchant_id: 'mock-merchant-id-0001',
      amount: 1000,
      callback_url: 'https://test.localhost/callback',
      description: 'Connection test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles malformed bodies as reachable', async () => {
    for (const body of ['oops', 7, [], {}, { data: 'nope' }, { errors: 'nope' }]) {
      mockJson(body);
      expect((await zarinpalProvider.testConnection(config)).success).toBe(true);
    }
  });

  it('reports nullish bodies and network failures as failures without leaking secrets', async () => {
    mockJson(null);
    const nullish = await zarinpalProvider.testConnection(config);
    expect(nullish.success).toBe(false);
    expect(nullish.error).not.toContain('mock-merchant-id-0001');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const out = await zarinpalProvider.testConnection(config);
    expect(out).toMatchObject({ success: false, error: 'socket hang up' });
  });
});
