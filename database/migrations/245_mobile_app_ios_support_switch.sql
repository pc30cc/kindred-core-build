-- ============================================================
-- THE iOS APP'S "ONLINE SUPPORT" SWITCH
--
-- Hosted twin: supabase/migrations/20261002100000_mobile_app_ios_support_switch.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- One more switch on the `mobile_app_settings` singleton, set in Super
-- Admin → Mobile App → iOS → In-app settings and read by the app from
-- GET /api/mobile-app/config?platform=ios (showSupport):
--
--   • ios_app_show_support — Settings → Online support: the chat with the
--     platform's support team (docs/PLATFORM_SUPPORT.md), as
--     android_app_show_support is on Android (migration 243).
--
-- The switch can only take the section away: it still needs support to be
-- on (Super Admin → Core settings → Support).
--
-- Additive and idempotent; defaults on, so applying this file changes
-- nothing until someone turns it off.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_app_show_support boolean NOT NULL DEFAULT true;
