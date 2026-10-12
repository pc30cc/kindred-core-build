import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sepProvider,
  readSepRecord,
  readSepStatus,
  readSepErrorDescription,
  readSepToken,
} from '../../../server/services/billing/providers/sep';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const TERMINAL = '98765432';
const config: BillingProviderConfig = { provider: 'sep_shaparak', terminal_id: TERMINAL };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://app.example.test/callback',
  metadata: { amount: '250000', phone: '09120000000' },
};

function mockJson(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('SEP readers', () => {
  it('throws on nullish body', () => {
    expect(() => readSepRecord(null)).toThrow(TypeError);
    expect(() => readSepRecord(undefined)).toThrow(TypeError);
  });
  it('returns empty record for primitives and arrays', () => {
    expect(readSepRecord('x')).toEqual({});
    expect(readSepRecord(5)).toEqual({});
    expect(readSepRecord([1, 2])).toEqual({});
  });
  it('passes objects through', () => {
    expect(readSepRecord({ status: 1 })).toEqual({ status: 1 });
  });
  it('reads raw status', () => {
    expect(readSepStatus({ status: 1 })).toBe(1);
    expect(readSepStatus({ status: '1' })).toBe('1');
    expect(readSepStatus({})).toBeUndefined();
  });
  it('reads only non-empty string errorDesc', () => {
    expect(readSepErrorDescription({ errorDesc: 'bad terminal' })).toBe('bad terminal');
    expect(readSepErrorDescription({ errorDesc: '' })).toBeUndefined();
    expect(readSepErrorDescription({ errorDesc: { a: 1 } })).toBeUndefined();
    expect(readSepErrorDescription({ errorDesc: ['a'] })).toBeUndefined();
    expect(readSepErrorDescription({})).toBeUndefined();
  });
  it('reads only non-empty string token', () => {
    expect(readSepToken({ token: 'tok' })).toBe('tok');
    expect(readSepToken({ token: '' })).toBeUndefined();
    expect(readSepToken({ token: 123 })).toBeUndefined();
    expect(readSepToken({ token: {} })).toBeUndefined();
    expect(readSepToken({})).toBeUndefined();
  });
});

describe('SEP createCheckoutSession — success', () => {
  it('posts the exact payload and returns token-derived URL', async () => {
    const fetchMock = mockJson({ status: 1, token: 'TOKEN_MOCK_ABC' });
    const result = await sepProvider.createCheckoutSession(config, req);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sep.shaparak.ir/onlinepg/onlinepg');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      action: 'token',
      TerminalId: TERMINAL,
      Amount: 250000,
      ResNum: `ws-1_plan-pro_${Date.now()}`,
      RedirectUrl: 'https://app.example.test/callback',
      CellNumber: '09120000000',
    });
    expect(result).toEqual({
      paymentUrl: 'https://sep.shaparak.ir/OnlinePG/SendToken?token=TOKEN_MOCK_ABC',
      sessionId: 'TOKEN_MOCK_ABC',
    });
  });

  it('uses the payment id as ResNum when there is one', async () => {
    const fetchMock = mockJson({ status: 1, token: 't' });
    await sepProvider.createCheckoutSession(config, { ...req, intentId: 'pay-1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).ResNum).toBe('pay-1');
  });

  it('defaults amount to 0 when metadata amount is missing', async () => {
    const fetchMock = mockJson({ status: 1, token: 't' });
    await sepProvider.createCheckoutSession(config, { ...req, metadata: {} });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).Amount).toBe(0);
  });
});

describe('SEP createCheckoutSession — provider failure', () => {
  it('numeric failure status with errorDesc', async () => {
    mockJson({ status: -1, errorDesc: 'Invalid terminal' });
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: Invalid terminal');
  });
  it('numeric failure status without errorDesc', async () => {
    mockJson({ status: -12 });
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: -12');
  });
  it('string status "1" is still a failure', async () => {
    mockJson({ status: '1', token: 'tok' });
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: 1');
  });
  it('object status does not leak into the message', async () => {
    mockJson({ status: { code: 5 } });
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: unknown status');
  });
  it('object errorDesc is ignored', async () => {
    mockJson({ status: -1, errorDesc: { msg: 'x' } });
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: -1');
  });
});

