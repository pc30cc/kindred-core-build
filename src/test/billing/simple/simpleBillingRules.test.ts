/**
 * The simple billing's pure rules (shared/simpleBilling.ts): top-up limits,
 * VAT that is shown only when set, the charge, and the profile cleaner.
 */
import { describe, it, expect } from 'vitest';
import {
  BILLING_PROFILE_KEYS,
  TOPUP_LIMITS,
  chargeFor,
  cleanProfile,
  topupAmountProblem,
  vatPercentFor,
} from '../../../../shared/simpleBilling';
import { toMinorAmount } from '@/pages/app/billing/account/accountUi';

describe('top-up limits', () => {
  it('accepts the bounds and refuses outside them', () => {
    for (const [currency, { min, max }] of Object.entries(TOPUP_LIMITS)) {
      expect(topupAmountProblem(min, currency)).toBeNull();
      expect(topupAmountProblem(max, currency)).toBeNull();
      expect(topupAmountProblem(min - 1, currency)).toBe('TOPUP_AMOUNT_TOO_SMALL');
      expect(topupAmountProblem(max + 1, currency)).toBe('TOPUP_AMOUNT_TOO_LARGE');
    }
  });

  it('refuses fractions, zero, negatives and unknown currencies', () => {
    expect(topupAmountProblem(500.5, 'USD')).toBe('TOPUP_AMOUNT_INVALID');
    expect(topupAmountProblem(0, 'USD')).toBe('TOPUP_AMOUNT_INVALID');
    expect(topupAmountProblem(-500, 'USD')).toBe('TOPUP_AMOUNT_INVALID');
    expect(topupAmountProblem('500', 'USD')).toBe('TOPUP_AMOUNT_INVALID');
    expect(topupAmountProblem(500, 'XYZ')).toBe('CURRENCY_NOT_SUPPORTED');
  });

  it('Iran: 10,000 Toman minimum (100,000 Rial)', () => {
    expect(topupAmountProblem(99_999, 'IRR')).toBe('TOPUP_AMOUNT_TOO_SMALL');
    expect(topupAmountProblem(100_000, 'IRR')).toBeNull();
  });
});

describe('VAT: shown only when it is set', () => {
  it('reads the percent of the currency', () => {
    expect(vatPercentFor({ IRR: 10 }, 'IRR')).toBe(10);
    expect(vatPercentFor({ TRY: '20' }, 'try')).toBe(20);
    expect(vatPercentFor({ USD: 7.25 }, 'USD')).toBe(7.25);
  });

  it('is null when empty, missing, zero, nonsense or not an object', () => {
    expect(vatPercentFor({ USD: null }, 'USD')).toBeNull();
    expect(vatPercentFor({ USD: '' }, 'USD')).toBeNull();
    expect(vatPercentFor({ IRR: 10 }, 'USD')).toBeNull();
    expect(vatPercentFor({ USD: 0 }, 'USD')).toBeNull();
    expect(vatPercentFor({ USD: 'ten' }, 'USD')).toBeNull();
    expect(vatPercentFor({ USD: 150 }, 'USD')).toBeNull();
    expect(vatPercentFor(null, 'USD')).toBeNull();
    expect(vatPercentFor([10], 'USD')).toBeNull();
  });
});

describe('the charge', () => {
  it('adds the VAT on top of the credit, rounded to the minor unit', () => {
    expect(chargeFor(5_000_000, 10)).toEqual({ net: 5_000_000, tax: 500_000, total: 5_500_000 });
    expect(chargeFor(999, 7.25)).toEqual({ net: 999, tax: 72, total: 1071 });
    expect(chargeFor(2500, null)).toEqual({ net: 2500, tax: 0, total: 2500 });
  });
});

describe('profiles', () => {
  it('keeps known keys with trimmed, non-empty, capped values', () => {
    const cleaned = cleanProfile(
      { company: '  Acme  ', vat_id: '', unknown: 'x', address: 'a'.repeat(400), phone: 5 },
      BILLING_PROFILE_KEYS,
    );
    expect(cleaned).toEqual({ company: 'Acme', address: 'a'.repeat(300) });
    expect(cleanProfile(null, BILLING_PROFILE_KEYS)).toEqual({});
  });
});

describe('typed amounts', () => {
  it('Toman becomes Rial; dollars become cents', () => {
    expect(toMinorAmount(500_000, 'IRR')).toBe(5_000_000);
    expect(toMinorAmount(25, 'USD')).toBe(2500);
    expect(toMinorAmount(25.99, 'USD')).toBe(2599);
    expect(toMinorAmount(0, 'USD')).toBeNull();
    expect(toMinorAmount(Number.NaN, 'USD')).toBeNull();
  });
});
