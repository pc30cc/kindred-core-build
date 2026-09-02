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
import { describe, it, expect, beforeEach } from 'vitest';
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
  DerivationKeyUnavailableError,
  VerificationPepperMissingError,
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
