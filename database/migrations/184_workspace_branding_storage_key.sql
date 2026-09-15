-- 184 — Workspace branding ownership: `workspace_branding.logo_storage_key`.
--
-- Corrective-pass P1 finding: account.ts already documented
-- `branding/<workspaceId>/...` as a pending legacy shape (target:
-- workspace/<id>/branding/...), but the legacy migration registry
-- (server/services/storage/legacyMigration/categories.ts) had providers
-- for email attachments, account avatars, privacy exports and LiveKit
-- recordings only — never branding. Same anti-pattern 177 already fixed
-- for account avatars: workspace_branding.logo_url stores a full URL, so
-- the object key was only ever recoverable by re-parsing that URL for a
-- `/branding/<workspaceId>/` marker substring — fragile, and impossible
-- to migrate through the generic legacy-migration engine, which commits
-- and read-verifies a bare key column, not a URL.
--
-- This migration adds the same bare-key sibling column 177 added for
-- avatars. New workspace-icon uploads (server/routes/account.ts, now
-- writing the canonical workspace/<id>/branding/... shape via
-- workspaceBrandingKey()) record it directly; the legacy migration
-- provider added alongside this migration
-- (workspaceBrandingMigrationProvider) uses it as its commit/readback
-- column, falling back to parsing logo_url only to DISCOVER legacy rows
-- (logo_storage_key IS NULL AND logo_url LIKE '%/branding/<id>/%') --
-- never as the column it writes to.
--
-- Purely additive: existing rows get logo_storage_key = NULL, meaning
-- "pre-migration icon, key not yet recorded" — account.ts's cleanup path
-- falls back to the legacy logo_url-marker parse for those specific rows
-- until they're replaced or migrated. No data loss, no behavior change
-- for a workspace that never re-uploads its icon.

ALTER TABLE public.workspace_branding ADD COLUMN IF NOT EXISTS logo_storage_key TEXT;

COMMENT ON COLUMN public.workspace_branding.logo_storage_key IS
  'Canonical storage object key for logo_url, e.g. workspace/<id>/branding/<uuid>-<name>. NULL for legacy pre-migration rows whose key must be recovered by parsing logo_url.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_branding' AND column_name = 'logo_storage_key'
  ) THEN
    RAISE EXCEPTION 'workspace_branding.logo_storage_key column missing after migration';
  END IF;
END
$verify$;
