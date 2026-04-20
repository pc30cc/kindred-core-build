-- ============================================================
-- Phase 1: Normalized geo cache columns on visitor_sessions
-- Purpose: city-level coords cached on session row for fast
-- read-path (no JOIN), with explicit accuracy + fallback flags
-- so the map can filter centroid-only points when desired.
-- ============================================================

ALTER TABLE public.visitor_sessions
  ADD COLUMN IF NOT EXISTS geo_country_code  text,
  ADD COLUMN IF NOT EXISTS geo_country_name  text,
  ADD COLUMN IF NOT EXISTS geo_region        text,
  ADD COLUMN IF NOT EXISTS geo_city          text,
  ADD COLUMN IF NOT EXISTS geo_latitude      double precision,
  ADD COLUMN IF NOT EXISTS geo_longitude     double precision,
  ADD COLUMN IF NOT EXISTS geo_timezone      text,
  ADD COLUMN IF NOT EXISTS geo_accuracy_level text
    CHECK (geo_accuracy_level IS NULL OR geo_accuracy_level IN ('country','region','city')),
  ADD COLUMN IF NOT EXISTS geo_source_provider text,
  ADD COLUMN IF NOT EXISTS geo_is_fallback   boolean,
  ADD COLUMN IF NOT EXISTS geo_resolved_at   timestamptz;

-- Index for map queries: only sessions with valid coords, recent activity
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_geo_map
  ON public.visitor_sessions (workspace_id, last_seen_at DESC)
  WHERE geo_latitude IS NOT NULL AND geo_longitude IS NOT NULL;

-- Index for warm-geo backfill: find stale or fallback-only sessions with raw IP
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_geo_warm
  ON public.visitor_sessions (workspace_id, geo_resolved_at)
  WHERE ip_raw IS NOT NULL;

-- ============================================================
-- Phase 2: Bootstrap default map_geo_settings runtime config
-- Stored under app_runtime_config so existing resolver pattern
-- and admin RLS policies apply. Strict priority pipeline lives
-- here; admin can flip toggles without code changes.
-- ============================================================

INSERT INTO public.app_runtime_config (key, value)
VALUES (
  'map_geo_settings',
  jsonb_build_object(
    -- A) Geo Core
    'enabled', true,
    'default_provider', 'maxmind_local',
    'preferred_precision', 'city',
    'allow_centroid_fallback', true,
    'min_accuracy_for_map', 'country',
    'store_raw_ip', false,
    'raw_ip_retention_days', 30,
    'auto_enrich_on_session_create', true,
    -- B) MaxMind Local
    'maxmind_local', jsonb_build_object(
      'enabled', true,
      'db_path', '/app/data/GeoLite2-City.mmdb',
      'auto_reload', true,
      'cache_ttl_seconds', 86400
    ),
    -- C) Map Behavior
    'map', jsonb_build_object(
      'show_only_valid_coords', true,
      'ignore_fallback_only_points', false,
      'default_center_mode', 'auto',
      'default_lat', 20.0,
      'default_lng', 0.0,
      'default_zoom', 2,
      'include_geo_labels', true,
      'debug_mode', false
    ),
    -- D) Geo Jobs
    'jobs', jsonb_build_object(
      'warm_lookback_days', 7,
      'warm_limit', 500,
      'warm_force_reenrich', false
    )
  )
)
ON CONFLICT (key) DO NOTHING;