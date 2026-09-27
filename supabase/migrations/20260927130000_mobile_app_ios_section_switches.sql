-- ============================================================
-- THE iOS APP'S CONTACTS, VISITORS AND WEBSITE ANALYTICS TABS
--
-- Self-host mirror: database/migrations/229_mobile_app_ios_section_switches.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Three in-app switches on the `mobile_app_settings` singleton, set in
-- Super Admin → Mobile App → iOS → In-app settings and read by the app from
-- GET /api/mobile-app/config?platform=ios (showContacts, showVisitors,
-- showWebAnalytics):
--
--   • ios_app_show_contacts        — the Contacts tab
--   • ios_app_show_visitors        — the live Visitors tab
--   • ios_app_show_web_analytics   — the Website analytics tab
--
-- A switch can only take a tab away: the workspace's plan still decides
-- whether it has the tab at all (contacts; visitor_tracking; web_analytics,
-- for owners and admins).
--
-- Additive and idempotent; all default on, so applying this file changes
-- nothing until someone turns one off.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS ios_app_show_contacts boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ios_app_show_visitors boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ios_app_show_web_analytics boolean NOT NULL DEFAULT true;
