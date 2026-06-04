-- Call Center — widget language settings (platform + workspace)
ALTER TABLE public.platform_call_center_settings
  ADD COLUMN IF NOT EXISTS widget_default_locale text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS widget_available_locales text[] NOT NULL DEFAULT ARRAY['en','fa','tr']::text[];

ALTER TABLE public.platform_call_center_settings
  DROP CONSTRAINT IF EXISTS platform_call_center_settings_widget_default_locale_check;
ALTER TABLE public.platform_call_center_settings
  ADD CONSTRAINT platform_call_center_settings_widget_default_locale_check
  CHECK (widget_default_locale IN ('en','fa','tr'));

ALTER TABLE public.call_center_settings
  ADD COLUMN IF NOT EXISTS widget_default_locale text NULL,
  ADD COLUMN IF NOT EXISTS widget_enabled_locales text[] NULL;

ALTER TABLE public.call_center_settings
  DROP CONSTRAINT IF EXISTS call_center_settings_widget_default_locale_check;
ALTER TABLE public.call_center_settings
  ADD CONSTRAINT call_center_settings_widget_default_locale_check
  CHECK (widget_default_locale IS NULL OR widget_default_locale IN ('en','fa','tr'));