describe('SEP createCheckoutSession — malformed body', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('throws TypeError for %s body', async (_l, body) => {
    mockJson(body);
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow(TypeError);
  });

  it.each([
    ['primitive', 'oops'],
    ['array', [{ status: 1, token: 'tok' }]],
    ['empty object', {}],
  ])('fails without a payment URL for %s body', async (_l, body) => {
    mockJson(body);
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: unknown status');
  });

  it.each([
    ['missing token', { status: 1 }],
    ['empty token', { status: 1, token: '' }],
    ['numeric token', { status: 1, token: 123 }],
    ['object token', { status: 1, token: { t: 'x' } }],
  ])('rejects success status with %s', async (_l, body) => {
    mockJson(body);
    await expect(sepProvider.createCheckoutSession(config, req)).rejects.toThrow('SEP error: missing token in response');
  });
});

describe('SEP testConnection', () => {
  it('succeeds only when SEP issues a token, with the platform\'s callback', async () => {
    const fetchMock = mockJson({ status: 1, token: 'tok' });
    const r = await sepProvider.testConnection({ ...config, probe_callback_url: 'https://api.webyar.ai/api/billing/account-return' });
    expect(r.success).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).RedirectUrl).toBe('https://api.webyar.ai/api/billing/account-return');
  });
  it('reports SEP\'s error code and description', async () => {
    mockJson({ status: -1, errorCode: 5, errorDesc: 'Invalid terminal' });
    expect(await sepProvider.testConnection(config)).toMatchObject({ success: false, error: 'SEP 5: Invalid terminal' });
  });
  it.each([
    ['other failure status', { status: -5 }],
    ['string status', { status: '1', token: 'tok' }],
    ['empty object', {}],
    ['array', []],
    ['primitive', 'x'],
    ['null body', null],
  ])('is not a success for %s (it used to report the endpoint reachable)', async (_l, body) => {
    mockJson(body);
    expect((await sepProvider.testConnection(config)).success).toBe(false);
  });
  it('refuses a terminal number that is not digits, without calling SEP', async () => {
    const fetchMock = mockJson({ status: 1, token: 'tok' });
    expect((await sepProvider.testConnection({ provider: 'sep_shaparak', terminal_id: 'abc' })).error).toMatch(/digits/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('handles network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const r = await sepProvider.testConnection(config);
    expect(r).toMatchObject({ success: false, error: 'network down' });
  });
});

describe('SEP does not leak sensitive data', () => {
  it('keeps credentials, phone and tokens out of errors', async () => {
    mockJson({ status: -1, errorDesc: 'Invalid terminal' });
    const err = await sepProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    const text = String((err as Error).message);
    expect(text).not.toContain(TERMINAL);
    expect(text).not.toContain('09120000000');
    expect(text).not.toContain('TOKEN_MOCK');
    expect(text).not.toContain('RedirectUrl');
  });
});

