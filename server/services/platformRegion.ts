/**
 * Server-side mirror of src/lib/region.ts — the platform-wide region/
 * language lock (`platform_settings.region_mode` / `active_locales`).
 *
 * The admin panel already hides language pickers outside the active
 * region, but that's a client-side-only convention: nothing server-side
 * previously clamped which locale gets used when a visitor's browser
 * negotiates a language the platform doesn't actually offer (e.g. a
 * Persian-only deployment still handing a Turkish visitor a Turkish
 * template because nothing told the AI intro logic the platform is
 * locked to fa). This gives server code the same "allowed locales" used
 * to gate the admin UI, so runtime text generation can clamp to it too.
 */
import { getServiceClient } from '../supabase.js';
import type { ServerConfig } from '../config.js';

type RegionMode = 'multi' | 'iran' | 'turkey' | 'global';

const REGION_LOCALES: Record<RegionMode, string[]> = {
  multi: ['en', 'fa', 'tr'],
  iran: ['fa'],
  turkey: ['tr'],
  global: ['en'],
};
const VALID_MODES = new Set<string>(Object.keys(REGION_LOCALES));
const SUPPORTED_LOCALES = ['en', 'fa', 'tr'];

const CACHE_TTL_MS = 60_000;
let cache: { value: string[]; ts: number } | null = null;

export async function getPlatformAllowedLocales(config: ServerConfig): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_settings')
      .select('region_mode, active_locales')
      .limit(1)
      .maybeSingle();

    const mode: RegionMode = VALID_MODES.has((data as any)?.region_mode) ? (data as any).region_mode : 'multi';
    let allowed: string[];
    if (mode !== 'multi') {
      allowed = REGION_LOCALES[mode];
    } else {
      const active = (((data as any)?.active_locales as string[] | null) || []).filter((l) => SUPPORTED_LOCALES.includes(l));
      allowed = active.length ? active : SUPPORTED_LOCALES;
    }
    cache = { value: allowed, ts: now };
    return allowed;
  } catch {
    cache = { value: SUPPORTED_LOCALES, ts: now };
    return SUPPORTED_LOCALES;
  }
}

/**
 * Clamps a visitor-reported locale to one the platform actually offers.
 * On a single-language platform this always returns that one locale,
 * regardless of what the visitor's browser/session negotiated.
 */
export async function clampLocaleToPlatformRegion(
  config: ServerConfig,
  locale: string | undefined | null,
): Promise<string | undefined> {
  const allowed = await getPlatformAllowedLocales(config);
  if (!allowed.length) return locale ?? undefined;
  const normalized = (locale || '').toLowerCase().split('-')[0];
  if (allowed.includes(normalized)) return normalized;
  return allowed[0];
}

/** Test-only — reset the in-memory cache. */
export function __resetPlatformRegionCache(): void {
  cache = null;
}
