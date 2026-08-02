-- ============================================================
-- Phase 6-S5-R3 — Final KB/AI authorization, lease ownership,
-- durable deferral and index reconciliation. Forward-only.
-- ============================================================

-- ─── 1. Least-privilege default KB permissions ──────────────
-- Explicit role_permissions overrides remain authoritative (handled in
-- public.has_workspace_permission). Defaults are owner/admin only.
CREATE OR REPLACE FUNCTION public.default_workspace_permission(_role text, _permission_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _permission_key IN ('can_manage_knowledge_base', 'can_publish_knowledge_base')
      THEN _role IN ('owner', 'admin')
    WHEN _role IN ('owner', 'admin') THEN true
    ELSE false
  END
$$;

-- ─── 2. Category delete must never NULL workspace_id ────────
CREATE OR REPLACE FUNCTION public.kb_detach_articles_before_category_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.knowledge_base_articles
  SET category_id = NULL
  WHERE category_id = OLD.id
    AND workspace_id = OLD.workspace_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.kb_detach_articles_before_category_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS kb_categories_detach_articles ON public.knowledge_base_categories;
CREATE TRIGGER kb_categories_detach_articles
  BEFORE DELETE ON public.knowledge_base_categories
  FOR EACH ROW EXECUTE FUNCTION public.kb_detach_articles_before_category_delete();

-- Composite ownership stays, but ON DELETE SET NULL (which would also NULL
-- workspace_id) is replaced by NO ACTION + the trigger above.
ALTER TABLE public.knowledge_base_articles
  DROP CONSTRAINT IF EXISTS knowledge_base_articles_category_workspace_fkey;

ALTER TABLE public.knowledge_base_articles
  ADD CONSTRAINT knowledge_base_articles_category_workspace_fkey
  FOREIGN KEY (category_id, workspace_id)
  REFERENCES public.knowledge_base_categories (id, workspace_id)
  ON DELETE NO ACTION;

-- ─── 3. Private SELECT must be plan-gated ───────────────────
DROP POLICY IF EXISTS "Members can read KB articles" ON public.knowledge_base_articles;
CREATE POLICY "Members with plan can read KB articles"
  ON public.knowledge_base_articles FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id)
  );

DROP POLICY IF EXISTS "Members can read KB categories" ON public.knowledge_base_categories;
CREATE POLICY "Members with plan can read KB categories"
  ON public.knowledge_base_categories FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id)
  );

-- ─── 4. Public category policy: no empty/internal leaks ─────
-- Documented product policy: published public content is visible ONLY while
-- the knowledge_base entitlement is active (no billing grace period).
DROP POLICY IF EXISTS "Public can read KB categories of entitled workspaces" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Public can read KB categories with published articles" ON public.knowledge_base_categories;

CREATE POLICY "Public can read non-empty KB categories of entitled workspaces"
  ON public.knowledge_base_categories FOR SELECT TO anon
  USING (
    public.workspace_has_knowledge_base(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.knowledge_base_articles a
      WHERE a.category_id = knowledge_base_categories.id
        AND a.workspace_id = knowledge_base_categories.workspace_id
        AND a.status = 'published'
    )
  );

CREATE INDEX IF NOT EXISTS knowledge_base_articles_category_published_idx
  ON public.knowledge_base_articles (category_id, workspace_id)
  WHERE status = 'published';

-- ─── 5. Outbox: stored lease expiration + ownership token ───
ALTER TABLE public.knowledge_base_change_events
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_detail text;

-- Any lease held under the old (locked_at only) model expires immediately.
UPDATE public.knowledge_base_change_events
SET locked_at = NULL, locked_by = NULL
WHERE processed_at IS NULL AND locked_at IS NOT NULL;

