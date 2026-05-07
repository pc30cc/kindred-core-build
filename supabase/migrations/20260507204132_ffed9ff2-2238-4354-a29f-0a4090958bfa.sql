
ALTER TABLE public.ai_agent_learning_candidates
  ADD COLUMN IF NOT EXISTS reason text;

UPDATE public.ai_agent_learning_candidates
   SET reason = COALESCE(reason, metadata->>'reason')
 WHERE reason IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_agent_learning_candidates_reason_check'
  ) THEN
    ALTER TABLE public.ai_agent_learning_candidates
      ADD CONSTRAINT ai_agent_learning_candidates_reason_check
      CHECK (reason IS NULL OR reason IN (
        'no_answer','low_confidence','handoff_after_ai',
        'repeated_clarification','no_indexed_page','no_url',
        'operator_answer_available','other'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_agent_learning_candidates_ws_status_reason_idx
  ON public.ai_agent_learning_candidates (workspace_id, status, reason);

CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_learning_candidates_pending_uniq
  ON public.ai_agent_learning_candidates (workspace_id, normalized_question)
  WHERE status = 'pending';
