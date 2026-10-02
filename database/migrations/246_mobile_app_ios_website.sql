-- ============================================================
-- THE iOS APP'S "WEBSITE" ROW
--
-- Hosted twin: supabase/migrations/20261002110000_mobile_app_ios_website.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Settings → About → Website in the iOS app: where it opens and what it is
-- called, set in Super Admin → Mobile App → iOS → In-app settings and read
-- by the app from GET /api/mobile-app/config?platform=ios (websiteUrl,
-- websiteLabel):
--
--   • ios_app_website_url   — an https address. Empty: the platform's
--     public site (Super Admin → Branding → Domains).
--   • ios_app_website_label — the row's name per language, {fa,en,tr}.
--     A language left out uses the app's own word ("وب‌سایت", "Website").
--
-- Additive and idempotent; both start empty, so applying this file changes
-- nothing until someone fills them in.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_app_website_url text,
  ADD COLUMN IF NOT EXISTS ios_app_website_label jsonb NOT NULL DEFAULT '{}'::jsonb;
