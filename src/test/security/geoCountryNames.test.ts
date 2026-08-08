/**
 * Offline country-name / flag / precision helpers (server/services/geo/countryNames.ts).
 * No external API may be involved in TR → Turkey.
 */
import { describe, it, expect } from 'vitest';
import {
  countryNameFromCode,
  flagEmojiFromCountryCode,
  precisionRank,
  toCountryCode,
} from '../../../server/services/geo/countryNames';

describe('country codes', () => {
  it('normalizes to alpha-2 uppercase', () => {
    expect(toCountryCode('tr')).toBe('TR');
    expect(toCountryCode('Turkey')).toBeNull();
    expect(toCountryCode(null)).toBeNull();
  });

  it('resolves display names offline', () => {
    expect(countryNameFromCode('TR')).toMatch(/T(ü|u)rk/i);
    expect(countryNameFromCode('DE')).toBe('Germany');
    expect(countryNameFromCode('IR')).toMatch(/Iran/i);
    expect(countryNameFromCode(null)).toBeNull();
  });

  it('produces flag emojis', () => {
    expect(flagEmojiFromCountryCode('TR')).toBe('🇹🇷');
    expect(flagEmojiFromCountryCode('ir')).toBe('🇮🇷');
    expect(flagEmojiFromCountryCode('XXX')).toBeNull();
  });
});

describe('precision ranking', () => {
  it('orders city > region > country > centroid > unknown', () => {
    expect(precisionRank('city')).toBeGreaterThan(precisionRank('region'));
    expect(precisionRank('region')).toBeGreaterThan(precisionRank('country'));
    expect(precisionRank('country')).toBeGreaterThan(precisionRank('centroid'));
    expect(precisionRank('centroid')).toBeGreaterThan(precisionRank(null));
  });
});
