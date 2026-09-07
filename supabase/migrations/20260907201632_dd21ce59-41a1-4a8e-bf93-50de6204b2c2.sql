INSERT INTO public.ai_billing_recovery_lease(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ai_billing_try_acquire_recovery_lease(_owner text, _ttl_seconds integer DEFAULT 240)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  INSERT INTO public.ai_billing_recovery_lease(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

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

REVOKE ALL ON FUNCTION public.ai_billing_try_acquire_recovery_lease(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_billing_try_acquire_recovery_lease(text, integer) TO service_role;