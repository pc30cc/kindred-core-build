/**
 * DESKTOP APP (macOS) PLATFORM SETTINGS.
 *
 * The singleton `macos_app_settings` row (database/migrations/211) is the one
 * source of truth for what the platform decides about the Mac app: where
 * Sparkle looks for updates and which builds are still allowed, realtime and
 * polling, which sections of the app are on, what it may do on the Mac, the
 * defaults of a first launch, a maintenance notice, and the help links.
 *
 * Read by:
 *   • Super Admin → macOS app (server/routes/adminMacosApp.ts),
 *   • GET /api/platform/macos-app (server/routes/desktopAppPublic.ts), which
 *     the Mac app asks on launch and every hour.
 *
 * Never throws: a missing row or a failed read resolves to DEFAULTS, which
 * reproduce what the Mac app did before the table existed.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type MacUpdateChannel = 'stable' | 'beta';
export type MacDefaultLanguage = 'system' | 'fa' | 'en' | 'tr';
export type MacDefaultAppearance = 'system' | 'light' | 'dark';
export type MacMaintenanceMessage = Partial<Record<'fa' | 'en' | 'tr', string>>;

export interface MacosAppSettings {
  // Updates (Sparkle)
  appcast_url: string | null;
  update_channel: MacUpdateChannel;
  latest_version: string | null;
  minimum_supported_version: string | null;
  blocked_versions: string[];
  download_url: string | null;
  release_notes: string | null;
  auto_update_enabled: boolean;
  auto_download_enabled: boolean;
  update_check_interval_minutes: number;

  // Runtime
  realtime_enabled: boolean;
  poll_interval_seconds: number;
  poll_interval_realtime_seconds: number;

  // Features — ANDed with the workspace plan by the app.
  calls_enabled: boolean;
  video_calls_enabled: boolean;
  email_enabled: boolean;
  visitors_enabled: boolean;
  call_center_enabled: boolean;
  colleagues_enabled: boolean;
  contacts_enabled: boolean;
  voice_notes_enabled: boolean;
  attachments_enabled: boolean;

  // System integration
  menu_bar_extra_enabled: boolean;
  launch_at_login_enabled: boolean;
  dock_badge_enabled: boolean;
  notifications_enabled: boolean;

  // First-launch defaults
  default_language: MacDefaultLanguage;
  default_appearance: MacDefaultAppearance;
  default_close_to_menu_bar: boolean;
  default_launch_at_login: boolean;

  // Maintenance
  maintenance_enabled: boolean;
  maintenance_message: MacMaintenanceMessage;
  maintenance_until: string | null;

  // Links
  support_url: string | null;
  status_page_url: string | null;
  privacy_url: string | null;
  terms_url: string | null;

  updated_at?: string | null;
}

export const MACOS_APP_DEFAULT_APPCAST_URL =
  'https://raw.githubusercontent.com/pc30cc/mac-os/main/appcast.xml';

export const MACOS_APP_DEFAULTS: MacosAppSettings = {
  appcast_url: MACOS_APP_DEFAULT_APPCAST_URL,
  update_channel: 'stable',
  latest_version: null,
  minimum_supported_version: null,
  blocked_versions: [],
  download_url: null,
  release_notes: null,
  auto_update_enabled: true,
  auto_download_enabled: true,
  update_check_interval_minutes: 240,

  realtime_enabled: true,
  poll_interval_seconds: 15,
  poll_interval_realtime_seconds: 120,

  calls_enabled: true,
  video_calls_enabled: true,
  email_enabled: true,
  visitors_enabled: true,
  call_center_enabled: true,
  colleagues_enabled: true,
  contacts_enabled: true,
  voice_notes_enabled: true,
  attachments_enabled: true,

  menu_bar_extra_enabled: true,
  launch_at_login_enabled: true,
  dock_badge_enabled: true,
  notifications_enabled: true,

  default_language: 'system',
  default_appearance: 'system',
  default_close_to_menu_bar: true,
  default_launch_at_login: false,

  maintenance_enabled: false,
  maintenance_message: {},
  maintenance_until: null,

  support_url: null,
  status_page_url: null,
  privacy_url: null,
  terms_url: null,

  updated_at: null,
};

/** Same bounds as the CHECK constraints in migration 211. */
export const MACOS_APP_BOUNDS = {
  update_check_interval_minutes: { min: 15, max: 1440 },
  poll_interval_seconds: { min: 5, max: 300 },
  poll_interval_realtime_seconds: { min: 15, max: 900 },
} as const;

