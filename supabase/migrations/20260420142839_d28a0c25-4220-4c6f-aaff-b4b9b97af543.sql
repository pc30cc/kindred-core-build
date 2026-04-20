-- ============================================
-- geo_ip_cache: cached IP -> geo lookups
-- ============================================
CREATE TABLE IF NOT EXISTS public.geo_ip_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ip_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'maxmind_local',
  country_code TEXT,
  country_name TEXT,
  region TEXT,
  city TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  timezone TEXT,
  accuracy_level TEXT,
  is_fallback BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_geo_ip_cache_ip_hash ON public.geo_ip_cache(ip_hash);
CREATE INDEX IF NOT EXISTS idx_geo_ip_cache_expires_at ON public.geo_ip_cache(expires_at);

ALTER TABLE public.geo_ip_cache ENABLE ROW LEVEL SECURITY;

-- Service role only; no client access. Server uses service key for reads/writes.
CREATE POLICY "Service role full access geo_ip_cache"
  ON public.geo_ip_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admins can read geo_ip_cache"
  ON public.geo_ip_cache
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- ============================================
-- Seed default map_geo_settings into app_runtime_config
-- ============================================
INSERT INTO public.app_runtime_config (key, value)
VALUES (
  'map_geo_settings',
  jsonb_build_object(
    'geo', jsonb_build_object(
      'enabled', true,
      'default_provider', 'maxmind_local',
      'preferred_precision', 'city',
      'allow_centroid_fallback', true,
      'min_accuracy_for_map', 'city',
      'store_raw_ip', false,
      'raw_ip_retention_days', 7,
      'auto_enrich_on_session_create', true,
      'cache_ttl_seconds', 2592000
    ),
    'maxmind_local', jsonb_build_object(
      'enabled', true,
      'db_path', '/app/data/GeoLite2-City.mmdb',
      'auto_reload', true,
      'cache_ttl_seconds', 2592000
    ),
    'maxmind_update', jsonb_build_object(
      'mode', 'manual',
      'account_id', '',
      'license_key', '',
      'edition_id', 'GeoLite2-City',
      'interval_hours', 168,
      'last_run_at', null,
      'last_status', null,
      'last_error', null
    ),
    'tiles', jsonb_build_object(
      'provider', 'self_hosted_raster',
      'url_template', '',
      'attribution', '',
      'min_zoom', 0,
      'max_zoom', 19,
      'subdomains', ''
    ),
    'behavior', jsonb_build_object(
      'show_only_valid_coords', true,
      'ignore_fallback_only', false,
      'include_geo_labels', true,
      'debug_metadata', false,
      'default_center_mode', 'auto',
      'default_center_lat', 0,
      'default_center_lng', 0,
      'default_zoom', 2
    )
  )
)
ON CONFLICT (key) DO NOTHING;