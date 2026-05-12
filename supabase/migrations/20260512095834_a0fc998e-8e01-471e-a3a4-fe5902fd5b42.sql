-- CC-2G-Canonical-Fix
-- 1) Add visitor department choice gate fields to call_center_settings.
ALTER TABLE public.call_center_settings
  ADD COLUMN IF NOT EXISTS departments_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_visitor_department_choice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.call_center_settings.departments_enabled IS
  'Workspace-level toggle: whether the standalone Call Center surfaces department concepts at all.';
COMMENT ON COLUMN public.call_center_settings.allow_visitor_department_choice IS
  'When true, the visitor call-widget shows a department dropdown using channel-enabled workspace_departments. Server-side default_department_id fallback still applies when false.';

-- 2) Corrective backfill of canonical workspace_department_members from
--    legacy call_center_department_agents.
--    Previous migration matched on (workspace_id, user_id) only, which can
--    over-apply settings across departments. Re-apply ONLY where the legacy
--    department_id maps 1:1 to a canonical workspace_departments.id.
--    No destructive undo — we just refine over-broad rows where we can.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'call_center_department_agents'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workspace_department_members'
  ) THEN
    EXECUTE $sql$
      UPDATE public.workspace_department_members wdm
      SET
        call_center_role = COALESCE(cca.role, wdm.call_center_role),
        call_center_priority = COALESCE(cca.priority, wdm.call_center_priority),
        call_center_enabled = COALESCE(cca.enabled, wdm.call_center_enabled),
        call_center_max_concurrent_calls = cca.max_concurrent_calls
      FROM public.call_center_department_agents cca
      WHERE cca.workspace_id = wdm.workspace_id
        AND cca.user_id = wdm.user_id
        AND cca.department_id = wdm.department_id
    $sql$;
  END IF;
END $$;

-- Documentation note (no further broad backfills will be run):
--   Source of truth = workspace_departments + workspace_department_members.
--   Legacy tables (call_center_departments, call_center_department_agents)
--   are kept for historical data only and are no longer referenced by the
--   active routing or widget paths.
