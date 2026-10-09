/**
 * DESKTOP APP (WINDOWS) PLATFORM SETTINGS.
 *
 * The edition's `desktop_app_settings` row (one per edition, migration 257;
 * server/services/editionSettings.ts) is the one source of truth for where
 * the desktop app looks for updates and how it tunes itself at runtime. It
 * is read by:
 *   • Super Admin → Desktop app (server/routes/adminDesktopApp.ts),
 *   • GET /api/platform/desktop-app (server/routes/desktopAppPublic.ts),
 *     which the desktop app asks on every launch.
 *
 * Nothing about the WEB build reads this row — a deployment that never ships
 * a desktop app is unaffected by every value here.
 *
 * Never throws: a missing row, a read failure or an edition that cannot be
 * told resolves to the edition's defaults (DEFAULTS in Iran, which reproduce
 * the values the desktop app used before this table existed; RESPOK's feed
 * abroad).
 */
import type { ServerConfig } from '../../config.js';
import type { Edition } from '../../../shared/edition.js';
import { NATIVE_APP_BRANDS, pointsAtWebyar } from '../../../shared/nativeAppBrands.js';
import { getPlatformEditionOrNull } from '../platformRegion.js';
import { editionSettingsRow } from '../editionSettings.js';

export type DesktopUpdateChannel = 'stable' | 'beta';

export interface DesktopAppSettings {
  /// electron-updater generic feed: must serve the installer AND latest.yml.
  update_feed_url: string | null;
  update_channel: DesktopUpdateChannel;
  latest_version: string | null;
  minimum_supported_version: string | null;
  download_url: string | null;
  release_notes: string | null;
  auto_update_enabled: boolean;
  update_check_interval_minutes: number;

  realtime_enabled: boolean;
  /// Polling cadence when realtime is down (or disabled).
  poll_interval_seconds: number;
  /// Safety-net polling while realtime is connected.
  poll_interval_realtime_seconds: number;
  calls_enabled: boolean;
  /// Whether the app shows its Settings → Storage section. Hidden, the cache still works.
  storage_settings_visible: boolean;
  /// Sections Super Admin can switch off in the app, on top of each workspace's plan.
  contacts_enabled: boolean;
  visitors_enabled: boolean;
  analytics_enabled: boolean;
  call_center_enabled: boolean;

  updated_at?: string | null;
}

export const DESKTOP_APP_DEFAULT_FEED_URL = NATIVE_APP_BRANDS.iran.windowsFeedUrl;

export const DESKTOP_APP_DEFAULTS: DesktopAppSettings = {
  update_feed_url: DESKTOP_APP_DEFAULT_FEED_URL,
  update_channel: 'stable',
  latest_version: null,
  minimum_supported_version: null,
  download_url: null,
  release_notes: null,
  auto_update_enabled: true,
  update_check_interval_minutes: 240,

  realtime_enabled: true,
  poll_interval_seconds: 15,
  poll_interval_realtime_seconds: 120,
  calls_enabled: true,
  storage_settings_visible: true,
  contacts_enabled: true,
  visitors_enabled: true,
  analytics_enabled: true,
  call_center_enabled: true,

  updated_at: null,
};

/** Same bounds as the CHECK constraints in migration 207. */
export const DESKTOP_APP_BOUNDS = {
  update_check_interval_minutes: { min: 15, max: 1440 },
  poll_interval_seconds: { min: 5, max: 300 },
  poll_interval_realtime_seconds: { min: 15, max: 900 },
} as const;

const CACHE_TTL_MS = 30_000;
/** Memoized per edition: a switch of edition reads that edition's row at once. */
let cache: { edition: Edition | null; value: DesktopAppSettings; ts: number } | null = null;

/** Test/route seam: drop the memoized row after a write. */
export function invalidateDesktopAppSettingsCache(): void {
  cache = null;
}

export async function loadDesktopAppSettings(config: ServerConfig): Promise<DesktopAppSettings> {
  const edition = await getPlatformEditionOrNull(config);
  const now = Date.now();
  if (cache && cache.edition === edition && now - cache.ts < CACHE_TTL_MS) return cache.value;

  // While the edition cannot be told, neither can its row: the defaults.
  let value = desktopAppDefaults(edition);
  if (edition) {
    try {
      const { data, error } = await editionSettingsRow(config, 'desktop_app_settings', edition);
      if (!error && data) value = desktopSettingsForEdition(normalize(data as Record<string, unknown>), edition);
    } catch {
      // A deployment that has not applied migration 207 yet still boots.
    }
  }
  cache = { edition, value, ts: now };
  return value;
}

/** The default update feed of an edition: WebYar's in Iran (and when unknown), RESPOK's abroad. */
export function desktopDefaultFeedUrl(edition: Edition | null): string {
  return edition === 'international' ? NATIVE_APP_BRANDS.international.windowsFeedUrl : DESKTOP_APP_DEFAULT_FEED_URL;
}

/** What an edition that has no row yet is served: DEFAULTS in Iran (and when unknown), with RESPOK's feed abroad. */
export function desktopAppDefaults(edition: Edition | null): DesktopAppSettings {
  return desktopSettingsForEdition(DESKTOP_APP_DEFAULTS, edition);
}

