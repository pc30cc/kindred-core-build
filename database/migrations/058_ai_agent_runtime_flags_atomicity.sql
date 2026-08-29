-- 058_ai_agent_runtime_flags_atomicity.sql
--
-- WebYar Support Intelligence vNext — runtime-state atomicity.
--
-- `server/services/ai-agent/runtime/conversationState.ts` used to update the
-- AI runtime dedup flags (ai_greeting_sent / ai_handoff_sent /
-- ai_trigger_executed_ids / ai_workflow_planned_ids /
-- ai_routing_executed_rule_ids / ai_last_runtime_action_at) with a
-- whole-document read-modify-write:
--
--    SELECT metadata → merge in JavaScript → UPDATE metadata
--
-- Any conversation-metadata write that landed between the SELECT and the
-- UPDATE was silently reverted — including `ai_state = 'needs_human'`
-- (handoff), `human_takeover_at` (operator takeover) and `ai_memory`
-- (working memory). This function performs the same merge server-side under
-- a row lock, so only the runtime-flag keys are ever touched.
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
