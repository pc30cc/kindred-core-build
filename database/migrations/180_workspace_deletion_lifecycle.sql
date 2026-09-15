-- 180 — Workspace deletion storage-aware lifecycle.
--
-- Storage ownership standardization (docs/STORAGE_ARCHITECTURE_AUDIT.md):
-- workspace deletion today (public.admin_purge_workspaces, hosted-only —
-- see the note below) deletes every DB row scoped to the workspace but
-- never calls the storage provider, so every blob the workspace ever
-- uploaded is silently orphaned forever. This introduces an
-- ACTIVE -> DELETING -> (storage cleanup) -> (DB cleanup) -> DELETED state
-- machine: workspaces.status marks a workspace mid-deletion so writes can
-- be rejected (server/services/storage/index.ts's uploadForOwner) while a
-- background worker walks and deletes every object under
-- workspace/<id>/ — and ONLY that prefix; users/ and platform/ objects are
-- structurally unreachable through a workspace-owner call
-- (listForOwner/deleteForOwner's owner-scope enforcement) — before the
-- existing DB purge runs.
--
-- workspace_deletion_jobs is the durable "DELETED" record: deliberately
-- NOT foreign-keyed to workspaces(id), because by the time a job reaches
-- status='completed' the workspace row itself has been hard-deleted by
-- the existing purge RPC — this table is the only surviving evidence a
-- given workspace ever existed and was deleted, snapshotting its
-- slug/name at request time for that reason.
--
-- Self-host note: public.admin_purge_workspaces/admin_delete_workspace are
-- hosted-only today (no self-host CREATE FUNCTION exists for either, a
-- pre-existing gap unrelated to this migration) — the schema added here
-- (workspaces.status, workspace_deletion_jobs) is additive and applies to
-- both chains identically, but a self-host deployment's worker run will
-- fail at the "db_cleanup" step with a clear error until that function is
-- ported, exactly as workspace deletion already fails today on self-host
-- (server/routes/adminManagement.ts's DELETE route calls the same
-- hosted-only RPC).

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_status_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_status_check CHECK (status IN ('active', 'deleting'));

COMMENT ON COLUMN public.workspaces.status IS
  'active (default) or deleting (a workspace_deletion_jobs row is in flight — server/services/workspaceDeletion/worker.ts). No deleted value: the row is hard-deleted by the existing purge RPC once cleanup completes; workspace_deletion_jobs is the durable record of that.';

CREATE TABLE IF NOT EXISTS public.workspace_deletion_jobs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL,
  workspace_slug           text NOT NULL,
  workspace_name           text NOT NULL,
  requested_by             uuid NOT NULL,
  status                   text NOT NULL DEFAULT 'pending',
  storage_objects_found    integer,
  storage_objects_deleted  integer NOT NULL DEFAULT 0,
  storage_cursor           text,
  storage_cleanup_error    text,
  db_cleanup_completed_at  timestamptz,
  error_message            text,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  CONSTRAINT workspace_deletion_jobs_status_check
    CHECK (status IN ('pending', 'storage_cleanup', 'db_cleanup', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_deletion_jobs_status ON public.workspace_deletion_jobs (status, requested_at);
CREATE INDEX IF NOT EXISTS idx_workspace_deletion_jobs_workspace ON public.workspace_deletion_jobs (workspace_id);

COMMENT ON TABLE public.workspace_deletion_jobs IS
  'One row per workspace deletion request — the durable ACTIVE->DELETING->DELETED audit trail (server/services/workspaceDeletion/worker.ts). Not foreign-keyed to workspaces(id): must survive the workspace row itself being deleted.';

ALTER TABLE public.workspace_deletion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_deletion_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.workspace_deletion_jobs TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'workspaces.status column missing after migration';
  END IF;
  IF to_regclass('public.workspace_deletion_jobs') IS NULL THEN
    RAISE EXCEPTION 'workspace_deletion_jobs table missing after migration';
  END IF;
END
$verify$;
