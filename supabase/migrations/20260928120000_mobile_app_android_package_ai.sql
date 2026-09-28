-- ============================================================
-- THE ANDROID APP'S PACKAGE NAME: com.webyar.ai
--
-- Self-host mirror: database/migrations/231_mobile_app_android_package_ai.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- The Android app's package name is now `com.webyar.ai` (it was
-- `com.webyar.operator` while the app was built and tried out, before any
-- Play listing existed). Super Admin → Mobile App → Android → Identity shows
-- and edits this value; the column's default and the one stored row move with
-- the app, and a value someone already changed by hand is left alone.
--
-- Idempotent: a second run finds nothing left to change.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ALTER COLUMN android_package_name SET DEFAULT 'com.webyar.ai';

UPDATE public.mobile_app_settings
   SET android_package_name = 'com.webyar.ai'
 WHERE android_package_name = 'com.webyar.operator';
