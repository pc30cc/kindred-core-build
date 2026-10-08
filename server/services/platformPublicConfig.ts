/**
 * The platform-wide settings every page needs before anyone signs in
 * (GET /api/platform/public/config): visual branding, per-locale branding
 * text, the region / language policy, and the realtime client's tuning
 * values.
 *
 * Every page load asks for them, and building them takes four database
 * operations, so the finished response is kept in memory:
 *   - for at most CACHE_TTL_MS (30 s, like the signup-policy and widget
 *     platform caches), which also bounds how stale another backend replica
 *     can be;
 *   - dropped at once by invalidatePlatformPublicConfig(), which every
 *     Super Admin route writing one of the four sources calls after a
 *     successful write — the next read on this process sees the change;
 *   - one load at a time: concurrent requests on a cold cache share one
 *     database round instead of each taking four;
 *   - a load that was already running when an invalidation came is used for
 *     the requests waiting on it but never stored, so it cannot put the old
 *     values back;
 *   - a failed load is never stored: the next request tries again.
 *
 * Only whitelisted, presentational fields are read into it, so the cache
 * holds nothing private: no platform_settings field beyond the three the
 * language picker needs, and the realtime values come from
 * get_widget_platform_settings(), the projection already safe for anonymous
 * callers.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

// Whitelists, applied after a `select('*')`: production and a database built
// from database/migrations do not have exactly the same optional columns
// (lock_ui_preferences exists only in the latter), and naming a missing column
// would fail the whole read.
const BRANDING_COLUMNS = [
  'logo_url',
  'favicon_url',
  'pwa_icon_url',
  'primary_color',
  'secondary_color',
  'pwa_enabled',
  'pwa_short_name',
  'pwa_background_color',
  'default_ui_font_size',
  'default_ui_accent',
  'default_ui_chroma',
  'default_ui_skin',
  'lock_ui_preferences',
  'workspace_panel_theme',
  // Its options (Art's layout and colour scheme); absent before migration 254.
  'workspace_panel_theme_options',
];

const LOCALIZED_COLUMNS = [
  'locale',
  'platform_name',
  'public_site_title',
  'browser_title_format',
  'meta_title',
  'meta_description',
  'social_share_title',
  'social_share_description',
  'footer_company_text',
  'support_label',
  'legal_company_display_name',
  'knowledge_base_title',
  'widget_display_name',
];

const REALTIME_KEYS = [
  'realtime_reconnect_jitter_pct',
  'realtime_pending_max',
  'realtime_message_dedupe_enabled',
  'realtime_message_dedupe_window',
] as const;

export const CACHE_TTL_MS = 30_000;

export interface PlatformPublicConfig {
  branding: Record<string, unknown> | null;
  localized: Array<Record<string, unknown> | null>;
  region: Record<string, unknown> | null;
  realtime: Record<string, unknown> | null;
}

function pick(row: Record<string, unknown> | null | undefined, keys: readonly string[]): Record<string, unknown> | null {
  if (!row) return null;
  return Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));
}

let cached: { value: PlatformPublicConfig; at: number } | null = null;
let loading: { promise: Promise<PlatformPublicConfig | null>; generation: number } | null = null;
let generation = 0;

/** Drop the cached settings; the next read loads them from the database. */
export function invalidatePlatformPublicConfig(): void {
  generation += 1;
  cached = null;
  loading = null;
}

async function load(config: ServerConfig): Promise<PlatformPublicConfig | null> {
  const sb = getServiceClient(config);
  const [branding, localized, settings, widgetPlatform] = await Promise.all([
    sb.from('platform_branding').select('*').limit(1).maybeSingle(),
    sb.from('platform_branding_localized').select('*').order('locale'),
    sb
      .from('platform_settings')
      .select('region_mode, active_locales, default_locale')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    sb.rpc('get_widget_platform_settings'),
  ]);
  for (const r of [branding, localized, settings]) {
    if (r.error) {
      console.warn('[platform-public] config read failed:', r.error.message);
      return null;
    }
  }
  const rawRealtime = (widgetPlatform.error ? null : (widgetPlatform.data as Record<string, unknown> | null)) ?? null;
  return {
    branding: pick(branding.data as Record<string, unknown> | null, BRANDING_COLUMNS),
    localized: ((localized.data ?? []) as Record<string, unknown>[]).map((r) => pick(r, LOCALIZED_COLUMNS)),
    region: (settings.data as Record<string, unknown> | null) ?? null,
    realtime: rawRealtime ? pick(rawRealtime, REALTIME_KEYS) : null,
  };
}

/** The settings, from memory when fresh; null when the database read failed. */
export async function getPlatformPublicConfig(config: ServerConfig): Promise<PlatformPublicConfig | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (loading && loading.generation === generation) return loading.promise;
  const startedAt = generation;
  const promise = load(config)
    .then((value) => {
      if (value && generation === startedAt) cached = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      if (loading?.promise === promise) loading = null;
    });
  loading = { promise, generation: startedAt };
  return promise;
}

/** Test-only — forget everything. */
export function __resetPlatformPublicConfigForTests(): void {
  invalidatePlatformPublicConfig();
}
