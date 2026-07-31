import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { sipayProvider } from '../../../server/services/billing/providers/sipay';

const config = {
  provider: 'sipay',
  merchant_key: 'MKEY_SECRET',
  app_key: 'APPKEY',
  app_secret: 'APPSECRET_SUPER',
};

const req = {
  workspaceId: 'ws-1',
  planId: 'pro',
  interval: 'monthly' as const,
  currency: 'TRY',
  callbackUrl: 'https://app.example.com/cb',
  customerEmail: 'a@b.com',
  customerName: 'Ali',
  metadata: { amount: '150.00' },
};

function mockJson(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sipay createCheckoutSession', () => {
  it('returns payment url and session id on success', async () => {
    const fetchMock = mockJson({ success: true, paymentUrl: 'https://pay.sipay/1' });
    const out = await sipayProvider.createCheckoutSession(config, req);
    expect(out.paymentUrl).toBe('https://pay.sipay/1');
    expect(out.sessionId).toBe(`ws-1_${Date.now()}`);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.sipay.com.tr/ccpayment/api/paySmart3D');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      merchant_key: 'MKEY_SECRET',
      app_key: 'APPKEY',
      hash_key: payload.hash_key,
      invoice_id: `ws-1_${Date.now()}`,
      total: '150.00',
      currency: 'TRY',
      return_url: 'https://app.example.com/cb',
      cancel_url: 'https://app.example.com/cb',
      bill_email: 'a@b.com',
      bill_fname: 'Ali',
      bill_lname: 'User',
      items: JSON.stringify([{ name: 'Plan pro', price: '150.00', quantity: 1 }]),
    });
  });

  it('falls back to url_3d', async () => {
    mockJson({ success: true, url_3d: 'https://pay.sipay/3d' });
    expect((await sipayProvider.createCheckoutSession(config, req)).paymentUrl).toBe('https://pay.sipay/3d');
  });

  it('prefers paymentUrl over url_3d', async () => {
    mockJson({ success: true, paymentUrl: 'https://a', url_3d: 'https://b' });
    expect((await sipayProvider.createCheckoutSession(config, req)).paymentUrl).toBe('https://a');
  });

  it('throws provider message on failure', async () => {
    mockJson({ success: false, message: 'Invalid merchant' });
    await expect(sipayProvider.createCheckoutSession(config, req)).rejects.toThrow('Invalid merchant');
  });

  it('throws generic error when message missing', async () => {
    mockJson({ success: false });
    await expect(sipayProvider.createCheckoutSession(config, req)).rejects.toThrow('Sipay checkout failed');
  });

  it('throws generic error when message has wrong type', async () => {
    mockJson({ success: false, message: { code: 1 } });
    await expect(sipayProvider.createCheckoutSession(config, req)).rejects.toThrow('Sipay checkout failed');
  });

  it.each([
    ['empty object', {}],
    ['array', []],
    ['primitive', 5],
    ['success true but no url', { success: true }],
    ['url wrong type', { success: true, paymentUrl: 42 }],
    ['url empty string', { success: true, paymentUrl: '', url_3d: '' }],
  ])('rejects malformed body: %s', async (_label, body) => {
    mockJson(body);
    await expect(sipayProvider.createCheckoutSession(config, req)).rejects.toThrow('Sipay checkout failed');
  });

  it('throws TypeError on null body (unchanged behavior)', async () => {
    mockJson(null);
    await expect(sipayProvider.createCheckoutSession(config, req)).rejects.toThrow(TypeError);
  });

  it('does not leak secrets in error messages', async () => {
    mockJson({ success: false, message: 'Invalid merchant' });
    let err: Error | null = null;
    try {
      await sipayProvider.createCheckoutSession(config, req);
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    const text = `${err?.message}${err?.stack ?? ''}`;
    expect(text).not.toContain('APPSECRET_SUPER');
    expect(text).not.toContain('MKEY_SECRET');
    expect(text).not.toContain('APPKEY');
  });
});

describe('sipay testConnection', () => {
  it('succeeds with full credentials and makes no network call', async () => {
    const fetchMock = mockJson({});
    const out = await sipayProvider.testConnection(config);
    expect(out.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without credentials, leaking nothing', async () => {
    const out = await sipayProvider.testConnection({ provider: 'sipay' });
    expect(out.success).toBe(false);
    expect(out.error).toBe('Missing credentials');
  });
});

describe('sipay refundPayment', () => {
  it('succeeds on status_code "100" and returns refund id, with exact payload and hash', async () => {
    const fetchMock = mockJson({ status_code: '100', refund_id: 'RF-1' });
    const out = await sipayProvider.refundPayment?.(config, 'INV-9', 14990);
    expect(out).toEqual({ success: true, refundId: 'RF-1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.sipay.com.tr/ccpayment/api/refund');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      merchant_key: 'MKEY_SECRET',
      hash_key: payload.hash_key,
      invoice_id: 'INV-9',
      refund_amount: '149.90',
    });
    const expectedHash = crypto.createHmac('sha256', 'APPSECRET_SUPER')
      .update('MKEY_SECRETINV-9').digest('base64');
    expect(payload.hash_key).toBe(expectedHash);
  });

  it('omits refund_amount when amount is not provided', async () => {
    const fetchMock = mockJson({ status_code: '100', refund_id: 'RF-2' });
    await sipayProvider.refundPayment?.(config, 'INV-9');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('refund_amount' in payload).toBe(false);
  });

  it('stringifies a numeric refund id', async () => {
    mockJson({ status_code: '100', refund_id: 12345 });
    expect(await sipayProvider.refundPayment?.(config, 'INV-9')).toEqual({ success: true, refundId: '12345' });
  });

  it.each([
    ['numeric failure code', { status_code: 200 }],
    ['string failure code', { status_code: '41' }],
    ['numeric 100 (not strictly equal)', { status_code: 100 }],
    ['missing status_code', { refund_id: 'RF-3' }],
    ['wrong-typed status_code', { status_code: { v: 100 } }],
    ['empty object', {}],
    ['array', []],
    ['primitive', 5],
  ])('does not report success for %s', async (_label, body) => {
    mockJson(body);
    const out = await sipayProvider.refundPayment?.(config, 'INV-9');
    expect(out?.success).toBe(false);
  });

  it('returns success without refund id when refund_id is missing', async () => {
    mockJson({ status_code: '100' });
    expect(await sipayProvider.refundPayment?.(config, 'INV-9')).toEqual({ success: true, refundId: undefined });
  });

  it.each([
    ['object', { status_code: '100', refund_id: { id: 1 } }],
    ['boolean', { status_code: '100', refund_id: true }],
    ['null', { status_code: '100', refund_id: null }],
  ])('ignores refund_id of type %s', async (_label, body) => {
    mockJson(body);
    expect(await sipayProvider.refundPayment?.(config, 'INV-9')).toEqual({ success: true, refundId: undefined });
  });

  it('throws TypeError on null body (unchanged behavior)', async () => {
    mockJson(null);
    await expect(sipayProvider.refundPayment?.(config, 'INV-9')).rejects.toThrow(TypeError);
  });

  it('propagates network failure without retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sipayProvider.refundPayment?.(config, 'INV-9')).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not leak secrets in the result', async () => {
    mockJson({ status_code: '41', refund_id: 'RF-X' });
    const text = JSON.stringify(await sipayProvider.refundPayment?.(config, 'INV-9'));
    expect(text).not.toContain('APPSECRET_SUPER');
    expect(text).not.toContain('MKEY_SECRET');
    expect(text).not.toContain('APPKEY');
  });
});
