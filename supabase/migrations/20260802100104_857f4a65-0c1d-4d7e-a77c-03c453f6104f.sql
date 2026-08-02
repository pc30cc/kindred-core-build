-- ============================================================
-- Phase 6-S5-R2 — Knowledge Base authorization, ownership
-- invariants and durable outbox leases.
-- ============================================================

-- ─── 1. Granular workspace permissions ──────────────────────
CREATE OR REPLACE FUNCTION public.default_workspace_permission(_role text, _permission_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _role IN ('owner', 'admin') THEN true
    WHEN _permission_key = 'can_manage_knowledge_base'
      THEN _role IN ('team_lead', 'marketing_manager', 'seo_manager', 'support_agent', 'developer')
    WHEN _permission_key = 'can_publish_knowledge_base'
      THEN _role IN ('team_lead', 'marketing_manager', 'seo_manager')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.has_workspace_permission(
  _workspace_id uuid, _user_id uuid, _permission_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _role text;
  _granted boolean;
BEGIN
  IF _workspace_id IS NULL OR _user_id IS NULL OR _permission_key IS NULL THEN
    RETURN false;
  END IF;

  SELECT role::text INTO _role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  SELECT granted INTO _granted
  FROM public.role_permissions
  WHERE workspace_id = _workspace_id
    AND role_slug = _role
    AND permission_key = _permission_key
  LIMIT 1;

  IF _granted IS NOT NULL THEN
    RETURN _granted;
  END IF;

  RETURN public.default_workspace_permission(_role, _permission_key);
END;
$$;

REVOKE ALL ON FUNCTION public.default_workspace_permission(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_workspace_permission(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.default_workspace_permission(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_workspace_permission(uuid, uuid, text) TO authenticated, service_role;

-- ─── 2. Composite workspace-ownership invariant ─────────────
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_categories_id_workspace_key
  ON public.knowledge_base_categories (id, workspace_id);

ALTER TABLE public.knowledge_base_articles
  DROP CONSTRAINT IF EXISTS knowledge_base_articles_category_id_fkey;

ALTER TABLE public.knowledge_base_articles
  DROP CONSTRAINT IF EXISTS knowledge_base_articles_category_workspace_fkey;

ALTER TABLE public.knowledge_base_articles
  ADD CONSTRAINT knowledge_base_articles_category_workspace_fkey
  FOREIGN KEY (category_id, workspace_id)
  REFERENCES public.knowledge_base_categories (id, workspace_id)
  ON DELETE SET NULL;

-- ─── 3. RLS: no direct client writes; entitled reads only ───
DROP POLICY IF EXISTS "Members with plan can insert KB articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Members with plan can update KB articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Members with plan can delete KB articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Members with plan can insert KB categories" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Members with plan can update KB categories" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Members with plan can delete KB categories" ON public.knowledge_base_categories;

-- This anon policy leaked categories of workspaces without the module.
DROP POLICY IF EXISTS "Public can read KB categories with published articles" ON public.knowledge_base_categories;

REVOKE INSERT, UPDATE, DELETE ON public.knowledge_base_articles FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.knowledge_base_categories FROM authenticated, anon;
GRANT SELECT ON public.knowledge_base_articles TO anon, authenticated;
GRANT SELECT ON public.knowledge_base_categories TO anon, authenticated;
GRANT ALL ON public.knowledge_base_articles TO service_role;
GRANT ALL ON public.knowledge_base_categories TO service_role;

-- ─── 4. Durable outbox: lease columns ───────────────────────
ALTER TABLE public.knowledge_base_change_events
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS knowledge_base_change_events_pending_idx
  ON public.knowledge_base_change_events (next_attempt_at, created_at)
  WHERE processed_at IS NULL;

-- ─── 5. Atomic lease / complete / fail ──────────────────────
CREATE OR REPLACE FUNCTION public.claim_kb_change_events(
  _worker_id text, _limit integer DEFAULT 100, _lease_seconds integer DEFAULT 300
)
RETURNS TABLE (id uuid, workspace_id uuid, event_type text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM public.knowledge_base_change_events e
    WHERE e.processed_at IS NULL
      AND e.next_attempt_at <= now()
      AND (e.locked_at IS NULL OR e.locked_at < now() - make_interval(secs => GREATEST(_lease_seconds, 30)))
    ORDER BY e.created_at ASC
    LIMIT GREATEST(LEAST(COALESCE(_limit, 100), 500), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.knowledge_base_change_events e
  SET locked_at = now(), locked_by = _worker_id, updated_at = now()
  FROM candidate c
  WHERE e.id = c.id
  RETURNING e.id, e.workspace_id, e.event_type, e.attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_kb_change_events(_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  UPDATE public.knowledge_base_change_events
  SET processed_at = now(), locked_at = NULL, locked_by = NULL,
      last_error = NULL, updated_at = now()
  WHERE id = ANY(_ids) AND processed_at IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_kb_change_events(
  _ids uuid[], _error text, _retry_seconds integer DEFAULT 60, _max_attempts integer DEFAULT 10
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  UPDATE public.knowledge_base_change_events e
  SET attempts = e.attempts + 1,
      last_error = LEFT(COALESCE(_error, 'unknown'), 500),
      locked_at = NULL,
      locked_by = NULL,
      next_attempt_at = now() + make_interval(secs => GREATEST(_retry_seconds, 5) * LEAST(e.attempts + 1, 10)),
      processed_at = CASE WHEN e.attempts + 1 >= _max_attempts THEN now() ELSE NULL END,
      updated_at = now()
  WHERE e.id = ANY(_ids) AND e.processed_at IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- Deterministic catch-up: re-queue a workspace after a plan upgrade.
CREATE OR REPLACE FUNCTION public.enqueue_kb_catchup(_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  IF _workspace_id IS NULL THEN RETURN 0; END IF;
  IF EXISTS (
    SELECT 1 FROM public.knowledge_base_change_events
    WHERE workspace_id = _workspace_id
      AND event_type = 'catchup'
      AND processed_at IS NULL
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.knowledge_base_change_events (workspace_id, event_type)
  VALUES (_workspace_id, 'catchup');
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_kb_change_events(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_kb_change_events(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_kb_change_events(uuid[], text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_kb_catchup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kb_change_events(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_kb_change_events(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_kb_change_events(uuid[], text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_kb_catchup(uuid) TO service_role;