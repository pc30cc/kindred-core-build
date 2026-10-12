import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zarinpalProvider, zarinpalSettingsProblem, ZARINPAL_TIMEOUT_MS } from '../../../server/services/billing/providers/zarinpal';
import { zarinpalTestProvider } from '../../../server/services/billing/providers/zarinpal-test';
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
  // readZarinpalJson() reads the body as text (to tolerate a non-JSON HTML
  // error page from the gateway/WAF) before JSON.parse-ing it, so the fetch
  // stub must expose `.text()`, not `.json()`.
  const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify(body) });
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

  // Blocker: the Providers form saves a touched toggle as the STRING 'false',
  // which a truthiness check read as on and sent live customers to the sandbox.
  it.each([[true], ['true'], ['false'], ['0'], [1]])('live zarinpal ignores a stored sandbox switch (%s): always the live hosts', async (sandbox) => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-live' } });
    const out = await zarinpalProvider.createCheckoutSession({ ...config, sandbox }, req);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.zarinpal.com/pg/v4/payment/request.json');
    expect(out.paymentUrl).toBe('https://www.zarinpal.com/pg/StartPay/A-live');
  });

  it('only zarinpal_test reaches the sandbox', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'S-mock' } });
    const out = await zarinpalTestProvider.createCheckoutSession({ provider: 'zarinpal_test', sandbox: 'false' }, req);
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.zarinpal.com/pg/v4/payment/request.json');
    expect(out.paymentUrl).toBe('https://sandbox.zarinpal.com/pg/StartPay/S-mock');
  });

  it('sends every call with a timeout signal and reports a timeout as unreachable', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-t' } });
    await zarinpalProvider.createCheckoutSession(config, req);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(ZARINPAL_TIMEOUT_MS).toBe(20_000);

    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })));
      const pending = zarinpalProvider.verifyPayment!(config, { Authority: 'A-t', amount: '1000' });
      const assertion = expect(pending).rejects.toThrow(/no answer within 20 s/);
      await vi.advanceTimersByTimeAsync(ZARINPAL_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  it('converts the whole-Rial metadata amount down to Toman when config.currency is IRT', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-mock' } });
    await zarinpalProvider.createCheckoutSession({ ...config, currency: 'IRT' }, req);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.currency).toBe('IRT');
    expect(payload.amount).toBe(25000); // 250,000 Rial === 25,000 Toman
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
  const live: BillingProviderConfig = {
    provider: 'zarinpal',
    merchant_id: '11111111-2222-3333-4444-555555555555',
    probe_callback_url: 'https://app.example.com/billing',
  };

  function mockStatus(status: number, body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ status, text: async () => JSON.stringify(body) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('succeeds only for data.code 100', async () => {
    mockJson({ data: { code: 100, authority: 'A-probe' } });
    const out = await zarinpalProvider.testConnection(live);
    expect(out).toMatchObject({ success: true });
  });

  // ZarinPal v4 terminal errors (-10 invalid merchant/IP, -11 inactive, -12
  // too many attempts) used to fall through to success.
  it.each([
    [-9, /ZarinPal -9 \(validation error\): bad callback/],
    [-10, /ZarinPal -10 \(terminal is not valid.*IP.*callback domain/],
    [-11, /ZarinPal -11 \(terminal is not active/],
    [-12, /ZarinPal -12 \(too many attempts/],
    [-15, /ZarinPal -15/],
    [-99, /ZarinPal -99: bad callback/],
  ])('reports errors.code %s as a failure with its meaning', async (code, error) => {
    mockStatus(422, { data: [], errors: { code, message: 'bad callback' } });
    const out = await zarinpalProvider.testConnection(live);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(error);
    expect(out.error).not.toContain(live.merchant_id as string);
  });

  it('refuses a missing or malformed merchant id before calling ZarinPal', async () => {
    const fetchMock = mockJson({ data: { code: 100 } });
    expect(await zarinpalProvider.testConnection({ provider: 'zarinpal' })).toMatchObject({ success: false, error: expect.stringMatching(/Merchant ID is empty/) });
    expect(await zarinpalProvider.testConnection(config)).toMatchObject({ success: false, error: expect.stringMatching(/36-character UUID/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not coerce string codes', async () => {
    mockJson({ data: { code: '100' } });
    expect((await zarinpalProvider.testConnection(live)).success).toBe(false);
  });

  it('sends a real request with the platform callback, the configured unit and the live host', async () => {
    const fetchMock = mockJson({ data: { code: 100, authority: 'A-probe' } });
    await zarinpalProvider.testConnection({ ...live, sandbox: 'true' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.zarinpal.com/pg/v4/payment/request.json');
    expect(JSON.parse(init.body)).toEqual({
      merchant_id: '11111111-2222-3333-4444-555555555555',
      amount: 20000,
      callback_url: 'https://app.example.com/billing',
      description: 'Connection test',
      currency: 'IRR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const irt = mockJson({ data: { code: 100, authority: 'A-probe' } });
    await zarinpalProvider.testConnection({ ...live, currency: 'IRT', probe_callback_url: undefined });
    expect(JSON.parse(irt.mock.calls[0][1].body)).toMatchObject({ amount: 2000, currency: 'IRT', callback_url: 'https://test.localhost/callback' });
  });

  it('treats malformed bodies as failures', async () => {
    for (const body of ['oops', 7, [], {}, { data: 'nope' }, { errors: 'nope' }]) {
      mockJson(body);
      expect((await zarinpalProvider.testConnection(live)).success).toBe(false);
    }
  });

  it('reports nullish bodies and network failures as failures without leaking secrets', async () => {
    mockJson(null);
    const nullish = await zarinpalProvider.testConnection(live);
    expect(nullish.success).toBe(false);
    expect(nullish.error).not.toContain(live.merchant_id as string);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const out = await zarinpalProvider.testConnection(live);
    expect(out).toMatchObject({ success: false, error: 'socket hang up' });
  });
});

describe('zarinpal settings (save check and readiness)', () => {
  it('names what is missing or malformed', () => {
    expect(zarinpalSettingsProblem({ provider: 'zarinpal' })).toMatch(/Merchant ID is empty/);
    expect(zarinpalSettingsProblem({ provider: 'zarinpal', merchant_id: 'abc' })).toMatch(/36-character UUID/);
    expect(zarinpalSettingsProblem({ provider: 'zarinpal', merchant_id: '11111111-2222-3333-4444-555555555555', currency: 'USD' })).toMatch(/IRR .*IRT/);
    expect(zarinpalSettingsProblem({ provider: 'zarinpal', merchant_id: ' 11111111-2222-3333-4444-555555555555 ', currency: 'irt' })).toBeNull();
  });

  it('validateConfig refuses a malformed merchant id on save but leaves an empty one to the readiness card', () => {
    expect(zarinpalProvider.validateConfig!({ provider: 'zarinpal', merchant_id: 'not-a-uuid' })).toMatch(/UUID/);
    expect(zarinpalProvider.validateConfig!({ provider: 'zarinpal' })).toBeNull();
    expect(zarinpalProvider.validateConfig!({ provider: 'zarinpal', merchant_id: '11111111-2222-3333-4444-555555555555' })).toBeNull();
  });
});

describe('zarinpal verifyPayment', () => {
  const verifyParams = { Authority: 'A0000000000000000000000000000mock', amount: '250000' };

  it('posts the verify payload and maps code 100 to success', async () => {
    const fetchMock = mockJson({ data: { code: 100, ref_id: 987654321 } });
    const out = await zarinpalProvider.verifyPayment!(config, verifyParams);
    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.zarinpal.com/pg/v4/payment/verify.json');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      merchant_id: 'mock-merchant-id-0001',
      authority: 'A0000000000000000000000000000mock',
      amount: 250000,
    });
    expect(out).toEqual({
      verified: true,
      providerRef: '987654321',
      amount: 250000,
      status: 'success',
    });
  });

  it('maps code 101 to already_verified and accepts a string ref_id unchanged', async () => {
    mockJson({ data: { code: 101, ref_id: ' RF-001 ' } });
    expect(await zarinpalProvider.verifyPayment!(config, verifyParams)).toEqual({
      verified: true,
      providerRef: ' RF-001 ',
      amount: 250000,
      status: 'already_verified',
    });
  });

  it('uses the lowercase authority param, and the live endpoint even with a stored sandbox switch', async () => {
    const fetchMock = mockJson({ data: { code: 100, ref_id: 1 } });
    await zarinpalProvider.verifyPayment!(
      { ...config, sandbox: 'false' },
      { authority: 'A0000000000000000000000000000mock', amount: '250000' },
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.zarinpal.com/pg/v4/payment/verify.json');
    expect(JSON.parse(init.body).authority).toBe('A0000000000000000000000000000mock');
  });

  it('converts the wire amount for IRT but always returns amount normalized back to IRR', async () => {
    for (const [currency, expectedWireAmount] of [['IRR', 250000], [undefined, 250000], ['IRT', 25000]] as const) {
      const fetchMock = mockJson({ data: { code: 100, ref_id: 5 } });
      const out = await zarinpalProvider.verifyPayment!({ ...config, currency }, verifyParams);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).amount).toBe(expectedWireAmount);
      expect(out.amount).toBe(250000); // always IRR in the result, regardless of wire currency
    }
    const fetchMock = mockJson({ data: { code: 100, ref_id: 5 } });
    const out = await zarinpalProvider.verifyPayment!(config, { Authority: 'A-mock' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).amount).toBe(0);
    expect(out.amount).toBe(0);
  });

  it('keeps provider failures as failures', async () => {
    for (const code of [-51, 0, '100', '101', { v: 100 }, true, null]) {
      mockJson({ data: { code, ref_id: 987654321 } });
      const out = await zarinpalProvider.verifyPayment!(config, verifyParams);
      expect(out.verified).toBe(false);
      expect(out.status).toBe('failed');
    }
  });

  it('handles malformed bodies without inventing a provider reference', async () => {
    for (const body of [{}, 'oops', 7, [], { data: 'nope' }, { data: [] }, { errors: { code: -11 } }]) {
      mockJson(body);
      expect(await zarinpalProvider.verifyPayment!(config, verifyParams)).toEqual({
        verified: false,
        providerRef: '',
        amount: 250000,
        status: 'failed',
      });
    }
  });

  it('returns an empty provider reference for a successful code without a usable ref_id', async () => {
    for (const ref_id of [undefined, null, '', 0, false, { a: 1 }, [1], true]) {
      mockJson({ data: { code: 100, ref_id } });
      expect(await zarinpalProvider.verifyPayment!(config, verifyParams)).toEqual({
        verified: true,
        providerRef: '',
        amount: 250000,
        status: 'success',
      });
    }
  });

  it('keeps nullish TypeError and network rejection behaviour', async () => {
    mockJson(null);
    await expect(zarinpalProvider.verifyPayment!(config, verifyParams)).rejects.toBeInstanceOf(TypeError);

    const failing = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', failing);
    await expect(zarinpalProvider.verifyPayment!(config, verifyParams)).rejects.toThrow('socket hang up');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('does not leak merchant or customer data in the verify result', async () => {
    mockJson({ data: { code: 100, ref_id: 987654321 } });
    const serialized = JSON.stringify(await zarinpalProvider.verifyPayment!(config, verifyParams));
    expect(serialized).not.toContain('mock-merchant-id-0001');
    expect(serialized).not.toContain('A0000000000000000000000000000mock');
    expect(serialized).not.toContain('mock-buyer@example.com');
    expect(serialized).not.toContain('09120000000');
  });
});
