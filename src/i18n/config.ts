import { cachedEdition } from '@/lib/edition';
import { isNativePlatform } from '@/lib/native';

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
 * The language this page was last shown in (I18nProvider writes it on every
 * change). index.html's title script, the build's locale preload
 * (vite.config.ts) and the Inbox read it. It does not say that someone
 * PICKED that language: LOCALE_CHOICE_KEY does.
 */
export const LOCALE_STORAGE_KEY = 'app-locale';

/**
 * The language someone picked themselves in a language switcher. Only an
 * explicit pick writes it (src/i18n setLocale without `remember: false`).
 * A pick outranks the platform's default language; nothing else does
 * (src/hooks/usePlatformRegion.ts usePanelLanguages).
 */
export const LOCALE_CHOICE_KEY = 'app-locale-choice';

/** Set once the `app-locale` kept before LOCALE_CHOICE_KEY existed has been read (migrateLegacyChoice). */
const LOCALE_CHOICE_MIGRATED_KEY = 'app-locale-choice-migrated';

function storedLocale(key: string): Locale | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === 'en' || stored === 'fa' || stored === 'tr' ? stored : null;
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: the next load decides again */
  }
}

/**
 * Once per browser: was the `app-locale` kept before LOCALE_CHOICE_KEY
 * existed (2026-10-31) a pick? It becomes one when it was:
 *   - the International edition (RESPOK) and the native shell always had
 *     language switchers, so what they kept was picked;
 *   - the Iranian edition (WebYar) had none until PR #376: its old region
 *     lock wrote Persian there, which must not outrank the Super Admin's
 *     default (owner, 2026-10-31: WebYar set to English stayed Persian).
 *     English or Turkish there could only come from #376's switcher, so
 *     those are picks; Persian is not.
 * An edition not known yet (a first visit) decides on a later load.
 */
function migrateLegacyChoice(): void {
  try {
    if (window.localStorage.getItem(LOCALE_CHOICE_MIGRATED_KEY) === '1') return;
  } catch {
    return;
  }
  if (storedLocale(LOCALE_CHOICE_KEY)) {
    store(LOCALE_CHOICE_MIGRATED_KEY, '1');
    return;
  }
  const legacy = storedLocale(LOCALE_STORAGE_KEY);
  const edition = cachedEdition();
  if (legacy && !edition && !isNativePlatform()) return;
  if (legacy && (edition === 'international' || isNativePlatform() || legacy !== 'fa')) {
    store(LOCALE_CHOICE_KEY, legacy);
  }
  store(LOCALE_CHOICE_MIGRATED_KEY, '1');
}

/** The language someone picked in this browser, or null when nobody did. */
export function getChosenLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  migrateLegacyChoice();
  return storedLocale(LOCALE_CHOICE_KEY);
}
