import { describe, expect, it } from 'vitest';
import {
  digestCode,
  digestsMatch,
  generateOtpCode,
  hashIpForRateLimit,
} from '../../../server/services/phoneVerification/crypto';
import {
  maskE164,
  normalizePhoneToE164,
  toProviderFormat,
} from '../../../server/services/phoneVerification/phone';

const env = { PHONE_VERIFICATION_PEPPER: 'x'.repeat(32) } as unknown as NodeJS.ProcessEnv;
const base = {
  challengeId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  phoneE164: '+989121234567',
  code: '123456',
  env,
};

describe('otp digests', () => {
  it('binds a digest to challenge, user and phone so it cannot be replayed', () => {
    const d = digestCode(base);
    expect(digestCode({ ...base, challengeId: '33333333-3333-3333-3333-333333333333' })).not.toBe(d);
    expect(digestCode({ ...base, userId: '44444444-4444-4444-4444-444444444444' })).not.toBe(d);
    expect(digestCode({ ...base, phoneE164: '+989121234568' })).not.toBe(d);
    expect(digestCode({ ...base, code: '123457' })).not.toBe(d);
    expect(digestCode(base)).toBe(d);
  });

  it('never leaks the raw code inside the digest', () => {
    expect(digestCode(base)).not.toContain('123456');
  });

  it('compares digests without throwing on length mismatch', () => {
    expect(digestsMatch('abc', 'abcd')).toBe(false);
    expect(digestsMatch('abcd', 'abcd')).toBe(true);
  });

  it('produces six-digit codes in range', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('hashes the ip irreversibly and never stores it verbatim', () => {
    const h = hashIpForRateLimit('203.0.113.7', env);
    expect(h).not.toBeNull();
    expect(h).not.toContain('203.0.113.7');
    expect(hashIpForRateLimit(null, env)).toBeNull();
  });
});

describe('phone normalization and masking', () => {
  it('accepts every common Iranian input shape', () => {
    for (const input of ['09121234567', '9121234567', '989121234567', '+98 912 123 4567', '۰۹۱۲۱۲۳۴۵۶۷']) {
      expect(normalizePhoneToE164(input, 'IR')).toEqual({ ok: true, e164: '+989121234567', country: 'IR' });
    }
  });

  it('rejects landlines, junk and unsupported countries', () => {
    expect(normalizePhoneToE164('02112345678', 'IR').ok).toBe(false);
    expect(normalizePhoneToE164('not-a-number', 'IR').ok).toBe(false);
    expect(normalizePhoneToE164('09121234567', 'US')).toEqual({
      ok: false,
      reason: 'phone_country_not_supported',
    });
  });

  it('masks the middle of the number in every rendered form', () => {
    const masked = maskE164('+989121234567');
    expect(masked).toBe('+98912*****67');
    expect(masked).not.toContain('1234');
    expect(maskE164(null)).toBeNull();
  });

  it('keeps E.164 canonical while giving adapters the local form', () => {
    expect(toProviderFormat('+989121234567')).toBe('09121234567');
  });
});
