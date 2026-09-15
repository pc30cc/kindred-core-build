-- call_center_settings.avatar_storage_path workspace-scope guard.
--
-- Hosted-only, same reason as 20260915091000_call_recordings_workspace_scope.sql:
-- call_center_settings has no self-host mirror table (only ALTERs assuming
-- it already exists — see database/migrations/101_call_widget_presentation_contract.sql),
-- so this is intentionally NOT registered in
-- src/test/integration/migrationMirrorParity.test.ts's MIRRORS array.
--
-- Storage ownership standardization audit finding: server/services/storage/
-- keys.ts already has a callCenterAvatarKey() builder
-- (workspace/<id>/avatars/call-center/<uuid>-<name>), but
-- server/routes/callCenter.ts's avatar upload route still ad-hoc
-- string-interpolates its own shape (workspace/<id>/call-center/avatar/
-- <uuid>-<name>) instead of using it — a tracked, not-yet-fixed producer
-- gap (touching that 2000+ line route file trips this repo's
-- lint:changed full-file-clean gate for ~100 pre-existing, unrelated `any`
-- errors, the same tradeoff already made for internalChannels.ts and
-- admin.ts elsewhere in this project — see docs/STORAGE_ARCHITECTURE_AUDIT.md).
-- Both are already correctly workspace_id-scoped under workspace/<id>/, so
-- this is a path-convention inconsistency, not an ownership violation.
-- The CHECK below accepts both shapes so it doesn't break the route that
-- is actually live today; once callCenter.ts is migrated to the builder,
-- the legacy branch can be dropped.
--
-- Added NOT VALID: avatar_storage_path predates this project and its
-- real production shape cannot be verified from here.

ALTER TABLE public.call_center_settings
  DROP CONSTRAINT IF EXISTS call_center_settings_avatar_path_scope_check;

ALTER TABLE public.call_center_settings
  ADD CONSTRAINT call_center_settings_avatar_path_scope_check
    CHECK (
      avatar_storage_path IS NULL
      OR avatar_storage_path LIKE 'workspace/' || workspace_id::text || '/avatars/call-center/%'
      OR avatar_storage_path LIKE 'workspace/' || workspace_id::text || '/call-center/avatar/%'
    )
    NOT VALID;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_settings_avatar_path_scope_check') THEN
    RAISE EXCEPTION 'call_center_settings_avatar_path_scope_check constraint missing after migration';
  END IF;
END
$verify$;
