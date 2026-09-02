ALTER TABLE public.workspace_members
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid,
  ADD COLUMN IF NOT EXISTS suspend_reason text;

CREATE INDEX IF NOT EXISTS workspace_members_suspended_idx
  ON public.workspace_members (workspace_id)
  WHERE suspended_at IS NOT NULL;