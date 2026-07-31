import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { paratikaProvider } from '../../../server/services/billing/providers/paratika';

const CONFIG = {
  provider: 'paratika',
  merchant_code: 'MOCK_MERCHANT',
  merchant_user: 'MOCK_USER',
  merchant_password: 'MOCK_PASSWORD_XYZ',
};

const REQ = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  planId: 'pro',
  interval: 'monthly' as const,
  currency: 'TRY',
  callbackUrl: 'https://app.example.com/billing/callback',
  customerEmail: 'mock.customer@example.com',
  metadata: { amount: '149.90' },
};

function mockJson(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('paratika createCheckoutSession', () => {
  it('returns payment url and session id on success', async () => {
    const fetchMock = mockJson({ responseCode: '00', sessionToken: 'TOKEN_ABC' });
    const result = await paratikaProvider.createCheckoutSession(CONFIG, REQ);
    expect(result).toEqual({
      paymentUrl: 'https://entegrasyon.asseco-see.com.tr/fim/paymentPage?sessiontoken=TOKEN_ABC',
      sessionId: 'TOKEN_ABC',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://entegrasyon.asseco-see.com.tr/fim/api');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const params = new URLSearchParams(init.body);
    expect(Object.fromEntries(params)).toEqual({
      ACTION: 'SESSIONTOKEN',
      MERCHANTUSER: 'MOCK_USER',
      MERCHANTPASSWORD: 'MOCK_PASSWORD_XYZ',
      MERCHANT: 'MOCK_MERCHANT',
      SESSIONTYPE: 'PAYMENTSESSION',
      RETURNURL: 'https://app.example.com/billing/callback',
      AMOUNT: '149.90',
      CURRENCY: 'TRY',
      MERCHANTPAYMENTID: `${REQ.workspaceId}_${Date.now()}`,
      CUSTOMER: 'mock.customer@example.com',
    });
  });

  it('defaults amount to 0 and customer to empty when absent', async () => {
    const fetchMock = mockJson({ responseCode: '00', sessionToken: 'T' });
    await paratikaProvider.createCheckoutSession(CONFIG, { ...REQ, metadata: undefined, customerEmail: undefined });
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('AMOUNT')).toBe('0');
    expect(params.get('CURRENCY')).toBe('TRY');
    expect(params.get('CUSTOMER')).toBe('');
  });

  it('throws provider message on error response', async () => {
    mockJson({ responseCode: '99', responseMsg: 'Invalid merchant' });
    await expect(paratikaProvider.createCheckoutSession(CONFIG, REQ)).rejects.toThrow('Invalid merchant');
  });

  it('falls back to generic message when responseMsg has wrong type', async () => {
    mockJson({ responseCode: '99', responseMsg: { nested: true } });
    await expect(paratikaProvider.createCheckoutSession(CONFIG, REQ)).rejects.toThrow('Paratika session failed');
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['empty object', {}],
    ['missing token', { responseCode: '00' }],
    ['token wrong type', { responseCode: '00', sessionToken: 12345 }],
    ['missing response code', { sessionToken: 'T' }],
    ['numeric response code', { responseCode: 0, sessionToken: 'T' }],
  ])('fails explicitly for %s', async (_label, body) => {
    mockJson(body);
    await expect(paratikaProvider.createCheckoutSession(CONFIG, REQ)).rejects.toThrow('Paratika session failed');
  });

  it('does not leak secrets in errors', async () => {
    mockJson({ responseCode: '99' });
    const err = await paratikaProvider.createCheckoutSession(CONFIG, REQ).catch((e: Error) => e);
    const msg = String((err as Error).message);
    expect(msg).not.toContain('MOCK_PASSWORD_XYZ');
    expect(msg).not.toContain('MOCK_MERCHANT');
    expect(msg).not.toContain('mock.customer@example.com');
    expect(msg).toBe('Paratika session failed');
  });
});

describe('paratika testConnection', () => {
  it('fails fast on missing credentials without calling fetch', async () => {
    const fetchMock = mockJson({});
    const result = await paratikaProvider.testConnection({ provider: 'paratika' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns success for a valid response', async () => {
    mockJson({ responseCode: '00', sessionToken: 'T' });
    expect((await paratikaProvider.testConnection(CONFIG)).success).toBe(true);
  });

  it('returns auth failure for responseCode 99', async () => {
    mockJson({ responseCode: '99' });
    const result = await paratikaProvider.testConnection(CONFIG);
    expect(result).toMatchObject({ success: false, error: 'Auth failed' });
  });

  it.each([['null', null], ['array', []], ['empty', {}]])('treats malformed body (%s) as success as before', async (_l, body) => {
    mockJson(body);
    expect((await paratikaProvider.testConnection(CONFIG)).success).toBe(true);
  });

  it('reports network failure without leaking credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const result = await paratikaProvider.testConnection(CONFIG);
    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
    expect(result.error).not.toContain('MOCK_PASSWORD_XYZ');
  });
});
