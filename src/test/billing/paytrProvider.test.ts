import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  paytrProvider,
  paytrMerchantOid,
  workspaceIdFromPaytrOid,
  readPayTrRecord,
  readPayTrCreateStatus,
  readPayTrCreateToken,
  readPayTrCreateError,
} from '../../../server/services/billing/providers/paytr.js';

const config = {
  provider: 'paytr',
  merchant_id: 'merchant-id-mock',
  merchant_key: 'merchant-key-mock',
  merchant_salt: 'merchant-salt-mock',
  sandbox: true,
};

const req = {
  workspaceId: 'ws1',
  planId: 'plan-pro',
  interval: 'monthly' as const,
  currency: 'TRY',
  callbackUrl: 'https://app.example.com/billing/callback',
  customerEmail: 'buyer@example.com',
  customerName: 'Buyer Name',
  metadata: { amount: '19900', ip: '10.0.0.1', phone: '5550000000' },
};

function mockJson(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PayTR create-response parsers', () => {
  it('readPayTrRecord throws for nullish body (unchanged legacy behaviour)', () => {
    expect(() => readPayTrRecord(null)).toThrow(TypeError);
    expect(() => readPayTrRecord(undefined)).toThrow(TypeError);
  });
  it.each([['str'], [42], [true], [[]]])('readPayTrRecord returns empty record for primitive/array %#', (body) => {
    expect(readPayTrRecord(body)).toEqual({});
  });
  it('readPayTrCreateStatus reads only string status', () => {
    expect(readPayTrCreateStatus({ status: 'success' })).toBe('success');
    expect(readPayTrCreateStatus({ status: 1 })).toBeUndefined();
    expect(readPayTrCreateStatus({})).toBeUndefined();
  });
  it('readPayTrCreateToken reads only non-empty string token', () => {
    expect(readPayTrCreateToken({ token: 'tok-mock' })).toBe('tok-mock');
    expect(readPayTrCreateToken({ token: '' })).toBeUndefined();
    expect(readPayTrCreateToken({ token: 42 })).toBeUndefined();
    expect(readPayTrCreateToken({ token: {} })).toBeUndefined();
    expect(readPayTrCreateToken({})).toBeUndefined();
  });
  it('readPayTrCreateError reads only non-empty string reason', () => {
    expect(readPayTrCreateError({ reason: 'bad request' })).toBe('bad request');
    expect(readPayTrCreateError({ reason: '' })).toBeUndefined();
    expect(readPayTrCreateError({ reason: { m: 1 } })).toBeUndefined();
    expect(readPayTrCreateError({})).toBeUndefined();
  });
});

