/**
 * Super Admin → macOS app data access.
 *
 * One query for the settings row and one mutation that writes it, the same
 * shape as the Windows app (src/hooks/useDesktopApp.ts). The server answers a
 * save with the normalized row, which replaces the cache directly so what is
 * shown is always what was stored.
 *
 * The types and bounds below mirror server/services/desktopApp/macosSettings.ts
 * and the zod schema in server/routes/adminMacosApp.ts field for field; keep
 * them in step. Ads, announcements, live usage and broadcasts are shared with
 * the Windows app and live in useDesktopApp.ts, scoped with `platform: 'macos'`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/hooks/useAdmin';

export type MacUpdateChannel = 'stable' | 'beta';
export type MacDefaultLanguage = 'system' | 'fa' | 'en' | 'tr';
export type MacDefaultAppearance = 'system' | 'light' | 'dark';
export type MacMessageLocale = 'fa' | 'en' | 'tr';
export type MacMaintenanceMessage = Partial<Record<MacMessageLocale, string>>;

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

export interface MacosAppPayload {
  settings: MacosAppSettings;
}

/** Where Sparkle looks when the appcast is cleared; the server restores it on save. */
export const MACOS_DEFAULT_APPCAST_URL =
  'https://raw.githubusercontent.com/pc30cc/webyar-desktop-releases/main/macos/appcast.xml';

/** Same bounds as MACOS_APP_BOUNDS on the server (and the CHECK constraints of migration 211). */
export const MACOS_BOUNDS = {
  update_check_interval_minutes: { min: 15, max: 1440 },
  poll_interval_seconds: { min: 5, max: 300 },
  poll_interval_realtime_seconds: { min: 15, max: 900 },
} as const;

/** Same text limits as the server's macosAppSettingsSchema. */
export const MACOS_LIMITS = {
  releaseNotes: 4000,
  maintenanceMessage: 600,
  blockedVersions: 50,
  version: 40,
  url: 2000,
} as const;

export const MACOS_LANGUAGES: readonly MacDefaultLanguage[] = ['system', 'fa', 'en', 'tr'];
export const MACOS_APPEARANCES: readonly MacDefaultAppearance[] = ['system', 'light', 'dark'];
export const MACOS_MESSAGE_LOCALES: readonly MacMessageLocale[] = ['fa', 'en', 'tr'];

/** `1.2.3` or `1.2.3-beta.1` — VERSION_RE on the server. */
export const MACOS_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** What installed Macs read; public, no auth. */
export const MACOS_PUBLIC_CONFIG_PATH = '/api/platform/macos-app';

const KEY = ['admin', 'macos-app'] as const;

export function useMacosAppSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => adminFetch<MacosAppPayload>('/api/admin/macos-app/settings'),
  });
}

export function useSaveMacosAppSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<MacosAppSettings>) =>
      adminFetch<MacosAppPayload & { success: boolean }>('/api/admin/macos-app/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      qc.setQueryData(KEY, (previous: MacosAppPayload | undefined) =>
        previous ? { ...previous, settings: data.settings } : { settings: data.settings },
      );
    },
  });
}
