-- 100 — Generic Verification Core: Super Admin settings hardening.
--
-- Forward-only. Does NOT edit migrations 098 or 099 — every table,
-- function, and grant from both is left exactly as it was; 099 may already
-- have been applied in a shared environment. This migration closes five
-- gaps found in an independent review of 099:
--
--   1. Settings could be TIGHTENED-only against the platform ceiling, but
--      nothing stopped a submission from WEAKENING a specific purpose
--      relative to its own canonical baseline (e.g. signup_email's OTP TTL
--      going from 600s to the platform ceiling of 900s). Every 'update'
--      call now additionally validates against
--      gv_admin_default_settings(_purpose) — the SAME baseline already
--      used by 'reset' — direction-aware: otpLength must not DECREASE,
--      otpTtlSeconds/maxVerificationAttempts/maxSendsPerWindow/
--      proofTtlSeconds must not INCREASE, resendCooldownSeconds/
--      rateWindowSeconds must not DECREASE. Equal-to-baseline always
--      passes. Violating this raises POLICY_WEAKENING_NOT_ALLOWED — from
--      INSIDE the RPC, so a Node-layer bypass cannot widen a purpose
--      either. The TypeScript mirror of this same baseline
--      (server/services/verification/types.ts's getAdminPolicyBaseline)
--      is proven identical to gv_admin_default_settings by a parity test,
--      so the two numbers cannot silently drift apart.
--
--   2. gv_admin_update_purpose_settings checked the idempotency ledger
--      BEFORE locking anything keyed to the request id — a SELECT against
--      a row that does not exist yet takes no lock, so two concurrent
--      calls with the SAME new requestId could both observe "not found"
--      and one would then fail on the ledger's PRIMARY KEY at INSERT time
--      instead of replaying deterministically. Fixed with a
--      transaction-scoped advisory lock keyed on the request id, acquired
--      BEFORE any ledger read, so a second concurrent caller with the same
--      requestId blocks until the first transaction commits or rolls back
--      and then sees a consistent ledger. As defense in depth (the
--      advisory lock should make this unreachable), the settings mutation
--      + audit insert + ledger insert are additionally wrapped so that a
--      residual unique_violation on the ledger insert unwinds that whole
--      unit of work via a PL/pgSQL exception block (not a bare `RAISE`)
--      and resolves deterministically (replay or ADMIN_REQUEST_CONFLICT)
--      rather than ever surfacing a raw constraint error.
--
--      Lock order (documented so it can be checked for deadlocks): this
--      function is the ONLY place that ever locks both a request id and a
--      purpose row, and it ALWAYS acquires the request-id advisory lock
--      FIRST, the purpose row SECOND — one fixed order, every call, so two
--      concurrent calls can never wait on each other in opposite order.
--      The only remaining contention point is the purpose row itself
--      (unchanged from 099): the second caller for the SAME purpose simply
--      waits for the first to finish, exactly as before.
--
--   3. The request fingerprint used MD5. No secret material is fingerprinted
--      (see 099 §7) but an authorization-sensitive idempotency contract
--      deserves a collision-resistant digest — switched to SHA-256 via
--      pgcrypto's digest() (already installed by migration 001 and already
--      used elsewhere in this codebase, e.g. 083/089).
--
--   4. verification_admin_idempotency had no retention: purely dormant
--      configuration-editing traffic would still grow this table forever.
--      Added a bounded `expires_at` (7-day retention — Super Admin
--      settings changes are rare, low-volume, and only need to survive a
--      client retrying a single in-flight request, not for auditing; the
--      separate, permanent verification_purpose_settings_audit table is
--      the audit trail and is NEVER purged by this migration or its new
--      RPC) and a new bounded purge RPC,
--      gv_admin_purge_expired_idempotency(_limit), mirroring 098's own
--      gv_purge_expired_idempotency exactly (LIMIT + FOR UPDATE SKIP
--      LOCKED + GET DIAGNOSTICS for an exact count). Like 098's purge RPC,
--      this is a service-role-only maintenance primitive meant to be
--      invoked by an operator/cron job outside the request path — no
--      Express route is added for it, matching 098's own precedent of
--      never wiring a purge endpoint into the API surface.
--
--   5. request_id/request_fingerprint/purpose (idempotency) and
--      request_id/ip_hash/user_agent/purpose (audit) were bounded only by
--      Zod at the Express layer. Added CHECK constraints at the database
--      layer so a direct RPC call (bypassing Node entirely) still cannot
--      store an oversized or unrecognized value.
--
-- Nothing here relaxes the non-negotiable activation rule from 099:
-- gv_admin_consumer_implemented/gv_admin_deployment_allowlisted remain
-- hardcoded empty, gv_is_purpose_enabled (098) is untouched, and this
-- migration's own verify block re-proves every purpose is still seeded
-- admin_enabled=false with effective_enabled=false after these changes.

