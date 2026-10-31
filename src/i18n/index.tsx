import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { DirectionProvider } from '@radix-ui/react-direction';
import { isNativePlatform } from '@/lib/native';

import type { Locale, Direction } from './config';
import { DEFAULT_LOCALE, LOCALE_CONFIG, DEFAULT_FALLBACK_CHAINS, LOCALE_STORAGE_KEY, getChosenLocale } from './config';
import en, { type TranslationKeys } from './locales/en';
import { loadFontsForLocale } from '@/lib/fonts';
import { installPersianDigits, uninstallPersianDigits } from '@/lib/persian-digits';
import { installLocalizedDateDefaults, setAppDateLocale } from '@/lib/date';
import { brandTokens, fillBrandTokens, useBrandVersion } from '@/lib/brand';
import { cachedEdition, cachedPlatformDefaultLocale } from '@/lib/edition';

const localeModules: Record<Locale, () => Promise<{ default: TranslationKeys }>> = {
  en: () => Promise.resolve({ default: en }),
  fa: () => import('./locales/fa'),
  tr: () => import('./locales/tr'),
};

type NestedKeyOf<T> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : K }[keyof T & string]
  : never;

export type TranslationKey = NestedKeyOf<TranslationKeys>;

function getNestedValue(obj: Record<string, unknown>, path: string): string {
  const keys = path.split('.');
  let current: unknown = obj;
  for (let i = 0; i < keys.length; i++) {
    if (current == null || typeof current !== 'object') return path;
    const obj = current as Record<string, unknown>;
    // Greedy match: try the longest remaining key as a literal property first.
    // This supports locale entries that store flat dotted keys (e.g.
    // `inbox: { 'callInvite.statusCancelled': '...' }`) alongside nested ones.
    let matched = false;
    for (let j = keys.length; j > i; j--) {
      const candidate = keys.slice(i, j).join('.');
      if (Object.prototype.hasOwnProperty.call(obj, candidate)) {
        current = obj[candidate];
        i = j - 1; // for-loop will increment to j
        matched = true;
        break;
      }
    }
    if (!matched) return path;
  }
  return typeof current === 'string' ? current : path;
}

export interface SetLocaleOptions {
  /**
   * false: switch without keeping it as this browser's choice, and forget a
   * choice kept before (in the browser and in this session), so the page
   * goes on following the platform's default language
   * (src/hooks/usePlatformRegion.ts usePanelLanguages). Default true: a
   * language someone picked is kept.
   */
  remember?: boolean;
}

interface I18nContextValue {
  locale: Locale;
  dir: Direction;
  setLocale: (locale: Locale, options?: SetLocaleOptions) => void;
  /**
   * The language picked in this session (setLocale without
   * `remember: false`), kept here even when the browser could not store it;
   * null when none was, or it was forgotten. A choice from an earlier
   * session is the browser's (getChosenLocale).
   */
  chosenLocale: Locale | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isLoading: boolean;
}

const i18nFallbackContext: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  dir: LOCALE_CONFIG[DEFAULT_LOCALE].dir,
  setLocale: () => {},
  chosenLocale: null,
  t: (key) => key,
  isLoading: false,
};

const I18nContext = createContext<I18nContextValue>(i18nFallbackContext);

/**
 * Configured SITE default language (deployment-level, no rebuild required):
 * `window.__APP_RUNTIME_CONFIG__.defaultLocale` in /runtime-config.js.
 * Browser language is deliberately NEVER consulted — the configured default
 * is the source of truth until the user picks a language in the selector.
 */
export function getSiteDefaultLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  // Native (iOS) app ships with English as its base language; once the
  // platform's settings are in, a language outside the panel's gives way to
  // its default, which is kept (src/hooks/usePlatformRegion.ts), and the
  // login screen and Settings offer the panel's other languages, if any.
  if (isNativePlatform()) return 'en';
  // Both editions start in the panel's default language (Super Admin →
  // Branding → Languages, shared/panelLanguages.ts, cached by index.html's
  // boot script and the public config). It never changes the brand: a WebYar
  // panel in English is still WebYar. The International edition never falls
  // back to the deployment file's Persian default; the Iranian edition —
  // and an edition not known yet — uses that file until the platform's
  // default is known, exactly as before.
  const edition = cachedEdition();
  const platformDefault = cachedPlatformDefaultLocale();
  if (edition === 'international') {
    return platformDefault === 'fa' || platformDefault === 'tr' ? platformDefault : 'en';
  }
  if (edition === 'iran' && (platformDefault === 'en' || platformDefault === 'fa' || platformDefault === 'tr')) {
    return platformDefault;
  }
  const configured = (window as Window & { __APP_RUNTIME_CONFIG__?: { defaultLocale?: unknown } }).__APP_RUNTIME_CONFIG__?.defaultLocale;
  if (configured === 'en' || configured === 'fa' || configured === 'tr') return configured as Locale;
  return DEFAULT_LOCALE;
}

