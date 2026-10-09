/**
 * The platform's edition on the client (shared/edition.ts): `iran` iff
 * `platform_settings.region_mode = 'iran'` (WebYar), else `international`
 * (RESPOK). It comes from the public config (GET /api/platform/public/config)
 * and is kept in localStorage (`wy-edition`) so the first paint — and
 * index.html's boot script, which reads the same key — already knows it.
 *
 * Until the edition is known (a browser that never loaded the config, a
 * failed read) the app behaves as it always did — the Iranian look and money —
 * except where a hint says otherwise (see cachedEdition). A failed read never
 * overwrites a known edition.
 */
import {
  EDITION_PROFILE,
  currencyForEditionRegion,
  parseEdition,
  parseRegionMode,
  resolveEdition,
  type Edition,
  type RegionCurrency,
  type RegionMode,
} from '../../shared/edition';

export { EDITION_PROFILE, parseEdition, resolveEdition, type Edition };

/** Read by index.html's boot script too: keep the name in step. */
export const EDITION_CACHE_KEY = 'wy-edition';
/** Older caches used as hints before the first `wy-edition` is written. */
const REGION_MODE_CACHE_KEY = 'platform-region-mode';
const SITE_MODE_CACHE_KEY = 'wy-site-mode';

function read(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The edition this browser last saw, or null when it never saw one. Before
 * the first `wy-edition` is written, a cached `iran` region mode means the
 * Iranian edition and a cached multi-language site mode the International
 * one (RESPOK browsers from before editions existed).
 */
export function cachedEdition(): Edition | null {
  const stored = parseEdition(read(EDITION_CACHE_KEY));
  if (stored) return stored;
  if (read(REGION_MODE_CACHE_KEY) === 'iran') return 'iran';
  if (read(SITE_MODE_CACHE_KEY) === 'multi_language') return 'international';
  return null;
}

let known: Edition | null = null;

/** Called once the public config has arrived: remembers the edition for the next first paint. */
export function rememberEdition(edition: Edition): void {
  known = edition;
  try {
    window.localStorage.setItem(EDITION_CACHE_KEY, edition);
  } catch {
    /* storage unavailable: the next first paint just does not know it yet */
  }
}

/** The edition as far as this page knows it: the config's, else the cache's, else null. */
export function knownEdition(): Edition | null {
  return known ?? cachedEdition();
}

/**
 * The edition money helpers outside React use (e.g. a default currency).
 * Unknown reads as `iran` — the behaviour from before editions existed.
 */
export function currentEdition(): Edition {
  return knownEdition() ?? 'iran';
}

let knownRegionMode: RegionMode | null = null;

/**
 * Called once the public config has arrived: remembers the raw region mode
 * (the same `platform-region-mode` cache src/lib/region.ts keeps) so money
 * helpers outside React know the region's currency.
 */
export function rememberRegionMode(mode: unknown): void {
  knownRegionMode = parseRegionMode(mode);
  try {
    window.localStorage.setItem(REGION_MODE_CACHE_KEY, knownRegionMode);
  } catch {
    /* storage unavailable */
  }
}

/** The region mode as far as this page knows it, or null. */
export function knownRegionModeOrNull(): RegionMode | null {
  if (knownRegionMode) return knownRegionMode;
  const cached = read(REGION_MODE_CACHE_KEY);
  return cached ? parseRegionMode(cached) : null;
}

/**
 * The currency money shows and is charged in when a record names none
 * (shared/edition.ts currencyForEditionRegion): IRR in the Iranian edition,
 * TRY on a Turkish-only site, USD in Multi Region and Global.
 */
export function currentCurrency(): RegionCurrency {
  return currencyForEditionRegion(currentEdition(), knownRegionModeOrNull() ?? 'multi');
}

/** The platform's default language (platform_settings.default_locale), as index.html's boot script and the public config cached it. */
export const DEFAULT_LOCALE_CACHE_KEY = 'wy-default-locale';

export function cachedPlatformDefaultLocale(): string | null {
  return read(DEFAULT_LOCALE_CACHE_KEY);
}

/** Called once the public config has arrived: remembers the platform's default language. */
export function rememberPlatformDefaultLocale(locale: unknown): void {
  if (typeof locale !== 'string' || !locale) return;
  try {
    window.localStorage.setItem(DEFAULT_LOCALE_CACHE_KEY, locale);
  } catch {
    /* storage unavailable */
  }
}

/** Test-only: forget the in-memory edition. */
export function __resetEditionForTests(): void {
  known = null;
  knownRegionMode = null;
}
