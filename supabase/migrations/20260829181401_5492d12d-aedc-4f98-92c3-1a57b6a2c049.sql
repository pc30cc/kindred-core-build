CREATE TABLE IF NOT EXISTS public.ai_agent_guidance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'direction',
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

CREATE TABLE IF NOT EXISTS public.ai_agent_guidance_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  visitor_message_id  uuid,
  run_id              uuid,
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

ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS handoff_policy text;
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS max_assist_attempts integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE public.ai_agent_settings
    ADD CONSTRAINT ai_agent_settings_handoff_policy_chk
    CHECK (handoff_policy IS NULL OR handoff_policy IN ('immediate','assist_first','adaptive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.conversations
    ADD CONSTRAINT conversations_id_workspace_uk UNIQUE (id, workspace_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance
    DROP CONSTRAINT IF EXISTS ai_agent_guidance_conversation_id_fkey;
  ALTER TABLE public.ai_agent_guidance
    ADD CONSTRAINT ai_agent_guidance_conversation_ws_fkey
    FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES public.conversations (id, workspace_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.ai_agent_guidance_requests
    DROP CONSTRAINT IF EXISTS ai_agent_guidance_requests_conversation_id_fkey;
  ALTER TABLE public.ai_agent_guidance_requests
    ADD CONSTRAINT ai_agent_guidance_requests_conversation_ws_fkey
    FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES public.conversations (id, workspace_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.patch_conversation_metadata(
  p_conversation_id uuid,
  p_workspace_id    uuid,
  p_patch           jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb;
BEGIN
  IF p_conversation_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.conversations
     SET metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_patch, '{}'::jsonb),
         updated_at = now()
   WHERE id = p_conversation_id
     AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
  RETURNING metadata INTO v_meta;
  RETURN v_meta;
END;
$$;

REVOKE ALL ON FUNCTION public.patch_conversation_metadata(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.patch_conversation_metadata(uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.patch_conversation_metadata(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.patch_conversation_metadata(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.patch_conversation_ai_memory(
  p_conversation_id uuid,
  p_workspace_id    uuid,
  p_expected_rev    bigint,
  p_memory          jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta    jsonb;
  v_rev     bigint;
  v_next    jsonb;
BEGIN
  IF p_conversation_id IS NULL THEN RETURN NULL; END IF;

  SELECT metadata INTO v_meta
    FROM public.conversations
   WHERE id = p_conversation_id
     AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_rev := COALESCE((v_meta -> 'ai_memory' ->> 'rev')::bigint, 0);
  IF p_expected_rev IS NOT NULL AND v_rev <> p_expected_rev THEN
    RETURN jsonb_build_object(
      'conflict', true,
      'rev', v_rev,
      'memory', COALESCE(v_meta -> 'ai_memory', '{}'::jsonb)
    );
  END IF;

  v_next := jsonb_set(
    COALESCE(v_meta, '{}'::jsonb),
    '{ai_memory}',
    COALESCE(p_memory, '{}'::jsonb) || jsonb_build_object('rev', v_rev + 1),
    true
  );

  UPDATE public.conversations
     SET metadata = v_next,
         updated_at = now()
   WHERE id = p_conversation_id;

  RETURN jsonb_build_object(
    'conflict', false,
    'rev', v_rev + 1,
    'memory', v_next -> 'ai_memory'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.patch_conversation_ai_memory(uuid, uuid, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.patch_conversation_ai_memory(uuid, uuid, bigint, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.patch_conversation_ai_memory(uuid, uuid, bigint, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.patch_conversation_ai_memory(uuid, uuid, bigint, jsonb) TO service_role;