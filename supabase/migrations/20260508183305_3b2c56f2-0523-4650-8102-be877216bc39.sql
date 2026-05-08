
-- E9: Suggested regression test cases derived from operator assist feedback or failed test runs.
CREATE TABLE public.ai_agent_suggested_test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('operator_assist_feedback','test_run','manual')),
  source_id uuid NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','converted')),
  name text NOT NULL,
  input_message text NOT NULL,
  locale text NULL,
  page_context jsonb NULL,
  expected_behavior text NOT NULL CHECK (expected_behavior IN ('answer','no_answer','handoff','clarification')),
  expected_source_type text NULL,
  expected_source_url text NULL,
  expected_source_id text NULL,
  expected_contains text[] NOT NULL DEFAULT '{}',
  expected_not_contains text[] NOT NULL DEFAULT '{}',
  min_confidence numeric NULL,
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL,
  reviewed_by uuid NULL,
  reviewed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_agent_suggested_tc_ws_status_created
  ON public.ai_agent_suggested_test_cases (workspace_id, status, created_at DESC);
CREATE INDEX idx_ai_agent_suggested_tc_source
  ON public.ai_agent_suggested_test_cases (source_type, source_id);
CREATE INDEX idx_ai_agent_suggested_tc_expected_source_type
  ON public.ai_agent_suggested_test_cases (expected_source_type);

CREATE TRIGGER trg_ai_agent_suggested_tc_updated_at
  BEFORE UPDATE ON public.ai_agent_suggested_test_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_agent_suggested_test_cases ENABLE ROW LEVEL SECURITY;

-- Read: workspace members.
CREATE POLICY "ai_agent_suggested_tc_read_members"
  ON public.ai_agent_suggested_test_cases
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Insert: owner/admin/agent/support_agent/team_lead.
CREATE POLICY "ai_agent_suggested_tc_insert_operators"
  ON public.ai_agent_suggested_test_cases
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_workspace_role(workspace_id, auth.uid())::text
      IN ('owner','admin','agent','support_agent','team_lead')
  );

-- Update: owner/admin only (accept/reject status changes).
CREATE POLICY "ai_agent_suggested_tc_update_admins"
  ON public.ai_agent_suggested_test_cases
  FOR UPDATE TO authenticated
  USING (
    public.get_workspace_role(workspace_id, auth.uid())::text IN ('owner','admin')
  )
  WITH CHECK (
    public.get_workspace_role(workspace_id, auth.uid())::text IN ('owner','admin')
  );

-- Delete: owner/admin only.
CREATE POLICY "ai_agent_suggested_tc_delete_admins"
  ON public.ai_agent_suggested_test_cases
  FOR DELETE TO authenticated
  USING (
    public.get_workspace_role(workspace_id, auth.uid())::text IN ('owner','admin')
  );