export const MACOS_BOOLEAN_KEYS = [
  'auto_update_enabled',
  'auto_download_enabled',
  'realtime_enabled',
  'calls_enabled',
  'video_calls_enabled',
  'email_enabled',
  'visitors_enabled',
  'call_center_enabled',
  'colleagues_enabled',
  'contacts_enabled',
  'voice_notes_enabled',
  'attachments_enabled',
  'menu_bar_extra_enabled',
  'launch_at_login_enabled',
  'dock_badge_enabled',
  'notifications_enabled',
  'default_close_to_menu_bar',
  'default_launch_at_login',
  'maintenance_enabled',
] as const;

const NULLABLE_TEXT_KEYS = [
  'latest_version',
  'minimum_supported_version',
  'download_url',
  'release_notes',
  'support_url',
  'status_page_url',
  'privacy_url',
  'terms_url',
] as const;

export const MACOS_LANGUAGES: readonly MacDefaultLanguage[] = ['system', 'fa', 'en', 'tr'];
export const MACOS_APPEARANCES: readonly MacDefaultAppearance[] = ['system', 'light', 'dark'];
export const MACOS_MESSAGE_LOCALES = ['fa', 'en', 'tr'] as const;
export const MACOS_MAX_BLOCKED_VERSIONS = 50;

export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const CACHE_TTL_MS = 30_000;
let cache: { value: MacosAppSettings; ts: number } | null = null;

export function invalidateMacosAppSettingsCache(): void {
  cache = null;
}

export async function loadMacosAppSettings(config: ServerConfig): Promise<MacosAppSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let value = MACOS_APP_DEFAULTS;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('macos_app_settings')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!error && data) value = normalizeMacos(data as Record<string, unknown>);
  } catch {
    // A deployment that has not applied migration 211 yet still boots.
  }
  cache = { value, ts: now };
  return value;
}

function boundedInt(raw: unknown, key: keyof typeof MACOS_APP_BOUNDS): number {
  const n = Number(raw);
  const { min, max } = MACOS_APP_BOUNDS[key];
  if (!Number.isFinite(n)) return MACOS_APP_DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

/** Fills every missing or unusable field from DEFAULTS so callers never see undefined. */
export function normalizeMacos(row: Record<string, unknown>): MacosAppSettings {
  const out: MacosAppSettings = { ...MACOS_APP_DEFAULTS, maintenance_message: {}, blocked_versions: [] };

  // An empty appcast would leave Sparkle with nowhere to look.
  out.appcast_url = text(row.appcast_url) ?? MACOS_APP_DEFAULT_APPCAST_URL;
  out.update_channel = row.update_channel === 'beta' ? 'beta' : 'stable';
  for (const key of NULLABLE_TEXT_KEYS) out[key] = text(row[key]);
  out.blocked_versions = Array.isArray(row.blocked_versions)
    ? [...new Set(row.blocked_versions.map((v) => String(v).trim()).filter((v) => VERSION_RE.test(v)))].slice(
        0,
        MACOS_MAX_BLOCKED_VERSIONS,
      )
    : [];

  for (const key of Object.keys(MACOS_APP_BOUNDS) as (keyof typeof MACOS_APP_BOUNDS)[]) {
    out[key] = row[key] === undefined || row[key] === null ? MACOS_APP_DEFAULTS[key] : boundedInt(row[key], key);
  }
  for (const key of MACOS_BOOLEAN_KEYS) {
    out[key] = typeof row[key] === 'boolean' ? (row[key] as boolean) : MACOS_APP_DEFAULTS[key];
  }

  out.default_language = MACOS_LANGUAGES.includes(row.default_language as MacDefaultLanguage)
    ? (row.default_language as MacDefaultLanguage)
    : 'system';
  out.default_appearance = MACOS_APPEARANCES.includes(row.default_appearance as MacDefaultAppearance)
    ? (row.default_appearance as MacDefaultAppearance)
    : 'system';

  const message = row.maintenance_message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    for (const locale of MACOS_MESSAGE_LOCALES) {
      const value = text((message as Record<string, unknown>)[locale]);
      if (value) out.maintenance_message[locale] = value;
    }
  }
  out.maintenance_until =
    typeof row.maintenance_until === 'string' && !Number.isNaN(Date.parse(row.maintenance_until))
      ? row.maintenance_until
      : null;

  out.updated_at = (row.updated_at as string | null) ?? null;
  return out;
}

