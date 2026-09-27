-- ============================================================
-- 226: desktop_app_settings section switches
--
-- Hosted mirror: supabase/migrations/20260927100000_desktop_app_section_switches.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Super Admin → Desktop app → Behaviour: sections of the Windows app it can
-- switch off for every installed copy, on top of what each workspace's plan
-- allows (the app shows a section only when both say yes): Contacts, Online
-- visitors, Website analytics and the Call center. The app reads them as
-- features.contacts / visitors / analytics / callCenter from
-- GET /api/platform/desktop-app. A switched-off call center also stops the
-- app ringing for waiting calls.
--
-- Additive and idempotent; the defaults keep every section as it was.
-- ============================================================

ALTER TABLE public.desktop_app_settings
  ADD COLUMN IF NOT EXISTS contacts_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS visitors_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS analytics_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS call_center_enabled boolean NOT NULL DEFAULT true;