/**
 * The columns an edition's first row is created with where its defaults
 * differ from the table's own (WebYar's): RESPOK's feed abroad, nothing in Iran.
 */
export function desktopInsertDefaults(edition: Edition): Partial<DesktopAppSettings> {
  return edition === 'international' ? { update_feed_url: desktopDefaultFeedUrl(edition) } : {};
}

/**
 * The settings as this edition's app may use them. The Iranian edition (or an
 * unknown one) gets them untouched. In the International edition the RESPOK
 * app is served nothing of WebYar's: a feed that still points at WebYar (a
 * database cloned from WebYar's, or the default) becomes RESPOK's, and a
 * download link or release notes naming WebYar are dropped. Saving the
 * Super Admin page then stores the clean values.
 */
export function desktopSettingsForEdition(s: DesktopAppSettings, edition: Edition | null): DesktopAppSettings {
  if (edition !== 'international') return s;
  const out = { ...s };
  if (pointsAtWebyar(out.update_feed_url)) out.update_feed_url = desktopDefaultFeedUrl(edition);
  if (pointsAtWebyar(out.download_url)) out.download_url = null;
  if (pointsAtWebyar(out.release_notes)) out.release_notes = null;
  return out;
}

function boundedInt(raw: unknown, key: keyof typeof DESKTOP_APP_BOUNDS): number {
  const n = Number(raw);
  const { min, max } = DESKTOP_APP_BOUNDS[key];
  if (!Number.isFinite(n)) return DESKTOP_APP_DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Fills every missing field from DEFAULTS so callers never see undefined. */
export function normalize(row: Record<string, unknown>): DesktopAppSettings {
  const out = { ...DESKTOP_APP_DEFAULTS } as Record<string, unknown>;
  for (const key of Object.keys(DESKTOP_APP_DEFAULTS) as (keyof DesktopAppSettings)[]) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    out[key] = raw;
  }
  // Nullable text columns: an explicit null is a real value, not "missing".
  for (const key of ['latest_version', 'minimum_supported_version', 'download_url', 'release_notes'] as const) {
    out[key] = typeof row[key] === 'string' && (row[key] as string).trim() ? row[key] : null;
  }
  // An empty feed URL would leave the updater with nowhere to look.
  out.update_feed_url =
    typeof row.update_feed_url === 'string' && row.update_feed_url.trim()
      ? row.update_feed_url
      : DESKTOP_APP_DEFAULTS.update_feed_url;
  out.update_channel = row.update_channel === 'beta' ? 'beta' : 'stable';
  for (const key of Object.keys(DESKTOP_APP_BOUNDS) as (keyof typeof DESKTOP_APP_BOUNDS)[]) {
    out[key] = row[key] === undefined || row[key] === null ? DESKTOP_APP_DEFAULTS[key] : boundedInt(row[key], key);
  }
  for (const key of [
    'auto_update_enabled', 'realtime_enabled', 'calls_enabled', 'storage_settings_visible',
    'contacts_enabled', 'visitors_enabled', 'analytics_enabled', 'call_center_enabled',
  ] as const) {
    out[key] = typeof row[key] === 'boolean' ? row[key] : DESKTOP_APP_DEFAULTS[key];
  }
  out.updated_at = (row.updated_at as string | null) ?? null;
  return out as unknown as DesktopAppSettings;
}

/**
 * The shape the desktop app reads from GET /api/platform/desktop-app. ONLY
 * non-secret, client-relevant fields — nothing about who configured what.
 */
export interface DesktopAppPublicConfig {
  update: {
    feedUrl: string | null;
    channel: DesktopUpdateChannel;
    latestVersion: string | null;
    minimumSupportedVersion: string | null;
    downloadUrl: string | null;
    releaseNotes: string | null;
    autoUpdate: boolean;
    checkIntervalMinutes: number;
  };
  realtime: { enabled: boolean };
  polling: { intervalSeconds: number; withRealtimeSeconds: number };
  features: {
    calls: boolean;
    storageSettings: boolean;
    contacts: boolean;
    visitors: boolean;
    analytics: boolean;
    callCenter: boolean;
  };
}

export function toPublicDesktopAppConfig(s: DesktopAppSettings): DesktopAppPublicConfig {
  return {
    update: {
      feedUrl: s.update_feed_url,
      channel: s.update_channel,
      latestVersion: s.latest_version,
      minimumSupportedVersion: s.minimum_supported_version,
      downloadUrl: s.download_url,
      releaseNotes: s.release_notes,
      autoUpdate: s.auto_update_enabled,
      checkIntervalMinutes: s.update_check_interval_minutes,
    },
    realtime: { enabled: s.realtime_enabled },
    polling: {
      intervalSeconds: s.poll_interval_seconds,
      withRealtimeSeconds: s.poll_interval_realtime_seconds,
    },
    features: {
      calls: s.calls_enabled,
      storageSettings: s.storage_settings_visible,
      contacts: s.contacts_enabled,
      visitors: s.visitors_enabled,
      analytics: s.analytics_enabled,
      callCenter: s.call_center_enabled,
    },
  };
}
