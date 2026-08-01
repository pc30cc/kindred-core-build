/**
 * Kavenegar adapter — all SDK calls are mocked. No network request is ever
 * made to Kavenegar, and no real credential is used anywhere in this file.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createKavenegarAdapter,
  kavenegarCall,
  mapKavenegarStatus,
  type KavenegarApiClient,
  type KavenegarCallback,
} from '../../../server/services/sms/providers/kavenegar.js';
import { SmsError, type KavenegarSmsConfig } from '../../../server/services/sms/types.js';

const CONFIG: KavenegarSmsConfig = {
  provider: 'kavenegar',
  apiKey: 'test-placeholder-key',
  verifyTemplate: 'verifyLogin',
};

function client(overrides: Partial<KavenegarApiClient>): KavenegarApiClient {
  const notImplemented = () => { throw new Error('not implemented'); };
  return {
    Send: overrides.Send ?? notImplemented,
    VerifyLookup: overrides.VerifyLookup ?? notImplemented,
    AccountInfo: overrides.AccountInfo ?? notImplemented,
  };
}

function adapter(c: KavenegarApiClient, timeoutMs = 200) {
  return createKavenegarAdapter(CONFIG, { createClient: () => c, timeoutMs });
}

describe('kavenegarCall wrapper', () => {
  it('resolves entries on status 200', async () => {
    await expect(kavenegarCall((cb) => cb([{ messageid: 1 }], 200, 'ok'), 200)).resolves.toEqual([
      { messageid: 1 },
    ]);
  });

  it('maps a non-200 status to a normalized error', async () => {
    await expect(kavenegarCall((cb) => cb([], 418, 'no credit'), 200)).rejects.toMatchObject({
      code: 'sms_insufficient_credit',
    });
  });

  it('fails closed on a malformed callback (no numeric status)', async () => {
    await expect(kavenegarCall((cb) => cb('{"error":"socket"}'), 200)).rejects.toMatchObject({
      code: 'sms_network_error',
    });
  });

  it('captures a synchronous throw from the SDK', async () => {
    await expect(
      kavenegarCall(() => { throw new Error('boom'); }, 200),
    ).rejects.toMatchObject({ code: 'sms_network_error' });
  });

  it('times out', async () => {
    await expect(kavenegarCall(() => { /* never calls back */ }, 20)).rejects.toMatchObject({
      code: 'sms_timeout',
    });
  });

  it('settles only once when the callback fires twice', async () => {
    const result = await kavenegarCall((cb) => {
      cb([{ messageid: 7 }], 200, 'ok');
      cb([], 500, 'late');
    }, 200);
    expect(result).toEqual([{ messageid: 7 }]);
  });

  it('maps documented Kavenegar statuses', () => {
    expect(mapKavenegarStatus(401)).toBe('sms_auth_failed');
    expect(mapKavenegarStatus(403)).toBe('sms_auth_failed');
    expect(mapKavenegarStatus(411)).toBe('sms_invalid_receptor');
    expect(mapKavenegarStatus(418)).toBe('sms_insufficient_credit');
    expect(mapKavenegarStatus(424)).toBe('sms_template_not_found');
    expect(mapKavenegarStatus(426)).toBe('sms_provider_feature_unavailable');
    expect(mapKavenegarStatus(431)).toBe('sms_template_invalid');
    expect(mapKavenegarStatus(432)).toBe('sms_template_invalid');
    expect(mapKavenegarStatus(999)).toBe('sms_provider_error');
  });
});