describe('paytr createCheckoutSession (success)', () => {
  it('returns checkout url and session id from the response token', async () => {
    mockJson({ status: 'success', token: 'iframe-token-mock' });
    const res = await paytrProvider.createCheckoutSession(config, req);
    expect(res.paymentUrl).toBe('https://www.paytr.com/odeme/guvenli/iframe-token-mock');
    expect(res.sessionId).toBe('iframe-token-mock');
  });

  it('sends the endpoint, method and payload, with the token PayTR actually computes', async () => {
    const fetchMock = mockJson({ status: 'success', token: 'iframe-token-mock' });
    await paytrProvider.createCheckoutSession(config, req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.paytr.com/odeme/api/get-token');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(URLSearchParams);

    const p = init.body as URLSearchParams;
    // PayTR order ids are alphanumeric only.
    const orderId = 'ws11700000000000';
    const expectedBasket = Buffer.from(JSON.stringify([['Plan plan-pro', '199.00', 1]])).toString('base64');
    // iFrame API: merchant_id + user_ip + merchant_oid + email + payment_amount +
    // user_basket + no_installment + max_installment + currency + test_mode, then
    // merchant_salt. (It used to hash 'subscription' / 'TRY' / '0' in the wrong
    // slots, so PayTR rejected every token.)
    const expectedHash = `merchant-id-mock10.0.0.1${orderId}buyer@example.com19900${expectedBasket}012TL1merchant-salt-mock`;
    const expectedToken = crypto.createHmac('sha256', 'merchant-key-mock').update(expectedHash).digest('base64');

    expect(p.get('merchant_id')).toBe('merchant-id-mock');
    expect(p.get('user_ip')).toBe('10.0.0.1');
    expect(p.get('merchant_oid')).toBe(orderId);
    expect(p.get('email')).toBe('buyer@example.com');
    expect(p.get('payment_amount')).toBe('19900');
    expect(p.get('paytr_token')).toBe(expectedToken);
    expect(p.get('user_basket')).toBe(expectedBasket);
    expect(p.get('debug_on')).toBe('1');
    expect(p.get('no_installment')).toBe('0');
    expect(p.get('max_installment')).toBe('12');
    expect(p.get('currency')).toBe('TL');
    expect(p.get('test_mode')).toBe('1');
    expect(p.get('merchant_ok_url')).toBe('https://app.example.com/billing/callback');
    expect(p.get('merchant_fail_url')).toBe('https://app.example.com/billing/callback');
    expect(p.get('user_name')).toBe('Buyer Name');
    expect(p.get('user_phone')).toBe('5550000000');
    expect(p.get('user_address')).toBe('Turkey');
    expect([...p.keys()].sort()).toEqual([
      'currency', 'debug_on', 'email', 'max_installment', 'merchant_fail_url', 'merchant_id',
      'merchant_oid', 'merchant_ok_url', 'no_installment', 'payment_amount', 'paytr_token',
      'test_mode', 'user_address', 'user_basket', 'user_ip', 'user_name', 'user_phone',
    ]);
  });

  it('charges a USD price in USD (not labelled TL), without lira installments, and signs that currency', async () => {
    const fetchMock = mockJson({ status: 'success', token: 'iframe-token-mock' });
    await paytrProvider.createCheckoutSession(config, { ...req, currency: 'USD', metadata: { ...req.metadata, amount: '2900' } });
    const p = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(p.get('currency')).toBe('USD');
    expect(p.get('payment_amount')).toBe('2900');
    expect(p.get('no_installment')).toBe('1');
    expect(p.get('max_installment')).toBe('0');
    const basket = p.get('user_basket');
    const hash = `merchant-id-mock10.0.0.1ws11700000000000buyer@example.com2900${basket}10USD1merchant-salt-mock`;
    expect(p.get('paytr_token')).toBe(crypto.createHmac('sha256', 'merchant-key-mock').update(hash).digest('base64'));
  });

  it.each([['EUR', 'EUR'], ['GBP', 'GBP'], ['try', 'TL']])('sends %s as %s', async (currency, sent) => {
    const fetchMock = mockJson({ status: 'success', token: 't' });
    await paytrProvider.createCheckoutSession(config, { ...req, currency });
    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get('currency')).toBe(sent);
  });

  it('refuses a currency PayTR cannot charge instead of relabelling it', async () => {
    const fetchMock = mockJson({ status: 'success', token: 't' });
    await expect(paytrProvider.createCheckoutSession(config, { ...req, currency: 'IRR' })).rejects.toThrow(/PayTR cannot charge IRR/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a workspace UUID becomes an alphanumeric order id that maps back to it', async () => {
    const ws = '2f1c9a3e-7b4d-4c1a-9e2f-0a1b2c3d4e5f';
    const fetchMock = mockJson({ status: 'success', token: 't' });
    await paytrProvider.createCheckoutSession(config, { ...req, workspaceId: ws });
    const oid = (fetchMock.mock.calls[0][1].body as URLSearchParams).get('merchant_oid') as string;
    expect(oid).toMatch(/^[A-Za-z0-9]+$/);
    expect(workspaceIdFromPaytrOid(oid)).toBe(ws);
    expect(paytrMerchantOid(ws, 1)).toBe('2f1c9a3e7b4d4c1a9e2f0a1b2c3d4e5f1');
  });
});

describe('paytr callback currency', () => {
  const key = 'merchant-key-mock';
  const salt = 'merchant-salt-mock';
  function callback(fields: Record<string, string>) {
    const hash = crypto.createHmac('sha256', key)
      .update(`${fields.merchant_oid}${salt}${fields.status}${fields.total_amount}`)
      .digest('base64');
    return new URLSearchParams({ ...fields, hash }).toString();
  }

  it('records the order currency PayTR reports (TL → TRY) and the workspace from the order id', async () => {
    const ws = '2f1c9a3e-7b4d-4c1a-9e2f-0a1b2c3d4e5f';
    const oid = paytrMerchantOid(ws, 1700000000000);
    const usd = await paytrProvider.verifyWebhook(config, {}, callback({ merchant_oid: oid, status: 'success', total_amount: '2900', currency: 'USD' }));
    expect(usd).toMatchObject({ amount: 2900, currency: 'USD', workspaceId: ws });
    const tl = await paytrProvider.verifyWebhook(config, {}, callback({ merchant_oid: oid, status: 'success', total_amount: '19900', currency: 'TL' }));
    expect(tl?.currency).toBe('TRY');
  });
});

describe('paytr createCheckoutSession (provider failure)', () => {
  it('throws the provider reason and produces no url or session id', async () => {
    mockJson({ status: 'failed', reason: 'invalid merchant' });
    await expect(paytrProvider.createCheckoutSession(config, req)).rejects.toThrow('invalid merchant');
  });
  it('does not accept SUCCESS in a different case', async () => {
    mockJson({ status: 'SUCCESS', token: 'iframe-token-mock' });
    await expect(paytrProvider.createCheckoutSession(config, req)).rejects.toThrow('PayTR token failed');
  });
  it('never leaks secrets in the error message', async () => {
    mockJson({ status: 'failed', reason: 'invalid merchant' });
    const err = await paytrProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    const msg = (err as Error).message;
    for (const secret of ['merchant-key-mock', 'merchant-salt-mock', 'buyer@example.com', '5550000000', 'Turkey']) {
      expect(msg).not.toContain(secret);
    }
  });
});

describe('paytr createCheckoutSession (malformed responses)', () => {
  it('throws a TypeError for a null body', async () => {
    mockJson(null);
    await expect(paytrProvider.createCheckoutSession(config, req)).rejects.toThrow(TypeError);
  });
  it.each([
    ['empty object', {}],
    ['array', []],
    ['primitive', 'oops'],
    ['status wrong type', { status: 1, token: 'tok' }],
    ['success without token', { status: 'success' }],
    ['success with empty token', { status: 'success', token: '' }],
    ['success with numeric token', { status: 'success', token: 42 }],
    ['success with object token', { status: 'success', token: { a: 1 } }],
    ['object reason', { status: 'failed', reason: { a: 1 } }],
  ])('fails explicitly for %s', async (_label, body) => {
    mockJson(body);
    await expect(paytrProvider.createCheckoutSession(config, req)).rejects.toThrow('PayTR token failed');
  });
});

describe('paytr createCheckoutSession (network failure)', () => {
  it('propagates the rejection without retrying', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(paytrProvider.createCheckoutSession(config, req)).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('paytr testConnection', () => {
  it('fails fast when credentials are missing', async () => {
    const fetchMock = mockJson({ status: 'error' });
    const res = await paytrProvider.testConnection({ provider: 'paytr' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Missing required credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports invalid credentials on the known provider reason', async () => {
    mockJson({ status: 'error', reason: 'Üye işyeri bulunamadı' });
    const res = await paytrProvider.testConnection(config);
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid merchant credentials');
  });
  it('treats any other reachable response as success', async () => {
    mockJson({ status: 'error', reason: 'zorunlu alan eksik' });
    const res = await paytrProvider.testConnection(config);
    expect(res.success).toBe(true);
  });
  it('handles a non-string reason without throwing', async () => {
    mockJson({ status: 'error', reason: { a: 1 } });
    const res = await paytrProvider.testConnection(config);
    expect(res.success).toBe(true);
  });
});
