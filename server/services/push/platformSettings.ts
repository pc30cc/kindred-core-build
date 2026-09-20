/**
 * PLATFORM-WIDE PUSH POLICY (Super Admin → Notifications).
 *
 * The singleton `push_platform_settings` row holds POLICY only — defaults for
 * users who never touched their own preferences, APNs delivery semantics, the
 * iOS notification categories and the per-event copy templates.
 *
 * Credentials are deliberately NOT here. The FCM service account stays in the
 * server environment (`server/services/push/fcm.ts`); that separation is what
 * makes it safe to expose this row to an admin UI at all.
 *
 * Read on the dispatch hot path, so it is memoized for 30s and NEVER throws:
 * a missing row, an unapplied migration or a database blip resolves to
 * DEFAULTS, which reproduce the behaviour that was hardcoded before this
 * table existed.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type PushScope = 'all' | 'assigned' | 'mentions' | 'none';
export type InterruptionLevel = 'passive' | 'active' | 'time-sensitive' | 'critical';
export type ThreadStrategy = 'conversation' | 'workspace' | 'none';

export interface PushCategoryAction {
  id: string;
  /** Localized button titles keyed by locale; `default` is the fallback. */
  titles: Record<string, string>;
  /** Opens the app instead of handling the action in the background. */
  foreground: boolean;
  destructive: boolean;
  /** Renders an inline reply text field (iOS `UNTextInputNotificationAction`). */
  textInput: boolean;
}

export interface PushCategory {
  id: string;
  eventTypes: string[];
  actions: PushCategoryAction[];
}

export interface PushTemplate {
  /** Locale → copy. `default` is used when the recipient's locale is absent. */
  title: Record<string, string>;
  body: Record<string, string>;
  /** Copy used when the recipient disabled message previews. */
  privateTitle?: Record<string, string>;
  privateBody?: Record<string, string>;
}

export interface PushPlatformSettings {
  push_enabled: boolean;

  default_scope: PushScope;
  default_preview: boolean;
  default_internal_notes: boolean;
  default_sound: boolean;
  default_quiet_hours_enabled: boolean;
  default_quiet_hours_start: string;
  default_quiet_hours_end: string;
  default_quiet_hours_timezone: string | null;
  mention_bypasses_quiet_hours: boolean;

  apns_priority: number;
  apns_ttl_seconds: number;
  interruption_level: InterruptionLevel;
  relevance_score: number;
  mutable_content: boolean;
  thread_id_strategy: ThreadStrategy;
  collapse_enabled: boolean;
  badge_enabled: boolean;
  sound_name: string;
  critical_alerts_enabled: boolean;
  critical_alert_volume: number;
  provisional_authorization: boolean;
  android_channel_id: string;

  throttle_per_user_per_minute: number;
  dispatch_log_retention_days: number;

  categories: PushCategory[];
  templates: Record<string, PushTemplate>;
  updated_at?: string | null;
}

/**
 * Shipped categories. `WEBYAR_MESSAGE` is what `dispatch.ts` attaches to an
 * inbound-message push; the actions are the ones the iOS shell registers.
 */
export const DEFAULT_CATEGORIES: PushCategory[] = [
  {
    id: 'WEBYAR_MESSAGE',
    eventTypes: ['new_message'],
    actions: [
      {
        id: 'REPLY',
        titles: { default: 'Reply', en: 'Reply', fa: 'پاسخ', tr: 'Yanıtla' },
        // Foreground: the reply is sent by the app once iOS resumes it. A
        // background send would need a notification service extension, and a
        // button that silently fails is worse than one that opens the thread.
        foreground: true,
        destructive: false,
        textInput: true,
      },
      {
        id: 'MARK_READ',
        titles: { default: 'Mark as read', en: 'Mark as read', fa: 'خوانده شد', tr: 'Okundu işaretle' },
        foreground: false,
        destructive: false,
        textInput: false,
      },
    ],
  },
  {
    id: 'WEBYAR_MENTION',
    eventTypes: ['mention', 'internal_note'],
    actions: [
      {
        id: 'OPEN',
        titles: { default: 'Open', en: 'Open', fa: 'باز کردن', tr: 'Aç' },
        foreground: true,
        destructive: false,
        textInput: false,
      },
    ],
  },
];

/**
 * Copy templates. `{{sender}}`, `{{preview}}`, `{{workspace}}` and
 * `{{count}}` are substituted at dispatch time; an unknown placeholder is
 * left untouched rather than rendered as an empty string.
 */
