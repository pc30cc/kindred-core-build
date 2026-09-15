-- privacy_jobs.artifact_storage_key ownership-scope guard.
--
-- Hosted-only, same reason as the two migrations before it: privacy_jobs
-- has no self-host mirror table, so this is intentionally NOT registered
-- in src/test/integration/migrationMirrorParity.test.ts's MIRRORS array.
--
-- Storage ownership standardization: privacy export artifacts have dual
-- ownership by design (server/services/privacy/worker.ts's ownerForJob()):
-- subject_type IN ('contact','visitor') jobs are workspace-owned
-- (workspace_id IS NOT NULL) and use
-- workspace/<workspace_id>/exports/privacy/<jobId>.zip
-- (server/services/storage/keys.ts's privacyExportKey()); subject_type =
-- 'user' jobs are user-owned (workspace_id IS NULL, cross-workspace) and
-- use users/<subject_id>/exports/privacy/<jobId>.zip. A single-branch
-- workspace-only CHECK (the conversation_attachments/email_attachments
-- shape) would incorrectly reject every legitimate user-subject export, so
-- this constraint is the OR of both shapes, gated on whether workspace_id
-- is set — matching ownerForJob()'s own branch exactly.
--
-- Also allows the historical privacy-exports/<workspace_id>/... shape
-- (predates privacyExportKey()) for old workspace-scoped rows. Added NOT
-- VALID: before this project's Phase 2 (privacy export canonicalization),
-- user-subject jobs were routed through the workspace-only builder with a
-- '_self' sentinel workspaceId (see worker.ts's git history), producing an
-- artifact_storage_key shape that is neither of the two valid shapes below
-- — those pre-existing rows must not block this migration, and are exactly
-- what Phase 6's legacy migration tool needs to rewrite before this
-- constraint can be VALIDATEd for real.

ALTER TABLE public.privacy_jobs
  DROP CONSTRAINT IF EXISTS privacy_jobs_artifact_path_scope_check;

ALTER TABLE public.privacy_jobs
  ADD CONSTRAINT privacy_jobs_artifact_path_scope_check
    CHECK (
      artifact_storage_key IS NULL
      OR (
        workspace_id IS NOT NULL
        AND (
          artifact_storage_key LIKE 'workspace/' || workspace_id::text || '/exports/privacy/%'
          OR artifact_storage_key LIKE 'privacy-exports/' || workspace_id::text || '/%'
        )
      )
      OR (
        workspace_id IS NULL
        AND artifact_storage_key LIKE 'users/' || subject_id || '/exports/privacy/%'
      )
    )
    NOT VALID;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_jobs_artifact_path_scope_check') THEN
    RAISE EXCEPTION 'privacy_jobs_artifact_path_scope_check constraint missing after migration';
  END IF;
END
$verify$;
