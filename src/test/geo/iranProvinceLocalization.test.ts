/**
 * src/lib/geo/iranProvinceLocalization.ts — Persian names for Iran's 31
 * provinces, replacing the earlier city-level dataset for anonymous
 * Iranian visitor identity.
 */
import { describe, it, expect } from 'vitest';
import { curatedIranProvinceName, localizedIranProvince } from '../../lib/geo/iranProvinceLocalization';

const ALL_31 = [
  ['Tehran', 'تهران'],
  ['Alborz', 'البرز'],
  ['Qom', 'قم'],
  ['Markazi', 'مرکزی'],
  ['Qazvin', 'قزوین'],
  ['Gilan', 'گیلان'],
  ['Ardabil', 'اردبیل'],
  ['Zanjan', 'زنجان'],
  ['East Azerbaijan', 'آذربایجان شرقی'],
  ['West Azerbaijan', 'آذربایجان غربی'],
  ['Kurdistan', 'کردستان'],
  ['Hamadan', 'همدان'],
  ['Kermanshah', 'کرمانشاه'],
  ['Ilam', 'ایلام'],
  ['Lorestan', 'لرستان'],
  ['Khuzestan', 'خوزستان'],
  ['Chaharmahal and Bakhtiari', 'چهارمحال و بختیاری'],
  ['Kohgiluyeh and Boyer-Ahmad', 'کهگیلویه و بویراحمد'],
  ['Bushehr', 'بوشهر'],
  ['Fars', 'فارس'],
  ['Hormozgan', 'هرمزگان'],
  ['Sistan and Baluchestan', 'سیستان و بلوچستان'],
  ['Kerman', 'کرمان'],
  ['Yazd', 'یزد'],
  ['Isfahan', 'اصفهان'],
  ['Semnan', 'سمنان'],
  ['Mazandaran', 'مازندران'],
  ['Golestan', 'گلستان'],
  ['North Khorasan', 'خراسان شمالی'],
  ['Razavi Khorasan', 'خراسان رضوی'],
  ['South Khorasan', 'خراسان جنوبی'],
] as const;

describe('curatedIranProvinceName — all 31 provinces', () => {
  it('covers exactly 31 unique provinces', () => {
    expect(ALL_31).toHaveLength(31);
    const faSet = new Set(ALL_31.map(([, fa]) => fa));
    expect(faSet.size).toBe(31);
  });

  it.each(ALL_31)('%s -> %s', (canonical, expectedFa) => {
    expect(curatedIranProvinceName(canonical)).toBe(expectedFa);
  });

  it('is case-insensitive', () => {
    expect(curatedIranProvinceName('tehran')).toBe('تهران');
    expect(curatedIranProvinceName('TEHRAN')).toBe('تهران');
  });

  it('accepts small, specific provider-spelling aliases without fuzzy matching', () => {
    // GeoNames-confirmed alternate English spelling.
    expect(curatedIranProvinceName('East Azarbaijan')).toBe('آذربایجان شرقی');
    expect(curatedIranProvinceName('West Azarbaijan')).toBe('آذربایجان غربی');
    // Common alternate spellings.
    expect(curatedIranProvinceName('Esfahan')).toBe('اصفهان');
    expect(curatedIranProvinceName('Qum')).toBe('قم');
  });

  it('returns null for an unrecognized region — never guesses', () => {
    expect(curatedIranProvinceName('Not A Real Province')).toBeNull();
    expect(curatedIranProvinceName('Istanbul')).toBeNull();
  });

  it('returns null for missing region', () => {
    expect(curatedIranProvinceName(null)).toBeNull();
    expect(curatedIranProvinceName(undefined)).toBeNull();
  });
});

describe('localizedIranProvince — locale/country gating', () => {
  it('fa + IR localizes', () => {
    expect(localizedIranProvince('Tehran', 'IR', 'fa')).toBe('تهران');
    expect(localizedIranProvince('Fars', 'IR', 'fa')).toBe('فارس');
    expect(localizedIranProvince('Gilan', 'IR', 'fa')).toBe('گیلان');
    expect(localizedIranProvince('Razavi Khorasan', 'IR', 'fa')).toBe('خراسان رضوی');
    expect(localizedIranProvince('East Azerbaijan', 'IR', 'fa')).toBe('آذربایجان شرقی');
    expect(localizedIranProvince('West Azerbaijan', 'IR', 'fa')).toBe('آذربایجان غربی');
    expect(localizedIranProvince('South Khorasan', 'IR', 'fa')).toBe('خراسان جنوبی');
    expect(localizedIranProvince('North Khorasan', 'IR', 'fa')).toBe('خراسان شمالی');
  });

  it('accepts a locale variant like fa-IR', () => {
    expect(localizedIranProvince('Tehran', 'IR', 'fa-IR')).toBe('تهران');
  });

  it('non-fa locale never translates, even for Iran', () => {
    expect(localizedIranProvince('Tehran', 'IR', 'en')).toBe('Tehran');
    expect(localizedIranProvince('Tehran', 'IR', 'tr')).toBe('Tehran');
  });

  it('fa + non-Iran country never translates — no new dataset for any other country', () => {
    expect(localizedIranProvince('Istanbul', 'TR', 'fa')).toBe('Istanbul');
    expect(localizedIranProvince('Bavaria', 'DE', 'fa')).toBe('Bavaria');
  });

  it('unrecognized Iranian region falls back to canonical, never guesses', () => {
    expect(localizedIranProvince('Some New Region', 'IR', 'fa')).toBe('Some New Region');
  });

  it('returns null only for a missing region', () => {
    expect(localizedIranProvince(null, 'IR', 'fa')).toBeNull();
    expect(localizedIranProvince(undefined, 'IR', 'fa')).toBeNull();
  });
});