describe('VerifyLookup', () => {
  it('passes receptor, token, template and type=sms, and omits sender', async () => {
    const VerifyLookup = vi.fn((_p: Record<string, string>, cb: KavenegarCallback) =>
      cb([{ messageid: 42 }], 200, 'ok'),
    );
    const withSender: KavenegarSmsConfig = { ...CONFIG, sender: '10008663' };
    const a = createKavenegarAdapter(withSender, {
      createClient: () => client({ VerifyLookup }),
      timeoutMs: 200,
    });
    const res = await a.sendVerificationCode({ receptor: '09120000000', token: '123456', template: 'verifyLogin' });
    expect(VerifyLookup).toHaveBeenCalledTimes(1);
    expect(VerifyLookup.mock.calls[0][0]).toEqual({
      receptor: '09120000000',
      token: '123456',
      template: 'verifyLogin',
      type: 'sms',
    });
    expect(VerifyLookup.mock.calls[0][0]).not.toHaveProperty('sender');
    expect(res.messageId).toBe('42');
  });

  it('rejects on a non-200 status', async () => {
    const a = adapter(client({ VerifyLookup: (_p, cb) => cb([], 424, 'no template') }));
    await expect(
      a.sendVerificationCode({ receptor: '09120000000', token: '1', template: 'verifyLogin' }),
    ).rejects.toMatchObject({ code: 'sms_template_not_found' });
  });

  it('fails closed on a malformed callback', async () => {
    const a = adapter(client({ VerifyLookup: (_p, cb) => cb(undefined) }));
    await expect(
      a.sendVerificationCode({ receptor: '09120000000', token: '1', template: 'verifyLogin' }),
    ).rejects.toMatchObject({ code: 'sms_network_error' });
  });

  it('handles a synchronous SDK exception', async () => {
    const a = adapter(client({ VerifyLookup: () => { throw new Error('sdk down'); } }));
    await expect(
      a.sendVerificationCode({ receptor: '09120000000', token: '1', template: 'verifyLogin' }),
    ).rejects.toMatchObject({ code: 'sms_network_error' });
  });

  it('handles a timeout', async () => {
    const a = adapter(client({ VerifyLookup: () => { /* silence */ } }), 20);
    await expect(
      a.sendVerificationCode({ receptor: '09120000000', token: '1', template: 'verifyLogin' }),
    ).rejects.toMatchObject({ code: 'sms_timeout' });
  });

  it('produces a single result when the SDK calls back twice', async () => {
    let calls = 0;
    const a = adapter(client({
      VerifyLookup: (_p, cb) => { cb([{ messageid: 5 }], 200, 'ok'); cb([], 500, 'late'); calls++; },
    }));
    const res = await a.sendVerificationCode({ receptor: '0912', token: '1', template: 'verifyLogin' });
    expect(res.messageId).toBe('5');
    expect(calls).toBe(1);
  });
});

describe('Send', () => {
  it('passes receptor and message and the configured default sender', async () => {
    const Send = vi.fn((_p: Record<string, string>, cb: KavenegarCallback) => cb([{ messageid: 9 }], 200, 'ok'));
    const a = createKavenegarAdapter({ ...CONFIG, sender: '10008663' }, {
      createClient: () => client({ Send }), timeoutMs: 200,
    });
    await a.sendSms({ receptor: '09120000000', message: 'hello' });
    expect(Send.mock.calls[0][0]).toEqual({ receptor: '09120000000', message: 'hello', sender: '10008663' });
  });

  it('works without any sender', async () => {
    const Send = vi.fn((_p: Record<string, string>, cb: KavenegarCallback) => cb([{ messageid: 9 }], 200, 'ok'));
    const a = adapter(client({ Send }));
    const res = await a.sendSms({ receptor: '09120000000', message: 'hi' });
    expect(Send.mock.calls[0][0]).not.toHaveProperty('sender');
    expect(res.messageId).toBe('9');
  });

  it('normalizes an object response as well as an array response', async () => {
    const a = adapter(client({ Send: (_p, cb) => cb({ messageid: '77' }, 200, 'ok') }));
    await expect(a.sendSms({ receptor: '0912', message: 'x' })).resolves.toEqual({ messageId: '77' });
  });

  it('never leaks a credential in the error', async () => {
    const a = adapter(client({ Send: (_p, cb) => cb([], 401, 'unauthorized') }));
    const err = await a.sendSms({ receptor: '0912', message: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect(JSON.stringify({ message: (err as SmsError).message, code: (err as SmsError).code }))
      .not.toContain(CONFIG.apiKey);
  });
});

describe('AccountInfo', () => {
  it('reads balance in IRR and the account type', async () => {
    const a = adapter(client({ AccountInfo: (_p, cb) => cb({ remaincredit: 1500000, type: 'master' }, 200, 'ok') }));
    await expect(a.getAccountInfo()).resolves.toEqual({ balance: 1500000, currency: 'IRR', accountType: 'master' });
  });

  it('surfaces an auth failure', async () => {
    const a = adapter(client({ AccountInfo: (_p, cb) => cb([], 401, 'bad key') }));
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_auth_failed' });
  });

  it('times out', async () => {
    const a = adapter(client({ AccountInfo: () => { /* silence */ } }), 20);
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_timeout' });
  });

  it('fails closed on a malformed response', async () => {
    const a = adapter(client({ AccountInfo: (_p, cb) => cb('garbage', 200, 'ok') }));
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_provider_error' });
  });
});
