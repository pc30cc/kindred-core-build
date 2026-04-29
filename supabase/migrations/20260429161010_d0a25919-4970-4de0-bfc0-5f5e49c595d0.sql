CREATE TABLE IF NOT EXISTS public.ai_agent_learning_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NULL,
  visitor_message_id uuid NULL,
  operator_message_id uuid NULL,
  question_text text NOT NULL,
  answer_text text NOT NULL,
  normalized_question text NOT NULL,
  source_type text NOT NULL DEFAULT 'operator_reply',
  locale text NULL,
  confidence_score numeric NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','converted_to_qna','converted_to_kb')),
  suggested_title text NULL,
  suggested_answer text NULL,
  suggested_tags text[] NOT NULL DEFAULT '{}',
  reviewed_by uuid NULL,
  reviewed_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_ws_status
  ON public.ai_agent_learning_candidates(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_ws_norm
  ON public.ai_agent_learning_candidates(workspace_id, normalized_question);
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_conv
  ON public.ai_agent_learning_candidates(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_created
  ON public.ai_agent_learning_candidates(created_at DESC);

DROP TRIGGER IF EXISTS trg_ai_learn_cand_updated ON public.ai_agent_learning_candidates;
CREATE TRIGGER trg_ai_learn_cand_updated
  BEFORE UPDATE ON public.ai_agent_learning_candidates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_agent_learning_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_learn_cand_member_read ON public.ai_agent_learning_candidates;
CREATE POLICY ai_learn_cand_member_read
  ON public.ai_agent_learning_candidates
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ai_learn_cand_admin_write ON public.ai_agent_learning_candidates;
CREATE POLICY ai_learn_cand_admin_write
  ON public.ai_agent_learning_candidates
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = ai_agent_learning_candidates.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = ai_agent_learning_candidates.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  );