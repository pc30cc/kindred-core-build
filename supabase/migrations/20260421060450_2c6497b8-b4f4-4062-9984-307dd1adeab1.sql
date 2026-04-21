ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS default_welcome_message text NOT NULL DEFAULT 'Hello! How can we help you?';