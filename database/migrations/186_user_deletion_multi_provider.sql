-- 186 — User deletion: multi-provider storage scopes.
--
-- Second corrective pass, P0 finding: user_deletion_jobs.avatar_cleanup_done
-- was a single boolean covering ONLY the global/default user storage
-- provider. A user-subject privacy export
-- (users/<userId>/exports/privacy/<jobId>.zip) physically lives in the
-- dedicated privacy storage provider (resolvePrivacyStoragePolicy),
-- which can be a different physical account entirely — the same
-- "canonical key ownership does not imply a single physical provider"
-- issue 181 already fixed for workspace deletion. server/services/
-- storage/userScopes.ts is the analogous per-user scope list;
-- server/services/userDeletion/worker.ts now walks both ('default' and
-- 'privacy_export') via the SAME shared engine
-- (server/services/storage/scopeCleanupEngine.ts) workspace deletion
-- uses, with the same dedup/verify/drift-detection guarantees.
--
-- avatar_cleanup_done is kept (unused by new code, forward-only
-- migrations never drop a shipped column) — storage_scopes supersedes it.

ALTER TABLE public.user_deletion_jobs ADD COLUMN IF NOT EXISTS storage_scopes jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_deletion_jobs.storage_scopes IS
  'Per-physical-scope progress for the users/<id>/ global prefix: {"<scopeName>": {status, cursor, objects_found, objects_deleted, error, fingerprint, dedup_of, verified}}. Scope names from server/services/storage/userScopes.ts. purging_user only advances to the final admin_delete_user call once every scope is done AND verified, or skipped_not_configured — mirrors workspace_deletion_jobs.storage_scopes exactly (185/181).';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_deletion_jobs' AND column_name = 'storage_scopes'
  ) THEN
    RAISE EXCEPTION '186_user_deletion_multi_provider: user_deletion_jobs.storage_scopes missing';
  END IF;
END;
$verify$;
