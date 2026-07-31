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

describe('paratika refundPayment', () => {
  it('returns success and refund id, asserting the exact request payload', async () => {
    const fetchMock = mockJson({ responseCode: '00', pgTranId: 'PG_REFUND_1' });
    const result = await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL', 14990);
    expect(result).toEqual({ success: true, refundId: 'PG_REFUND_1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://entegrasyon.asseco-see.com.tr/fim/api');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      ACTION: 'REFUND',
      MERCHANTUSER: 'MOCK_USER',
      MERCHANTPASSWORD: 'MOCK_PASSWORD_XYZ',
      MERCHANT: 'MOCK_MERCHANT',
      PGTRANID: 'PG_TRAN_ORIGINAL',
      AMOUNT: '149.90',
      CURRENCY: 'TRY',
    });
  });

  it('omits AMOUNT when no amount is passed', async () => {
    const fetchMock = mockJson({ responseCode: '00', pgTranId: 'PG_REFUND_2' });
    await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL');
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('AMOUNT')).toBeNull();
    expect(params.get('CURRENCY')).toBe('TRY');
    expect(params.get('PGTRANID')).toBe('PG_TRAN_ORIGINAL');
  });

  it('converts a numeric pgTranId with an explicit toString', async () => {
    mockJson({ responseCode: '00', pgTranId: 987654 });
    expect(await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL')).toEqual({
      success: true,
      refundId: '987654',
    });
  });

  it('reports provider failure without inventing success', async () => {
    mockJson({ responseCode: '99', responseMsg: 'Refund rejected' });
    expect(await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL', 100)).toEqual({
      success: false,
      refundId: undefined,
    });
  });

  it.each([
    ['null body', null, false, undefined],
    ['array body', [], false, undefined],
    ['empty object', {}, false, undefined],
    ['primitive body', 'oops', false, undefined],
    ['missing responseCode', { pgTranId: 'X' }, false, 'X'],
    ['numeric responseCode', { responseCode: 0, pgTranId: 'X' }, false, 'X'],
    ['success without pgTranId', { responseCode: '00' }, true, undefined],
    ['object pgTranId', { responseCode: '00', pgTranId: { a: 1 } }, true, undefined],
    ['boolean pgTranId', { responseCode: '00', pgTranId: true }, true, undefined],
    ['null pgTranId', { responseCode: '00', pgTranId: null }, true, undefined],
    ['wrong-typed responseMsg', { responseCode: '99', responseMsg: { m: 1 } }, false, undefined],
  ])('handles malformed body (%s)', async (_label, body, success, refundId) => {
    mockJson(body);
    expect(await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL')).toEqual({ success, refundId });
  });

  it('propagates network failure without retrying', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const err = await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL').catch((e: Error) => e);
    expect((err as Error).message).toBe('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not leak credentials in the returned result', async () => {
    mockJson({ responseCode: '99', responseMsg: 'Refund rejected' });
    const serialized = JSON.stringify(await paratikaProvider.refundPayment?.(CONFIG, 'PG_TRAN_ORIGINAL'));
    expect(serialized).not.toContain('MOCK_PASSWORD_XYZ');
    expect(serialized).not.toContain('MOCK_USER');
    expect(serialized).not.toContain('MOCK_MERCHANT');
  });
});