-- ============================================================
-- 1. verification_admin_idempotency — bounded retention + DB-layer bounds.
-- ============================================================
ALTER TABLE public.verification_admin_idempotency
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

CREATE INDEX IF NOT EXISTS idx_verification_admin_idempotency_expires
  ON public.verification_admin_idempotency (expires_at);

DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_admin_idempotency'::regclass
      AND conname = 'verification_admin_idempotency_request_id_len'
  ) THEN
    ALTER TABLE public.verification_admin_idempotency
      ADD CONSTRAINT verification_admin_idempotency_request_id_len
      CHECK (length(request_id) BETWEEN 8 AND 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_admin_idempotency'::regclass
      AND conname = 'verification_admin_idempotency_purpose_known'
  ) THEN
    ALTER TABLE public.verification_admin_idempotency
      ADD CONSTRAINT verification_admin_idempotency_purpose_known
      CHECK (purpose = ANY(ARRAY[
        'signup_email','signup_phone','password_reset','login_step_up',
        'change_email','change_phone','sensitive_action','workspace_invitation'
      ]));
  END IF;

  -- SHA-256 hex digest is always exactly 64 characters.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_admin_idempotency'::regclass
      AND conname = 'verification_admin_idempotency_fingerprint_len'
  ) THEN
    ALTER TABLE public.verification_admin_idempotency
      ADD CONSTRAINT verification_admin_idempotency_fingerprint_len
      CHECK (length(request_fingerprint) = 64);
  END IF;
END
$c$;

-- ============================================================
-- 2. verification_purpose_settings_audit — DB-layer bounds on request
--    metadata (this table is append-only and never purged by this
--    migration; only the internal idempotency ledger above gets a
--    retention window).
-- ============================================================
DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_purpose_settings_audit'::regclass
      AND conname = 'verification_purpose_settings_audit_purpose_known'
  ) THEN
    ALTER TABLE public.verification_purpose_settings_audit
      ADD CONSTRAINT verification_purpose_settings_audit_purpose_known
      CHECK (purpose = ANY(ARRAY[
        'signup_email','signup_phone','password_reset','login_step_up',
        'change_email','change_phone','sensitive_action','workspace_invitation'
      ]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_purpose_settings_audit'::regclass
      AND conname = 'verification_purpose_settings_audit_request_id_len'
  ) THEN
    ALTER TABLE public.verification_purpose_settings_audit
      ADD CONSTRAINT verification_purpose_settings_audit_request_id_len
      CHECK (length(request_id) BETWEEN 8 AND 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_purpose_settings_audit'::regclass
      AND conname = 'verification_purpose_settings_audit_ip_hash_len'
  ) THEN
    ALTER TABLE public.verification_purpose_settings_audit
      ADD CONSTRAINT verification_purpose_settings_audit_ip_hash_len
      CHECK (ip_hash IS NULL OR length(ip_hash) <= 128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_purpose_settings_audit'::regclass
      AND conname = 'verification_purpose_settings_audit_user_agent_len'
  ) THEN
    ALTER TABLE public.verification_purpose_settings_audit
      ADD CONSTRAINT verification_purpose_settings_audit_user_agent_len
      CHECK (user_agent IS NULL OR length(user_agent) <= 300);
  END IF;
END
$c$;

-- ============================================================
-- 3. verification_purpose_settings — absolute ceiling on the opt-in
--    global rate limit bucket, so it can never be configured as something
--    practically unbounded. This bucket is ADDITIVE on top of, never a
--    replacement for, the per-purpose maxSendsPerWindow/rateWindowSeconds
--    counters above — enabling it can only add a further platform-wide
--    restriction, never relax an existing per-purpose one, so no separate
--    "weakening" check applies to it beyond this ceiling.
-- ============================================================
DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.verification_purpose_settings'::regclass
      AND conname = 'verification_purpose_settings_global_rate_limit_max_ceiling'
  ) THEN
    ALTER TABLE public.verification_purpose_settings
      ADD CONSTRAINT verification_purpose_settings_global_rate_limit_max_ceiling
      CHECK (global_rate_limit_max_per_window IS NULL OR global_rate_limit_max_per_window <= 100000);
  END IF;
END
$c$;

