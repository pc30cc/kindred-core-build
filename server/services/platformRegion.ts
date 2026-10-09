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
import { parseRegionMode, resolveEdition, type Edition, type RegionMode as SharedRegionMode } from '../../shared/edition.js';

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
/** A failed read is retried after this long (the edition keeps its last value meanwhile). */
const FAILURE_TTL_MS = 5_000;

interface RegionRow {
  region_mode?: unknown;
  active_locales?: unknown;
}

/**
 * One cached read of `platform_settings` serves the allowed locales and the
 * edition. `ok: false` marks a failed read: the locales then fall back to
 * every supported language (as they always did), while the edition keeps the
 * last value a successful read produced (`lastEdition`).
 */
let settings: { row: RegionRow | null; ok: boolean; ts: number } | null = null;
let inflight: Promise<{ row: RegionRow | null; ok: boolean; ts: number }> | null = null;
let lastEdition: Edition | null = null;
let lastRegionMode: SharedRegionMode | null = null;

async function readRegionSettings(config: Pick<ServerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>) {
  const now = Date.now();
  if (settings && now - settings.ts < (settings.ok ? CACHE_TTL_MS : FAILURE_TTL_MS)) return settings;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const sb = getServiceClient(config as ServerConfig);
      const { data, error } = await sb
        .from('platform_settings')
        .select('region_mode, active_locales')
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = (data as RegionRow | null) ?? null;
      // No row reads as the column default, `multi` — the International edition.
      lastEdition = resolveEdition(row?.region_mode ?? 'multi');
      lastRegionMode = parseRegionMode(row?.region_mode);
      settings = { row, ok: true, ts: Date.now() };
    } catch {
      settings = { row: null, ok: false, ts: Date.now() };
    }
    return settings;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function getPlatformAllowedLocales(config: ServerConfig): Promise<string[]> {
  const { row, ok } = await readRegionSettings(config);
  if (!ok) return SUPPORTED_LOCALES;
  const mode: RegionMode = VALID_MODES.has(row?.region_mode as string) ? (row!.region_mode as RegionMode) : 'multi';
  if (mode !== 'multi') return REGION_LOCALES[mode];
  const active = ((row?.active_locales as string[] | null) || []).filter((l) => SUPPORTED_LOCALES.includes(l));
  return active.length ? active : SUPPORTED_LOCALES;
}

/**
 * The platform could not tell its edition: the settings read failed and no
 * earlier read succeeded. Money paths (gateway lists, payments, invoices)
 * refuse with this rather than guess between Rial and dollars.
 */
export class EditionUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'EDITION_UNAVAILABLE';
  constructor() {
    super('platform edition unavailable: platform_settings could not be read');
    this.name = 'EditionUnavailableError';
  }
}

/**
 * The platform's edition (shared/edition.ts): `iran` iff
 * `platform_settings.region_mode = 'iran'`, otherwise `international`.
 * Shares the cached settings read with getPlatformAllowedLocales. On a read
 * error the last successfully read edition is kept; with none, this throws
 * EditionUnavailableError (HTTP 503) — never a guess.
 */
export async function getPlatformEdition(
  config: Pick<ServerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>,
): Promise<Edition> {
  await readRegionSettings(config);
  if (!lastEdition) throw new EditionUnavailableError();
  return lastEdition;
}

/**
 * The platform's region mode (`multi` for a missing row or an unknown value),
 * from the same cached read as getPlatformEdition, with the same failure
 * rule: the last successfully read value, else EditionUnavailableError.
 * Money paths use it for the region's currency (shared/edition.ts
 * editionCurrencyFor): IRR in `iran`, TRY in `turkey`, USD otherwise.
 */
export async function getPlatformRegionMode(
  config: Pick<ServerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>,
): Promise<SharedRegionMode> {
  await readRegionSettings(config);
  if (!lastRegionMode) throw new EditionUnavailableError();
  return lastRegionMode;
}

/** Like getPlatformEdition, but null instead of throwing (for non-money presentation such as icons). */
export async function getPlatformEditionOrNull(
  config: Pick<ServerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>,
): Promise<Edition | null> {
  try {
    return await getPlatformEdition(config);
  } catch {
    return null;
  }
}

/**
 * Drop the cached settings so the next read sees a Super Admin change
 * (PUT /api/admin/platform-settings). The last known edition stays as the
 * fallback for a failed re-read.
 */
export function invalidatePlatformRegionCache(): void {
  settings = null;
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

/** Test-only — reset the in-memory cache, including the last known edition. */
export function __resetPlatformRegionCache(): void {
  settings = null;
  inflight = null;
  lastEdition = null;
  lastRegionMode = null;
}

/**
 * Heuristic script check — used to reject stored strings that were written
 * in a language the platform no longer offers (e.g. a legacy Turkish intro
 * left in the DB on a Persian-only deployment).
 */
export function textMatchesLocale(text: string, locale: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  const persian = /[\u0600-\u06FF]/.test(t);
  const loc = (locale || '').toLowerCase().split('-')[0];
  if (loc === 'fa') return persian;
  // Latin-script locales must not be dominated by Arabic/Persian script.
  return !persian;
}
