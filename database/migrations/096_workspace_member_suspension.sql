-- 096 — Workspace member suspension ("ban an operator").
--
-- A banned member keeps their membership row (history, assignments and audit
-- trails stay intact) but loses every workspace capability: the Express
-- authorization helper (server/lib/workspaceAuth.ts) denies access while
-- `suspended_at` is set. Forward-only, idempotent.

ALTER TABLE public.workspace_members
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid,
  ADD COLUMN IF NOT EXISTS suspend_reason text;

CREATE INDEX IF NOT EXISTS workspace_members_suspended_idx
  ON public.workspace_members (workspace_id)
  WHERE suspended_at IS NOT NULL;
