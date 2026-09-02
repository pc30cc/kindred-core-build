-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 — committed-replay peek (Phase 0 closure gate).
--
-- Problem: /otp/verify resolved the OTP derivation pepper BEFORE consulting
-- the committed idempotency ledger. After a pepper version is retired, an
-- honest retry of an ALREADY COMMITTED requestId therefore answered 503
-- DERIVATION_KEY_UNAVAILABLE instead of the canonical committed replay, even
-- though replaying never needs the code again.
--
-- wi_peek_idempotent is a read-only lookup of the ledger by the same
-- server-derived key + keyed fingerprint. It NEVER executes a primitive and
-- NEVER mutates. Fingerprint/scope/operation binding is unchanged and still
-- fails closed with IDEMPOTENCY_KEY_REUSED, so conflict detection is not
-- weakened: only the ordering of "already committed?" vs. "can I still derive
-- the OTP digest?" changes. Fresh operations still require the recorded pepper.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.wi_peek_idempotent(
  _key text,
  _fingerprint text,
  _operation text,
  _scope_kind text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _row public.workspace_invitation_idempotency%ROWTYPE;
BEGIN
  IF _key IS NULL OR length(_key) < 16 THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF _fingerprint IS NULL OR length(_fingerprint) < 16 THEN RAISE EXCEPTION 'IDEMPOTENCY_FINGERPRINT_REQUIRED'; END IF;

  SELECT * INTO _row FROM public.workspace_invitation_idempotency WHERE key = _key;
  IF _row.key IS NULL THEN
    RETURN jsonb_build_object('found', false, 'committed', false);
  END IF;

  IF _row.operation IS DISTINCT FROM _operation
     OR _row.scope_kind IS DISTINCT FROM _scope_kind
     OR _row.request_fingerprint IS DISTINCT FROM _fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
  END IF;

  IF _row.result_state IS DISTINCT FROM 'committed' THEN
    RETURN jsonb_build_object('found', true, 'committed', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'committed', true,
    'replayed', true,
    'result_code', coalesce(_row.result_code, 'COMMITTED'),
    'safe_result', coalesce(_row.safe_result, '{}'::jsonb)
  );
END;
$$;

DO $acl$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.wi_peek_idempotent(text,text,text,text) FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.wi_peek_idempotent(text,text,text,text) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.wi_peek_idempotent(text,text,text,text) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.wi_peek_idempotent(text,text,text,text) TO service_role';
  END IF;
END
$acl$;

DO $verify$
BEGIN
  IF to_regprocedure('public.wi_peek_idempotent(text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'wi_peek_idempotent missing';
  END IF;
  IF has_function_privilege('anon', 'public.wi_peek_idempotent(text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.wi_peek_idempotent(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'wi_peek_idempotent ACL proof failed';
  END IF;
END
$verify$;
