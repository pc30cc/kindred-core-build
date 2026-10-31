import { EDITION_PROFILE, type Edition } from '../../shared/edition';

/**
 * Client-side mirror of the server phone country table
 * (`server/services/phoneVerification/phone.ts`). Keep both in sync.
 */
export interface PhoneCountry {
  code: string;
  dial: string;
  flag: string;
  labels: { fa: string; en: string; tr: string };
}

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { code: 'IR', dial: '+98', flag: '🇮🇷', labels: { fa: 'ایران', en: 'Iran', tr: 'İran' } },
  { code: 'TR', dial: '+90', flag: '🇹🇷', labels: { fa: 'ترکیه', en: 'Türkiye', tr: 'Türkiye' } },
  { code: 'AE', dial: '+971', flag: '🇦🇪', labels: { fa: 'امارات', en: 'UAE', tr: 'BAE' } },
  { code: 'IQ', dial: '+964', flag: '🇮🇶', labels: { fa: 'عراق', en: 'Iraq', tr: 'Irak' } },
  { code: 'AF', dial: '+93', flag: '🇦🇫', labels: { fa: 'افغانستان', en: 'Afghanistan', tr: 'Afganistan' } },
  { code: 'GB', dial: '+44', flag: '🇬🇧', labels: { fa: 'بریتانیا', en: 'United Kingdom', tr: 'Birleşik Krallık' } },
  { code: 'DE', dial: '+49', flag: '🇩🇪', labels: { fa: 'آلمان', en: 'Germany', tr: 'Almanya' } },
];

/**
 * The country a phone picker opens on.
 *
 *   - Iranian edition (the default): Iran (+98), whatever the dashboard's
 *     language. Its panel may be English or Turkish too (Super Admin →
 *     Branding, shared/panelLanguages.ts), and it is still WebYar with +98
 *     phones (shared/edition.ts EDITION_PROFILE.iran.phoneCountry); before
 *     that it was only ever Persian, so Iran, as now.
 *   - International edition: never Iran. Turkish → Türkiye, every other
 *     language (Persian included) → the UK, as before.
 */
export function defaultPhoneCountry(locale?: string, edition: Edition = 'iran'): string {
  const national = EDITION_PROFILE[edition]?.phoneCountry;
  if (national) return national;
  return locale === 'tr' ? 'TR' : 'GB';
}

const FA_AR_DIGITS = /[۰-۹٠-٩]/g;
function latinDigits(input: string): string {
  return input.replace(FA_AR_DIGITS, (d) => {
    const fa = '۰۱۲۳۴۵۶۷۸۹'.indexOf(d);
    return String(fa >= 0 ? fa : '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  });
}

/** International (E.164) phone input: keeps digits and one leading `+` while typing. */
export function sanitizeIntlPhoneInput(input: string): string {
  const v = latinDigits(input).replace(/[^\d+]/g, '');
  const plus = v.startsWith('+');
  return (plus ? '+' : '') + v.replace(/\+/g, '').slice(0, 17);
}

/** The canonical E.164 value (`00` → `+`, a missing `+` added); empty for an empty input. */
export function normalizeIntlPhone(input: string): string {
  let v = sanitizeIntlPhoneInput(input);
  if (!v) return '';
  if (v.startsWith('00')) v = '+' + v.slice(2);
  else if (!v.startsWith('+')) v = '+' + v;
  return v;
}

/** `+` and 7-15 digits, no leading zero in the country code. Empty is valid (no number). */
export function isValidIntlPhone(v: string): boolean {
  if (!v) return true;
  return /^\+[1-9]\d{6,14}$/.test(v);
}

export function phoneCountryLabel(code: string, locale: string): string {
  const c = PHONE_COUNTRIES.find((x) => x.code === code);
  if (!c) return code;
  const l = (locale === 'fa' || locale === 'tr' ? locale : 'en') as 'fa' | 'en' | 'tr';
  return `${c.flag} ${c.labels[l]} (${c.dial})`;
}

/** Best-effort country guess from a stored E.164 number. */
export function countryFromE164(phone?: string | null): string | null {
  if (!phone) return null;
  const match = [...PHONE_COUNTRIES]
    .sort((a, b) => b.dial.length - a.dial.length)
    .find((c) => phone.startsWith(c.dial));
  return match?.code ?? null;
}
