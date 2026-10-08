/**
 * International mode on the client: the platform's site mode
 * (`platform_settings.site_mode`, from the public config) is multi_language
 * (RESPOK) and the UI is not in Persian. Only then does the app wear the
 * RESPOK brand kit: its logos and icons (INTL_BRAND, public/brand/intl/),
 * the Art colour scheme `respok`, and that scheme on the sign-in pages. In
 * Persian, and on a single-language site (WebYar), nothing changes.
 *
 * The last site mode seen is kept in localStorage (`wy-site-mode`) so the first
 * paint, before the public config arrives (and index.html's boot splash,
 * which reads the same key), already knows it.
 */
import { useEffect } from 'react';
import { useI18n } from '@/i18n';
import { usePlatformPublicConfig } from '@/lib/platformPublicConfig';
import { INTL_BRAND, isInternationalMode, resolveSiteMode, type SiteMode } from '../../shared/internationalMode';

export { INTL_BRAND, isInternationalMode, resolveSiteMode, type SiteMode };

/** Read by index.html's boot splash too: keep the name in step. */
export const SITE_MODE_CACHE_KEY = 'wy-site-mode';

/** The site mode this browser last saw (single_language when it never saw one). */
export function cachedSiteMode(): SiteMode {
  try {
    return resolveSiteMode(window.localStorage.getItem(SITE_MODE_CACHE_KEY));
  } catch {
    return 'single_language';
  }
}

function rememberSiteMode(mode: SiteMode) {
  try {
    window.localStorage.setItem(SITE_MODE_CACHE_KEY, mode);
  } catch {
    /* storage unavailable: the next first paint just does not know it yet */
  }
}

/** The platform's site mode: the public config once it has arrived, the cache before. */
export function useSiteMode(): SiteMode {
  const { data } = usePlatformPublicConfig();
  const mode = data ? resolveSiteMode(data.region?.site_mode) : cachedSiteMode();
  useEffect(() => {
    if (data) rememberSiteMode(mode);
  }, [data, mode]);
  return mode;
}

/** True in international mode (multi_language, and the UI is not in Persian). */
export function useInternationalMode(): boolean {
  const { locale } = useI18n();
  return isInternationalMode(useSiteMode(), locale);
}