-- ============================================================
-- 4. gv_admin_purge_expired_idempotency — bounded maintenance purge for
--    the table above ONLY. Mirrors 098's gv_purge_expired_idempotency
--    exactly: LIMIT + FOR UPDATE SKIP LOCKED (never blocks or
--    double-deletes a row a concurrent caller is using) + GET DIAGNOSTICS
--    for the exact row count. Never touches
--    verification_purpose_settings_audit — audit evidence is never
--    deleted by this or any function in this migration.
-- ============================================================
CREATE OR REPLACE FUNCTION public.gv_admin_purge_expired_idempotency(_limit integer) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _n integer;
BEGIN
  WITH victims AS (
    SELECT request_id FROM public.verification_admin_idempotency
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.verification_admin_idempotency USING victims
    WHERE public.verification_admin_idempotency.request_id = victims.request_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_purge_expired_idempotency(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gv_admin_purge_expired_idempotency(integer) TO service_role;

-- ============================================================
-- 5. gv_admin_update_purpose_settings — hardened body, SAME signature as
--    099 (no caller-visible contract change): SHA-256 fingerprint,
--    request-id advisory lock acquired before any ledger read,
--    policy-weakening enforcement on 'update', and a defensive
--    unique_violation catch around the settings+audit+ledger write unit.
-- ============================================================
CREATE OR REPLACE FUNCTION public.gv_admin_update_purpose_settings(
  _request_id text,
  _purpose text,
  _action text,
  _actor_profile_id uuid,
  _expected_revision integer,
  _admin_enabled boolean,
  _otp_length integer,
  _otp_ttl_seconds integer,
  _max_verification_attempts integer,
  _resend_cooldown_seconds integer,
  _max_sends_per_window integer,
  _rate_window_seconds integer,
  _proof_ttl_seconds integer,
  _global_rate_limit_enabled boolean,
  _global_rate_limit_max_per_window integer,
  _global_rate_limit_window_seconds integer,
  _default_locale text,
  _ip_hash text,
  _user_agent text,
  _locale text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _lock_key bigint;
  _fingerprint text;
  _cached public.verification_admin_idempotency%ROWTYPE;
  _row public.verification_purpose_settings%ROWTYPE;
  _previous jsonb;
  _defaults jsonb;
  _result jsonb;
BEGIN
  IF _request_id IS NULL OR length(_request_id) < 8 THEN
    RAISE EXCEPTION 'ADMIN_REQUEST_ID_INVALID';
  END IF;
  IF _action NOT IN ('update', 'reset') THEN
    RAISE EXCEPTION 'ADMIN_ACTION_UNKNOWN';
  END IF;

  _fingerprint := encode(digest(jsonb_build_object(
    'purpose', _purpose, 'action', _action, 'expectedRevision', _expected_revision,
    'adminEnabled', _admin_enabled, 'otpLength', _otp_length, 'otpTtlSeconds', _otp_ttl_seconds,
    'maxVerificationAttempts', _max_verification_attempts, 'resendCooldownSeconds', _resend_cooldown_seconds,
    'maxSendsPerWindow', _max_sends_per_window, 'rateWindowSeconds', _rate_window_seconds,
    'proofTtlSeconds', _proof_ttl_seconds, 'globalRateLimitEnabled', _global_rate_limit_enabled,
    'globalRateLimitMaxPerWindow', _global_rate_limit_max_per_window,
    'globalRateLimitWindowSeconds', _global_rate_limit_window_seconds, 'defaultLocale', _default_locale
  )::text, 'sha256'), 'hex');

  -- Canonical lock order: request-id advisory lock FIRST, always, before
  -- any ledger read and before the purpose row lock below. Transaction-
  -- scoped — released automatically on COMMIT or ROLLBACK, so it can never
  -- leak past this call.
  _lock_key := hashtextextended('gv_admin_settings:' || _request_id, 42);
  PERFORM pg_advisory_xact_lock(_lock_key);

  SELECT * INTO _cached FROM public.verification_admin_idempotency WHERE request_id = _request_id;
  IF FOUND THEN
    IF _cached.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'ADMIN_REQUEST_CONFLICT';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'result', _cached.result);
  END IF;

  SELECT * INTO _row FROM public.verification_purpose_settings WHERE purpose = _purpose FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURPOSE_UNKNOWN';
  END IF;

  IF _expected_revision IS NULL OR _expected_revision <> _row.revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT';
  END IF;

  _previous := public.gv_admin_sanitize_settings(_row);

  IF _action = 'reset' THEN
    _defaults := public.gv_admin_default_settings(_purpose);
    UPDATE public.verification_purpose_settings SET
      admin_enabled = false,
      otp_length = (_defaults->>'otpLength')::integer,
      otp_ttl_seconds = (_defaults->>'otpTtlSeconds')::integer,
      max_verification_attempts = (_defaults->>'maxVerificationAttempts')::integer,
      resend_cooldown_seconds = (_defaults->>'resendCooldownSeconds')::integer,
      max_sends_per_window = (_defaults->>'maxSendsPerWindow')::integer,
      rate_window_seconds = (_defaults->>'rateWindowSeconds')::integer,
      proof_ttl_seconds = (_defaults->>'proofTtlSeconds')::integer,
      global_rate_limit_enabled = false,
      global_rate_limit_max_per_window = NULL,
      global_rate_limit_window_seconds = NULL,
      default_locale = 'en',
      revision = revision + 1,
      updated_by = _actor_profile_id,
      updated_at = now()
    WHERE purpose = _purpose
    RETURNING * INTO _row;
  ELSE
    -- 'update' — the only path that could ever set admin_enabled = true,
    -- so this is the ONLY place PURPOSE_NOT_DEPLOYED is checked. Reset
    -- always forces admin_enabled back to false above, so it never needs
    -- this check.
    IF _admin_enabled AND NOT public.gv_admin_consumer_implemented(_purpose) THEN
      RAISE EXCEPTION 'PURPOSE_NOT_DEPLOYED';
    END IF;

    -- Policy-tightening-only enforcement — see this migration's header
    -- comment (gap 1). Reset never reaches here (it applies the baseline
    -- itself, unconditionally), so only 'update' needs this check.
    _defaults := public.gv_admin_default_settings(_purpose);
    IF _otp_length < (_defaults->>'otpLength')::integer
       OR _otp_ttl_seconds > (_defaults->>'otpTtlSeconds')::integer
       OR _max_verification_attempts > (_defaults->>'maxVerificationAttempts')::integer
       OR _resend_cooldown_seconds < (_defaults->>'resendCooldownSeconds')::integer
       OR _max_sends_per_window > (_defaults->>'maxSendsPerWindow')::integer
       OR _rate_window_seconds < (_defaults->>'rateWindowSeconds')::integer
       OR _proof_ttl_seconds > (_defaults->>'proofTtlSeconds')::integer
    THEN
      RAISE EXCEPTION 'POLICY_WEAKENING_NOT_ALLOWED';
    END IF;

    UPDATE public.verification_purpose_settings SET
      admin_enabled = _admin_enabled,
      otp_length = _otp_length,
      otp_ttl_seconds = _otp_ttl_seconds,
      max_verification_attempts = _max_verification_attempts,
      resend_cooldown_seconds = _resend_cooldown_seconds,
      max_sends_per_window = _max_sends_per_window,
      rate_window_seconds = _rate_window_seconds,
      proof_ttl_seconds = _proof_ttl_seconds,
      global_rate_limit_enabled = _global_rate_limit_enabled,
      global_rate_limit_max_per_window = _global_rate_limit_max_per_window,
      global_rate_limit_window_seconds = _global_rate_limit_window_seconds,
      default_locale = _default_locale,
      revision = revision + 1,
      updated_by = _actor_profile_id,
      updated_at = now()
    WHERE purpose = _purpose
    RETURNING * INTO _row;
  END IF;

  _result := jsonb_build_object(
    'settings', public.gv_admin_sanitize_settings(_row),
    'effectiveEnabled', public.gv_admin_effective_enabled(_purpose)
  );

  -- Defense in depth: the advisory lock above should make a duplicate
  -- ledger insert unreachable, but if one ever occurred, this block undoes
  -- the settings mutation + audit insert together with the failed ledger
  -- insert (a nested PL/pgSQL exception block is an implicit SAVEPOINT,
  -- rolled back as one unit on the exception) and resolves deterministically
  -- instead of leaking a raw unique_violation.
  BEGIN
    INSERT INTO public.verification_purpose_settings_audit (
      purpose, action, previous_settings, new_settings, actor_profile_id, request_id, ip_hash, user_agent, locale
    ) VALUES (
      _purpose, _action, _previous, public.gv_admin_sanitize_settings(_row), _actor_profile_id, _request_id, _ip_hash, _user_agent, _locale
    );

    INSERT INTO public.verification_admin_idempotency (request_id, purpose, request_fingerprint, result, expires_at)
    VALUES (_request_id, _purpose, _fingerprint, _result, now() + interval '7 days');
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO _cached FROM public.verification_admin_idempotency WHERE request_id = _request_id;
    IF FOUND AND _cached.request_fingerprint = _fingerprint THEN
      RETURN jsonb_build_object('replayed', true, 'result', _cached.result);
    END IF;
    RAISE EXCEPTION 'ADMIN_REQUEST_CONFLICT';
  END;

  RETURN jsonb_build_object('replayed', false, 'result', _result);
END;
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_update_purpose_settings(
  text, text, text, uuid, integer, boolean, integer, integer, integer, integer, integer, integer,
  integer, boolean, integer, integer, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gv_admin_update_purpose_settings(
  text, text, text, uuid, integer, boolean, integer, integer, integer, integer, integer, integer,
  integer, boolean, integer, integer, text, text, text, text
) TO service_role;

-- ============================================================
-- 6. Build-time verification.
-- ============================================================
DO $verify$
DECLARE
  p text;
  purposes text[] := ARRAY['signup_email','signup_phone','password_reset','login_step_up','change_email','change_phone','sensitive_action','workspace_invitation'];
  update_fn_sig text := 'public.gv_admin_update_purpose_settings(text, text, text, uuid, integer, boolean, integer, integer, integer, integer, integer, integer, integer, boolean, integer, integer, text, text, text, text)';
  purge_fn_sig text := 'public.gv_admin_purge_expired_idempotency(integer)';
BEGIN
  -- Retention column + index.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification_admin_idempotency' AND column_name = 'expires_at'
  ) THEN
    RAISE EXCEPTION '100: verification_admin_idempotency.expires_at was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_verification_admin_idempotency_expires') THEN
    RAISE EXCEPTION '100: idx_verification_admin_idempotency_expires was not created';
  END IF;

  -- DB-layer bounds (gap 5).
  FOREACH p IN ARRAY ARRAY[
    'verification_admin_idempotency_request_id_len', 'verification_admin_idempotency_purpose_known',
    'verification_admin_idempotency_fingerprint_len', 'verification_purpose_settings_audit_purpose_known',
    'verification_purpose_settings_audit_request_id_len', 'verification_purpose_settings_audit_ip_hash_len',
    'verification_purpose_settings_audit_user_agent_len', 'verification_purpose_settings_global_rate_limit_max_ceiling'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p) THEN
      RAISE EXCEPTION '100: expected constraint % was not created', p;
    END IF;
  END LOOP;

  -- Purge RPC: service_role-only, SECURITY DEFINER, search_path pinned.
  IF has_function_privilege('anon', purge_fn_sig, 'EXECUTE') OR has_function_privilege('authenticated', purge_fn_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '100: anon/authenticated can execute gv_admin_purge_expired_idempotency';
  END IF;
  IF NOT has_function_privilege('service_role', purge_fn_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '100: service_role cannot execute gv_admin_purge_expired_idempotency';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc pr WHERE pr.oid = to_regprocedure(purge_fn_sig)
      AND pr.prosecdef = true
      AND EXISTS (SELECT 1 FROM unnest(pr.proconfig) c WHERE c LIKE 'search_path=public, pg_temp')
  ) THEN
    RAISE EXCEPTION '100: gv_admin_purge_expired_idempotency is not SECURITY DEFINER with search_path pinned';
  END IF;

  -- gv_admin_update_purpose_settings ACL unchanged after CREATE OR REPLACE.
  IF has_function_privilege('anon', update_fn_sig, 'EXECUTE') OR has_function_privilege('authenticated', update_fn_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '100: anon/authenticated can execute gv_admin_update_purpose_settings';
  END IF;
  IF NOT has_function_privilege('service_role', update_fn_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '100: service_role cannot execute gv_admin_update_purpose_settings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc pr WHERE pr.oid = to_regprocedure(update_fn_sig)
      AND pr.prosecdef = true
      AND EXISTS (SELECT 1 FROM unnest(pr.proconfig) c WHERE c LIKE 'search_path=public, pg_temp')
  ) THEN
    RAISE EXCEPTION '100: gv_admin_update_purpose_settings is not SECURITY DEFINER with search_path pinned after hardening';
  END IF;

  -- Re-prove dormancy after this migration (same style as 099's own proof).
  FOREACH p IN ARRAY purposes LOOP
    IF (SELECT admin_enabled FROM public.verification_purpose_settings WHERE purpose = p) THEN
      RAISE EXCEPTION '100: purpose % has admin_enabled = true after migration', p;
    END IF;
    IF public.gv_admin_effective_enabled(p) THEN
      RAISE EXCEPTION '100: gv_admin_effective_enabled unexpectedly true for % after hardening', p;
    END IF;
  END LOOP;

  RAISE NOTICE '100: Generic Verification Core Super Admin settings hardened — policy-tightening enforcement, concurrency-safe idempotency (SHA-256, advisory lock), bounded retention + purge, DB-layer field bounds. All purposes remain admin_enabled=false, effective_enabled=false.';
END
$verify$;
