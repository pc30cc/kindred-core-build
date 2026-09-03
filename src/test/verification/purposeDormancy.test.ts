/**
 * Generic Verification Core v1 — dormancy + crypto unit tests (no database).
 *
 * Proves, without touching Postgres, that:
 *  - every purpose ships disabled by default
 *  - a disabled purpose throws BEFORE any database call could happen
 *    (asserted here at the pure-function level; the "zero rows written"
 *    half of this guarantee is re-proven independently against a real
 *    database in genericVerificationCore.pg.test.ts)
 *  - the crypto primitives behave as specified (deterministic derivation,
 *    key-version-aware digesting, key rotation, missing-key fail-closed,
 *    constant-time compare, IPv6-safe rate-limit bucketing)
 *  - fa/tr/en templates are complete for every locale
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ALL_VERIFICATION_PURPOSES,
  PURPOSE_POLICIES,
  PLATFORM_MAXIMUMS,
  assertPurposeEnabled,
  assertChannelAllowed,
  getPurposePolicy,
  UnknownVerificationPurposeError,
  VerificationPurposeDisabledError,
  VerificationChannelNotAllowedError,
  __setPurposePolicyOverrideForTests,
  __clearAllPurposePolicyOverridesForTests,
} from '../../../server/services/verification/types';
import {
  deriveOtpCode,
  digestOtpCode,
  candidateOtpDigest,
  verifyOtpDigest,
  collapseIpForRateLimit,
  hashIpForRateLimit,
  currentVerificationKeyVersion,
  hasVerificationPepper,
  deriveProofToken,
  parseProofToken,
  hashProofToken,
  DerivationKeyUnavailableError,
  VerificationPepperMissingError,
  VerificationConfigError,
  InvalidProofTokenFormatError,
  __resetVerificationCryptoCacheForTests,
} from '../../../server/services/verification/crypto';
import { renderOtpEmail, renderOtpSms, SUPPORTED_TEMPLATE_LOCALES } from '../../../server/services/verification/templates';

describe('Generic Verification Core — purpose registry is disabled by default', () => {
  it('every registered purpose ships enabled:false', () => {
    for (const purpose of ALL_VERIFICATION_PURPOSES) {
      expect(PURPOSE_POLICIES[purpose].enabled).toBe(false);
    }
  });

  it('assertPurposeEnabled throws for every purpose (nothing is quietly enabled)', () => {
    for (const purpose of ALL_VERIFICATION_PURPOSES) {
      expect(() => assertPurposeEnabled(purpose)).toThrow(VerificationPurposeDisabledError);
    }
  });

  it('assertChannelAllowed also fails closed for a disabled purpose, before the channel check', () => {
    expect(() => assertChannelAllowed('signup_email', 'email')).toThrow(VerificationPurposeDisabledError);
  });

  it('rejects an unknown purpose distinctly from a disabled one', () => {
    expect(() => getPurposePolicy('not_a_real_purpose')).toThrow(UnknownVerificationPurposeError);
  });

  it('platform maximums clamp every policy — no purpose can exceed them', () => {
    for (const purpose of ALL_VERIFICATION_PURPOSES) {
      const p = PURPOSE_POLICIES[purpose];
      expect(p.otpLength).toBeLessThanOrEqual(PLATFORM_MAXIMUMS.otpLength);
      expect(p.otpTtlSeconds).toBeLessThanOrEqual(PLATFORM_MAXIMUMS.otpTtlSeconds);
      expect(p.maxSendsPerWindow).toBeLessThanOrEqual(PLATFORM_MAXIMUMS.maxSendsPerWindow);
      expect(p.maxVerificationAttempts).toBeLessThanOrEqual(PLATFORM_MAXIMUMS.maxVerificationAttempts);
      expect(p.proofTtlSeconds).toBeLessThanOrEqual(PLATFORM_MAXIMUMS.proofTtlSeconds);
      expect(p.resendCooldownSeconds).toBeGreaterThanOrEqual(PLATFORM_MAXIMUMS.resendCooldownSecondsMin);
    }
  });

  it('a test-only override attempting to exceed a platform maximum is still clamped', () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true, otpLength: 999, maxSendsPerWindow: 999 });
    const p = getPurposePolicy('sensitive_action');
    expect(p.otpLength).toBe(PLATFORM_MAXIMUMS.otpLength);
    expect(p.maxSendsPerWindow).toBe(PLATFORM_MAXIMUMS.maxSendsPerWindow);
    __clearAllPurposePolicyOverridesForTests();
  });

  it('the channel-not-allowed error only fires for an ENABLED purpose with a disallowed channel', () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    expect(() => assertChannelAllowed('signup_email', 'sms')).toThrow(VerificationChannelNotAllowedError);
    expect(() => assertChannelAllowed('signup_email', 'email')).not.toThrow();
    __clearAllPurposePolicyOverridesForTests();
  });
});

describe('Generic Verification Core — OTP crypto', () => {
  beforeEach(() => {
    __resetVerificationCryptoCacheForTests();
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
  });

  const domain = { purpose: 'signup_email', channel: 'email' as const, challengeHandle: 'gvc_test_handle_1', generation: 1, destinationHash: 'abc123' };

  it('deriveOtpCode is deterministic for the same inputs', () => {
    const a = deriveOtpCode(domain, 1, 6);
    const b = deriveOtpCode(domain, 1, 6);
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{6}$/);
  });

  it('deriveOtpCode changes if ANY domain input changes (purpose/channel/handle/generation/destination)', () => {
    const base = deriveOtpCode(domain, 1, 6);
    expect(deriveOtpCode({ ...domain, purpose: 'password_reset' }, 1, 6)).not.toBe(base);
    expect(deriveOtpCode({ ...domain, channel: 'sms' }, 1, 6)).not.toBe(base);
    expect(deriveOtpCode({ ...domain, challengeHandle: 'gvc_other' }, 1, 6)).not.toBe(base);
    expect(deriveOtpCode({ ...domain, generation: 2 }, 1, 6)).not.toBe(base);
    expect(deriveOtpCode({ ...domain, destinationHash: 'xyz' }, 1, 6)).not.toBe(base);
  });

  it('digestOtpCode never contains the raw code as a substring, and is versioned', () => {
    const code = deriveOtpCode(domain, 1, 6);
    const digest = digestOtpCode(domain, code, 1);
    expect(digest.startsWith('v1:')).toBe(true);
    expect(digest.includes(code)).toBe(false);
  });

  it('candidateOtpDigest matches digestOtpCode for the same code, and verifyOtpDigest confirms it', () => {
    const code = deriveOtpCode(domain, 1, 6);
    const stored = digestOtpCode(domain, code, 1);
    const candidate = candidateOtpDigest(domain, code, 1);
    expect(candidate).toBe(stored);
    expect(verifyOtpDigest(candidate, stored)).toBe(true);
  });

  it('verifyOtpDigest rejects a wrong code and never throws on length mismatch', () => {
    const code = deriveOtpCode(domain, 1, 6);
    const stored = digestOtpCode(domain, code, 1);
    const wrongCandidate = candidateOtpDigest(domain, '000000' === code ? '111111' : '000000', 1);
    expect(verifyOtpDigest(wrongCandidate, stored)).toBe(false);
    expect(verifyOtpDigest('short', stored)).toBe(false);
  });

  it('key rotation: verifying against an OLD key version still works while that key remains in the ring', () => {
    // This test's ring is the sole source of truth for version 1 here — it
    // must NOT also inherit the outer beforeEach's GENERIC_VERIFICATION_PEPPER
    // (a different value), which would now fail closed as a version-1
    // conflict (see the "fail-closed cryptographic configuration" suite).
    delete process.env.GENERIC_VERIFICATION_PEPPER;
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({
      1: 'ring-key-version-one-at-least-32-bytes!!',
      2: 'ring-key-version-two-at-least-32-bytes!!',
    });
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '1';
    __resetVerificationCryptoCacheForTests();

    const code = deriveOtpCode(domain, 1, 6);
    const stored = digestOtpCode(domain, code, 1);

    // Rotate: current version becomes 2, but v1 is still in the ring.
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '2';
    __resetVerificationCryptoCacheForTests();
    expect(currentVerificationKeyVersion()).toBe(2);

    // Verification of the OLD challenge must still use its OWN recorded
    // version (1), not the new current version (2).
    const candidateWithHistoricalVersion = candidateOtpDigest(domain, code, 1);
    expect(verifyOtpDigest(candidateWithHistoricalVersion, stored)).toBe(true);
  });

  it('missing historical key fails closed (never silently falls back to the current key)', () => {
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ 2: 'ring-key-version-two-at-least-32-bytes!!' });
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '2';
    __resetVerificationCryptoCacheForTests();

    // Version 99 was never in the ring (base GENERIC_VERIFICATION_PEPPER
    // always occupies version 1, so a genuinely-absent version must be a
    // number that appears nowhere — base pepper included) — deriving/
    // digesting against it must throw, never silently substitute the
    // current version's key.
    expect(() => deriveOtpCode(domain, 99, 6)).toThrow(DerivationKeyUnavailableError);
  });

  it('missing pepper entirely fails closed with a distinct error', () => {
    delete process.env.GENERIC_VERIFICATION_PEPPER;
    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    __resetVerificationCryptoCacheForTests();
    expect(() => deriveOtpCode(domain, 1, 6)).toThrow(VerificationPepperMissingError);
  });

  it('IPv6 addresses in the same /64 hash to the SAME rate-limit bucket', () => {
    const a = hashIpForRateLimit('2a01:4f8:1c17:1234::1');
    const b = hashIpForRateLimit('2a01:4f8:1c17:1234::9999');
    expect(a).toBe(b);
  });

  it('IPv6 addresses in DIFFERENT /64s hash to different buckets', () => {
    const a = hashIpForRateLimit('2a01:4f8:1c17:1234::1');
    const b = hashIpForRateLimit('2a01:4f8:1c18:1234::1');
    expect(a).not.toBe(b);
  });

  it('collapseIpForRateLimit is a no-op for IPv4', () => {
    expect(collapseIpForRateLimit('203.0.113.7')).toBe('203.0.113.7');
  });

  it('hashIpForRateLimit never contains the raw IP as a substring', () => {
    const hash = hashIpForRateLimit('203.0.113.7');
    expect(hash.includes('203.0.113.7')).toBe(false);
  });
});

describe('Generic Verification Core — fail-closed cryptographic configuration', () => {
  beforeEach(() => {
    __resetVerificationCryptoCacheForTests();
    delete process.env.GENERIC_VERIFICATION_PEPPER;
    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
  });

  afterEach(() => {
    __resetVerificationCryptoCacheForTests();
    delete process.env.GENERIC_VERIFICATION_PEPPER;
    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
  });

  it('nothing configured at all fails LAZILY at first use (VerificationPepperMissingError) — loadRing itself never throws for a totally empty config', () => {
    expect(hasVerificationPepper()).toBe(false);
    expect(() =>
      deriveOtpCode({ purpose: 'x', channel: 'email', challengeHandle: 'h', generation: 1, destinationHash: 'd' }, 1, 6),
    ).toThrow(VerificationPepperMissingError);
  });

  it('a malformed GENERIC_VERIFICATION_PEPPER_RING (not valid JSON) fails closed with VerificationConfigError, never silently treated as "no ring"', () => {
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    process.env.GENERIC_VERIFICATION_PEPPER_RING = 'not-json-at-all{{{';
    expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
  });

  it('a GENERIC_VERIFICATION_PEPPER_RING that is valid JSON but not a plain object (a string, an array, or null) is rejected', () => {
    for (const notAnObject of ['"just-a-string"', '[1,2,3]', 'null', '42']) {
      __resetVerificationCryptoCacheForTests();
      process.env.GENERIC_VERIFICATION_PEPPER_RING = notAnObject;
      expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
    }
  });

  it('an invalid version key in the ring (non-integer, zero, negative, leading zero, decimal) is rejected', () => {
    for (const badKey of ['0', '-1', '01', 'abc', '1.5']) {
      __resetVerificationCryptoCacheForTests();
      process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ [badKey]: 'a-value-that-is-at-least-32-bytes-long!!' });
      expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
    }
  });

  it('a ring value shorter than 32 characters is rejected', () => {
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ 1: 'too-short' });
    expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
  });

  it('an explicitly empty ring object is rejected, never silently treated as "no ring configured"', () => {
    process.env.GENERIC_VERIFICATION_PEPPER_RING = '{}';
    expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
  });

  it('GENERIC_VERIFICATION_PEPPER shorter than 32 characters is rejected outright, not silently dropped', () => {
    process.env.GENERIC_VERIFICATION_PEPPER = 'too-short';
    expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
  });

  it('GENERIC_VERIFICATION_PEPPER and ring version 1 disagreeing fails startup instead of one silently overriding the other', () => {
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ 1: 'a-different-ring-value-at-least-32-bytes!!' });
    expect(() => hasVerificationPepper()).toThrow(VerificationConfigError);
  });

  it('GENERIC_VERIFICATION_PEPPER and an IDENTICAL ring version 1 is accepted (not treated as a conflict)', () => {
    const pepper = 'test-pepper-value-at-least-32-bytes-long!!';
    process.env.GENERIC_VERIFICATION_PEPPER = pepper;
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ 1: pepper, 2: 'second-ring-key-value-at-least-32-bytes!!' });
    expect(hasVerificationPepper()).toBe(true);
    expect(currentVerificationKeyVersion()).toBe(2); // default: max of the ring when KEY_VERSION is unset
  });

  it('an explicitly configured GENERIC_VERIFICATION_KEY_VERSION absent from the ring fails closed, never falls back to the max version', () => {
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({
      1: 'test-pepper-value-at-least-32-bytes-long!!',
      2: 'second-ring-key-value-at-least-32-bytes!!',
    });
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '5'; // never in the ring
    expect(() => currentVerificationKeyVersion()).toThrow(VerificationConfigError);
  });

  it('an explicitly configured GENERIC_VERIFICATION_KEY_VERSION that is not a valid positive integer fails closed', () => {
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    for (const bad of ['0', '-1', '1.5', 'abc', '01']) {
      __resetVerificationCryptoCacheForTests();
      process.env.GENERIC_VERIFICATION_KEY_VERSION = bad;
      expect(() => currentVerificationKeyVersion()).toThrow(VerificationConfigError);
    }
  });

  it('an UNSET GENERIC_VERIFICATION_KEY_VERSION still correctly defaults to the max ring version — the fallback is only skipped when a version IS explicitly configured', () => {
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({
      1: 'test-pepper-value-at-least-32-bytes-long!!',
      3: 'third-ring-key-value-at-least-32-bytes!!',
    });
    expect(currentVerificationKeyVersion()).toBe(3);
  });
});

describe('Generic Verification Core — proof token parsing/hashing (strict validation)', () => {
  beforeEach(() => {
    __resetVerificationCryptoCacheForTests();
    process.env.GENERIC_VERIFICATION_PEPPER = 'test-pepper-value-at-least-32-bytes-long!!';
    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
  });

  const domain = { handle: 'gvc_test_handle_1', requestId: 'req-1', purpose: 'signup_email', channel: 'email' as const };

  it('a validly-derived token round-trips through parseProofToken and hashProofToken', () => {
    const token = deriveProofToken(domain, 1);
    expect(token).toMatch(/^gvp_v1_[A-Za-z0-9_-]{43}$/);
    const value = token.slice('gvp_v1_'.length);
    expect(parseProofToken(token)).toEqual({ version: 1, value });
    expect(() => hashProofToken(token)).not.toThrow();
  });

  it('rejects a malformed prefix — the old, deliberately-retired unversioned gvp_<value> format, and a wrong scheme entirely', () => {
    const token = deriveProofToken(domain, 1);
    const value = token.slice('gvp_v1_'.length);
    expect(parseProofToken(`gvp_${value}`)).toBeNull();
    expect(parseProofToken(`gvx_v1_${value}`)).toBeNull();
    expect(parseProofToken('not-a-proof-token-at-all')).toBeNull();
    expect(() => hashProofToken(`gvp_${value}`)).toThrow(InvalidProofTokenFormatError);
  });

  it('rejects a zero, negative, or non-numeric version', () => {
    const token = deriveProofToken(domain, 1);
    const value = token.slice('gvp_v1_'.length);
    expect(parseProofToken(`gvp_v0_${value}`)).toBeNull();
    expect(parseProofToken(`gvp_v-1_${value}`)).toBeNull();
    expect(parseProofToken(`gvp_vabc_${value}`)).toBeNull();
    expect(() => hashProofToken(`gvp_v0_${value}`)).toThrow(InvalidProofTokenFormatError);
  });

  it('rejects a huge version — both an unsafe-integer digit string and one merely exceeding the bounded ceiling', () => {
    const token = deriveProofToken(domain, 1);
    const value = token.slice('gvp_v1_'.length);
    expect(parseProofToken(`gvp_v99999999999999999999999999_${value}`)).toBeNull(); // unsafe integer
    expect(parseProofToken(`gvp_v2000000_${value}`)).toBeNull(); // safe integer, but exceeds MAX_KEY_VERSION
    expect(() => hashProofToken(`gvp_v2000000_${value}`)).toThrow(InvalidProofTokenFormatError);
  });

  it('rejects a truncated value — fewer than the exact 43 base64url characters a 32-byte digest always encodes to', () => {
    const token = deriveProofToken(domain, 1);
    const truncated = token.slice(0, token.length - 5);
    expect(parseProofToken(truncated)).toBeNull();
    expect(() => hashProofToken(truncated)).toThrow(InvalidProofTokenFormatError);
  });

  it('rejects an oversized value — more than 43 characters, e.g. extra injected data appended', () => {
    const token = deriveProofToken(domain, 1);
    const oversized = `${token}EXTRA`;
    expect(parseProofToken(oversized)).toBeNull();
    expect(() => hashProofToken(oversized)).toThrow(InvalidProofTokenFormatError);
  });

  it('a well-formed token whose embedded version has no corresponding ring entry fails with DerivationKeyUnavailableError, distinct from InvalidProofTokenFormatError', () => {
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ 1: 'test-pepper-value-at-least-32-bytes-long!!' });
    __resetVerificationCryptoCacheForTests();
    const token = deriveProofToken(domain, 1);
    const value = token.slice('gvp_v1_'.length);
    const missingKeyToken = `gvp_v99_${value}`; // well-formed shape; version 99 was never in the ring
    expect(parseProofToken(missingKeyToken)).toEqual({ version: 99, value });
    expect(() => hashProofToken(missingKeyToken)).toThrow(DerivationKeyUnavailableError);
  });
});

describe('Generic Verification Core — fa/tr/en template completeness', () => {
  it('renders an OTP email for every supported locale with non-empty subject/text/html', () => {
    for (const locale of SUPPORTED_TEMPLATE_LOCALES) {
      const rendered = renderOtpEmail(locale, '123456', 600);
      expect(rendered.subject).toBeTruthy();
      expect(rendered.text).toBeTruthy();
      expect(rendered.html).toBeTruthy();
      expect(rendered.text.includes('123456')).toBe(true);
    }
  });

  it('renders an OTP SMS for every supported locale with non-empty text', () => {
    for (const locale of SUPPORTED_TEMPLATE_LOCALES) {
      const rendered = renderOtpSms(locale, '123456', 300);
      expect(rendered.text).toBeTruthy();
      expect(rendered.text.includes('123456')).toBe(true);
    }
  });

  it('fa template renders as RTL', () => {
    const rendered = renderOtpEmail('fa', '123456', 600);
    expect(rendered.html).toContain('dir="rtl"');
  });

  it('tr/en templates render as LTR', () => {
    expect(renderOtpEmail('tr', '123456', 600).html).toContain('dir="ltr"');
    expect(renderOtpEmail('en', '123456', 600).html).toContain('dir="ltr"');
  });
});
