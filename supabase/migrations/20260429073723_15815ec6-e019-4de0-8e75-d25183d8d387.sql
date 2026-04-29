ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS escalation_style text NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS allow_clarifying_questions boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_clarification_attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS allow_answer_with_caveat boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS learning_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_create_learning_candidates boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS require_approval_for_learning boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_settings_escalation_style_check'
  ) THEN
    ALTER TABLE public.ai_agent_settings
      ADD CONSTRAINT ai_agent_settings_escalation_style_check
      CHECK (escalation_style IN ('conservative','balanced','helpful_first'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_settings_max_clar_attempts_check'
  ) THEN
    ALTER TABLE public.ai_agent_settings
      ADD CONSTRAINT ai_agent_settings_max_clar_attempts_check
      CHECK (max_clarification_attempts BETWEEN 0 AND 5);
  END IF;
END $$;