-- AI Agent module — Phase 1 foundation
-- Self-hosted, workspace-isolated. Reuses existing AI provider + KB systems.

-- 1) ai_agent_settings — one row per workspace
CREATE TABLE IF NOT EXISTS public.ai_agent_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  agent_name text NOT NULL DEFAULT 'AI Assistant',
  agent_logo_url text,
  business_description text,
  answer_guidance text NOT NULL DEFAULT 'conservative',
  mode text NOT NULL DEFAULT 'off',
  answer_only_from_kb boolean NOT NULL DEFAULT true,
  welcome_message text,
  fallback_message text NOT NULL DEFAULT 'I''m not sure about that yet. I''ll connect you with a human agent.',
  handoff_keywords text[] NOT NULL DEFAULT ARRAY[
    'human','agent','operator','representative','speak to someone',
    'انسان','اپراتور','پشتیبان',
    'insan','operatör','temsilci','yetkili'
  ],
  max_replies_per_conversation integer NOT NULL DEFAULT 3,
  max_replies_per_hour integer NOT NULL DEFAULT 20,
  allowed_locales text[] NOT NULL DEFAULT ARRAY['en','tr','fa'],
  show_sources_to_operator boolean NOT NULL DEFAULT true,
  show_sources_to_visitor boolean NOT NULL DEFAULT false,
  -- Routing / handoff policy
  handoff_on_low_confidence boolean NOT NULL DEFAULT true,
  handoff_on_human_request boolean NOT NULL DEFAULT true,
  handoff_when_no_kb_match boolean NOT NULL DEFAULT true,
  confidence_threshold numeric NOT NULL DEFAULT 0.55,
  -- Free-form instructions (tone, forbidden topics, etc.)
  instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_settings_mode_chk CHECK (mode IN ('off','suggest_only','auto_reply_when_offline','auto_reply_until_human_joins','auto_reply_always')),
  CONSTRAINT ai_agent_settings_guidance_chk CHECK (answer_guidance IN ('conservative','balanced','creative'))
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_settings_workspace ON public.ai_agent_settings(workspace_id);

-- 2) ai_agent_runs — every playground/auto/suggest/handoff/skip event
CREATE TABLE IF NOT EXISTS public.ai_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid,
  visitor_message_id uuid,
  run_type text NOT NULL,
  mode text,
  status text NOT NULL,
  input_text text,
  output_text text,
  skip_reason text,
  error_message text,
  provider text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  credits_used integer NOT NULL DEFAULT 0,
  kb_article_ids uuid[] NOT NULL DEFAULT '{}',
  confidence numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_runs_run_type_chk CHECK (run_type IN ('playground','auto_reply','suggestion','handoff','skip')),
  CONSTRAINT ai_agent_runs_status_chk CHECK (status IN ('skipped','replied','suggested','handoff','failed','no_answer'))
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_workspace_created ON public.ai_agent_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_conversation ON public.ai_agent_runs(conversation_id) WHERE conversation_id IS NOT NULL;

-- 3) ai_agent_suggestions
CREATE TABLE IF NOT EXISTS public.ai_agent_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  visitor_message_id uuid,
  suggested_reply text NOT NULL,
  source_article_ids uuid[] NOT NULL DEFAULT '{}',
  confidence numeric,
  status text NOT NULL DEFAULT 'pending',
  created_by_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_suggestions_status_chk CHECK (status IN ('pending','used','dismissed','expired'))
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_suggestions_workspace ON public.ai_agent_suggestions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_suggestions_conversation ON public.ai_agent_suggestions(conversation_id);

-- 4) ai_agent_sources — registry placeholder
CREATE TABLE IF NOT EXISTS public.ai_agent_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'idle',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_sources_type_chk CHECK (source_type IN ('knowledge_base','web_pages','files','qna','integrations','mcp'))
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_sources_workspace ON public.ai_agent_sources(workspace_id);

-- 5) ai_agent_qna — manual Q&A pairs
CREATE TABLE IF NOT EXISTS public.ai_agent_qna (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_qna_workspace ON public.ai_agent_qna(workspace_id);

-- ─── updated_at triggers (reuse existing helper if present) ───
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column' AND pronamespace = 'public'::regnamespace) THEN
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS TRIGGER AS $f$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $f$ LANGUAGE plpgsql SET search_path = public;
  END IF;
END$$;

DROP TRIGGER IF EXISTS trg_ai_agent_settings_updated ON public.ai_agent_settings;
CREATE TRIGGER trg_ai_agent_settings_updated BEFORE UPDATE ON public.ai_agent_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_ai_agent_suggestions_updated ON public.ai_agent_suggestions;
CREATE TRIGGER trg_ai_agent_suggestions_updated BEFORE UPDATE ON public.ai_agent_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_ai_agent_sources_updated ON public.ai_agent_sources;
CREATE TRIGGER trg_ai_agent_sources_updated BEFORE UPDATE ON public.ai_agent_sources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_ai_agent_qna_updated ON public.ai_agent_qna;
CREATE TRIGGER trg_ai_agent_qna_updated BEFORE UPDATE ON public.ai_agent_qna
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── RLS — workspace-scoped via existing is_workspace_member helper ───
ALTER TABLE public.ai_agent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_qna ENABLE ROW LEVEL SECURITY;

-- Members can read; backend (service role) does writes via the API.
DROP POLICY IF EXISTS ai_agent_settings_member_read ON public.ai_agent_settings;
CREATE POLICY ai_agent_settings_member_read ON public.ai_agent_settings
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ai_agent_runs_member_read ON public.ai_agent_runs;
CREATE POLICY ai_agent_runs_member_read ON public.ai_agent_runs
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ai_agent_suggestions_member_read ON public.ai_agent_suggestions;
CREATE POLICY ai_agent_suggestions_member_read ON public.ai_agent_suggestions
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ai_agent_sources_member_read ON public.ai_agent_sources;
CREATE POLICY ai_agent_sources_member_read ON public.ai_agent_sources
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ai_agent_qna_member_read ON public.ai_agent_qna;
CREATE POLICY ai_agent_qna_member_read ON public.ai_agent_qna
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));
