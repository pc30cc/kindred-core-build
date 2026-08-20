-- Atomic single-use redemption for password-reset and email-verify tokens.
--
-- server/routes/auth-email.ts previously redeemed both token kinds as
-- separate round-trips: SELECT the unused token, THEN update
-- user_credentials, THEN mark the token used. Two concurrent requests for
-- the SAME raw token could both pass the SELECT ... used_at IS NULL check
-- before either UPDATE landed, so both would proceed to write a password /
-- verified-email — the "single-use" token guarantee was not actually
-- enforced against a race.
--
-- Fix: do the whole redemption — claim the token, write the identity
-- change, and (for password reset) revoke the user's other sessions — as a
-- single SECURITY DEFINER function call. The claiming step is a
-- conditional UPDATE (`WHERE ... used_at IS NULL ... RETURNING`), which
-- Postgres executes under a row lock: only one concurrent caller can ever
-- see a non-empty RETURNING result for the same token_hash, so exactly one
-- caller proceeds and every other caller (this one or a genuine replay)
-- gets an empty result — the same "invalid or expired" response the route
-- already gives a truly-invalid token. Every write inside the function
-- body runs in the single implicit transaction of the RPC call itself, so
-- a failure at any step (e.g. the user_credentials write) rolls back the
-- token claim too — the function never leaves a token marked "used" with
-- no corresponding effect.
--
-- Identity is derived ONLY from the claimed token row's user_id — neither
-- function accepts a caller-supplied user id, so a client can never redeem
-- a token "as" a different user than the one the token was actually issued
-- to.
--
-- Locked to service_role only, same as the other first-party auth RPCs in
-- this chain (20260819170000_admin_rpcs_actor_param.sql).
--
-- Self-host counterpart: database/migrations/030_atomic_auth_token_redemption.sql
-- (function bodies are byte-identical — both chains already have
-- structurally identical user_credentials/auth_sessions/auth_reset_tokens/
-- auth_verify_tokens tables by this point in the chain).

-- ── redeem_password_reset_token ──────────────────────────────────────────
-- Atomically claims a reset token, writes the new Argon2id hash, and
-- revokes every existing session for that user (revoke_reason =
-- 'password_reset') — the old password and any stolen session must stop
-- working the instant a reset succeeds. Returns zero rows for an
-- invalid/expired/already-used/revoked token; the caller must treat an
-- empty result exactly like today's "Invalid or expired token" 400.
-- NOTE on output column names: RETURNS TABLE(...) implicitly declares each
-- output column as a PL/pgSQL variable in scope for the whole function
-- body. Naming one `user_id` (matching user_credentials.user_id) makes
-- `ON CONFLICT (user_id)` below ambiguous between the table's column and
-- that variable — Postgres raises "column reference is ambiguous" at
-- CREATE time. Prefixed with `redeemed_` so no output column can ever
-- collide with a real column name referenced in the body.
CREATE OR REPLACE FUNCTION public.redeem_password_reset_token(
  _token_hash text,
  _new_password_hash text
)
RETURNS TABLE(redeemed_user_id uuid, redeemed_email text, redeemed_sessions_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _claimed_user_id uuid;
  _claimed_email text;
  _revoked_count integer;
BEGIN
  UPDATE public.auth_reset_tokens t
  SET used_at = now()
  WHERE t.token_hash = _token_hash
    AND t.used_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
  RETURNING t.user_id, t.email
  INTO _claimed_user_id, _claimed_email;

  IF _claimed_user_id IS NULL THEN
    RETURN; -- empty result set: invalid / expired / already-used / revoked
  END IF;

  INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at, failed_login_count)
  VALUES (_claimed_user_id, _new_password_hash, 'argon2id', now(), 0)
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_algo = EXCLUDED.password_algo,
        password_set_at = EXCLUDED.password_set_at,
        failed_login_count = 0,
        updated_at = now();

  UPDATE public.auth_sessions s
  SET revoked_at = now(), revoke_reason = 'password_reset'
  WHERE s.user_id = _claimed_user_id
    AND s.revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN QUERY SELECT _claimed_user_id, _claimed_email, _revoked_count;
END;
$$;

-- ── redeem_email_verify_token ────────────────────────────────────────────
-- Same claim-then-write pattern for email verification. No session
-- revocation here — verifying an email does not invalidate anything the
-- user is already doing. Output columns prefixed `redeemed_` for the same
-- reason as redeem_password_reset_token above.
CREATE OR REPLACE FUNCTION public.redeem_email_verify_token(
  _token_hash text
)
RETURNS TABLE(redeemed_user_id uuid, redeemed_email text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _claimed_user_id uuid;
  _claimed_email text;
BEGIN
  UPDATE public.auth_verify_tokens t
  SET used_at = now()
  WHERE t.token_hash = _token_hash
    AND t.used_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
  RETURNING t.user_id, t.email
  INTO _claimed_user_id, _claimed_email;

  IF _claimed_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.user_credentials (user_id, email_verified_at)
  VALUES (_claimed_user_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET email_verified_at = now(),
        updated_at = now();

  RETURN QUERY SELECT _claimed_user_id, _claimed_email;
END;
$$;

-- ---------- lock EXECUTE to service_role only (Express is the sole gate) --
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.redeem_password_reset_token(text,text)',
    'public.redeem_email_verify_token(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regprocedure('public.redeem_password_reset_token(text,text)') IS NULL THEN
    RAISE EXCEPTION 'redeem_password_reset_token was not created';
  END IF;
  IF to_regprocedure('public.redeem_email_verify_token(text)') IS NULL THEN
    RAISE EXCEPTION 'redeem_email_verify_token was not created';
  END IF;

  IF has_function_privilege('anon', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute redeem_password_reset_token';
  END IF;
  IF has_function_privilege('authenticated', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute redeem_password_reset_token';
  END IF;
  IF has_function_privilege('anon', 'public.redeem_email_verify_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute redeem_email_verify_token';
  END IF;
  IF has_function_privilege('authenticated', 'public.redeem_email_verify_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute redeem_email_verify_token';
  END IF;

  RAISE NOTICE 'atomic auth token redemption functions created, locked to service_role';
END
$verify$;
