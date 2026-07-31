import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sepProvider,
  readSepRecord,
  readSepStatus,
  readSepErrorDescription,
  readSepToken,
} from '../../../server/services/billing/providers/sep';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const TERMINAL = 'TERMINAL_MOCK_0001';
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
    expect(url).toBe('https://sep.shaparak.ir/OnlinePG/OnlinePG');
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
  it('succeeds for a valid response', async () => {
    mockJson({ status: 1, token: 'tok' });
    const r = await sepProvider.testConnection(config);
    expect(r.success).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
  });
  it('reports invalid terminal for status -1', async () => {
    mockJson({ status: -1 });
    const r = await sepProvider.testConnection(config);
    expect(r).toMatchObject({ success: false, error: 'Invalid terminal ID' });
  });
  it.each([
    ['other failure status', { status: -5 }],
    ['string status', { status: '-1' }],
    ['empty object', {}],
    ['array', []],
    ['primitive', 'x'],
  ])('still reports reachable endpoint for %s', async (_l, body) => {
    mockJson(body);
    const r = await sepProvider.testConnection(config);
    expect(r.success).toBe(true);
  });
  it.each([
    ['null body', null],
    ['undefined body', undefined],
  ])('reports failure for %s', async (_l, body) => {
    mockJson(body);
    const r = await sepProvider.testConnection(config);
    expect(r.success).toBe(false);
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
