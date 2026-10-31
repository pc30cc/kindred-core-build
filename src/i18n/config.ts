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

/** Where this browser keeps the language someone picked (index.html reads it too). */
export const LOCALE_STORAGE_KEY = 'app-locale';

/** The language someone picked in this browser (`app-locale`), or null when none was picked. */
export function getChosenLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored === 'en' || stored === 'fa' || stored === 'tr' ? stored : null;
  } catch {
    return null;
  }
}
