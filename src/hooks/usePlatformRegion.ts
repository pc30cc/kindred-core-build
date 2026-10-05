/**
 * Reads the platform-wide region/country mode and enforces it on the UI:
 * only the allowed languages are selectable, and the active locale is forced
 * back to the region language when it drifts out of range.
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useI18n } from '@/i18n';
import type { Locale } from '@/i18n/config';
import {
  allowedLocalesFor,
  displayCurrency,
  getCachedRegionMode,
  isRegionMode,
  setCachedRegionMode,
  type RegionMode,
} from '@/lib/region';

export function usePlatformRegionSettings() {
  return useQuery({
    queryKey: ['platform_region_settings'],
    queryFn: async () => {
      // A failed read falls back to the defaults below, as it always did.
      const data = await fetchPlatformPublicConfig().then((c) => c.region, () => null);
      const mode: RegionMode = isRegionMode((data as any)?.region_mode) ? (data as any).region_mode : 'multi';
      setCachedRegionMode(mode);
      return {
        mode,
        activeLocales: ((data as any)?.active_locales ?? null) as string[] | null,
        defaultLocale: ((data as any)?.default_locale ?? 'en') as string,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function usePlatformRegion() {
  const { data } = usePlatformRegionSettings();
  const { locale, setLocale } = useI18n();
  const mode: RegionMode = data?.mode ?? getCachedRegionMode();

  const allowedLocales = useMemo(
    () => allowedLocalesFor(mode, data?.activeLocales),
    [mode, data?.activeLocales],
  );

  // Hard enforcement: a locale outside the region can never stay active.
  useEffect(() => {
    if (!allowedLocales.length) return;
    if (!allowedLocales.includes(locale)) setLocale(allowedLocales[0] as Locale);
  }, [allowedLocales, locale, setLocale]);

  return {
    mode,
    allowedLocales,
    /** Single-language region → no language picker at all. */
    canSwitchLanguage: allowedLocales.length > 1,
    currency: displayCurrency(mode, locale),
  };
}