DROP INDEX IF EXISTS knowledge_base_change_events_pending_idx;
CREATE INDEX knowledge_base_change_events_pending_idx
  ON public.knowledge_base_change_events (next_attempt_at, created_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS knowledge_base_change_events_claim_idx
  ON public.knowledge_base_change_events (claim_token)
  WHERE claim_token IS NOT NULL;

-- ─── 6. Claim / complete / defer / fail with owner enforcement ──
DROP FUNCTION IF EXISTS public.claim_kb_change_events(text, integer, integer);
DROP FUNCTION IF EXISTS public.complete_kb_change_events(uuid[]);
DROP FUNCTION IF EXISTS public.fail_kb_change_events(uuid[], text, integer, integer);

CREATE FUNCTION public.claim_kb_change_events(
  _worker_id text,
  _limit integer DEFAULT 100,
  _lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  event_type text,
  attempts integer,
  claim_token uuid,
  claim_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _token uuid := gen_random_uuid();
  _lease integer := GREATEST(COALESCE(_lease_seconds, 300), 30);
  _batch integer := GREATEST(LEAST(COALESCE(_limit, 100), 500), 1);
BEGIN
  IF _worker_id IS NULL OR btrim(_worker_id) = '' THEN
    RAISE EXCEPTION 'worker_id_required';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM public.knowledge_base_change_events e
    WHERE e.processed_at IS NULL
      AND e.dead_lettered_at IS NULL
      AND e.next_attempt_at <= now()
      AND (e.claim_token IS NULL OR e.claim_expires_at IS NULL OR e.claim_expires_at < now())
    ORDER BY e.next_attempt_at ASC, e.created_at ASC
    LIMIT _batch
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.knowledge_base_change_events e
  SET claim_token = _token,
      claimed_by = _worker_id,
      claimed_at = now(),
      claim_expires_at = now() + make_interval(secs => _lease),
      locked_at = now(),
      locked_by = _worker_id,
      updated_at = now()
  FROM candidate c
  WHERE e.id = c.id
  RETURNING e.id, e.workspace_id, e.event_type, e.attempts, e.claim_token, e.claim_expires_at;
END;
$$;

CREATE FUNCTION public.complete_kb_change_events(
  _claim_token uuid,
  _worker_id text,
  _ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  IF _claim_token IS NULL OR _worker_id IS NULL OR _ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.knowledge_base_change_events e
  SET processed_at = now(),
      claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL,
      locked_at = NULL, locked_by = NULL,
      last_error = NULL, last_error_code = NULL, last_error_detail = NULL,
      updated_at = now()
  WHERE e.id = ANY(_ids)
    AND e.processed_at IS NULL
    AND e.claim_token = _claim_token
    AND e.claimed_by = _worker_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- Deferral: temporary condition (plan off, platform off, provider down,
-- entitlement lookup failure). Never increments attempts, never dead-letters.
CREATE FUNCTION public.defer_kb_change_events(
  _claim_token uuid,
  _worker_id text,
  _ids uuid[],
  _error_code text,
  _retry_seconds integer DEFAULT 300
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  IF _claim_token IS NULL OR _worker_id IS NULL OR _ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.knowledge_base_change_events e
  SET claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL,
      locked_at = NULL, locked_by = NULL,
      last_error_code = LEFT(COALESCE(_error_code, 'deferred'), 100),
      last_error = LEFT(COALESCE(_error_code, 'deferred'), 500),
      next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(_retry_seconds, 300), 30)),
      updated_at = now()
  WHERE e.id = ANY(_ids)
    AND e.processed_at IS NULL
    AND e.claim_token = _claim_token
    AND e.claimed_by = _worker_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- Failure: real error. Increments attempts, exponential backoff, and
-- dead-letters on permanent errors or after _max_attempts.
CREATE FUNCTION public.fail_kb_change_events(
  _claim_token uuid,
  _worker_id text,
  _ids uuid[],
  _error_code text,
  _error_detail text DEFAULT NULL,
  _retry_seconds integer DEFAULT 60,
  _permanent boolean DEFAULT false,
  _max_attempts integer DEFAULT 10
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  IF _claim_token IS NULL OR _worker_id IS NULL OR _ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.knowledge_base_change_events e
  SET attempts = e.attempts + 1,
      last_error_code = LEFT(COALESCE(_error_code, 'unknown'), 100),
      last_error_detail = LEFT(_error_detail, 500),
      last_error = LEFT(COALESCE(_error_code, 'unknown'), 500),
      claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL,
      locked_at = NULL, locked_by = NULL,
      next_attempt_at = now() + make_interval(
        secs => GREATEST(COALESCE(_retry_seconds, 60), 5) * LEAST(e.attempts + 1, 10)
      ),
      dead_lettered_at = CASE
        WHEN COALESCE(_permanent, false) THEN now()
        WHEN e.attempts + 1 >= GREATEST(COALESCE(_max_attempts, 10), 1) THEN now()
        ELSE NULL
      END,
      updated_at = now()
  WHERE e.id = ANY(_ids)
    AND e.processed_at IS NULL
    AND e.claim_token = _claim_token
    AND e.claimed_by = _worker_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- Catch-up stays idempotent, and also makes deferred events eligible now.
CREATE OR REPLACE FUNCTION public.enqueue_kb_catchup(_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer := 0;
BEGIN
  IF _workspace_id IS NULL THEN RETURN 0; END IF;

  -- Deferred events for this workspace become immediately eligible again.
  UPDATE public.knowledge_base_change_events
  SET next_attempt_at = now(), updated_at = now()
  WHERE workspace_id = _workspace_id
    AND processed_at IS NULL
    AND dead_lettered_at IS NULL
    AND next_attempt_at > now();

  IF EXISTS (
    SELECT 1 FROM public.knowledge_base_change_events
    WHERE workspace_id = _workspace_id
      AND event_type = 'catchup'
      AND processed_at IS NULL
      AND dead_lettered_at IS NULL
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
REVOKE ALL ON FUNCTION public.complete_kb_change_events(uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_kb_change_events(uuid, text, uuid[], text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_kb_change_events(uuid, text, uuid[], text, text, integer, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_kb_catchup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kb_change_events(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_kb_change_events(uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_kb_change_events(uuid, text, uuid[], text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_kb_change_events(uuid, text, uuid[], text, text, integer, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_kb_catchup(uuid) TO service_role;

-- ─── 7. Idempotent backfill of existing published AI articles ───
INSERT INTO public.knowledge_base_change_events (workspace_id, event_type)
SELECT DISTINCT a.workspace_id, 'catchup'
FROM public.knowledge_base_articles a
WHERE a.status = 'published'
  AND a.used_by_ai = true
  AND NOT EXISTS (
    SELECT 1 FROM public.knowledge_base_change_events e
    WHERE e.workspace_id = a.workspace_id
      AND e.event_type = 'catchup'
      AND e.processed_at IS NULL
      AND e.dead_lettered_at IS NULL
  );