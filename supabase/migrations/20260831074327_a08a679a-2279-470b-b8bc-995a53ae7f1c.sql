ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS powered_by_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS powered_by_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS powered_by_brand_text text,
  ADD COLUMN IF NOT EXISTS powered_by_url text;