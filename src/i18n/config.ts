export type Locale = 'en' | 'fa' | 'tr';
export type Direction = 'ltr' | 'rtl';

export const SUPPORTED_LOCALES: Locale[] = ['en', 'fa', 'tr'];
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_CONFIG: Record<Locale, { label: string; nativeLabel: string; dir: Direction }> = {
  en: { label: 'English', nativeLabel: 'English', dir: 'ltr' },
  fa: { label: 'Persian', nativeLabel: 'فارسی', dir: 'rtl' },
  tr: { label: 'Turkish', nativeLabel: 'Türkçe', dir: 'ltr' },
};

export const DEFAULT_FALLBACK_CHAINS: Record<Locale, Locale[]> = {
  fa: ['fa', 'en'],
  tr: ['tr', 'en'],
  en: ['en'],
};

export function getDirection(locale: Locale): Direction {
  return LOCALE_CONFIG[locale]?.dir ?? 'ltr';
}

export function isRtl(locale: Locale): boolean {
  return getDirection(locale) === 'rtl';
}
