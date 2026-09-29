-- ============================================================
-- THE ANDROID APP'S DEFAULT LANGUAGE AND MAINTENANCE NOTICE
--
-- Hosted twin: supabase/migrations/20260929120000_mobile_app_android_language_maintenance.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Two things Super Admin → Mobile App → Android → In-app settings can now
-- decide for every installed copy without a new build:
--
--   • android_default_language — the language the app opens in until the
--     operator picks one on the phone: 'fa', 'en' or 'tr'. Ships at 'fa',
--     which is what the app starts in today.
--
--   • android_maintenance_*   — a maintenance notice. While it is on nobody
--     can sign in to the Android app and operators already signed in see the
--     notice instead of the app.
--       android_maintenance_enabled  the switch;
--       android_maintenance_message  `{ "fa": "…", "en": "…", "tr": "…" }`,
--                                    any language may be missing — the app
--                                    then uses its own wording;
--       android_maintenance_until    optional end time; past it the notice is
--                                    over by itself, even if nobody switched
--                                    it off.
--
-- The app has to know both BEFORE anyone signs in, so they are served
-- publicly by GET /api/mobile-app/public-config?platform=android (and, to a
-- signed-in app, by GET /api/mobile-app/config as `defaultLanguage` and
-- `maintenance`). Nothing here is secret.
--
-- Additive and idempotent. Every column ships at the value the app already
-- behaves with — Persian, no notice — so applying this file changes nothing
-- until someone asks for it.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS android_default_language text NOT NULL DEFAULT 'fa',
  ADD COLUMN IF NOT EXISTS android_maintenance_enabled boolean NOT NULL DEFAULT false,
  -- `{ "fa": "...", "en": "...", "tr": "..." }` — the notice, per language.
  ADD COLUMN IF NOT EXISTS android_maintenance_message jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS android_maintenance_until timestamptz;

-- Guarded so the file can be applied twice: `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_android_language_known'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_android_language_known
        CHECK (android_default_language IN ('fa', 'en', 'tr'));
  END IF;
END $$;

COMMENT ON COLUMN public.mobile_app_settings.android_default_language IS
  'Android app: the language it opens in until the operator picks one on the phone (fa, en or tr).';
COMMENT ON COLUMN public.mobile_app_settings.android_maintenance_enabled IS
  'Android app: maintenance mode. While on (and before android_maintenance_until), nobody can sign in and signed-in operators see the notice.';
COMMENT ON COLUMN public.mobile_app_settings.android_maintenance_message IS
  'Android app: the maintenance notice per language, { fa, en, tr }. A missing language falls back to the app''s own wording.';
COMMENT ON COLUMN public.mobile_app_settings.android_maintenance_until IS
  'Android app: when the maintenance notice ends by itself. Null keeps it until switched off.';
