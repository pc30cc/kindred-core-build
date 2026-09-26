-- ============================================================
-- 224 — THE ANDROID APP IN SUPER ADMIN → MOBILE APP
--
-- Until now the `mobile_app_settings` singleton described the iOS app only
-- (bundle id, App Store, TestFlight). The Android app — package
-- `com.webyar.operator` — had nothing: no record of what is on Play, and no
-- way to change how the app behaves without shipping a build.
--
-- Two kinds of column, added to the same service_role-only row:
--
--   • android_* identity and release: what the Play Console listing and the
--     current release are. A record for whoever ships the app; nothing reads
--     them at runtime.
--
--   • android_app_* switches: how the installed app behaves, read by the app
--     from GET /api/mobile-app/config and applied without a new build. Each
--     ships at the value the app already behaves with, except the name on the
--     profile, which is now read-only unless a platform admin allows editing
--     it — so applying this file changes nothing an operator has not asked for.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  -- Identity on Google Play.
  ADD COLUMN IF NOT EXISTS android_package_name text NOT NULL DEFAULT 'com.webyar.operator',
  ADD COLUMN IF NOT EXISTS android_app_name text NOT NULL DEFAULT 'Webyar',
  ADD COLUMN IF NOT EXISTS android_play_store_url text,

  -- The current release, as Play Console knows it.
  ADD COLUMN IF NOT EXISTS android_version_name text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS android_version_code integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS android_min_sdk integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS android_target_sdk integer NOT NULL DEFAULT 37,
  ADD COLUMN IF NOT EXISTS android_release_track text NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS android_rollout_percent integer NOT NULL DEFAULT 100,
  -- `{ "en": "...", "fa": "...", "tr": "..." }` — Play's "What's new", per language.
  ADD COLUMN IF NOT EXISTS android_release_notes jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- In-app switches, applied live by the installed app.
  ADD COLUMN IF NOT EXISTS android_app_show_storage boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS android_app_show_security boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS android_app_show_notification_settings boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS android_app_allow_wallpaper_colors boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS android_app_profile_name_editable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS android_app_profile_phone_editable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS android_app_profile_photo_editable boolean NOT NULL DEFAULT true;

-- Guarded so the file can be applied twice: `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_android_track_known'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_android_track_known
        CHECK (android_release_track IN ('internal', 'closed', 'open', 'production'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_android_rollout_sane'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_android_rollout_sane
        CHECK (android_rollout_percent BETWEEN 1 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_android_sdk_sane'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_android_sdk_sane
        CHECK (android_min_sdk BETWEEN 21 AND 99
           AND android_target_sdk BETWEEN 21 AND 99
           AND android_min_sdk <= android_target_sdk);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_android_version_code_sane'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_android_version_code_sane
        CHECK (android_version_code BETWEEN 1 AND 2100000000);
  END IF;
END $$;

COMMENT ON COLUMN public.mobile_app_settings.android_app_show_storage IS
  'Android app: show the Storage section (cache size, clear cache) in Settings.';
COMMENT ON COLUMN public.mobile_app_settings.android_app_profile_name_editable IS
  'Android app: operators may change their first and last name on the Profile screen. Off shows them read-only.';
