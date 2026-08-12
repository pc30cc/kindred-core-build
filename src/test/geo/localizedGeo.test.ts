/**
 * src/lib/geo/localizedGeo.ts — the canonical resolver combining country +
 * region localization into one presentation-only "what does this geo look
 * like in the active UI locale" function, plus the composed location label.
 *
 * Policy: country localizes via Intl.DisplayNames for every locale/country
 * (unchanged). region localizes to a Persian province name ONLY for
 * country_code=IR + the fa locale (src/lib/geo/iranProvinceLocalization.ts).
 * city ALWAYS stays canonical — there is no city-level translation dataset.
 */
import { describe, it, expect } from 'vitest';
import { resolveLocalizedGeoName, localizedLocationLabel } from '../../lib/geo/localizedGeo';

describe('resolveLocalizedGeoName', () => {
  it('fa + IR: localizes region, city stays canonical', () => {
    const result = resolveLocalizedGeoName(
      { city: 'Tehran', region: 'Tehran', country_code: 'IR', country: 'Iran' },
      'fa',
    );
    expect(result.city).toBe('Tehran'); // canonical — no city translation exists
    expect(result.region).toBe('تهران');
    expect(result.country).toBe('ایران');
  });

  it('fa + non-IR (TR): country localizes, region and city stay canonical', () => {
    const result = resolveLocalizedGeoName(
      { city: 'Istanbul', region: 'Istanbul', country_code: 'TR', country: 'Turkey' },
      'fa',
    );
    expect(result.city).toBe('Istanbul');
    expect(result.region).toBe('Istanbul');
    expect(result.country).toBe('ترکیه');
  });

  it('en + IR: nothing localizes except country (region/city stay canonical, no locale-based translation)', () => {
    const result = resolveLocalizedGeoName(
      { city: 'Tehran', region: 'Tehran', country_code: 'IR', country: 'Iran' },
      'en',
    );
    expect(result.city).toBe('Tehran');
    expect(result.region).toBe('Tehran');
  });

  it('city is never localized for any locale/country combination', () => {
    for (const locale of ['fa', 'en', 'tr']) {
      const result = resolveLocalizedGeoName(
        { city: 'Isfahan', region: 'Isfahan', country_code: 'IR', country: 'Iran' },
        locale,
      );
      expect(result.city).toBe('Isfahan');
    }
  });

  it('never mutates canonical stored geo data — pure, returns a new object', () => {
    const canonical = { city: 'Tehran', region: 'Tehran', country_code: 'IR', country: 'Iran' };
    const snapshot = { ...canonical };
    resolveLocalizedGeoName(canonical, 'fa');
    expect(canonical).toEqual(snapshot);
  });

  it('handles null/empty fields gracefully — never throws, never returns garbage', () => {
    expect(() => resolveLocalizedGeoName({}, 'fa')).not.toThrow();
    const result = resolveLocalizedGeoName({ city: null, region: null, country_code: null, country: null }, 'fa');
    expect(result).toEqual({ city: null, region: null, country: null });
  });
});

describe('localizedLocationLabel', () => {
  it('fa + IR: city، province، country', () => {
    const label = localizedLocationLabel(
      { city: 'Tehran', region: 'Tehran', country_code: 'IR', country: 'Iran' },
      'fa',
      ['city', 'region', 'country'],
    );
    expect(label).toBe('Tehran، تهران، ایران');
  });

  it('fa + TR: everything canonical except country', () => {
    const label = localizedLocationLabel(
      { city: 'Istanbul', country_code: 'TR', country: 'Turkey' },
      'fa',
    );
    expect(label).toBe('Istanbul، ترکیه');
  });

  it('en uses a plain comma', () => {
    const label = localizedLocationLabel(
      { city: 'Istanbul', country_code: 'TR', country: 'Turkey' },
      'en',
    );
    expect(label).toBe('Istanbul, Türkiye');
  });

  it('drops empty parts instead of leaving a stray separator', () => {
    const label = localizedLocationLabel({ city: null, country_code: 'DE', country: 'Germany' }, 'en');
    expect(label).toBe('Germany');
  });

  it('returns null when every part is empty', () => {
    expect(localizedLocationLabel({}, 'en')).toBeNull();
  });

  it('supports a custom part order/selection (e.g. city+region for compact rows)', () => {
    const label = localizedLocationLabel(
      { city: 'Tehran', region: 'Tehran', country: 'Iran', country_code: 'IR' },
      'fa',
      ['city', 'region'],
    );
    expect(label).toBe('Tehran، تهران');
  });
});
