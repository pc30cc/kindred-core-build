/**
 * src/lib/geo/countryLocalization.ts — Intl.DisplayNames-based country name
 * localization, keyed by the ACTIVE product locale (never hardcoded 'en').
 */
import { describe, it, expect } from 'vitest';
import { localizedCountryName, normalizeLocaleTag, toCountryCode } from '../../lib/geo/countryLocalization';

describe('normalizeLocaleTag', () => {
  it('normalizes locale variants to their supported primary tag', () => {
    expect(normalizeLocaleTag('fa-IR')).toBe('fa');
    expect(normalizeLocaleTag('en-US')).toBe('en');
    expect(normalizeLocaleTag('tr-TR')).toBe('tr');
    expect(normalizeLocaleTag('fa')).toBe('fa');
  });
  it('falls back to en for unknown/missing locales', () => {
    expect(normalizeLocaleTag(undefined)).toBe('en');
    expect(normalizeLocaleTag(null)).toBe('en');
    expect(normalizeLocaleTag('')).toBe('en');
    expect(normalizeLocaleTag('de-DE')).toBe('en');
  });
});

describe('toCountryCode', () => {
  it('accepts a bare 2-letter code, case-insensitive', () => {
    expect(toCountryCode('tr')).toBe('TR');
    expect(toCountryCode('TR')).toBe('TR');
  });
  it('rejects non-code input', () => {
    expect(toCountryCode('Turkey')).toBeNull();
    expect(toCountryCode(null)).toBeNull();
    expect(toCountryCode(undefined)).toBeNull();
    expect(toCountryCode('')).toBeNull();
  });
});

describe('localizedCountryName', () => {
  it('TR → ترکیه in fa, Türkiye in tr and en (current CLDR English short name for Turkey)', () => {
    expect(localizedCountryName('TR', 'fa')).toBe('ترکیه');
    expect(localizedCountryName('TR', 'tr')).toBe('Türkiye');
    expect(localizedCountryName('TR', 'en')).toBe('Türkiye');
  });

  it('IR → ایران in fa', () => {
    expect(localizedCountryName('IR', 'fa')).toBe('ایران');
  });

  it('DE → آلمان in fa, Almanya in tr', () => {
    expect(localizedCountryName('DE', 'fa')).toBe('آلمان');
    expect(localizedCountryName('DE', 'tr')).toBe('Almanya');
  });

  it('accepts locale variants (fa-IR, tr-TR, en-US)', () => {
    expect(localizedCountryName('TR', 'fa-IR')).toBe('ترکیه');
    expect(localizedCountryName('TR', 'tr-TR')).toBe('Türkiye');
  });

  it('falls back to the canonical name when the code is missing, never returning null while a canonical name exists', () => {
    expect(localizedCountryName(null, 'fa', 'Some Country')).toBe('Some Country');
    expect(localizedCountryName(undefined, 'fa', 'Some Country')).toBe('Some Country');
  });

  it('returns null only when there is truly nothing to fall back to', () => {
    expect(localizedCountryName(null, 'fa', null)).toBeNull();
    expect(localizedCountryName(undefined, 'fa')).toBeNull();
  });

  it('falls back to the raw code when no canonical name is supplied and the code is unrecognized', () => {
    // 'ZZ' is CLDR's reserved "Unknown Region" code and resolves to a real
    // (localized) name, so it doesn't exercise the "truly unknown" path —
    // 'XX' is unassigned in CLDR and Intl.DisplayNames returns it unchanged.
    expect(localizedCountryName('XX', 'fa')).toBe('XX');
  });

  it('changing locale never mutates any shared/cached state across calls — pure function', () => {
    const first = localizedCountryName('TR', 'fa');
    const second = localizedCountryName('TR', 'en');
    const third = localizedCountryName('TR', 'fa');
    expect(first).toBe('ترکیه');
    expect(second).toBe('Türkiye');
    expect(third).toBe('ترکیه'); // unaffected by the intervening 'en' call
  });
});
