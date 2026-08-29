-- 057_ai_agent_conversation_metadata_atomicity.sql
--
-- WebYar Support Intelligence vNext — blockers 3 & 5.
--
--   1. Atomic conversation metadata patching (no read-modify-write races).
--      `conversations.metadata` is written concurrently by the AI engine
--      (handoff state, working memory) and by operator/routing code. The
--      previous SELECT → merge-in-JS → UPDATE pattern lost updates whenever
--      two writers overlapped: whichever wrote last silently discarded the
--      other's keys. Both writers now go through server-side functions that
--      merge inside a single statement / locked row.
--
--   2. Workspace ↔ conversation consistency for the vNext guidance tables.
--      `ai_agent_guidance(workspace_id, conversation_id)` could previously
--      reference a conversation belonging to a DIFFERENT workspace (two
--      independent single-column FKs). A composite FK now makes a
--      cross-tenant guidance row impossible at the database level, not only
--      in application code.
--
-- Idempotent: safe to re-run.

-- ── 1. Composite key on conversations ─────────────────────────────────
DO $$ BEGIN
  ALTER TABLE public.conversations
    ADD CONSTRAINT conversations_id_workspace_uk UNIQUE (id, workspace_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- ── 2. Tenant-consistent guidance FKs ─────────────────────────────────
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

-- ── 3. Atomic shallow metadata patch ──────────────────────────────────
-- Returns the resulting metadata document, or NULL when the conversation
-- does not exist in that workspace. Callers that must be TRUTHFUL about a
-- durable state transition (handoff) treat NULL as failure.
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

-- ── 4. Compare-and-set for AI working memory ──────────────────────────
-- Working memory is not a shallow patch: the next document is computed in
-- TypeScript from the previous one (attempt counters, resolution state).
-- A blind write would still lose updates, so the write is guarded by a
-- monotonic `rev` counter. On mismatch the current document is returned and
-- the caller recomputes the patch against it and retries.
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
