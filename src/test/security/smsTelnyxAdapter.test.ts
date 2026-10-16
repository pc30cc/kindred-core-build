/**
 * Telnyx adapter (Telnyx Verify) — request shape, error mapping, timeouts and
 * secrecy. `fetch` is faked: no request ever leaves the process, and the key
 * below is a placeholder.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createTelnyxAdapter,
  mapTelnyxFailure,
  telnyxTimeoutSecs,
  isValidTelnyxProfileId,
  TELNYX_API_BASE,
  type TelnyxFetch,
} from '../../../server/services/sms/providers/telnyx.js';
import { SmsError } from '../../../server/services/sms/types.js';

const KEY = 'KEY_placeholder_never_real_0123456789';
const PROFILE = '490001a1-442d-809f-5753-c2332bd10640';

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(status: number, body: unknown, calls: Captured[] = []): TelnyxFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(status, body);
  };
}

function adapter(fetchImpl: TelnyxFetch, channel: 'sms' | 'call' = 'sms', timeoutMs = 500) {
  return createTelnyxAdapter(
    { provider: 'telnyx', apiKey: KEY, verifyProfileId: PROFILE, channel },
    { fetchImpl, timeoutMs },
  );
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SmsError);
    return (err as SmsError).code;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Telnyx adapter — request shape', () => {
  it('POSTs /verifications/sms with bearer auth, E.164, custom_code and timeout_secs', async () => {
    const calls: Captured[] = [];
    const a = adapter(fakeFetch(200, { data: { id: 'ver-123', status: 'pending', type: 'sms' } }, calls));
    const result = await a.sendVerificationCode({ phoneNumber: '+447700900123', code: '482913', timeoutSecs: 300 });
    expect(result).toEqual({ messageId: 'ver-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TELNYX_API_BASE}/verifications/sms`);
    expect(TELNYX_API_BASE).toBe('https://api.telnyx.com/v2');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      phone_number: '+447700900123',
      verify_profile_id: PROFILE,
      custom_code: '482913',
      timeout_secs: 300,
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the call channel uses /verifications/call with the same body', async () => {
    const calls: Captured[] = [];
    const a = adapter(fakeFetch(200, { data: { id: 'ver-9' } }, calls), 'call');
    await a.sendVerificationCode({ phoneNumber: '+989121234567', code: '123456', timeoutSecs: 600 });
    expect(calls[0].url).toBe(`${TELNYX_API_BASE}/verifications/call`);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ custom_code: '123456', timeout_secs: 600, phone_number: '+989121234567' });
  });

  it('refuses a non-E.164 number before any request (sms_invalid_receptor)', async () => {
    const fetchImpl = vi.fn(fakeFetch(200, { data: { id: 'x' } }));
    const a = adapter(fetchImpl);
    for (const bad of ['09121234567', '447700900123', '+0447700900123', '+44 7700 900123', '', '+12']) {
      expect(await codeOf(a.sendVerificationCode({ phoneNumber: bad, code: '123456' }))).toBe('sms_invalid_receptor');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-numeric code (sms_template_invalid)', async () => {
    const fetchImpl = vi.fn(fakeFetch(200, { data: { id: 'x' } }));
    expect(await codeOf(adapter(fetchImpl).sendVerificationCode({ phoneNumber: '+447700900123', code: 'abc' }))).toBe('sms_template_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('timeout_secs is our TTL, kept to a sane whole number (default 300)', () => {
    expect(telnyxTimeoutSecs(300)).toBe(300);
    expect(telnyxTimeoutSecs(600.4)).toBe(600);
    expect(telnyxTimeoutSecs(undefined)).toBe(300);
    expect(telnyxTimeoutSecs(Number.NaN)).toBe(300);
    expect(telnyxTimeoutSecs(1)).toBe(30);
    expect(telnyxTimeoutSecs(10_000_000)).toBe(86_400);
  });

  it('a malformed success body is a provider error', async () => {
    expect(await codeOf(adapter(fakeFetch(200, { nope: true })).sendVerificationCode({ phoneNumber: '+447700900123', code: '123456' })))
      .toBe('sms_provider_error');
  });

  it('refuses to build without a key or with a profile id that is not a UUID', () => {
    expect(() => createTelnyxAdapter({ provider: 'telnyx', apiKey: '', verifyProfileId: PROFILE, channel: 'sms' })).toThrow(SmsError);
    expect(() => createTelnyxAdapter({ provider: 'telnyx', apiKey: KEY, verifyProfileId: 'RESPOK', channel: 'sms' })).toThrow(SmsError);
    expect(isValidTelnyxProfileId(PROFILE)).toBe(true);
    expect(isValidTelnyxProfileId(PROFILE.toUpperCase())).toBe(true);
    expect(isValidTelnyxProfileId('490001a1-442d-809f-5753')).toBe(false);
  });
});

describe('Telnyx adapter — connection test (GET the Verify Profile, never sends)', () => {
  it('GETs /verify_profiles/{id} and reports the profile name', async () => {
    const calls: Captured[] = [];
    const a = adapter(fakeFetch(200, { data: { id: PROFILE, name: 'RESPOK', record_type: 'verification_profile' } }, calls));
    await expect(a.getAccountInfo()).resolves.toEqual({ balance: null, currency: 'USD', accountType: null, profileName: 'RESPOK' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TELNYX_API_BASE}/verify_profiles/${PROFILE}`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(calls.some((c) => c.url.includes('/verifications'))).toBe(false);
  });

  it('a wrong key is sms_auth_failed; a missing profile is sms_template_not_found', async () => {
    const unauthorized = { errors: [{ code: '10009', title: 'Authentication failed', detail: 'Could not understand the provided credentials.' }] };
    expect(await codeOf(adapter(fakeFetch(401, unauthorized)).getAccountInfo())).toBe('sms_auth_failed');
    const missing = { errors: [{ code: '10005', title: 'Resource not found', detail: 'Verify profile not found' }] };
    expect(await codeOf(adapter(fakeFetch(404, missing)).getAccountInfo())).toBe('sms_template_not_found');
  });

  it('an answer for a different profile is treated as not found', async () => {
    const other = { data: { id: '11111111-2222-3333-4444-555555555555', name: 'Other' } };
    expect(await codeOf(adapter(fakeFetch(200, other)).getAccountInfo())).toBe('sms_template_not_found');
  });
});

describe('Telnyx error mapping → the closed SmsErrorCode union', () => {
  const err = (detail: string, pointer = '', title = 'Error') => ({ errors: [{ code: '10015', title, detail, source: { pointer } }] });
  const table: Array<[number, unknown, string]> = [
    [401, err('Authentication failed'), 'sms_auth_failed'],
    [403, err('Forbidden'), 'sms_auth_failed'],
    [402, err('Payment required'), 'sms_insufficient_credit'],
    [400, err('Insufficient balance to complete the request'), 'sms_insufficient_credit'],
    [422, err('The phone number is invalid', '/phone_number'), 'sms_invalid_receptor'],
    [422, err('Destination is not whitelisted on this verify profile'), 'sms_invalid_receptor'],
    [422, err('Invalid value', '/verify_profile_id'), 'sms_template_not_found'],
    [422, err('Must be numeric', '/custom_code'), 'sms_template_invalid'],
    [404, err('Not found'), 'sms_template_not_found'],
    [408, null, 'sms_timeout'],
    [504, null, 'sms_timeout'],
    [500, null, 'sms_network_error'],
    [503, err('Service unavailable'), 'sms_network_error'],
    [429, err('Too many requests'), 'sms_provider_error'],
    [422, err('Something else entirely'), 'sms_provider_error'],
    [418, 'not json', 'sms_provider_error'],
  ];
  it.each(table)('HTTP %i → %s', (status, body, expected) => {
    expect(mapTelnyxFailure(status, body)).toBe(expected);
  });

  it('a non-JSON error body still maps by status', async () => {
    const fetchImpl: TelnyxFetch = async () => new Response('<html>bad gateway</html>', { status: 502 });
    expect(await codeOf(adapter(fetchImpl).sendVerificationCode({ phoneNumber: '+447700900123', code: '123456' }))).toBe('sms_network_error');
  });
});

describe('Telnyx adapter — network and timeout', () => {
  it('a network failure is sms_network_error', async () => {
    const fetchImpl: TelnyxFetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await codeOf(adapter(fetchImpl).sendVerificationCode({ phoneNumber: '+447700900123', code: '123456' }))).toBe('sms_network_error');
  });

  it('a request that outlives the timeout is aborted: sms_timeout', async () => {
    let aborted = false;
    const fetchImpl: TelnyxFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    expect(await codeOf(adapter(fetchImpl, 'sms', 30).sendVerificationCode({ phoneNumber: '+447700900123', code: '123456' }))).toBe('sms_timeout');
    expect(aborted).toBe(true);
  });
});

describe('Telnyx adapter — secrecy', () => {
  it('never puts the key, the code or Telnyx payloads in an error or a log line', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
      });
    }
    const leaky = { errors: [{ code: '10015', title: 'Bad', detail: `key ${KEY} phone +447700900123 code 482913` }] };
    for (const status of [400, 401, 402, 422, 500]) {
      try {
        await adapter(fakeFetch(status, leaky)).sendVerificationCode({ phoneNumber: '+447700900123', code: '482913' });
        throw new Error('expected a rejection');
      } catch (e) {
        const dump = `${String(e)} ${JSON.stringify(e)} ${(e as Error).message} ${(e as Error).stack ?? ''}`;
        expect(dump).not.toContain(KEY);
        expect(dump).not.toContain('482913');
        expect(dump).not.toContain('+447700900123');
      }
    }
    expect(logs.join('\n')).not.toContain(KEY);
  });
});
