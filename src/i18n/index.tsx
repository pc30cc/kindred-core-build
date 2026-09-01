import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { Locale, Direction } from './config';
import { DEFAULT_LOCALE, LOCALE_CONFIG, DEFAULT_FALLBACK_CHAINS } from './config';
import en, { type TranslationKeys } from './locales/en';
import { loadFontsForLocale } from '@/lib/fonts';
import { installPersianDigits, uninstallPersianDigits } from '@/lib/persian-digits';
import { installLocalizedDateDefaults, setAppDateLocale } from '@/lib/date';

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

interface I18nContextValue {
  locale: Locale;
  dir: Direction;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
  isLoading: boolean;
}

const i18nFallbackContext: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  dir: LOCALE_CONFIG[DEFAULT_LOCALE].dir,
  setLocale: () => {},
  t: (key) => key,
  isLoading: false,
};

const I18nContext = createContext<I18nContextValue>(i18nFallbackContext);

export function getStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const stored = localStorage.getItem('app-locale');
  if (stored && (stored === 'en' || stored === 'fa' || stored === 'tr')) return stored as Locale;
  return DEFAULT_LOCALE;
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

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('app-locale', newLocale);
  }, []);

  useEffect(() => {
    if (initialTranslations && locale === initialLocale) {
      setTranslations(initialTranslations);
      setIsLoading(false);
      return;
    }

    void loadLocale(locale);
  }, [initialLocale, initialTranslations, loadLocale, locale]);

  const t = useCallback((key: TranslationKey, params?: Record<string, string>): string => {
    let value = getNestedValue(translations as unknown as Record<string, unknown>, key);
    if (value === key) {
      value = getNestedValue(fallbackTranslations as unknown as Record<string, unknown>, key);
    }
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        value = value.replace(`{{${k}}}`, v);
      });
    }
    return value;
  }, [translations, fallbackTranslations]);

  // Block rendering until translations are loaded to prevent flash
  if (isLoading) {
    return null;
  }

  return (
    <I18nContext.Provider value={{ locale, dir, setLocale, t, isLoading }}>
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
