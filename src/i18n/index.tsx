import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { Locale, Direction } from './config';
import { DEFAULT_LOCALE, LOCALE_CONFIG, DEFAULT_FALLBACK_CHAINS } from './config';
import en, { type TranslationKeys } from './locales/en';
import { loadFontsForLocale } from '@/lib/fonts';

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
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return path;
    current = (current as Record<string, unknown>)[key];
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

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const stored = localStorage.getItem('app-locale');
  if (stored && (stored === 'en' || stored === 'fa' || stored === 'tr')) return stored as Locale;
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);
  const [translations, setTranslations] = useState<TranslationKeys>(en);
  const [fallbackTranslations] = useState<TranslationKeys>(en);
  const [isLoading, setIsLoading] = useState(false);

  const dir = LOCALE_CONFIG[locale].dir;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    loadFontsForLocale(locale);
  }, [locale, dir]);

  const loadLocale = useCallback(async (newLocale: Locale) => {
    if (newLocale === 'en') {
      setTranslations(en);
      return;
    }
    setIsLoading(true);
    try {
      const mod = await localeModules[newLocale]();
      setTranslations(mod.default);
    } catch {
      setTranslations(en);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('app-locale', newLocale);
    loadLocale(newLocale);
  }, [loadLocale]);

  useEffect(() => {
    loadLocale(locale);
  }, []);

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

  return (
    <I18nContext.Provider value={{ locale, dir, setLocale, t, isLoading }}>
      {children}
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
