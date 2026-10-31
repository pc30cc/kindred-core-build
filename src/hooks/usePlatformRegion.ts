/**
 * The platform-wide region/country mode and the languages that follow from
 * it, in two sets that differ only in the Iranian edition:
 *
 *   - usePanelLanguages(): the DASHBOARD's own languages
 *     (shared/panelLanguages.ts) — the language switchers, the operator's
 *     preferred language, and the language the panel opens in. A WebYar
 *     (`iran`) panel may be English or Turkish too, by default and with or
 *     without a switcher, and stays WebYar.
 *   - usePlatformRegion().allowedLocales: the languages of what VISITORS and
 *     customers read (widget, AI texts, knowledge base, canned responses,
 *     Telegram), the server's getPlatformAllowedLocales: Persian only in
 *     `iran`, as before.
 *
 * The active UI language is kept inside the panel's languages: one outside
 * them is switched to the panel's default, and a browser where nobody picked
 * a language follows the default when the Super Admin changes it. The native
 * (Capacitor) app keeps its own rule: only a language outside them is
 * switched, to the default, which is then kept as its choice.
 *
 * Only the platform's own settings move the language: a failed read never
 * does (see usePlatformRegionSettings).
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useI18n } from '@/i18n';
import { getChosenLocale, type Locale } from '@/i18n/config';
import { isNativePlatform } from '@/lib/native';
import {
  allowedLocalesFor,
  displayCurrency,
  getCachedRegionMode,
  isRegionMode,
  setCachedRegionMode,
  type RegionMode,
} from '@/lib/region';
import { panelLanguagesFor, type PanelLanguages } from '../../shared/panelLanguages';

/** The platform's region and language settings, as GET /api/platform/public/config serves them. */
export interface PlatformRegionSettings {
  mode: RegionMode;
  activeLocales: string[] | null;
  defaultLocale: string;
  siteMode: string | null;
}

export function usePlatformRegionSettings() {
  return useQuery({
    queryKey: ['platform_region_settings'],
    queryFn: async (): Promise<PlatformRegionSettings> => {
      // A failed read fails the query: React Query keeps the last good
      // settings through a failed refetch, and before any good read `data`
      // stays empty, so callers use the cached region's guess and the panel
      // language guard waits. It used to resolve made-up defaults (`multi`,
      // English) that read as the platform's own settings, and cached `multi`.
      // A read without a settings row is real: the column default, `multi`.
      const data = (await fetchPlatformPublicConfig()).region;
      const mode: RegionMode = isRegionMode(data?.region_mode) ? (data.region_mode as RegionMode) : 'multi';
      try {
        setCachedRegionMode(mode);
      } catch {
        /* storage full or blocked: the settings still apply to this page */
      }
      return {
        mode,
        activeLocales: data?.active_locales ?? null,
        defaultLocale: data?.default_locale ?? 'en',
        siteMode: data?.site_mode ?? null,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export interface PanelLanguagesInfo extends PanelLanguages {
  /**
   * True once the platform's own settings are in; before (and while every
   * read so far has failed), the cached region's guess, which the guard
   * never acts on.
   */
  ready: boolean;
}

/**
 * The dashboard's languages (shared/panelLanguages.ts), and the guard that
 * keeps the active UI language inside them. The guard acts only on the
 * platform's own settings (the last good read), never on the cached guess
 * before them or on a failed read.
 */
export function usePanelLanguages(): PanelLanguagesInfo {
  const { data } = usePlatformRegionSettings();
  const i18n = useI18n();
  const { locale, setLocale } = i18n;
  // The language picked in this session (I18nProvider keeps it even when
  // the browser could not store it); a stand-in context may not carry it.
  const sessionChoice: Locale | null = i18n.chosenLocale ?? null;

  const panel = useMemo(
    () =>
      panelLanguagesFor(
        data
          ? { region_mode: data.mode, active_locales: data.activeLocales, default_locale: data.defaultLocale, site_mode: data.siteMode }
          : { region_mode: getCachedRegionMode() },
      ),
    [data],
  );

  useEffect(() => {
    if (!data) return;
    if (isNativePlatform()) {
      // The native app opens in English (getSiteDefaultLocale), so it keeps
      // the rule it always had: a language outside the panel's gives way to
      // the default, which is kept, and it reopens in it.
      if (!panel.locales.includes(locale)) setLocale(panel.defaultLocale);
      return;
    }
    const chosen = sessionChoice ?? getChosenLocale();
    // A language the panel does not offer (or no longer does) gives way to
    // the default, and a kept choice of it is forgotten. A browser where
    // nobody picked one follows the default, so changing it in Super Admin
    // reaches everyone who did not choose otherwise.
    if (!panel.locales.includes(locale) || (!chosen && locale !== panel.defaultLocale)) {
      setLocale(panel.defaultLocale, { remember: false });
    } else if (chosen && !panel.locales.includes(chosen)) {
      setLocale(locale, { remember: false });
    }
  }, [data, panel, locale, setLocale, sessionChoice]);

  return { ...panel, ready: !!data };
}

export function usePlatformRegion() {
  const { data } = usePlatformRegionSettings();
  const { locale } = useI18n();
  const mode: RegionMode = data?.mode ?? getCachedRegionMode();
  // Every screen that reads the region keeps the UI language in range, as
  // it always did; the range is the panel's languages.
  usePanelLanguages();

  const allowedLocales = useMemo(
    () => allowedLocalesFor(mode, data?.activeLocales),
    [mode, data?.activeLocales],
  );

  return {
    mode,
    /** The languages of what visitors and customers read (Persian only in `iran`). */
    allowedLocales,
    /** More than one such language: the content screens show their language tabs and fields. */
    canSwitchLanguage: allowedLocales.length > 1,
    currency: displayCurrency(mode, locale as Locale),
  };
}
