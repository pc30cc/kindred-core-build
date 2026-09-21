/**
 * WHAT THE PLATFORM OFFERS (Super Admin → Notifications → Email).
 *
 * The singleton `notification_email_settings` row. It decides which
 * notification emails exist at all, which provider carries them, and when
 * the two scheduled ones go out — and the operator's own page is drawn from
 * it, so a type the platform has not enabled is not a switch somebody can
 * turn on and then wonder about.
 *
 * Read on every dispatch pass, so it is memoized briefly and NEVER throws: a
 * missing row or an unapplied migration resolves to "everything off", which
 * is the behaviour of the day before this shipped rather than an outage.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { NOTIFICATION_EMAIL_TYPES, type NotificationEmailType } from './types.js';

export interface NotificationEmailSettings {
  enabled: boolean;
  unread_messages_enabled: boolean;
  transcripts_enabled: boolean;
  paid_invoices_enabled: boolean;
  weekly_summary_enabled: boolean;
  product_updates_enabled: boolean;
  provider_override: string | null;
  unread_after_minutes: number;
  digest_every_minutes: number;
  weekly_summary_dow: number;
  weekly_summary_hour: number;
}

/**
 * Everything off.
 *
 * Not a conservative guess — the actual default in the migration. A mail
 * path that has never sent anything should start silent and be switched on
 * by somebody who meant to.
 */
export const NOTIFICATION_EMAIL_DEFAULTS: NotificationEmailSettings = {
  enabled: false,
  unread_messages_enabled: false,
  transcripts_enabled: false,
  paid_invoices_enabled: false,
  weekly_summary_enabled: false,
  product_updates_enabled: false,
  provider_override: null,
  unread_after_minutes: 15,
  digest_every_minutes: 60,
  weekly_summary_dow: 1,
  weekly_summary_hour: 8,
};

export const SETTINGS_COLUMNS =
  'enabled, unread_messages_enabled, transcripts_enabled, paid_invoices_enabled, weekly_summary_enabled, product_updates_enabled, provider_override, unread_after_minutes, digest_every_minutes, weekly_summary_dow, weekly_summary_hour';

const CACHE_TTL_MS = 30_000;
let cached: { at: number; value: NotificationEmailSettings } | null = null;

export function invalidateNotificationEmailSettingsCache(): void {
  cached = null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeNotificationEmailSettings(row: unknown): NotificationEmailSettings {
  const r = (row ?? {}) as Record<string, unknown>;
  const bool = (key: keyof NotificationEmailSettings) =>
    typeof r[key] === 'boolean' ? (r[key] as boolean) : NOTIFICATION_EMAIL_DEFAULTS[key] as boolean;

  const override = typeof r.provider_override === 'string' ? r.provider_override.trim() : '';

  return {
    enabled: bool('enabled'),
    unread_messages_enabled: bool('unread_messages_enabled'),
    transcripts_enabled: bool('transcripts_enabled'),
    paid_invoices_enabled: bool('paid_invoices_enabled'),
    weekly_summary_enabled: bool('weekly_summary_enabled'),
    product_updates_enabled: bool('product_updates_enabled'),
    provider_override: override || null,
    unread_after_minutes: clampInt(r.unread_after_minutes, 5, 1440, 15),
    digest_every_minutes: clampInt(r.digest_every_minutes, 15, 1440, 60),
    weekly_summary_dow: clampInt(r.weekly_summary_dow, 0, 6, 1),
    weekly_summary_hour: clampInt(r.weekly_summary_hour, 0, 23, 8),
  };
}

export async function loadNotificationEmailSettings(
  config: ServerConfig,
): Promise<NotificationEmailSettings> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('notification_email_settings')
      .select(SETTINGS_COLUMNS)
      .eq('id', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const value = normalizeNotificationEmailSettings(data);
    cached = { at: now, value };
    return value;
  } catch (err) {
    // Silence rather than an exception: this is read on a path that is
    // already sending nothing when it is off.
    console.warn('[notification-email] settings unreadable; treating as off', {
      message: err instanceof Error ? err.message : String(err),
    });
    return NOTIFICATION_EMAIL_DEFAULTS;
  }
}

/** Whether one type may be sent at all right now. */
export function isTypeEnabled(
  settings: NotificationEmailSettings,
  type: NotificationEmailType,
): boolean {
  if (!settings.enabled) return false;
  return settings[`${type}_enabled` as keyof NotificationEmailSettings] === true;
}

/** The types the platform currently offers, for the operator's own page. */
export function enabledTypes(settings: NotificationEmailSettings): NotificationEmailType[] {
  return NOTIFICATION_EMAIL_TYPES.filter((type) => isTypeEnabled(settings, type));
}
