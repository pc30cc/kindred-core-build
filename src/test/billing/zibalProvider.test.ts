import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zibalProvider } from '../../../server/services/billing/providers/zibal';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const config: BillingProviderConfig = { provider: 'zibal', merchant: 'zibal-merchant-secret' };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://app.example.com/callback',
  metadata: { amount: '150000', phone: '09120000000' },
};

function mockJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('zibal createCheckoutSession', () => {
  it('succeeds with string trackId', async () => {
    mockJson({ result: 100, trackId: 'trk-abc' });
    const out = await zibalProvider.createCheckoutSession(config, req);
    expect(out).toEqual({ paymentUrl: 'https://gateway.zibal.ir/start/trk-abc', sessionId: 'trk-abc' });
  });

  it('succeeds with numeric trackId (string representation)', async () => {
    mockJson({ result: 100, trackId: 1234567 });
    const out = await zibalProvider.createCheckoutSession(config, req);
    expect(out.paymentUrl).toBe('https://gateway.zibal.ir/start/1234567');
    expect(out.sessionId).toBe('1234567');
  });

  it('sends the exact payload', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'trk' });
    await zibalProvider.createCheckoutSession(config, req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.zibal.ir/v1/request');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(init.body);
    expect(payload.merchant).toBe('zibal-merchant-secret');
    expect(payload.amount).toBe(150000);
    expect(payload.callbackUrl).toBe('https://app.example.com/callback');
    expect(payload.description).toBe('Plan pro');
    expect(payload.mobile).toBe('09120000000');
    expect(payload.orderId).toMatch(/^ws-1_pro_\d+$/);
    expect('multiplexingInfos' in payload).toBe(false);
  });

  it('includes multiplexingInfos when lazy_mode is on', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'trk' });
    await zibalProvider.createCheckoutSession({ ...config, lazy_mode: true }, req);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).multiplexingInfos).toEqual([]);
  });

  it('defaults amount to 0 when metadata amount is absent', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'trk' });
    await zibalProvider.createCheckoutSession(config, { ...req, metadata: undefined });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.amount).toBe(0);
    expect(payload.mobile).toBeUndefined();
  });

  it('fails on numeric non-100 result', async () => {
    mockJson({ result: 102 });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: 102');
  });

  it('does not coerce string "100" to success', async () => {
    mockJson({ result: '100', trackId: 'trk' });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: undefined');
  });

  it('uses a valid string message', async () => {
    mockJson({ result: 102, message: 'merchant invalid' });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: merchant invalid');
  });

  it('falls back when message is malformed', async () => {
    mockJson({ result: 105, message: { fa: 'bad' } });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: 105');
    mockJson({ result: 106, message: '' });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: 106');
  });

  it('fails explicitly when result is 100 but trackId is missing/invalid', async () => {
    for (const trackId of [undefined, null, '', {}, true, [], NaN]) {
      mockJson({ result: 100, trackId });
      await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('missing trackId');
    }
  });

  it('never produces undefined in URL or sessionId', async () => {
    mockJson({ result: 100 });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow(/^Zibal error: missing trackId/);
  });

  it('handles malformed bodies', async () => {
    for (const body of [null, undefined, 'oops', 42, [], {}]) {
      mockJson(body);
      await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: undefined');
    }
  });

  it('propagates network failure without leaking secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('network down');
  });

  it('does not leak merchant, mobile or request body in errors', async () => {
    mockJson({ result: 102, message: 'nope' });
    const err = await zibalProvider.createCheckoutSession(config, req).catch((e: Error) => e);
    const text = String((err as Error).message);
    expect(text).not.toContain('zibal-merchant-secret');
    expect(text).not.toContain('09120000000');
    expect(text).not.toContain('callbackUrl');
  });
});

describe('zibal testConnection', () => {
  it('reports invalid merchant for numeric 102 and 103', async () => {
    for (const result of [102, 103]) {
      mockJson({ result });
      const out = await zibalProvider.testConnection(config);
      expect(out.success).toBe(false);
      expect(out.error).toBe('Invalid merchant');
      expect(typeof out.latencyMs).toBe('number');
    }
  });

  it('does not coerce string "102"/"103"', async () => {
    for (const result of ['102', '103']) {
      mockJson({ result });
      const out = await zibalProvider.testConnection(config);
      expect(out.success).toBe(true);
    }
  });

  it('succeeds on result 100', async () => {
    mockJson({ result: 100, trackId: 'x' });
    expect((await zibalProvider.testConnection(config)).success).toBe(true);
  });

  it('succeeds on malformed bodies', async () => {
    for (const body of [null, undefined, 'oops', 7, [], {}]) {
      mockJson(body);
      expect((await zibalProvider.testConnection(config)).success).toBe(true);
    }
  });

  it('reports network failure without leaking merchant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const out = await zibalProvider.testConnection(config);
    expect(out.success).toBe(false);
    expect(out.error).toBe('socket hang up');
    expect(out.error).not.toContain('zibal-merchant-secret');
  });
});
