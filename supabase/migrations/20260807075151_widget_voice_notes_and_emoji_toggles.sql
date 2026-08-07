-- Widget composer feature toggles — voice notes and emoji, independent
-- of the existing file-attachments toggle. Owner-configurable from the
-- widget settings "Behavior" tab.
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS voice_notes_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS emoji_enabled BOOLEAN NOT NULL DEFAULT true;
