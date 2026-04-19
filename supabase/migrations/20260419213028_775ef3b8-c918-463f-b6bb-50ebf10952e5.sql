ALTER TABLE public.widget_settings
ADD COLUMN IF NOT EXISTS offline_message_localized jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.widget_settings.offline_message_localized IS
'Per-locale offline message shown to visitors outside business hours. Shape: { "en": "...", "fa": "...", "tr": "..." }. Falls back to widget_settings.offline_message when a locale is missing.';