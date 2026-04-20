-- Visitor geo enrichment cache (provider-based)
-- Cached IP→geo lookups so we don't re-call providers on every request.
-- Keyed by ip_hash so we never store raw IPs.
CREATE TABLE IF NOT EXISTS public.visitor_geo_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash TEXT NOT NULL UNIQUE,
  country TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  source TEXT NOT NULL DEFAULT 'centroid', -- 'centroid' | 'ipapi' | 'ipinfo' | etc.
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_visitor_geo_cache_ip_hash ON public.visitor_geo_cache(ip_hash);
CREATE INDEX IF NOT EXISTS idx_visitor_geo_cache_expires ON public.visitor_geo_cache(expires_at);

ALTER TABLE public.visitor_geo_cache ENABLE ROW LEVEL SECURITY;

-- Service-role only — geo cache is backend-managed; UI talks to it via API.
CREATE POLICY "Service role full access geo cache"
  ON public.visitor_geo_cache FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Allow no direct access from anon/authenticated; backend service-role mediates.
CREATE POLICY "No direct access to geo cache"
  ON public.visitor_geo_cache FOR ALL
  TO anon, authenticated
  USING (false) WITH CHECK (false);
