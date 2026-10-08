/**
 * International mode on the client: the platform is the International
 * edition (shared/edition.ts — `platform_settings.region_mode` is not
 * `'iran'`, RESPOK). There the app wears the RESPOK brand kit in every
 * language, Persian included: its logos and icons (INTL_BRAND,
 * public/brand/intl/), the Art colour scheme `respok`, and that scheme on the
 * sign-in pages. Persian in the International edition is only right-to-left
 * Persian text. The Iranian edition (WebYar) never changes.
 *
 * The edition last seen is kept in localStorage (`wy-edition`,
 * src/lib/edition.ts) so the first paint, before the public config arrives
 * (and index.html's boot splash, which reads the same key), already knows it.
 * Until it is known nothing changes.
 *
 * The site mode (`platform_settings.site_mode`) is still cached under
 * `wy-site-mode`: older RESPOK browsers use it as a hint for the edition.
 */
import { useEffect } from 'react';
import { usePlatformPublicConfig } from '@/lib/platformPublicConfig';
import { useKnownEdition } from '@/hooks/useEdition';
import { INTL_BRAND, isInternationalMode, resolveSiteMode, type SiteMode } from '../../shared/internationalMode';

export { INTL_BRAND, isInternationalMode, resolveSiteMode, type SiteMode };
export { EDITION_CACHE_KEY } from '@/lib/edition';

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

/** True in the International edition, in every UI language (Persian included). */
export function useInternationalMode(): boolean {
  return isInternationalMode(useKnownEdition());
}
