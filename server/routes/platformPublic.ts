/**
 * GET /api/platform/public/config — the platform-wide settings every page
 * needs before anyone signs in: visual branding, per-locale branding text,
 * the region / language policy, the dashboard UI defaults, and the realtime
 * client's tuning values.
 *
 * The browser used to read these straight from Supabase with the anon key
 * (src/integrations/supabase/client.ts, hard-wired to one hosted project).
 * That tied every build to that project, and on a database built from
 * database/migrations it failed anyway — the self-host chain grants anon
 * nothing on platform_branding or platform_settings. Served from here, the
 * dashboard needs no Supabase URL or key at all and works the same on any
 * database.
 *
 * Public, unauthenticated, read-only. Only presentational columns leave the
 * server: no platform_settings field beyond the three the language picker
 * needs, and the realtime values come from get_widget_platform_settings(),
 * the sanitized projection that already existed for anon callers.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export const platformPublicRouter = Router();

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
].join(', ');

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
].join(', ');

const REALTIME_KEYS = [
  'realtime_reconnect_jitter_pct',
  'realtime_pending_max',
  'realtime_message_dedupe_enabled',
  'realtime_message_dedupe_window',
] as const;

platformPublicRouter.get('/config', async (req, res) => {
  const config = (req as unknown as { serverConfig: ServerConfig }).serverConfig;
  const sb = getServiceClient(config);
  const [branding, localized, settings, widgetPlatform] = await Promise.all([
    sb.from('platform_branding').select(BRANDING_COLUMNS).limit(1).maybeSingle(),
    sb.from('platform_branding_localized').select(LOCALIZED_COLUMNS).order('locale'),
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
      return res.status(503).json({ error: 'platform_config_unavailable' });
    }
  }
  const rawRealtime = (widgetPlatform.error ? null : (widgetPlatform.data as Record<string, unknown> | null)) ?? null;
  const realtime = rawRealtime
    ? Object.fromEntries(REALTIME_KEYS.filter((k) => k in rawRealtime).map((k) => [k, rawRealtime[k]]))
    : null;

  // Not cached: Super Admin → Branding edits must show on the next read
  // (the page invalidates its queries right after saving). One request per
  // page load still replaces the four it used to take.
  res.set('Cache-Control', 'no-store');
  return res.json({
    branding: branding.data ?? null,
    localized: localized.data ?? [],
    region: settings.data ?? null,
    realtime,
  });
});
