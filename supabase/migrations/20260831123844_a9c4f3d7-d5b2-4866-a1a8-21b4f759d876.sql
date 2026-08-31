ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS shadow_color text;

COMMENT ON COLUMN public.widget_settings.brand_name IS 'Optional widget header display name. Empty/NULL falls back to the workspace name.';
COMMENT ON COLUMN public.widget_settings.shadow_color IS 'Optional hex colour used to tint the widget panel shadow. Empty/NULL uses the template default.';