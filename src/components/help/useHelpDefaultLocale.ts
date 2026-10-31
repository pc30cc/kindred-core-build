/**
 * The language the platform's public help center (app.* /help) opens in:
 * the platform's default language kept inside the VISITORS' languages
 * (src/lib/region.ts allowedLocalesFor; Iran: Persian only). The default is
 * the dashboard's too (shared/panelLanguages.ts), and a WebYar dashboard the
 * Super Admin opened to English must not send visitors to /help/en. The
 * server's own help center does the same (server/routes/kb.ts
 * loadDefaultLocale).
 *
 * It waits for the platform's settings: before they arrive it gives null
 * (nothing is drawn), and if they cannot be read it falls back to the
 * region this browser last saw (Iran: Persian; unknown: English).
 */
import { usePlatformRegionSettings } from '@/hooks/usePlatformRegion';
import { allowedLocalesFor, getCachedRegionMode } from '@/lib/region';
import type { Locale } from '@/i18n/config';

export function useHelpDefaultLocale(): Locale | null {
  const { data, isError } = usePlatformRegionSettings();
  if (!data && !isError) return null;
  const visitors = allowedLocalesFor(data?.mode ?? getCachedRegionMode(), data?.activeLocales);
  const wanted = data?.defaultLocale;
  return visitors.find((l) => l === wanted) ?? visitors[0] ?? 'en';
}
