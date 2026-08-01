/**
 * SMS.ir adapter — envelope handling, error normalization and timeouts.
 * The vendor SDK is replaced with an in-memory fake; no network call is made
 * and no credential is asserted on.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createSmsIrAdapter,
  mapSmsIrFailure,
  isValidSmsIrLineNumber,
  isValidSmsIrTemplateId,
  isValidSmsIrParameterName,
  type SmsIrClient,
} from '../../../server/services/sms/providers/smsir.js';
import type { SmsIrSmsConfig } from '../../../server/services/sms/types.js';

const CONFIG: SmsIrSmsConfig = {
  provider: 'smsir',
  apiKey: 'stored-placeholder',
  lineNumber: '30007732',
  verifyTemplateId: 100000,
  verifyParameterName: 'CODE',
};

function adapter(client: Partial<SmsIrClient>, timeoutMs = 200) {
  return createSmsIrAdapter(CONFIG, {
    timeoutMs,
    createClient: () =>
      ({
        sendBulk: () => Promise.resolve({ status: 1, message: 'ok', data: { packId: 'p', messageIds: [1], cost: 1 } }),
        sendVerifyCode: () => Promise.resolve({ status: 1, message: 'ok', data: { messageId: 2, cost: 1 } }),
        getCredit: () => Promise.resolve({ status: 1, message: 'ok', data: 10 }),
        ...client,
      }) as SmsIrClient,
  });
}

describe('validators', () => {
  it('accepts digit-only line numbers that survive the number conversion', () => {
    expect(isValidSmsIrLineNumber('30007732')).toBe(true);
    expect(isValidSmsIrLineNumber('3000 7732')).toBe(false);
    expect(isValidSmsIrLineNumber('+30007732')).toBe(false);
    expect(isValidSmsIrLineNumber('99999999999999999999')).toBe(false); // unsafe integer
  });

  it('accepts positive integer template ids only', () => {
    expect(isValidSmsIrTemplateId(100000)).toBe(true);
    expect(isValidSmsIrTemplateId(0)).toBe(false);
    expect(isValidSmsIrTemplateId(1.5)).toBe(false);
    expect(isValidSmsIrTemplateId('100000')).toBe(false);
  });

  it('accepts safe parameter names only', () => {
    expect(isValidSmsIrParameterName('CODE')).toBe(true);
    expect(isValidSmsIrParameterName('verify_code1')).toBe(true);
    expect(isValidSmsIrParameterName('code value')).toBe(false);
    expect(isValidSmsIrParameterName('')).toBe(false);
  });
});

describe('error mapping', () => {
  it('maps HTTP statuses and message hints to normalized codes', () => {
    expect(mapSmsIrFailure(401, 'Unauthorized')).toBe('sms_auth_failed');
    expect(mapSmsIrFailure(403, 'Forbidden')).toBe('sms_auth_failed');
    expect(mapSmsIrFailure(402, 'no credit')).toBe('sms_insufficient_credit');
    expect(mapSmsIrFailure(null, 'Insufficient credit')).toBe('sms_insufficient_credit');
    expect(mapSmsIrFailure(null, 'template not found')).toBe('sms_template_not_found');
    expect(mapSmsIrFailure(null, 'invalid mobile')).toBe('sms_invalid_receptor');
    expect(mapSmsIrFailure(503, 'gateway')).toBe('sms_network_error');
    expect(mapSmsIrFailure(null, 'unexpected')).toBe('sms_provider_error');
  });
});

describe('adapter construction', () => {
  it('fails closed on an invalid line number', () => {
    expect(() => createSmsIrAdapter({ ...CONFIG, lineNumber: 'abc' }, { createClient: () => ({}) as SmsIrClient }))
      .toThrowError(/not configured/i);
  });

  it('fails closed on an invalid template id', () => {
    expect(() => createSmsIrAdapter({ ...CONFIG, verifyTemplateId: -1 }, { createClient: () => ({}) as SmsIrClient }))
      .toThrowError(/template/i);
  });
});

describe('runtime behaviour', () => {
  it('returns the first message id from a bulk send', async () => {
    await expect(adapter({}).sendSms({ receptor: '09120000000', message: 'hi' }))
      .resolves.toEqual({ messageId: '1' });
  });

  it('rejects a non-numeric line override', async () => {
    await expect(adapter({}).sendSms({ receptor: '09120000000', message: 'hi', lineNumber: 'kaveh' }))
      .rejects.toMatchObject({ code: 'sms_provider_error' });
  });

  it('passes the code through the template parameter', async () => {
    const seen: unknown[] = [];
    const a = adapter({
      sendVerifyCode: (mobile, templateId, params) => {
        seen.push({ mobile, templateId, params });
        return Promise.resolve({ status: 1, message: 'ok', data: { messageId: 9, cost: 1 } });
      },
    });
    await expect(a.sendVerificationCode({ receptor: '09120000000', token: '123456', templateId: 100000, parameterName: 'CODE' }))
      .resolves.toEqual({ messageId: '9' });
    expect(seen[0]).toMatchObject({ params: [{ name: 'CODE', value: '123456' }] });
  });

  it('treats a non-success envelope status as an error', async () => {
    const a = adapter({ getCredit: () => Promise.resolve({ status: 0, message: 'Invalid api key', data: null }) });
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_auth_failed' });
  });

  it('rejects a malformed envelope', async () => {
    const a = adapter({ getCredit: () => Promise.resolve('nope') });
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_provider_error' });
  });

  it('normalizes a thrown SDK error using the HTTP status', async () => {
    const a = adapter({ getCredit: () => Promise.reject(new Error('HTTP error! status: 402 - low')) });
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_insufficient_credit' });
  });

  it('normalizes a network failure', async () => {
    const a = adapter({ getCredit: () => Promise.reject(new Error('fetch failed')) });
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_network_error' });
  });

  it('normalizes a synchronous throw', async () => {
    const a = adapter({ getCredit: () => { throw new Error('boom'); } });
    await expect(a.getAccountInfo()).rejects.toMatchObject({ code: 'sms_provider_error' });
  });

  it('times out a hanging call', async () => {
    vi.useFakeTimers();
    const a = adapter({ getCredit: () => new Promise(() => {}) }, 50);
    const pending = a.getAccountInfo();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'sms_timeout' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('returns the credit balance', async () => {
    await expect(adapter({}).getAccountInfo()).resolves.toEqual({ balance: 10, currency: 'IRR', accountType: null });
  });
});
