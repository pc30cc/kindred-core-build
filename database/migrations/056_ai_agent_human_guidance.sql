-- 056_ai_agent_human_guidance.sql
--
-- WebYar Support Intelligence vNext — Human Guidance, guidance requests and
-- adaptive handoff policy.
--
-- Adds:
--   1. public.ai_agent_guidance          — private operator → AI guidance
--   2. public.ai_agent_guidance_requests — AI → operator "I need one fact"
--   3. ai_agent_settings.handoff_policy / max_assist_attempts
--
-- Human guidance is PRIVATE workspace data. It is never a visitor-facing
-- message and never lands in conversation_messages, so it can never be
-- mistaken for a public human reply by takeover detection.
--
-- Idempotent: safe to re-run.

-- ── 1. Human guidance ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_agent_guidance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  -- 'direction' = how to answer, 'fact' = trusted ephemeral business fact
  kind              text NOT NULL DEFAULT 'direction',
  -- 'next_turn' = consumed by the next AI generation, 'conversation' = sticky
  scope             text NOT NULL DEFAULT 'next_turn',
  body              text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  operator_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  operator_name     text,
  consumed_at       timestamptz,
  consumed_by_run_id uuid,
  use_count         integer NOT NULL DEFAULT 0,
  expires_at        timestamptz,
  request_id        uuid,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance
    ADD CONSTRAINT ai_agent_guidance_kind_chk CHECK (kind IN ('direction','fact'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance
    ADD CONSTRAINT ai_agent_guidance_scope_chk CHECK (scope IN ('next_turn','conversation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance
    ADD CONSTRAINT ai_agent_guidance_status_chk
    CHECK (status IN ('active','consumed','expired','revoked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bounded payload: guidance is a short instruction, not a document dump.
DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance
    ADD CONSTRAINT ai_agent_guidance_body_len_chk
    CHECK (char_length(body) BETWEEN 1 AND 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_ai_agent_guidance_active
  ON public.ai_agent_guidance (conversation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_guidance_workspace
  ON public.ai_agent_guidance (workspace_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_agent_guidance TO authenticated;
GRANT ALL ON public.ai_agent_guidance TO service_role;

ALTER TABLE public.ai_agent_guidance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage conversation guidance" ON public.ai_agent_guidance;
CREATE POLICY "Members manage conversation guidance"
  ON public.ai_agent_guidance FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role manages guidance" ON public.ai_agent_guidance;
CREATE POLICY "Service role manages guidance"
  ON public.ai_agent_guidance FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 2. AI → operator guidance requests ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_agent_guidance_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  visitor_message_id  uuid,
  run_id              uuid,
  -- factual summaries only — never model chain-of-thought
  visitor_question    text,
  known_summary       text,
  missing_information text,
  question            text NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_guidance_id uuid REFERENCES public.ai_agent_guidance(id) ON DELETE SET NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance_requests
    ADD CONSTRAINT ai_agent_guidance_requests_status_chk
    CHECK (status IN ('pending','resolved','dismissed','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- At most one pending guidance request per conversation — no infinite
-- pending states, no operator card spam.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_guidance_requests_one_pending
  ON public.ai_agent_guidance_requests (conversation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ai_agent_guidance_requests_ws
  ON public.ai_agent_guidance_requests (workspace_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_agent_guidance_requests TO authenticated;
GRANT ALL ON public.ai_agent_guidance_requests TO service_role;

ALTER TABLE public.ai_agent_guidance_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage guidance requests" ON public.ai_agent_guidance_requests;
CREATE POLICY "Members manage guidance requests"
  ON public.ai_agent_guidance_requests FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role manages guidance requests" ON public.ai_agent_guidance_requests;
CREATE POLICY "Service role manages guidance requests"
  ON public.ai_agent_guidance_requests FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 3. Adaptive handoff policy on ai_agent_settings ───────────────────
-- Backward compatibility: NULL means "derive from handoff_on_human_request"
-- at read time (true → immediate, false → adaptive). Existing workspaces
-- therefore keep byte-identical behaviour until an owner opts in.
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS handoff_policy text;
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS max_assist_attempts integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE public.ai_agent_settings
    ADD CONSTRAINT ai_agent_settings_handoff_policy_chk
    CHECK (handoff_policy IS NULL OR handoff_policy IN ('immediate','assist_first','adaptive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
