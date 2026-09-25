/**
 * The macOS app panel's model: which switches exist, and a client-side
 * mirror of the server's rules (macosAppSettingsSchema in
 * server/routes/adminMacosApp.ts).
 *
 * The page uses `macosProblems` to keep Save disabled and to say why; each
 * tab uses the small predicates to paint its own fields red. Keeping both on
 * one list means a field can never be red without also blocking Save, or
 * block Save without a red field to point at.
 */
import type { TranslationKey } from '@/i18n';
import {
  MACOS_BOUNDS,
  MACOS_LIMITS,
  MACOS_MESSAGE_LOCALES,
  MACOS_VERSION_RE,
  type MacMaintenanceMessage,
  type MacosAppSettings,
} from '@/hooks/useMacosApp';

export type MacosTab =
  | 'overview'
  | 'updates'
  | 'behaviour'
  | 'integration'
  | 'maintenance'
  | 'campaigns'
  | 'live';

// ── Catalog ──────────────────────────────────────────────────────────────

type BooleanKey<T> = { [K in keyof T]-?: T[K] extends boolean ? K : never }[keyof T];
type SwitchKey = BooleanKey<MacosAppSettings>;

/** What the app may do on the Mac itself; `copy` names the pair under admin.macosApp.integration. */
export const MACOS_INTEGRATIONS: ReadonlyArray<{ key: SwitchKey; copy: string }> = [
  { key: 'menu_bar_extra_enabled', copy: 'menuBar' },
  { key: 'launch_at_login_enabled', copy: 'launchAtLogin' },
  { key: 'dock_badge_enabled', copy: 'dockBadge' },
  { key: 'notifications_enabled', copy: 'notifications' },
];

// ── Validation ───────────────────────────────────────────────────────────

export interface MacosProblem {
  tab: MacosTab;
  /** Translated sentence naming the field and what is wrong with it. */
  message: TranslationKey;
}

/** An https:// address with no spaces; empty clears the value. */
export const isHttpsOrEmpty = (value: string | null | undefined) => {
  const v = (value ?? '').trim();
  return !v || (v.length <= MACOS_LIMITS.url && /^https:\/\/[^\s]+$/i.test(v));
};

/** `1.2.3` or `1.2.3-beta.1`; empty clears the value. */
export const isVersion = (value: string) =>
  value.trim().length <= MACOS_LIMITS.version && MACOS_VERSION_RE.test(value.trim());
export const isVersionOrEmpty = (value: string | null | undefined) => !(value ?? '').trim() || isVersion(value ?? '');

export const inBounds = (value: number, key: keyof typeof MACOS_BOUNDS) =>
  Number.isInteger(value) && value >= MACOS_BOUNDS[key].min && value <= MACOS_BOUNDS[key].max;

/** True when at least one language has something to say (the server trims first). */
export const hasMaintenanceMessage = (message: MacMaintenanceMessage) =>
  MACOS_MESSAGE_LOCALES.some((locale) => (message[locale] ?? '').trim().length > 0);

export const maintenanceMessageTooLong = (message: MacMaintenanceMessage) =>
  MACOS_MESSAGE_LOCALES.some((locale) => (message[locale] ?? '').trim().length > MACOS_LIMITS.maintenanceMessage);

export const isValidDateOrEmpty = (value: string | null) => !value || !Number.isNaN(Date.parse(value));

/** Every reason the draft cannot be saved yet, in tab order. Empty means Save is allowed. */
export function macosProblems(s: MacosAppSettings): MacosProblem[] {
  const out: MacosProblem[] = [];
  const add = (ok: boolean, tab: MacosTab, message: TranslationKey) => {
    if (!ok) out.push({ tab, message });
  };

  add(isHttpsOrEmpty(s.appcast_url), 'updates', 'admin.macosApp.validation.appcastUrl');
  add(isVersionOrEmpty(s.latest_version), 'updates', 'admin.macosApp.validation.latestVersion');
  add(isVersionOrEmpty(s.minimum_supported_version), 'updates', 'admin.macosApp.validation.minimumVersion');
  add(
    s.blocked_versions.length <= MACOS_LIMITS.blockedVersions && s.blocked_versions.every(isVersion),
    'updates',
    'admin.macosApp.validation.blockedVersions',
  );
  add(isHttpsOrEmpty(s.download_url), 'updates', 'admin.macosApp.validation.downloadUrl');
  add((s.release_notes ?? '').trim().length <= MACOS_LIMITS.releaseNotes, 'updates', 'admin.macosApp.validation.releaseNotes');
  add(inBounds(s.update_check_interval_minutes, 'update_check_interval_minutes'), 'updates', 'admin.macosApp.validation.checkInterval');

  add(inBounds(s.poll_interval_seconds, 'poll_interval_seconds'), 'behaviour', 'admin.macosApp.validation.pollInterval');
  add(
    inBounds(s.poll_interval_realtime_seconds, 'poll_interval_realtime_seconds'),
    'behaviour',
    'admin.macosApp.validation.pollIntervalRealtime',
  );

  add(!s.maintenance_enabled || hasMaintenanceMessage(s.maintenance_message), 'maintenance', 'admin.macosApp.validation.maintenanceMessage');
  add(!maintenanceMessageTooLong(s.maintenance_message), 'maintenance', 'admin.macosApp.validation.maintenanceMessageLength');
  add(isValidDateOrEmpty(s.maintenance_until), 'maintenance', 'admin.macosApp.validation.maintenanceUntil');
  add(isHttpsOrEmpty(s.support_url), 'maintenance', 'admin.macosApp.validation.supportUrl');
  add(isHttpsOrEmpty(s.status_page_url), 'maintenance', 'admin.macosApp.validation.statusPageUrl');
  add(isHttpsOrEmpty(s.privacy_url), 'maintenance', 'admin.macosApp.validation.privacyUrl');
  add(isHttpsOrEmpty(s.terms_url), 'maintenance', 'admin.macosApp.validation.termsUrl');

  return out;
}

/** Whether a maintenance notice is actually on screen: switched on and not past its end time. */
export function maintenanceShowing(s: Pick<MacosAppSettings, 'maintenance_enabled' | 'maintenance_until'>, now = Date.now()) {
  return s.maintenance_enabled && !(s.maintenance_until && Date.parse(s.maintenance_until) <= now);
}

/** ISO ↔ the value of an <input type="datetime-local"> in the admin's own time zone. */
export const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value: string) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
