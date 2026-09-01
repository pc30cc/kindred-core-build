-- AI billing — cluster-wide recovery lease.
-- Process-local single-flight is not enough with multiple replicas: every
-- instance runs the same timer. This lease makes exactly ONE instance execute
-- a recovery pass at a time, and expires on its own if that instance dies.
CREATE TABLE IF NOT EXISTS public.ai_billing_recovery_lease (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  owner text,
  acquired_at timestamptz,
  expires_at timestamptz,
  last_finished_at timestamptz,
  passes bigint NOT NULL DEFAULT 0
);

GRANT ALL ON public.ai_billing_recovery_lease TO service_role;
ALTER TABLE public.ai_billing_recovery_lease ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: only service_role (which bypasses RLS) may touch it.

INSERT INTO public.ai_billing_recovery_lease (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ai_billing_try_acquire_recovery_lease(
  _owner text,
  _ttl_seconds integer DEFAULT 240
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _acquired boolean := false;
BEGIN
  IF _owner IS NULL OR length(_owner) = 0 THEN
    RAISE EXCEPTION 'recovery_lease_owner_required';
  END IF;
  IF _ttl_seconds IS NULL OR _ttl_seconds < 30 OR _ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'recovery_lease_ttl_out_of_range';
  END IF;

  -- Row lock serializes competing instances; the winner is whoever finds the
  -- lease free or expired.
  UPDATE public.ai_billing_recovery_lease
     SET owner = _owner,
         acquired_at = now(),
         expires_at = now() + make_interval(secs => _ttl_seconds),
         passes = passes + 1
   WHERE id
     AND (owner IS NULL OR expires_at IS NULL OR expires_at <= now())
  RETURNING true INTO _acquired;

  RETURN COALESCE(_acquired, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_billing_release_recovery_lease(_owner text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _released boolean := false;
BEGIN
  UPDATE public.ai_billing_recovery_lease
     SET owner = NULL,
         expires_at = NULL,
         last_finished_at = now()
   WHERE id AND owner = _owner
  RETURNING true INTO _released;
  RETURN COALESCE(_released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.ai_billing_try_acquire_recovery_lease(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_billing_release_recovery_lease(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_billing_try_acquire_recovery_lease(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_billing_release_recovery_lease(text) TO service_role;