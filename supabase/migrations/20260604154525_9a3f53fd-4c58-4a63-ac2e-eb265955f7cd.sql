
ALTER TABLE public.platform_call_center_settings
  ADD COLUMN IF NOT EXISTS ringback_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ringback_mode text NOT NULL DEFAULT 'tone',
  ADD COLUMN IF NOT EXISTS ringback_music_url text,
  ADD COLUMN IF NOT EXISTS queue_show_position boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS queue_show_eta boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS queue_eta_seconds_per_position integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS queue_offer_callback_after_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS operator_new_call_sound_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.platform_call_center_settings
  DROP CONSTRAINT IF EXISTS platform_call_center_settings_ringback_mode_check;
ALTER TABLE public.platform_call_center_settings
  ADD CONSTRAINT platform_call_center_settings_ringback_mode_check
  CHECK (ringback_mode IN ('tone', 'music', 'off'));
