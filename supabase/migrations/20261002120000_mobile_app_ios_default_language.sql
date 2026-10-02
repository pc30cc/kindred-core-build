-- ============================================================
-- THE iOS APP'S DEFAULT LANGUAGE
--
-- Self-host mirror: database/migrations/247_mobile_app_ios_default_language.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- The language the iOS app opens in until the operator picks one on the
-- phone, set in Super Admin → Mobile App → iOS → In-app settings and read by
-- the app before sign-in from GET /api/mobile-app/public-config?platform=ios
-- — as android_default_language is for Android (migration 237).
--
-- Additive and idempotent. Defaults to English, which is what the iOS build
-- fell back to before this setting, so applying this file changes nothing
-- until someone picks another language.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_default_language text NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_ios_language_known'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_ios_language_known
        CHECK (ios_default_language IN ('fa', 'en', 'tr'));
  END IF;
END $$;

COMMENT ON COLUMN public.mobile_app_settings.ios_default_language IS
  'iOS app: the language it opens in until the operator picks one on the phone (fa, en or tr).';
