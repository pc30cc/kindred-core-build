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

  it('never sends an empty multiplexingInfos (Zibal refuses it: no "self" beneficiary), whatever lazy_mode says', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'trk' });
    await zibalProvider.createCheckoutSession({ ...config, lazy_mode: true }, req);
    expect('multiplexingInfos' in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false);
  });

  it('uses the payment id as the order id when there is one', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'trk' });
    await zibalProvider.createCheckoutSession(config, { ...req, intentId: 'pay-1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).orderId).toBe('pay-1');
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
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: no result');
  });

  it('uses a valid string message', async () => {
    mockJson({ result: 102, message: 'merchant invalid' });
    await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: 102: merchant not found: merchant invalid');
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
      await expect(zibalProvider.createCheckoutSession(config, req)).rejects.toThrow('Zibal error: no result');
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
  it('reports Zibal\'s code and meaning for an invalid or inactive merchant', async () => {
    mockJson({ result: 102 });
    expect(await zibalProvider.testConnection(config)).toEqual({ success: false, latencyMs: expect.any(Number), error: 'Zibal 102: merchant not found' });
    mockJson({ result: 103 });
    expect((await zibalProvider.testConnection(config)).error).toBe('Zibal 103: merchant is inactive');
  });

  it('is not a success for anything but a numeric 100 (it used to pass any other answer)', async () => {
    for (const body of [{ result: '102' }, { result: 115 }, { result: '100' }]) {
      mockJson(body);
      expect((await zibalProvider.testConnection(config)).success).toBe(false);
    }
  });

  it('sends the platform\'s callback (a domain Zibal does not allow fails here)', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'x' });
    await zibalProvider.testConnection({ ...config, probe_callback_url: 'https://app.webyar.ai/billing' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).callbackUrl).toBe('https://app.webyar.ai/billing');
  });

  it('refuses the sandbox merchant without calling Zibal', async () => {
    const fetchMock = mockJson({ result: 100, trackId: 'x' });
    const out = await zibalProvider.testConnection({ provider: 'zibal', merchant: 'zibal' });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/sandbox/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('succeeds on result 100', async () => {
    mockJson({ result: 100, trackId: 'x' });
    expect((await zibalProvider.testConnection(config)).success).toBe(true);
  });

  it('fails on malformed bodies', async () => {
    for (const body of [null, undefined, 'oops', 7, [], {}]) {
      mockJson(body);
      expect((await zibalProvider.testConnection(config)).success).toBe(false);
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

// ── Verify ────────────────────────────────────────────────────────────
const verifyParams = { trackId: 'trk-verify-1' };

describe('zibal verifyPayment', () => {
  it('sends the exact payload to the verify endpoint', async () => {
    const fetchMock = mockJson({ result: 100, refNumber: 'ref-1', amount: 150000 });
    await zibalProvider.verifyPayment!(config, verifyParams);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.zibal.ir/v1/verify');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ merchant: 'zibal-merchant-secret', trackId: 'trk-verify-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a successful verification', async () => {
    mockJson({ result: 100, refNumber: 'ref-1', amount: 150000 });
    expect(await zibalProvider.verifyPayment!(config, verifyParams)).toEqual({
      verified: true, providerRef: 'ref-1', amount: 150000, status: 'success',
    });
  });

  it('202 (not paid / failed) and 203 end the payment; a merchant problem or an unknown answer does not', async () => {
    for (const result of [202, 203]) {
      mockJson({ result, refNumber: 'ref-1' });
      expect(await zibalProvider.verifyPayment!(config, verifyParams)).toMatchObject({ verified: false, status: 'failed' });
    }
    for (const result of [102, 103, 0, -1, '201']) {
      mockJson({ result, refNumber: 'ref-1' });
      expect(await zibalProvider.verifyPayment!(config, verifyParams)).toMatchObject({ verified: false, status: 'pending' });
    }
  });

  it('201 without an amount asks /v1/inquiry, and reports the paid amount it confirms', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ result: 201, message: 'already verified' }) })
      .mockResolvedValueOnce({ json: async () => ({ result: 100, status: 1, amount: 150000, refNumber: 'ref-9' }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await zibalProvider.verifyPayment!(config, { trackId: '12345' });
    expect(out).toEqual({ verified: true, providerRef: 'ref-9', amount: 150000, status: 'already_verified' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://gateway.zibal.ir/v1/inquiry');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ merchant: 'zibal-merchant-secret', trackId: 12345 });
  });

  it('201 whose inquiry does not show a verified payment reports no amount (never settles a guess)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ result: 201 }) })
      .mockResolvedValueOnce({ json: async () => ({ result: 100, status: 2, amount: 150000 }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await zibalProvider.verifyPayment!(config, verifyParams);
    expect(out.status).toBe('already_verified');
    expect(out.amount).toBeUndefined();
  });

  it('sends a numeric trackId as a number, as Zibal documents it', async () => {
    const fetchMock = mockJson({ result: 100, refNumber: 'r', amount: 1 });
    await zibalProvider.verifyPayment!(config, { trackId: '3714061657' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).trackId).toBe(3714061657);
  });

  it('reports 201 (already verified) as already_verified, never as a fresh success', async () => {
    mockJson({ result: 201, refNumber: 'ref-1' });
    const out = await zibalProvider.verifyPayment!(config, verifyParams);
    expect(out.verified).toBe(true);
    expect(out.status).toBe('already_verified');
  });

  it('does not coerce string result codes', async () => {
    for (const result of ['100', '102', '103']) {
      mockJson({ result });
      const out = await zibalProvider.verifyPayment!(config, verifyParams);
      expect(out.verified).toBe(false);
      expect(out.status).toBe('pending');
    }
  });

  it('rejects object/boolean/missing result', async () => {
    for (const body of [{ result: {} }, { result: true }, {}]) {
      mockJson(body);
      expect((await zibalProvider.verifyPayment!(config, verifyParams)).verified).toBe(false);
    }
  });

  it('resolves providerRef from string, number, or falls back to trackId', async () => {
    mockJson({ result: 100, refNumber: 'ref-x' });
    expect((await zibalProvider.verifyPayment!(config, verifyParams)).providerRef).toBe('ref-x');
    mockJson({ result: 100, refNumber: 987654 });
    expect((await zibalProvider.verifyPayment!(config, verifyParams)).providerRef).toBe('987654');
    for (const refNumber of [undefined, '', 0, {}, true, []]) {
      mockJson({ result: 100, refNumber });
      expect((await zibalProvider.verifyPayment!(config, verifyParams)).providerRef).toBe('trk-verify-1');
    }
  });

  it('never emits the literal "undefined" as providerRef', async () => {
    const fetchMock = mockJson({ result: 100 });
    const out = await zibalProvider.verifyPayment!(config, {});
    expect(out).toEqual({ verified: false, providerRef: '', status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes finite amounts through and drops invalid ones', async () => {
    for (const amount of [150000, 0, -50]) {
      mockJson({ result: 100, refNumber: 'r', amount });
      expect((await zibalProvider.verifyPayment!(config, verifyParams)).amount).toBe(amount);
    }
    for (const amount of [undefined, '150000', NaN, Infinity, null, {}]) {
      mockJson({ result: 100, refNumber: 'r', amount });
      expect((await zibalProvider.verifyPayment!(config, verifyParams)).amount).toBeUndefined();
    }
  });

  it('handles malformed non-null bodies', async () => {
    for (const body of ['oops', 42, [], {}]) {
      mockJson(body);
      const out = await zibalProvider.verifyPayment!(config, verifyParams);
      expect(out).toEqual({ verified: false, providerRef: 'trk-verify-1', status: 'pending' });
    }
  });

  it('settles nothing and ends nothing on a nullish body', async () => {
    for (const body of [null, undefined]) {
      mockJson(body);
      expect(await zibalProvider.verifyPayment!(config, verifyParams)).toMatchObject({ verified: false, status: 'pending' });
    }
  });

  it('gives up after the timeout with a message naming Zibal', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })));
      const pending = zibalProvider.verifyPayment!(config, verifyParams);
      const assertion = expect(pending).rejects.toThrow('Zibal gateway unreachable: no answer within 20 s');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores HTTP status and does not retry on network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(zibalProvider.verifyPayment!(config, verifyParams)).rejects.toThrow('socket hang up');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not leak merchant, trackId or body in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500, text: async () => '<html>oops</html>' }));
    const err = await zibalProvider.verifyPayment!(config, verifyParams).catch((e: Error) => e);
    const text = String((err as Error).message);
    expect(text).not.toContain('zibal-merchant-secret');
    expect(text).not.toContain('trk-verify-1');
  });
});
