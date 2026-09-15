ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_status_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_status_check CHECK (status IN ('active', 'deleting'));

COMMENT ON COLUMN public.workspaces.status IS
  'active (default) or deleting (a workspace_deletion_jobs row is in flight).';

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

ALTER TABLE public.workspace_deletion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_deletion_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.workspace_deletion_jobs TO service_role;

ALTER TABLE public.workspace_branding ADD COLUMN IF NOT EXISTS logo_storage_key TEXT;