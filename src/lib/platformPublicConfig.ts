/**
 * The platform-wide settings every page needs — branding, per-locale
 * branding text, region / language policy, UI defaults and realtime tuning —
 * from GET /api/platform/public/config (server/routes/platformPublic.ts).
 *
 * This replaces the browser's direct Supabase reads: the dashboard holds no
 * Supabase URL or key and talks to its own API only, so the same build works
 * whichever PostgreSQL (or Supabase project) the server is connected to.
 *
 * One request serves every consumer: concurrent callers share the in-flight
 * fetch, and React Query consumers share one cache entry.
 */
import { useQuery } from '@tanstack/react-query';
import { API_BASE } from './apiBase';

export interface PlatformPublicBranding {
  logo_url: string | null;
  favicon_url: string | null;
  pwa_icon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  pwa_enabled: boolean;
  pwa_short_name: string | null;
  pwa_background_color: string | null;
  default_ui_font_size: string | null;
  default_ui_accent: string | null;
  default_ui_chroma: string | null;
  default_ui_skin: string | null;
  lock_ui_preferences: boolean | null;
  /** The workspace panel's theme (shared/panelThemes.ts); missing before migration 253. */
  workspace_panel_theme?: string | null;
  /**
   * Each theme's options, `{ "<theme>": { "<option>": "<value>" } }`
   * (shared/panelThemes.ts, resolvePanelThemeOptions); missing before
   * migration 254.
   */
  workspace_panel_theme_options?: Record<string, Record<string, unknown> | null> | null;
}

export interface PlatformPublicLocalized {
  locale: string;
  platform_name: string;
  public_site_title: string | null;
  browser_title_format: string | null;
  meta_title: string | null;
  meta_description: string | null;
  social_share_title: string | null;
  social_share_description: string | null;
  footer_company_text: string | null;
  support_label: string | null;
  legal_company_display_name: string | null;
  knowledge_base_title: string | null;
  widget_display_name: string | null;
}

export interface PlatformPublicConfig {
  branding: PlatformPublicBranding | null;
  localized: PlatformPublicLocalized[];
  region: { region_mode: string | null; active_locales: string[] | null; default_locale: string | null } | null;
  realtime: Record<string, unknown> | null;
}

export const PLATFORM_PUBLIC_CONFIG_QUERY_KEY = ['platform_public_config'] as const;

let inflight: Promise<PlatformPublicConfig> | null = null;

export function fetchPlatformPublicConfig(): Promise<PlatformPublicConfig> {
  if (!inflight) {
    inflight = (async () => {
      const res = await fetch(`${API_BASE}/api/platform/public/config`, { credentials: 'include' });
      if (!res.ok) throw new Error(`platform config: HTTP ${res.status}`);
      return (await res.json()) as PlatformPublicConfig;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function usePlatformPublicConfig() {
  return useQuery({
    queryKey: PLATFORM_PUBLIC_CONFIG_QUERY_KEY,
    queryFn: fetchPlatformPublicConfig,
    staleTime: 5 * 60 * 1000,
  });
}
