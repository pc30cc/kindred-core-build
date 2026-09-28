-- ============================================================
-- THE iOS APP'S SUPPORT LINK
--
-- Hosted twin: supabase/migrations/20260928140000_mobile_app_ios_support_link.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- One more in-app setting on the `mobile_app_settings` singleton, set in
-- Super Admin → Mobile App → iOS → In-app settings and read by the app from
-- GET /api/mobile-app/config?platform=ios (supportUrl):
--
--   • ios_app_support_url  — where Settings → About → Support opens: a page,
--                            a Telegram or WhatsApp link (https), an email
--                            (mailto:) or a phone number (tel:)
--
-- Empty means "not set here": the config falls back to the App Store support
-- URL (support_url), and the app to the platform's own help centre.
--
-- Additive and idempotent; nullable with no default, so applying this file
-- changes nothing until someone fills it in.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_app_support_url text;
