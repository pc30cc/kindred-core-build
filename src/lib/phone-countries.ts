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

/** Farsi UI defaults to Iran, Turkish to Türkiye, everything else to the UK. */
export function defaultPhoneCountry(locale?: string): string {
  if (locale === 'fa') return 'IR';
  if (locale === 'tr') return 'TR';
  return 'GB';
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
