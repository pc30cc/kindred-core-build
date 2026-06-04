ALTER TABLE public.platform_call_center_settings
  ADD COLUMN IF NOT EXISTS ringback_music_path text,
  ADD COLUMN IF NOT EXISTS ringback_announcement_audio_path text,
  ADD COLUMN IF NOT EXISTS ringback_queue_audio_paths jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.platform_call_center_settings.ringback_music_path IS
  'Provider storage key for platform call-center hold music. URL is resolved at widget bootstrap from active global storage provider.';
COMMENT ON COLUMN public.platform_call_center_settings.ringback_announcement_audio_path IS
  'Provider storage key for uploaded queue announcement audio.';
COMMENT ON COLUMN public.platform_call_center_settings.ringback_queue_audio_paths IS
  'Provider storage keys for queue-position waiting audio, keyed by position 1..6.';