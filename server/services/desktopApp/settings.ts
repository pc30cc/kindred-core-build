/**
 * DESKTOP APP (WINDOWS) PLATFORM SETTINGS.
 *
 * The singleton `desktop_app_settings` row is the one source of truth for
 * where the desktop app looks for updates and how it tunes itself at
 * runtime. It is read by:
 *   • Super Admin → Desktop app (server/routes/adminDesktopApp.ts),
 *   • GET /api/platform/desktop-app (server/routes/desktopAppPublic.ts),
 *     which the desktop app asks on every launch.
 *
 * Nothing about the WEB build reads this row — a deployment that never ships
 * a desktop app is unaffected by every value here.
 *
 * Never throws: a missing row or a read failure resolves to DEFAULTS, which
 * reproduce the values the desktop app used before this table existed.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

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

  updated_at?: string | null;
}

export const DESKTOP_APP_DEFAULT_FEED_URL =
  'https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download';

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

  updated_at: null,
};

/** Same bounds as the CHECK constraints in migration 207. */
export const DESKTOP_APP_BOUNDS = {
  update_check_interval_minutes: { min: 15, max: 1440 },
  poll_interval_seconds: { min: 5, max: 300 },
  poll_interval_realtime_seconds: { min: 15, max: 900 },
} as const;

const CACHE_TTL_MS = 30_000;
let cache: { value: DesktopAppSettings; ts: number } | null = null;

/** Test/route seam: drop the memoized row after a write. */
export function invalidateDesktopAppSettingsCache(): void {
  cache = null;
}

export async function loadDesktopAppSettings(config: ServerConfig): Promise<DesktopAppSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let value = DESKTOP_APP_DEFAULTS;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('desktop_app_settings')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!error && data) value = normalize(data as Record<string, unknown>);
  } catch {
    // A deployment that has not applied migration 207 yet still boots.
  }
  cache = { value, ts: now };
  return value;
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
  for (const key of ['auto_update_enabled', 'realtime_enabled', 'calls_enabled', 'storage_settings_visible'] as const) {
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
  features: { calls: boolean; storageSettings: boolean };
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
    features: { calls: s.calls_enabled, storageSettings: s.storage_settings_visible },
  };
}
