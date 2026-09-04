-- 128 — Widget launcher (FAB) custom image
-- Stores the URL returned by the workspace storage provider for the floating
-- chat button. NULL / empty = use the configured vector icon only.
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS fab_image_url text;
