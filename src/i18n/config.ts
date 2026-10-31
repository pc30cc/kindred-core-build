import { cachedEdition } from '@/lib/edition';

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

/**
 * The language this page is in, kept for the next load (index.html's title
 * script and the Inbox read it too). Since 2026-10-31 it no longer says on
 * its own that someone PICKED that language: see LOCALE_CHOICE_KEY.
 */
export const LOCALE_STORAGE_KEY = 'app-locale';

/**
 * The language someone picked themselves in a language switcher. Only an
 * explicit pick writes it (src/i18n setLocale without `remember: false`).
 * A pick outranks the platform's default language; nothing else does
 * (src/hooks/usePlatformRegion.ts usePanelLanguages).
 */
export const LOCALE_CHOICE_KEY = 'app-locale-choice';

function storedLocale(key: string): Locale | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === 'en' || stored === 'fa' || stored === 'tr' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The language someone picked in this browser, or null when nobody did.
 *
 * Before LOCALE_CHOICE_KEY existed, `app-locale` was all there was. In the
 * International edition it was written by its language switchers, so it is
 * still taken as a pick. The Iranian edition had no switcher until the
 * dashboard's languages became a Super Admin setting (2026-10-31): what
 * `app-locale` holds there was written by the old region lock, never picked,
 * and it must not outrank the default the Super Admin chooses.
 */
export function getChosenLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  const choice = storedLocale(LOCALE_CHOICE_KEY);
  if (choice) return choice;
  return cachedEdition() === 'international' ? storedLocale(LOCALE_STORAGE_KEY) : null;
}
