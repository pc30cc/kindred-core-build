ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS embed_header_comment TEXT,
  ADD COLUMN IF NOT EXISTS embed_footer_comment TEXT;