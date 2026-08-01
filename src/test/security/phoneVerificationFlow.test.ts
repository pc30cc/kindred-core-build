import { describe, expect, it } from 'vitest';
import { resolvePhoneStatus } from '@/features/phone-verification/status';

describe('phone status resolution', () => {
  it('treats a user with no number as no_phone, never as unverified', () => {
    expect(resolvePhoneStatus({ phoneMasked: null, verified: false })).toBe('no_phone');
    expect(resolvePhoneStatus({})).toBe('no_phone');
  });

  it('marks a stored but unconfirmed number as unverified', () => {
    expect(resolvePhoneStatus({ phoneMasked: '+98••••1234', verified: false })).toBe('unverified');
  });

  it('marks a confirmed number as verified via flag or timestamp', () => {
    expect(resolvePhoneStatus({ phoneMasked: '+98••••1234', verified: true })).toBe('verified');
    expect(
      resolvePhoneStatus({ phone: '+989121234567', verifiedAt: '2026-01-01T00:00:00Z' }),
    ).toBe('verified');
  });
});
