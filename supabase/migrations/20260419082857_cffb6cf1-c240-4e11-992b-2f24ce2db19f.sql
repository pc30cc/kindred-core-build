-- Add widget URL columns to widget_platform_settings (single source of truth)
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS widget_loader_base_url text,
  ADD COLUMN IF NOT EXISTS widget_asset_base_url text,
  ADD COLUMN IF NOT EXISTS widget_public_base_url text,
  ADD COLUMN IF NOT EXISTS widget_api_base_url text;

COMMENT ON COLUMN public.widget_platform_settings.widget_loader_base_url IS 'Origin used to serve /widget/loader.js. Single source of truth for widget loader URL.';
COMMENT ON COLUMN public.widget_platform_settings.widget_asset_base_url IS 'Origin used to serve runtime.js / runtime.css / runtime-rt-centrifugo.js / widget-manifest.json.';
COMMENT ON COLUMN public.widget_platform_settings.widget_public_base_url IS 'Public website origin where the widget is embedded (used for default origin checks and embed previews).';
COMMENT ON COLUMN public.widget_platform_settings.widget_api_base_url IS 'Backend API origin used by the widget for /api/widget/* calls.';

-- One-time migration of existing values from platform_domains into widget_platform_settings.
-- Only fills NULL columns so we never overwrite an explicit setting.
WITH pd AS (
  SELECT widget_base_url, asset_base_url, public_base_url, api_base_url
  FROM public.platform_domains
  ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  LIMIT 1
)
UPDATE public.widget_platform_settings wps
SET
  widget_loader_base_url = COALESCE(wps.widget_loader_base_url, pd.widget_base_url, pd.public_base_url),
  widget_asset_base_url  = COALESCE(wps.widget_asset_base_url, pd.asset_base_url, pd.widget_base_url, pd.public_base_url),
  widget_public_base_url = COALESCE(wps.widget_public_base_url, pd.public_base_url, pd.widget_base_url),
  widget_api_base_url    = COALESCE(wps.widget_api_base_url, pd.api_base_url),
  updated_at             = now()
FROM pd
WHERE TRUE;

-- Mark the old platform_domains widget columns as deprecated. We keep the
-- columns for safe rollback but they are no longer the source of truth.
COMMENT ON COLUMN public.platform_domains.widget_base_url IS 'DEPRECATED — moved to widget_platform_settings.widget_loader_base_url. Kept for rollback only.';
COMMENT ON COLUMN public.platform_domains.asset_base_url IS 'DEPRECATED for widget assets — see widget_platform_settings.widget_asset_base_url.';

COMMENT ON COLUMN public.workspace_branding.widget_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';
COMMENT ON COLUMN public.workspace_branding.widget_public_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';
COMMENT ON COLUMN public.workspace_branding.widget_loader_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';
COMMENT ON COLUMN public.workspace_branding.widget_api_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';