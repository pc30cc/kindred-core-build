-- ============================================================
-- THE iOS APP'S STORAGE ROW IN SETTINGS
--
-- Hosted twin: supabase/migrations/20260928130000_mobile_app_ios_storage_switch.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- One more switch on the `mobile_app_settings` singleton, set in Super
-- Admin → Mobile App → iOS → In-app settings and read by the app from
-- GET /api/mobile-app/config?platform=ios (showStorage):
--
--   • ios_app_show_storage  — Settings → Storage: what the app keeps on the
--                              phone and the button that clears it
--
-- The Android app has had the same switch (android_app_show_storage) since
-- 224. Off hides the row; the cache itself keeps working.
--
-- Additive and idempotent; defaults on, so applying this file changes
-- nothing until someone turns it off.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_app_show_storage boolean NOT NULL DEFAULT true;
