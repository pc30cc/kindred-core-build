CREATE TABLE IF NOT EXISTS public.ai_operator_assist_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  assist_run_id uuid NOT NULL REFERENCES public.ai_operator_assist_runs(id) ON DELETE CASCADE,
  conversation_id uuid NULL,
  submitted_by uuid NULL,
  rating text NOT NULL CHECK (rating IN ('positive','negative','neutral')),
  reason text NULL CHECK (reason IS NULL OR reason IN (
    'helpful','wrong_answer','missing_context','bad_tone',
    'too_long','too_short','unsafe','not_grounded','other'
  )),
  comment text NULL,
  operator_action text NULL CHECK (operator_action IS NULL OR operator_action IN (
    'inserted','replaced','appended','copied','dismissed','regenerated','sent_after_edit','sent_as_is'
  )),
  final_composer_text text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_ws_created
  ON public.ai_operator_assist_feedback (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_run
  ON public.ai_operator_assist_feedback (assist_run_id);
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_rating
  ON public.ai_operator_assist_feedback (rating);
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_reason
  ON public.ai_operator_assist_feedback (reason);
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_action
  ON public.ai_operator_assist_feedback (operator_action);

ALTER TABLE public.ai_operator_assist_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_op_assist_fb_select_members"
  ON public.ai_operator_assist_feedback
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "ai_op_assist_fb_insert_operators"
  ON public.ai_operator_assist_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = ai_operator_assist_feedback.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role::text IN ('owner','admin','agent','support_agent','team_lead')
    )
  );

CREATE POLICY "ai_op_assist_fb_delete_admins"
  ON public.ai_operator_assist_feedback
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = ai_operator_assist_feedback.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role::text IN ('owner','admin')
    )
  );
