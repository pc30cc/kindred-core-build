import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { paypalProvider, readPayPalAccessToken, readPayPalOAuthError } from '../../../server/services/billing/providers/paypal.js';

const config = { provider: 'paypal', client_id: 'client-id-mock', client_secret: 'client-secret-mock', sandbox: true };

function mockJson(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 401, json: async () => body });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('readPayPalAccessToken', () => {
  it('reads a valid token', () => expect(readPayPalAccessToken({ access_token: 'tok' })).toBe('tok'));
  it.each([null, undefined, 'str', 42, [], {}, { access_token: '' }, { access_token: 7 }, { access_token: {} }])(
    'rejects malformed body %#', (body) => expect(readPayPalAccessToken(body)).toBeNull()
  );
});

describe('readPayPalOAuthError', () => {
  it('reads error_description', () => expect(readPayPalOAuthError({ error_description: 'bad creds' })).toBe('bad creds'));
  it.each([null, [], {}, { error_description: 5 }, { error_description: '' }, { error: 'invalid_client' }])(
    'falls back for %#', (body) => expect(readPayPalOAuthError(body)).toBeNull()
  );
});

describe('paypal testConnection (OAuth token flow)', () => {
  it('succeeds with valid token and uses correct request contract', async () => {
    const fetchMock = mockJson({ access_token: 'tok', token_type: 'Bearer', expires_in: 32400 });
    const res = await paypalProvider.testConnection(config);
    expect(res.success).toBe(true);
    expect(typeof res.latencyMs).toBe('number');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['Authorization']).toBe(`Basic ${Buffer.from('client-id-mock:client-secret-mock').toString('base64')}`);
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('uses production endpoint when sandbox is false', async () => {
    const fetchMock = mockJson({ access_token: 'tok' });
    await paypalProvider.testConnection({ ...config, sandbox: false });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api-m.paypal.com/v1/oauth2/token');
  });

  it('fails with OAuth error_description', async () => {
    mockJson({ error: 'invalid_client', error_description: 'Client Authentication failed' }, false);
    const res = await paypalProvider.testConnection(config);
    expect(res.success).toBe(false);
    expect(res.error).toBe('Client Authentication failed');
  });

  it('falls back to generic message when error_description is wrong type', async () => {
    mockJson({ error_description: 123 }, false);
    const res = await paypalProvider.testConnection(config);
    expect(res).toMatchObject({ success: false, error: 'PayPal auth failed' });
  });

  it.each([[null], [{}], [[]], ['oops'], [{ access_token: '' }], [{ access_token: 9 }], [{ access_token: {} }]])(
    'fails on malformed successful body %#', async (body) => {
      mockJson(body);
      const res = await paypalProvider.testConnection(config);
      expect(res).toMatchObject({ success: false, error: 'PayPal auth failed' });
    }
  );

  it('handles network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await paypalProvider.testConnection(config);
    expect(res).toMatchObject({ success: false, error: 'network down' });
  });

  it('never leaks credentials in the error output', async () => {
    mockJson({ error_description: 'Client Authentication failed' }, false);
    const res = await paypalProvider.testConnection(config);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('client-secret-mock');
    expect(serialized).not.toContain('client-id-mock');
    expect(serialized).not.toContain('Basic ');
    expect(serialized).not.toContain('grant_type=client_credentials');
  });
});
