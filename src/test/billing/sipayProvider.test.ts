import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    const err = await sipayProvider.createCheckoutSession(config, req).catch((e) => e as Error);
    const text = `${err.message}${err.stack ?? ''}`;
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