export const DEFAULT_TEMPLATES: Record<string, PushTemplate> = {
  new_message: {
    title: { default: '{{sender}}', en: '{{sender}}', fa: '{{sender}}', tr: '{{sender}}' },
    body: { default: '{{preview}}', en: '{{preview}}', fa: '{{preview}}', tr: '{{preview}}' },
    privateTitle: { default: 'Webyar', en: 'Webyar', fa: 'Webyar', tr: 'Webyar' },
    privateBody: {
      default: 'New message',
      en: 'New message',
      fa: 'پیام جدید',
      tr: 'Yeni mesaj',
    },
  },
  internal_note: {
    title: {
      default: 'Internal note · {{sender}}',
      en: 'Internal note · {{sender}}',
      fa: 'یادداشت داخلی · {{sender}}',
      tr: 'Dahili not · {{sender}}',
    },
    body: { default: '{{preview}}', en: '{{preview}}', fa: '{{preview}}', tr: '{{preview}}' },
    privateTitle: { default: 'Webyar', en: 'Webyar', fa: 'Webyar', tr: 'Webyar' },
    privateBody: {
      default: 'New internal note',
      en: 'New internal note',
      fa: 'یادداشت داخلی جدید',
      tr: 'Yeni dahili not',
    },
  },
  mention: {
    title: {
      default: '{{sender}} mentioned you',
      en: '{{sender}} mentioned you',
      fa: '{{sender}} شما را منشن کرد',
      tr: '{{sender}} sizden bahsetti',
    },
    body: { default: '{{preview}}', en: '{{preview}}', fa: '{{preview}}', tr: '{{preview}}' },
    privateTitle: { default: 'Webyar', en: 'Webyar', fa: 'Webyar', tr: 'Webyar' },
    privateBody: {
      default: 'You were mentioned',
      en: 'You were mentioned',
      fa: 'شما منشن شدید',
      tr: 'Sizden bahsedildi',
    },
  },
};

export const PUSH_PLATFORM_DEFAULTS: PushPlatformSettings = {
  push_enabled: true,

  default_scope: 'all',
  default_preview: true,
  default_internal_notes: true,
  default_sound: true,
  default_quiet_hours_enabled: false,
  default_quiet_hours_start: '22:00',
  default_quiet_hours_end: '08:00',
  default_quiet_hours_timezone: null,
  mention_bypasses_quiet_hours: true,

  apns_priority: 10,
  apns_ttl_seconds: 86_400,
  interruption_level: 'active',
  relevance_score: 0.5,
  mutable_content: true,
  thread_id_strategy: 'conversation',
  collapse_enabled: true,
  badge_enabled: true,
  sound_name: 'default',
  critical_alerts_enabled: false,
  critical_alert_volume: 0.7,
  provisional_authorization: false,
  android_channel_id: 'webyar_messages',

  throttle_per_user_per_minute: 20,
  dispatch_log_retention_days: 30,

  categories: DEFAULT_CATEGORIES,
  templates: DEFAULT_TEMPLATES,
  updated_at: null,
};

const CACHE_TTL_MS = 30_000;
let cache: { value: PushPlatformSettings; ts: number } | null = null;

export function invalidatePushPlatformSettingsCache(): void {
  cache = null;
}

export async function loadPushPlatformSettings(
  config: ServerConfig,
): Promise<PushPlatformSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let value = PUSH_PLATFORM_DEFAULTS;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('push_platform_settings')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!error && data) value = normalizePushSettings(data as Record<string, unknown>);
  } catch {
    // Push policy must never take the dispatch path down.
  }
  cache = { value, ts: now };
  return value;
}

export function normalizePushSettings(row: Record<string, unknown>): PushPlatformSettings {
  const out = { ...PUSH_PLATFORM_DEFAULTS } as Record<string, unknown>;
  for (const key of Object.keys(PUSH_PLATFORM_DEFAULTS) as (keyof PushPlatformSettings)[]) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    out[key] = raw;
  }
  // An empty jsonb default ('[]' / '{}') means "never configured" — fall back
  // to the shipped set rather than sending notifications with no category and
  // no copy.
  const categories = row.categories;
  out.categories = Array.isArray(categories) && categories.length
    ? (categories as PushCategory[])
    : DEFAULT_CATEGORIES;
  const templates = row.templates as Record<string, unknown> | null;
  out.templates = templates && Object.keys(templates).length
    ? (templates as Record<string, PushTemplate>)
    : DEFAULT_TEMPLATES;
  out.relevance_score = Number(row.relevance_score ?? PUSH_PLATFORM_DEFAULTS.relevance_score);
  out.critical_alert_volume = Number(
    row.critical_alert_volume ?? PUSH_PLATFORM_DEFAULTS.critical_alert_volume,
  );
  out.updated_at = (row.updated_at as string | null) ?? null;
  return out as unknown as PushPlatformSettings;
}

/**
 * Renders a template for one recipient. Falls back locale → `default` →
 * the shipped English copy, so a half-translated template can never produce
 * an empty notification.
 */
export function renderTemplate(
  settings: PushPlatformSettings,
  eventType: string,
  locale: string,
  preview: boolean,
  vars: Record<string, string>,
): { title: string; body: string } {
  const template = settings.templates?.[eventType] ?? DEFAULT_TEMPLATES[eventType] ?? DEFAULT_TEMPLATES.new_message;
  const fallback = DEFAULT_TEMPLATES[eventType] ?? DEFAULT_TEMPLATES.new_message;
  const pick = (
    map: Record<string, string> | undefined,
    fallbackMap: Record<string, string> | undefined,
  ): string => map?.[locale] ?? map?.default ?? fallbackMap?.[locale] ?? fallbackMap?.default ?? '';

  const title = preview
    ? pick(template.title, fallback.title)
    : pick(template.privateTitle, fallback.privateTitle);
  const body = preview
    ? pick(template.body, fallback.body)
    : pick(template.privateBody, fallback.privateBody);
  return { title: substitute(title, vars), body: substitute(body, vars) };
}

/** `{{name}}` → value. An unknown placeholder is left as-is, never blanked. */
function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}
