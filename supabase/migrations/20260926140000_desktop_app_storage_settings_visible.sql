-- ============================================================
-- desktop_app_settings.storage_settings_visible
--
-- Self-host mirror: database/migrations/224_desktop_app_storage_settings_visible.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Whether the Windows app shows its Storage section (Settings → Storage: how
-- much the local cache holds, and the button that empties it) to the people
-- using it. Super Admin → Desktop app → Behaviour switches it; the app reads it
-- as features.storageSettings from GET /api/platform/desktop-app. Off only
-- hides the section: the cache on each PC keeps working exactly as before.
--
-- Additive and idempotent; the default keeps the section visible, as it was.
-- ============================================================

ALTER TABLE public.desktop_app_settings
  ADD COLUMN IF NOT EXISTS storage_settings_visible boolean NOT NULL DEFAULT true;
