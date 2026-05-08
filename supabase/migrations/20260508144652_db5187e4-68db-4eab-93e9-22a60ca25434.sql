-- AI Agent Test Harness — Pass E6
-- Tables for production QA: scenario definitions and run history.

CREATE TABLE IF NOT EXISTS public.ai_agent_test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  input_message text NOT NULL,
  locale text,
  page_context jsonb DEFAULT NULL,
  expected_behavior text NOT NULL CHECK (expected_behavior IN ('answer','no_answer','handoff','clarification')),
  expected_source_type text CHECK (expected_source_type IS NULL OR expected_source_type IN ('qna','learned_qna','kb_article','web_page','file','business_profile')),
  expected_source_url text,
  expected_source_id text,
  expected_contains text[] NOT NULL DEFAULT '{}',
  expected_not_contains text[] NOT NULL DEFAULT '{}',
  min_confidence numeric,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_test_cases_ws ON public.ai_agent_test_cases(workspace_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_cases_behavior ON public.ai_agent_test_cases(workspace_id, expected_behavior);

CREATE TABLE IF NOT EXISTS public.ai_agent_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  test_case_id uuid REFERENCES public.ai_agent_test_cases(id) ON DELETE SET NULL,
  ai_agent_run_id uuid,
  status text NOT NULL CHECK (status IN ('passed','failed','errored')),
  input_message text NOT NULL,
  actual_output text,
  actual_status text,
  confidence numeric,
  selected_sources jsonb NOT NULL DEFAULT '[]',
  retrieval_debug jsonb,
  answer_strategy jsonb,
  failure_reasons text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_test_runs_ws ON public.ai_agent_test_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_runs_case ON public.ai_agent_test_runs(test_case_id, created_at DESC);

-- Trigger: keep updated_at fresh on test cases
CREATE OR REPLACE FUNCTION public.touch_ai_agent_test_cases_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_agent_test_cases_updated_at ON public.ai_agent_test_cases;
CREATE TRIGGER trg_ai_agent_test_cases_updated_at
  BEFORE UPDATE ON public.ai_agent_test_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_ai_agent_test_cases_updated_at();

-- RLS
ALTER TABLE public.ai_agent_test_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_test_runs ENABLE ROW LEVEL SECURITY;

-- test_cases policies
DROP POLICY IF EXISTS "ai_agent_test_cases_select_members" ON public.ai_agent_test_cases;
CREATE POLICY "ai_agent_test_cases_select_members"
  ON public.ai_agent_test_cases FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "ai_agent_test_cases_write_admins" ON public.ai_agent_test_cases;
CREATE POLICY "ai_agent_test_cases_write_admins"
  ON public.ai_agent_test_cases FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = public.ai_agent_test_cases.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = public.ai_agent_test_cases.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  );

-- test_runs policies
DROP POLICY IF EXISTS "ai_agent_test_runs_select_members" ON public.ai_agent_test_runs;
CREATE POLICY "ai_agent_test_runs_select_members"
  ON public.ai_agent_test_runs FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "ai_agent_test_runs_insert_members" ON public.ai_agent_test_runs;
CREATE POLICY "ai_agent_test_runs_insert_members"
  ON public.ai_agent_test_runs FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));