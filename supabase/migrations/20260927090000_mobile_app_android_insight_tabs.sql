-- ============================================================
-- THE ANDROID APP'S VISITORS AND WEBSITE ANALYTICS TABS
--
-- Self-host mirror: database/migrations/226_mobile_app_android_insight_tabs.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Two more in-app switches on the `mobile_app_settings` singleton, set in
-- Super Admin → Mobile App → Android → In-app settings and read by the app
-- from GET /api/mobile-app/config (showVisitors, showWebAnalytics):
--
--   • android_app_show_visitors       — the live Visitors tab
--   • android_app_show_web_analytics  — the Website analytics tab
--
-- A switch can only take a tab away. Whether a workspace has the tab at all
-- is still its plan's call (visitor_tracking; web_analytics, for owners and
-- admins), exactly as on the web — a plan without the feature never shows
-- it, whatever these say.
--
-- Additive and idempotent; both default on, so applying this file changes
-- nothing until someone turns one off.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS android_app_show_visitors boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS android_app_show_web_analytics boolean NOT NULL DEFAULT true;
