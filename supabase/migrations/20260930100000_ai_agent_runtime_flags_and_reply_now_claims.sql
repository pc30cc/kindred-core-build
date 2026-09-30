-- AI Agent: atomic runtime-flag patch + durable "AI Reply Now" claims.
--
-- Mirrors self-host migrations 058 and 059, which never reached this chain.
-- The server calls both:
--   * server/services/ai-agent/runtime/conversationState.ts →
--     rpc('patch_conversation_runtime_flags'). Without it the code falls back
--     to a non-atomic read-modify-write of conversations.metadata that can
--     revert a concurrent handoff (ai_state = 'needs_human') or takeover.
--   * server/services/ai-agent/replyNowClaims.ts →
--     ai_agent_reply_now_claims. Without the table every claim insert fails,
--     the follow-up read finds nothing, and claimReplyNow() ends at
--     'duplicate_running' — "AI Reply Now" never runs.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.patch_conversation_runtime_flags(
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
  v_arr  jsonb;
  v_key  text;
  v_val  text;
BEGIN
  IF p_conversation_id IS NULL THEN RETURN NULL; END IF;

  SELECT metadata INTO v_meta
    FROM public.conversations
   WHERE id = p_conversation_id
     AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_meta := COALESCE(v_meta, '{}'::jsonb);

  IF COALESCE((p_patch ->> 'greeting_sent')::boolean, false) THEN
    v_meta := v_meta || jsonb_build_object('ai_greeting_sent', true);
  END IF;

  IF COALESCE((p_patch ->> 'handoff_sent')::boolean, false) THEN
    v_meta := v_meta || jsonb_build_object('ai_handoff_sent', true);
  END IF;

  -- Append-once list merges (order preserved, duplicates ignored).
  FOR v_key, v_val IN
    SELECT * FROM (VALUES
      ('ai_trigger_executed_ids',      p_patch ->> 'append_trigger_id'),
      ('ai_workflow_planned_ids',      p_patch ->> 'append_workflow_id'),
      ('ai_routing_executed_rule_ids', p_patch ->> 'append_routing_rule_id')
    ) AS t(k, v)
  LOOP
    CONTINUE WHEN v_val IS NULL OR v_val = '';
    v_arr := v_meta -> v_key;
    IF v_arr IS NULL OR jsonb_typeof(v_arr) <> 'array' THEN
      v_arr := '[]'::jsonb;
    END IF;
    IF NOT (v_arr @> to_jsonb(v_val)) THEN
      v_arr := v_arr || jsonb_build_array(v_val);
    END IF;
    v_meta := v_meta || jsonb_build_object(v_key, v_arr);
  END LOOP;

  IF COALESCE((p_patch ->> 'touch')::boolean, true) THEN
    v_meta := v_meta || jsonb_build_object(
      'ai_last_runtime_action_at',
      to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;

  UPDATE public.conversations
     SET metadata = v_meta,
         updated_at = now()
   WHERE id = p_conversation_id;

  RETURN v_meta;
END;
$$;

REVOKE ALL ON FUNCTION public.patch_conversation_runtime_flags(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.patch_conversation_runtime_flags(uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.patch_conversation_runtime_flags(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.patch_conversation_runtime_flags(uuid, uuid, jsonb) TO service_role;

CREATE TABLE IF NOT EXISTS public.ai_agent_reply_now_claims (
  claim_key text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  operation text NOT NULL DEFAULT 'ai_reply_now',
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  result jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reply_now_claims_scope
  ON public.ai_agent_reply_now_claims(workspace_id, conversation_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ai_reply_now_claims_expiry
  ON public.ai_agent_reply_now_claims(expires_at);

GRANT ALL ON public.ai_agent_reply_now_claims TO service_role;

ALTER TABLE public.ai_agent_reply_now_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages ai reply now claims" ON public.ai_agent_reply_now_claims;
CREATE POLICY "Service role manages ai reply now claims"
  ON public.ai_agent_reply_now_claims
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Server-only table: customer roles get nothing, whatever the project's
-- default privileges grant on creation (RLS already denies them rows).
REVOKE ALL ON public.ai_agent_reply_now_claims FROM PUBLIC, anon, authenticated;
