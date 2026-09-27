-- ============================================================
-- macos_app_settings.web_analytics_enabled, storage_settings_visible
--
-- Self-host mirror: database/migrations/227_macos_app_section_switches.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Super Admin → macOS app → Behaviour switches sections of the Mac app off
-- for everyone, whatever each workspace's plan allows: contacts, online
-- visitors and the call center already have columns (migration 211); this
-- adds the website analytics section and the Storage section of the app's
-- settings. The app reads them as features.webAnalytics and
-- features.storageSettings from GET /api/platform/macos-app and ANDs them
-- with the plan. Hiding Storage only hides the section: the cache on each Mac
-- keeps working as before.
--
-- Additive and idempotent; the defaults keep both sections as they were.
-- ============================================================

ALTER TABLE public.macos_app_settings
  ADD COLUMN IF NOT EXISTS web_analytics_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.macos_app_settings
  ADD COLUMN IF NOT EXISTS storage_settings_visible boolean NOT NULL DEFAULT true;
