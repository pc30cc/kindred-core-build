
-- Extend canonical workspace_department_members with Call Center routing fields.
ALTER TABLE public.workspace_department_members
  ADD COLUMN IF NOT EXISTS call_center_role text NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS call_center_priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS call_center_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS call_center_max_concurrent_calls integer NULL,
  ADD COLUMN IF NOT EXISTS call_center_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.workspace_department_members
  DROP CONSTRAINT IF EXISTS workspace_department_members_call_center_role_check;
ALTER TABLE public.workspace_department_members
  ADD CONSTRAINT workspace_department_members_call_center_role_check
  CHECK (call_center_role IN ('agent', 'supervisor'));

CREATE INDEX IF NOT EXISTS idx_wdm_workspace_department
  ON public.workspace_department_members (workspace_id, department_id);
CREATE INDEX IF NOT EXISTS idx_wdm_workspace_user
  ON public.workspace_department_members (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_wdm_workspace_cc_enabled
  ON public.workspace_department_members (workspace_id, call_center_enabled);

-- Add cc_routing_state to workspace_departments to persist round-robin pointer
-- without resurrecting the legacy departments table.
ALTER TABLE public.workspace_departments
  ADD COLUMN IF NOT EXISTS cc_routing_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: any pre-existing legacy department-agent rows that match
-- canonical members get their call_center_* fields aligned.
UPDATE public.workspace_department_members wdm
SET
  call_center_role = COALESCE(cca.role, wdm.call_center_role),
  call_center_priority = COALESCE(cca.priority, wdm.call_center_priority),
  call_center_enabled = COALESCE(cca.enabled, wdm.call_center_enabled),
  call_center_max_concurrent_calls = cca.max_concurrent_calls
FROM public.call_center_department_agents cca
WHERE cca.workspace_id = wdm.workspace_id
  AND cca.user_id = wdm.user_id;
