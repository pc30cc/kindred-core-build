/**
 * The language the platform's public help center (app.* /help) opens in:
 * the platform's default language kept inside the VISITORS' languages
 * (src/lib/region.ts allowedLocalesFor; Iran: Persian only). The default is
 * the dashboard's too (shared/panelLanguages.ts), and a WebYar dashboard the
 * Super Admin opened to English must not send visitors to /help/en. The
 * server's own help center does the same (server/routes/kb.ts
 * loadDefaultLocale).
 *
 * A browser that has seen the platform answers at once from the region it
 * last saw (Iran: Persian); one that never has waits for the settings
 * (null: nothing is drawn), or, if they cannot be read, takes English.
 */
import { usePlatformRegionSettings } from '@/hooks/usePlatformRegion';
import { allowedLocalesFor } from '@/lib/region';
import { knownRegionModeOrNull } from '@/lib/edition';
import type { Locale } from '@/i18n/config';

export function useHelpDefaultLocale(): Locale | null {
  const { data, isError } = usePlatformRegionSettings();
  const cachedMode = knownRegionModeOrNull();
  if (!data && !isError && !cachedMode) return null;
  const visitors = allowedLocalesFor(data?.mode ?? cachedMode ?? 'multi', data?.activeLocales);
  // A tagged default ('fa-IR') reads as its language, as on the server.
  const wanted = String(data?.defaultLocale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return visitors.find((l) => l === wanted) ?? visitors[0] ?? 'en';
}
