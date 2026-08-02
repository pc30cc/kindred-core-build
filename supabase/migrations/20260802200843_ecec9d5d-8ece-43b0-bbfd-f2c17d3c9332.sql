-- Phase 6-S5-R4
-- 1. Knowledge Base is a CORE product: remove every plan/entitlement
--    dependency from RLS. No policy may reference workspace_has_knowledge_base.

DROP POLICY IF EXISTS "Members with plan can read KB articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Public can read published articles of entitled workspaces" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Members with plan can read KB categories" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Public can read non-empty KB categories of entitled workspaces" ON public.knowledge_base_categories;

CREATE POLICY "Members can read KB articles"
ON public.knowledge_base_articles
FOR SELECT
TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Public can read published KB articles"
ON public.knowledge_base_articles
FOR SELECT
TO anon
USING (status = 'published'::article_status);

CREATE POLICY "Members can read KB categories"
ON public.knowledge_base_categories
FOR SELECT
TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Public can read non-empty KB categories"
ON public.knowledge_base_categories
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1
    FROM public.knowledge_base_articles a
    WHERE a.category_id = knowledge_base_categories.id
      AND a.workspace_id = knowledge_base_categories.workspace_id
      AND a.status = 'published'::article_status
  )
);

DROP FUNCTION IF EXISTS public.workspace_has_knowledge_base(uuid);

-- 2. Outbox lease ownership MUST also verify the lease has not expired.

CREATE OR REPLACE FUNCTION public.complete_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    AND e.claimed_by = _worker_id
    AND e.claim_expires_at IS NOT NULL
    AND e.claim_expires_at > now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.defer_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _retry_seconds integer DEFAULT 300)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    AND e.claimed_by = _worker_id
    AND e.claim_expires_at IS NOT NULL
    AND e.claim_expires_at > now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _error_detail text DEFAULT NULL::text, _retry_seconds integer DEFAULT 60, _permanent boolean DEFAULT false, _max_attempts integer DEFAULT 10)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    AND e.claimed_by = _worker_id
    AND e.claim_expires_at IS NOT NULL
    AND e.claim_expires_at > now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;