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
 * a language follows the default when the Super Admin changes it.
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useI18n } from '@/i18n';
import { getChosenLocale, type Locale } from '@/i18n/config';
import {
  allowedLocalesFor,
  displayCurrency,
  getCachedRegionMode,
  isRegionMode,
  setCachedRegionMode,
  type RegionMode,
} from '@/lib/region';
import { panelLanguagesFor, type PanelLanguages } from '../../shared/panelLanguages';

export function usePlatformRegionSettings() {
  return useQuery({
    queryKey: ['platform_region_settings'],
    queryFn: async () => {
      // A failed read falls back to the defaults below, as it always did.
      const data = await fetchPlatformPublicConfig().then((c) => c.region, () => null);
      const mode: RegionMode = isRegionMode(data?.region_mode) ? (data.region_mode as RegionMode) : 'multi';
      setCachedRegionMode(mode);
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
  /** True once the platform's own settings are in (before, the cached region's guess). */
  ready: boolean;
}

/**
 * The dashboard's languages (shared/panelLanguages.ts), and the guard that
 * keeps the active UI language inside them. The guard acts only once the
 * platform's settings have arrived, never on the cached guess before them.
 */
export function usePanelLanguages(): PanelLanguagesInfo {
  const { data } = usePlatformRegionSettings();
  const { locale, setLocale } = useI18n();

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
    const chosen = getChosenLocale();
    // A language the panel does not offer (or no longer does) gives way to
    // the default, and a kept choice of it is forgotten. A browser where
    // nobody picked one follows the default, so changing it in Super Admin
    // reaches everyone who did not choose otherwise.
    if (!panel.locales.includes(locale) || (!chosen && locale !== panel.defaultLocale)) {
      setLocale(panel.defaultLocale, { remember: false });
    } else if (chosen && !panel.locales.includes(chosen)) {
      setLocale(locale, { remember: false });
    }
  }, [data, panel, locale, setLocale]);

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
