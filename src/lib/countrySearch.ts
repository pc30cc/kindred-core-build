/**
 * Country search for the phone number field
 * (src/components/phone/PhoneNumberField.tsx): names in the interface
 * language (and English) from `Intl.DisplayNames`, matched by name, ISO
 * code or calling code.
 */
import { DIAL_COUNTRIES, MAIN_FOR_DIAL, type DialCountry } from './dialCountries';

/** Lower case, no accents, Persian/Arabic letter forms unified: "Türkiye" ≈ "turkiye", "ي" ≈ "ی". */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[‌‏‎]/g, '')
    .toLowerCase()
    .trim();
}

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'region' });
  } catch {
    return null;
  }
}

export interface CountryEntry {
  country: DialCountry;
  name: string;
  haystack: string;
}

export function buildCountryEntries(locale: string): CountryEntry[] {
  const local = displayNames(locale);
  const english = displayNames('en');
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return DIAL_COUNTRIES.map((country) => {
    const name = local?.of(country.code) ?? country.code;
    const en = english?.of(country.code) ?? country.code;
    return {
      country,
      name,
      haystack: foldForSearch(`${name} ${en} ${country.code} +${country.dial} ${country.dial}`),
    };
  }).sort((a, b) => collator.compare(a.name, b.name));
}

export function filterCountryEntries(entries: readonly CountryEntry[], query: string): CountryEntry[] {
  const q = foldForSearch(query).replace(/^00/, '+');
  if (!q) return [...entries];
  const digits = q.replace(/^\+/, '');
  if (/^\d+$/.test(digits)) {
    // A calling code: exact matches first (the code's main country ahead of
    // those that share it, +44 → United Kingdom before Guernsey), then codes
    // that start with it.
    const rank = (e: CountryEntry) =>
      e.country.dial === digits ? (MAIN_FOR_DIAL[digits] === e.country.code ? 0 : 1) : 2;
    return entries
      .filter((e) => e.country.dial.startsWith(digits))
      .sort((a, b) => rank(a) - rank(b));
  }
  const words = q.split(/\s+/).filter(Boolean);
  const hits = entries.filter((e) => words.every((w) => e.haystack.includes(w)));
  // Names that start with the query before names that merely contain it.
  return hits.sort((a, b) => Number(foldForSearch(b.name).startsWith(q)) - Number(foldForSearch(a.name).startsWith(q)));
}