export function getStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  return getChosenLocale() ?? getSiteDefaultLocale();
}


export async function loadLocaleMessages(locale: Locale): Promise<TranslationKeys> {
  if (locale === 'en') return en;

  try {
    const mod = await localeModules[locale]();
    return mod.default;
  } catch {
    return en;
  }
}

interface I18nProviderProps {
  children: React.ReactNode;
  initialLocale?: Locale;
  initialTranslations?: TranslationKeys;
}

export function I18nProvider({ children, initialLocale: initialLocaleProp, initialTranslations }: I18nProviderProps) {
  const initialLocale = initialLocaleProp ?? getStoredLocale();
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [chosenLocale, setChosenLocale] = useState<Locale | null>(null);
  const [translations, setTranslations] = useState<TranslationKeys>(initialTranslations ?? en);
  const [fallbackTranslations] = useState<TranslationKeys>(en);
  const [isLoading, setIsLoading] = useState(!initialTranslations && initialLocale !== 'en');

  const dir = LOCALE_CONFIG[locale].dir;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    loadFontsForLocale(locale);
    installLocalizedDateDefaults();
    setAppDateLocale(locale);
    if (locale === 'fa') installPersianDigits();
    else uninstallPersianDigits();
    return () => { if (locale === 'fa') uninstallPersianDigits(); };
  }, [locale, dir]);


  const loadLocale = useCallback(async (newLocale: Locale) => {
    setIsLoading(true);
    const messages = await loadLocaleMessages(newLocale);
    setTranslations(messages);
    setIsLoading(false);
  }, []);

  const setLocale = useCallback((newLocale: Locale, options?: SetLocaleOptions) => {
    const remember = options?.remember !== false;
    setLocaleState(newLocale);
    // In memory too: a pick the browser cannot store (storage full or
    // blocked) still holds for this session.
    setChosenLocale(remember ? newLocale : null);
    try {
      if (remember) localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
      else localStorage.removeItem(LOCALE_STORAGE_KEY);
    } catch {
      /* storage unavailable: the switch still applies to this page */
    }
  }, []);

  useEffect(() => {
    if (initialTranslations && locale === initialLocale) {
      setTranslations(initialTranslations);
      setIsLoading(false);
      return;
    }

    void loadLocale(locale);
  }, [initialLocale, initialTranslations, loadLocale, locale]);

  // The platform's brand in text (src/lib/brand.ts): the Iranian edition's
  // fixed WebYar strings, or the International platform's own name. A change
  // (the public config arriving) re-renders every translation.
  const brandVersion = useBrandVersion();

  const t = useCallback((key: TranslationKey, params?: Record<string, string | number>): string => {
    let value = getNestedValue(translations as unknown as Record<string, unknown>, key);
    if (value === key) {
      value = getNestedValue(fallbackTranslations as unknown as Record<string, unknown>, key);
    }
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        // Every occurrence: a text may use the same value twice.
        value = value.split(`{{${k}}}`).join(String(v));
      });
    }
    // Brand tokens ({{brand}}, {{supportEmail}}, …) the caller did not fill.
    return fillBrandTokens(value, brandTokens(locale));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- brandVersion invalidates the brand tokens
  }, [translations, fallbackTranslations, locale, brandVersion]);

  // Block rendering until translations are loaded to prevent flash
  if (isLoading) {
    return null;
  }

  return (
    <I18nContext.Provider value={{ locale, dir, setLocale, chosenLocale, t, isLoading }}>
      <DirectionProvider dir={dir}>{children}</DirectionProvider>
    </I18nContext.Provider>
  );

}

export function useI18n() {
  return useContext(I18nContext);
}

export function useTranslation() {
  const { t, locale, dir } = useI18n();
  return { t, locale, dir };
}
