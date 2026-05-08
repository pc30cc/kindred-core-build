CREATE TABLE IF NOT EXISTS public.ai_operator_assist_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  requested_by uuid NULL,
  status text NOT NULL CHECK (status IN ('suggested','failed','skipped')),
  input_message text NULL,
  instruction text NULL,
  tone text NULL,
  suggestion text NULL,
  confidence numeric NULL,
  selected_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieval_debug jsonb NOT NULL DEFAULT '{}'::jsonb,
  answer_strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  safety_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text NULL,
  model text NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_op_assist_ws_conv_created
  ON public.ai_operator_assist_runs (workspace_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_ws_created
  ON public.ai_operator_assist_runs (workspace_id, created_at DESC);

ALTER TABLE public.ai_operator_assist_runs ENABLE ROW LEVEL SECURITY;

-- Workspace members can read assist runs for their workspace.
CREATE POLICY "ai_operator_assist_runs_select_members"
  ON public.ai_operator_assist_runs
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Direct client INSERT/UPDATE/DELETE intentionally not policy-allowed.
-- Writes go through the Express backend using the service role.