/**
 * What the Mac app reads from GET /api/platform/macos-app. Only non-secret,
 * client-relevant fields — nothing about who configured what.
 */
export interface MacosAppPublicConfig {
  update: {
    appcastUrl: string | null;
    channel: MacUpdateChannel;
    latestVersion: string | null;
    minimumSupportedVersion: string | null;
    blockedVersions: string[];
    downloadUrl: string | null;
    releaseNotes: string | null;
    autoCheck: boolean;
    autoDownload: boolean;
    checkIntervalMinutes: number;
  };
  realtime: { enabled: boolean };
  polling: { intervalSeconds: number; withRealtimeSeconds: number };
  features: {
    calls: boolean;
    videoCalls: boolean;
    email: boolean;
    visitors: boolean;
    callCenter: boolean;
    colleagues: boolean;
    contacts: boolean;
    voiceNotes: boolean;
    attachments: boolean;
  };
  system: { menuBarExtra: boolean; launchAtLogin: boolean; dockBadge: boolean; notifications: boolean };
  defaults: {
    language: MacDefaultLanguage;
    appearance: MacDefaultAppearance;
    closeToMenuBar: boolean;
    launchAtLogin: boolean;
  };
  maintenance: { enabled: boolean; message: MacMaintenanceMessage; until: string | null };
  links: { support: string | null; status: string | null; privacy: string | null; terms: string | null };
}

export function toPublicMacosAppConfig(s: MacosAppSettings): MacosAppPublicConfig {
  return {
    update: {
      appcastUrl: s.appcast_url,
      channel: s.update_channel,
      latestVersion: s.latest_version,
      minimumSupportedVersion: s.minimum_supported_version,
      blockedVersions: s.blocked_versions,
      downloadUrl: s.download_url,
      releaseNotes: s.release_notes,
      autoCheck: s.auto_update_enabled,
      autoDownload: s.auto_update_enabled && s.auto_download_enabled,
      checkIntervalMinutes: s.update_check_interval_minutes,
    },
    realtime: { enabled: s.realtime_enabled },
    polling: { intervalSeconds: s.poll_interval_seconds, withRealtimeSeconds: s.poll_interval_realtime_seconds },
    features: {
      calls: s.calls_enabled,
      // Video rides on the call stack: no calls, no video.
      videoCalls: s.calls_enabled && s.video_calls_enabled,
      email: s.email_enabled,
      visitors: s.visitors_enabled,
      callCenter: s.call_center_enabled,
      colleagues: s.colleagues_enabled,
      contacts: s.contacts_enabled,
      voiceNotes: s.voice_notes_enabled,
      attachments: s.attachments_enabled,
    },
    system: {
      menuBarExtra: s.menu_bar_extra_enabled,
      launchAtLogin: s.launch_at_login_enabled,
      dockBadge: s.dock_badge_enabled,
      notifications: s.notifications_enabled,
    },
    defaults: {
      language: s.default_language,
      appearance: s.default_appearance,
      // Closing to the menu bar needs the menu bar item.
      closeToMenuBar: s.menu_bar_extra_enabled && s.default_close_to_menu_bar,
      launchAtLogin: s.launch_at_login_enabled && s.default_launch_at_login,
    },
    maintenance: {
      // A notice whose end time has passed is over, even if nobody switched it off.
      enabled: s.maintenance_enabled && !(s.maintenance_until && Date.parse(s.maintenance_until) <= Date.now()),
      message: s.maintenance_message,
      until: s.maintenance_until,
    },
    links: { support: s.support_url, status: s.status_page_url, privacy: s.privacy_url, terms: s.terms_url },
  };
}
