CREATE TABLE IF NOT EXISTS public.ai_agent_regression_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  name text NOT NULL DEFAULT 'Default regression schedule',
  frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('hourly','daily','weekly','manual')),
  time_of_day text NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  include_enabled_cases_only boolean NOT NULL DEFAULT true,
  max_cases_per_run integer NOT NULL DEFAULT 50,
  call_llm boolean NOT NULL DEFAULT true,
  last_run_at timestamptz NULL,
  next_run_at timestamptz NULL,
  created_by uuid NULL,
  updated_by uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_schedules_ws ON public.ai_agent_regression_schedules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_schedules_enabled_next ON public.ai_agent_regression_schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_schedules_ws_enabled ON public.ai_agent_regression_schedules(workspace_id, enabled);

ALTER TABLE public.ai_agent_regression_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read regression schedules"
  ON public.ai_agent_regression_schedules FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "owner_admin insert regression schedules"
  ON public.ai_agent_regression_schedules FOR INSERT
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE POLICY "owner_admin update regression schedules"
  ON public.ai_agent_regression_schedules FOR UPDATE
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE POLICY "owner_admin delete regression schedules"
  ON public.ai_agent_regression_schedules FOR DELETE
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TABLE IF NOT EXISTS public.ai_agent_regression_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  schedule_id uuid NULL REFERENCES public.ai_agent_regression_schedules(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','scheduled')),
  total_cases integer NOT NULL DEFAULT 0,
  passed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  errored integer NOT NULL DEFAULT 0,
  pass_rate numeric NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  last_error text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_batches_ws_created ON public.ai_agent_regression_batches(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_batches_status_created ON public.ai_agent_regression_batches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_batches_schedule_created ON public.ai_agent_regression_batches(schedule_id, created_at DESC);

ALTER TABLE public.ai_agent_regression_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read regression batches"
  ON public.ai_agent_regression_batches FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "owner_admin insert regression batches"
  ON public.ai_agent_regression_batches FOR INSERT
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE POLICY "owner_admin update regression batches"
  ON public.ai_agent_regression_batches FOR UPDATE
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

ALTER TABLE public.ai_agent_test_runs
  ADD COLUMN IF NOT EXISTS regression_batch_id uuid NULL REFERENCES public.ai_agent_regression_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_runs_regression_batch ON public.ai_agent_test_runs(regression_batch_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at_e10()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_ai_regression_schedules_updated ON public.ai_agent_regression_schedules;
CREATE TRIGGER trg_ai_regression_schedules_updated
  BEFORE UPDATE ON public.ai_agent_regression_schedules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_e10();

DROP TRIGGER IF EXISTS trg_ai_regression_batches_updated ON public.ai_agent_regression_batches;
CREATE TRIGGER trg_ai_regression_batches_updated
  BEFORE UPDATE ON public.ai_agent_regression_batches
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_e10();