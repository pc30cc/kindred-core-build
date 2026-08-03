ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS region_mode text NOT NULL DEFAULT 'multi',
  ADD COLUMN IF NOT EXISTS region_currency text;

ALTER TABLE public.platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_region_mode_check;

ALTER TABLE public.platform_settings
  ADD CONSTRAINT platform_settings_region_mode_check
  CHECK (region_mode IN ('multi','iran','turkey','global'));