describe('sep verifyPayment', () => {
  const VERIFY_URL = 'https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction';
  const verifyParams = { RefNum: 'REFNUM_MOCK_0001' };

  it('posts the verify payload and maps ResultCode 0 to success', async () => {
    const fetchMock = mockJson({
      ResultCode: 0,
      Success: true,
      TransactionDetail: { RefNum: 'REFNUM_MOCK_0001', OrginalAmount: 250000, AffectiveAmount: 250000 },
    });
    const out = await sepProvider.verifyPayment!(config, verifyParams);
    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe(VERIFY_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ RefNum: 'REFNUM_MOCK_0001', TerminalNumber: Number(TERMINAL) });
    expect(out).toEqual({
      verified: true,
      providerRef: 'REFNUM_MOCK_0001',
      amount: 250000,
      status: 'success',
    });
  });

  it('maps SEP ResultCodes strictly: 0 success, 2 already verified, anything else failed', async () => {
    const cases: Array<[unknown, boolean, string]> = [
      [0, true, 'success'],
      [2, true, 'already_verified'],
      [1, false, 'failed'],
      [-2, false, 'failed'],
      [-6, false, 'failed'],
      [-104, false, 'failed'],
      ['0', false, 'failed'],
      ['2', false, 'failed'],
      ['oops', false, 'failed'],
      [true, false, 'failed'],
      [false, false, 'failed'],
      [{ code: 0 }, false, 'failed'],
      [[], false, 'failed'],
      [null, false, 'failed'],
      [undefined, false, 'failed'],
    ];
    for (const [ResultCode, verified, status] of cases) {
      mockJson({ ResultCode, TransactionDetail: { OrginalAmount: 250000 } });
      const out = await sepProvider.verifyPayment!(config, verifyParams);
      expect(out.verified).toBe(verified);
      expect(out.status).toBe(status);
    }
  });

  it('an explicit Success=false vetoes ResultCode 0', async () => {
    mockJson({ ResultCode: 0, Success: false, TransactionDetail: { OrginalAmount: 250000 } });
    const out = await sepProvider.verifyPayment!(config, verifyParams);
    expect(out.verified).toBe(false);
    expect(out.status).toBe('failed');
  });

  it('returns OrginalAmount only when it is a finite number', async () => {
    const cases: Array<[unknown, number | undefined]> = [
      [250000, 250000],
      [0, undefined],
      [-5, undefined],
      ['250000', undefined],
      [Number.POSITIVE_INFINITY, undefined],
      [Number.NaN, undefined],
      [undefined, undefined],
      [null, undefined],
      [{ v: 1 }, undefined],
      [true, undefined],
    ];
    for (const [OrginalAmount, expected] of cases) {
      mockJson({ ResultCode: 1, TransactionDetail: { OrginalAmount } });
      expect((await sepProvider.verifyPayment!(config, verifyParams)).amount).toBe(expected);
    }
  });

  it('reads SEP\'s documented `OrginalAmount`, then `OriginalAmount`, then `AffectiveAmount`', async () => {
    mockJson({ ResultCode: 0, TransactionDetail: { OriginalAmount: 111, AffectiveAmount: 222 } });
    expect((await sepProvider.verifyPayment!(config, verifyParams)).amount).toBe(111);
    mockJson({ ResultCode: 0, TransactionDetail: { AffectiveAmount: 222 } });
    expect((await sepProvider.verifyPayment!(config, verifyParams)).amount).toBe(222);
    mockJson({ ResultCode: 0, TransactionDetail: { OrginalAmount: 333, OriginalAmount: 111 } });
    expect((await sepProvider.verifyPayment!(config, verifyParams)).amount).toBe(333);
  });

  it('a return without RefNum (cancelled at the bank) is not sent to SEP', async () => {
    const fetchMock = mockJson({ ResultCode: 0 });
    expect(await sepProvider.verifyPayment!(config, { State: 'CanceledByUser', Token: 't' })).toEqual({ verified: false, providerRef: '', status: 'canceled' });
    expect(await sepProvider.verifyPayment!(config, { Token: 't' })).toEqual({ verified: false, providerRef: '', status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the request RefNum as the provider reference', async () => {
    mockJson({ ResultCode: 1, TransactionDetail: { RefNum: 'OTHER_REF', OrginalAmount: 1 } });
    expect((await sepProvider.verifyPayment!(config, verifyParams)).providerRef).toBe('REFNUM_MOCK_0001');

    expect((await sepProvider.verifyPayment!(config, {})).providerRef).toBe('');
  });

  it('handles malformed bodies without inventing an amount', async () => {
    for (const body of [{}, 'oops', 7, [], { ResultCode: 1 }, { ResultCode: 1, TransactionDetail: 'nope' }, { ResultCode: 1, TransactionDetail: [] }]) {
      mockJson(body);
      const out = await sepProvider.verifyPayment!(config, verifyParams);
      expect(out.amount).toBeUndefined();
      expect(out.providerRef).toBe('REFNUM_MOCK_0001');
    }
  });

  it('keeps nullish TypeError and network rejection behaviour', async () => {
    mockJson(null);
    await expect(sepProvider.verifyPayment!(config, verifyParams)).rejects.toBeInstanceOf(TypeError);

    const failing = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', failing);
    await expect(sepProvider.verifyPayment!(config, verifyParams)).rejects.toThrow('socket hang up');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('does not leak terminal or customer data in the verify result', async () => {
    mockJson({ ResultCode: 1, TransactionDetail: { OrginalAmount: 250000 } });
    const serialized = JSON.stringify(await sepProvider.verifyPayment!(config, verifyParams));
    expect(serialized).not.toContain(TERMINAL);
    expect(serialized).not.toContain('09120000000');
    expect(serialized).not.toContain('TransactionDetail');
  });
});

describe('sep timeouts', () => {
  function slowFetch(delayMs: number, body: unknown) {
    const fn = vi.fn((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ json: async () => body }), delayMs);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('verify waits well past the 20 s create/test deadline (SEP verifies slowly and never undoes a verify)', async () => {
    slowFetch(25_000, { Success: true, ResultCode: 0, TransactionDetail: { OrginalAmount: 250000 } });
    const pending = sepProvider.verifyPayment(config, { RefNum: 'ref-slow', State: 'OK' });
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(pending).resolves.toMatchObject({ verified: true, status: 'success', amount: 250000 });
  });

  it('create still gives up after 20 s', async () => {
    slowFetch(25_000, { status: 1, token: 'tok' });
    const pending = sepProvider.createCheckoutSession(config, req);
    const check = expect(pending).rejects.toThrow(/SEP gateway unreachable: no answer within 20 s/);
    await vi.advanceTimersByTimeAsync(21_000);
    await check;
  });
});
