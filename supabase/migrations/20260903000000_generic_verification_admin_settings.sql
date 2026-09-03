-- 099 — Generic Verification Core: Super Admin management layer.
--
-- Forward-only. Does NOT edit migration 098 — every table/function/grant
-- from 098 is untouched. Adds a Super-Admin-only settings/audit layer that
-- lets an operator VIEW and TIGHTEN per-purpose policy values ahead of a
-- future integration, without that layer ever being able to activate a
-- purpose itself.
--
-- NON-NEGOTIABLE ACTIVATION RULE — a purpose is "effectively enabled" only
-- when ALL FOUR of these are true:
--   effective_enabled = admin_enabled
--                        AND consumer_implemented   (gv_admin_consumer_implemented)
--                        AND deployment_allowlisted (gv_admin_deployment_allowlisted)
--                        AND database_enabled       (gv_is_purpose_enabled, from 098)
--
-- In THIS migration, gv_admin_consumer_implemented and
-- gv_admin_deployment_allowlisted are BOTH hardcoded to an empty allow-list
-- for every purpose — mirroring 098's own gv_is_purpose_enabled pattern —
-- so gv_admin_effective_enabled() returns FALSE for every purpose
-- regardless of what admin_enabled is set to in the settings table. This
-- means a raw `UPDATE verification_purpose_settings SET admin_enabled =
-- true` (bypassing the RPC, bypassing the API, bypassing Node entirely)
-- STILL cannot activate a purpose — the other three gates are hardcoded
-- closed at the SQL level, not merely checked in application code. Making
-- a purpose real requires editing THIS migration's two hardcoded arrays in
-- a new, reviewed, additive migration (to flip consumer_implemented and/or
-- deployment_allowlisted) AND building the actual consumer AND 098's own
-- gv_is_purpose_enabled allow-list — a deliberate three-key change, exactly
-- like 098 already requires a two-key change for its own dormancy gate.
--
-- Nothing here creates a route, sends anything, or touches
-- verification_challenges/proofs/attempts. This is configuration-at-rest
-- only.

-- ============================================================
-- 1. verification_purpose_settings — one row per registered purpose,
--    Super-Admin-editable POLICY VALUES only. Bindings (subjectBinding,
--    tenantBinding, requiresAuth, allowedChannels, invalidatesPreviousGeneration,
--    issuesProof) remain code-controlled in server/services/verification/
--    types.ts and are NOT represented here — there is no column for them,
--    so there is nothing in this table a UI could use to change them.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_purpose_settings (
  purpose text PRIMARY KEY CHECK (purpose = ANY(ARRAY[
    'signup_email','signup_phone','password_reset','login_step_up',
    'change_email','change_phone','sensitive_action','workspace_invitation'
  ])),
  -- The ONLY column a Super Admin can flip toward "on". Even at true, the
  -- purpose stays dormant unless the other three gates also agree — see
  -- gv_admin_effective_enabled() below. Defaults to false and is reset to
  -- false by gv_admin_update_purpose_settings's 'reset' action.
  admin_enabled boolean NOT NULL DEFAULT false,

  -- Policy values — each CHECK mirrors server/services/verification/types.ts's
  -- PLATFORM_MAXIMUMS exactly. These are CEILINGS (or, for resend_cooldown,
  -- a FLOOR) already enforced in TypeScript at read time; the CHECK here is
  -- defense in depth so a direct INSERT/UPDATE bypassing the RPC still
  -- cannot store a value outside the platform's hardcoded ceiling.
  otp_length integer NOT NULL CHECK (otp_length BETWEEN 4 AND 8),
  otp_ttl_seconds integer NOT NULL CHECK (otp_ttl_seconds BETWEEN 30 AND 900),
  max_verification_attempts integer NOT NULL CHECK (max_verification_attempts BETWEEN 1 AND 8),
  resend_cooldown_seconds integer NOT NULL CHECK (resend_cooldown_seconds >= 30),
  max_sends_per_window integer NOT NULL CHECK (max_sends_per_window BETWEEN 1 AND 5),
  rate_window_seconds integer NOT NULL CHECK (rate_window_seconds BETWEEN 60 AND 3600),
  proof_ttl_seconds integer NOT NULL CHECK (proof_ttl_seconds BETWEEN 30 AND 1800),

  -- Optional platform-wide bucket (PurposePolicy.globalRateLimit) — opt-in,
  -- null/disabled by default, exactly like the TypeScript field it mirrors.
  global_rate_limit_enabled boolean NOT NULL DEFAULT false,
  global_rate_limit_max_per_window integer CHECK (global_rate_limit_max_per_window IS NULL OR global_rate_limit_max_per_window >= 1),
  global_rate_limit_window_seconds integer CHECK (global_rate_limit_window_seconds IS NULL OR global_rate_limit_window_seconds BETWEEN 60 AND 86400),
  CONSTRAINT verification_purpose_settings_global_rate_limit_complete CHECK (
    NOT global_rate_limit_enabled
    OR (global_rate_limit_max_per_window IS NOT NULL AND global_rate_limit_window_seconds IS NOT NULL)
  ),

  default_locale text NOT NULL DEFAULT 'en' CHECK (default_locale IN ('fa', 'tr', 'en')),

  -- Optimistic concurrency: every update/reset must supply the revision it
  -- read, and bumps it by exactly 1. See gv_admin_update_purpose_settings.
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. verification_purpose_settings_audit — append-only. Never stores an
--    OTP, proof token, pepper, provider credential, cookie, or
--    service-role key — only the sanitized before/after settings rows
--    (which themselves never contain any of those) plus request metadata.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_purpose_settings_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  purpose text NOT NULL,
  action text NOT NULL CHECK (action IN ('update', 'reset')),
  previous_settings jsonb NOT NULL,
  new_settings jsonb NOT NULL,
  actor_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  request_id text NOT NULL,
  ip_hash text,
  user_agent text,
  locale text CHECK (locale IS NULL OR locale IN ('fa', 'tr', 'en')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_purpose_settings_audit_purpose ON public.verification_purpose_settings_audit (purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_purpose_settings_audit_created ON public.verification_purpose_settings_audit (created_at DESC);

-- ============================================================
-- 3. verification_admin_idempotency — internal replay cache for the admin
--    update/reset RPC ONLY. Node never reads or writes this table directly
--    (no grant to service_role at all — see RLS/GRANT section); it exists
--    purely so gv_admin_update_purpose_settings can detect a replayed
--    requestId (same request → same cached result) vs. a requestId reused
--    with a different payload (rejected as a conflict).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_admin_idempotency (
  request_id text PRIMARY KEY,
  purpose text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. RLS + GRANTs — zero browser policies, service_role reaches these
--    tables via BYPASSRLS, not a policy. Minimum-necessary grants only:
--    Node reads settings/audit directly (SELECT) but every WRITE to
--    either table happens exclusively inside the SECURITY DEFINER RPC
--    below, which needs no table grant of its own (it runs as the
--    defining role). service_role gets NO grant at all on the internal
--    idempotency table.
-- ============================================================
ALTER TABLE public.verification_purpose_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_purpose_settings_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_admin_idempotency ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.verification_purpose_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_purpose_settings_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_admin_idempotency FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.verification_purpose_settings TO service_role;
GRANT SELECT ON public.verification_purpose_settings_audit TO service_role;
-- No grant at all on verification_admin_idempotency — RPC-internal only.

-- ============================================================
-- 5. Seed all eight registered purposes with safe defaults, admin_enabled
--    = false. Values mirror server/services/verification/types.ts's
--    RAW_POLICIES exactly, so a future consumer integration sees the same
--    numbers whether it reads TypeScript or this table.
-- ============================================================
INSERT INTO public.verification_purpose_settings (
  purpose, admin_enabled, otp_length, otp_ttl_seconds, max_verification_attempts,
  resend_cooldown_seconds, max_sends_per_window, rate_window_seconds, proof_ttl_seconds, default_locale
) VALUES
  ('signup_email',        false, 6, 600, 5, 60, 5, 3600, 600, 'en'),
  ('signup_phone',        false, 6, 300, 5, 60, 5, 3600, 600, 'en'),
  ('password_reset',      false, 6, 600, 5, 60, 3, 3600, 300, 'en'),
  ('login_step_up',       false, 6, 300, 5, 45, 5, 1800, 300, 'en'),
  ('change_email',        false, 6, 600, 5, 60, 5, 3600, 600, 'en'),
  ('change_phone',        false, 6, 300, 5, 60, 5, 3600, 600, 'en'),
  ('sensitive_action',    false, 6, 300, 5, 60, 3, 1800, 180, 'en'),
  ('workspace_invitation',false, 6, 600, 5, 60, 5, 3600, 600, 'en')
ON CONFLICT (purpose) DO NOTHING;

-- ============================================================
-- 6. Consumer-implemented / deployment-allowlist gates — hardcoded empty
--    for every purpose in THIS pass, exactly mirroring 098's
--    gv_is_purpose_enabled(). These are NOT read from the settings table
--    (a Super Admin cannot edit them) and are NOT environment variables —
--    flipping either requires a new, reviewed, additive migration.
-- ============================================================
CREATE OR REPLACE FUNCTION public.gv_admin_consumer_implemented(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY[]::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_consumer_implemented(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.gv_admin_deployment_allowlisted(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY[]::text[]);
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_deployment_allowlisted(text) FROM PUBLIC;

-- The single authoritative computation of the activation formula. A future
-- consumer, a future admin route, and this migration's own verify block
-- all call THIS function rather than re-deriving the AND chain themselves,
-- so there is exactly one place the formula can be gotten wrong.
CREATE OR REPLACE FUNCTION public.gv_admin_effective_enabled(_purpose text) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(
    (SELECT s.admin_enabled FROM public.verification_purpose_settings s WHERE s.purpose = _purpose),
    false
  )
  AND public.gv_admin_consumer_implemented(_purpose)
  AND public.gv_admin_deployment_allowlisted(_purpose)
  AND public.gv_is_purpose_enabled(_purpose);
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_effective_enabled(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gv_admin_effective_enabled(text) TO service_role;

-- Per-purpose hardcoded safe defaults, used by the 'reset' action below.
-- Kept in its own function (rather than inlined into the RPC) so the
-- numbers are declared exactly once.
CREATE OR REPLACE FUNCTION public.gv_admin_default_settings(_purpose text) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT CASE _purpose
    WHEN 'signup_email' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',600,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',5,'rateWindowSeconds',3600,'proofTtlSeconds',600)
    WHEN 'signup_phone' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',300,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',5,'rateWindowSeconds',3600,'proofTtlSeconds',600)
    WHEN 'password_reset' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',600,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',3,'rateWindowSeconds',3600,'proofTtlSeconds',300)
    WHEN 'login_step_up' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',300,'maxVerificationAttempts',5,'resendCooldownSeconds',45,'maxSendsPerWindow',5,'rateWindowSeconds',1800,'proofTtlSeconds',300)
    WHEN 'change_email' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',600,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',5,'rateWindowSeconds',3600,'proofTtlSeconds',600)
    WHEN 'change_phone' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',300,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',5,'rateWindowSeconds',3600,'proofTtlSeconds',600)
    WHEN 'sensitive_action' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',300,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',3,'rateWindowSeconds',1800,'proofTtlSeconds',180)
    WHEN 'workspace_invitation' THEN jsonb_build_object('otpLength',6,'otpTtlSeconds',600,'maxVerificationAttempts',5,'resendCooldownSeconds',60,'maxSendsPerWindow',5,'rateWindowSeconds',3600,'proofTtlSeconds',600)
    ELSE NULL
  END;
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_default_settings(text) FROM PUBLIC;

-- Sanitized projection of a settings row for audit storage / API responses
-- — explicitly enumerates columns so a future column addition to the table
-- does not silently start appearing in audit rows or API payloads without
-- a deliberate decision to include it here.
CREATE OR REPLACE FUNCTION public.gv_admin_sanitize_settings(_s public.verification_purpose_settings) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'purpose', _s.purpose,
    'adminEnabled', _s.admin_enabled,
    'otpLength', _s.otp_length,
    'otpTtlSeconds', _s.otp_ttl_seconds,
    'maxVerificationAttempts', _s.max_verification_attempts,
    'resendCooldownSeconds', _s.resend_cooldown_seconds,
    'maxSendsPerWindow', _s.max_sends_per_window,
    'rateWindowSeconds', _s.rate_window_seconds,
    'proofTtlSeconds', _s.proof_ttl_seconds,
    'globalRateLimitEnabled', _s.global_rate_limit_enabled,
    'globalRateLimitMaxPerWindow', _s.global_rate_limit_max_per_window,
    'globalRateLimitWindowSeconds', _s.global_rate_limit_window_seconds,
    'defaultLocale', _s.default_locale,
    'revision', _s.revision
  );
$function$;
REVOKE ALL ON FUNCTION public.gv_admin_sanitize_settings(public.verification_purpose_settings) FROM PUBLIC;

-- ============================================================
-- 7. gv_admin_update_purpose_settings — the ONLY way settings ever change.
--    Atomic: locks the settings row, checks optimistic-concurrency
--    revision, enforces PURPOSE_NOT_DEPLOYED before ever allowing
--    admin_enabled=true, applies the update (or, for action='reset',
--    the hardcoded safe defaults instead of the caller's numbers),
--    writes one audit row, and caches the result under requestId so a
--    retried call with the SAME payload replays instead of re-applying,
--    while a retried call with a DIFFERENT payload is rejected.
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

  _fingerprint := md5(jsonb_build_object(
    'purpose', _purpose, 'action', _action, 'expectedRevision', _expected_revision,
    'adminEnabled', _admin_enabled, 'otpLength', _otp_length, 'otpTtlSeconds', _otp_ttl_seconds,
    'maxVerificationAttempts', _max_verification_attempts, 'resendCooldownSeconds', _resend_cooldown_seconds,
    'maxSendsPerWindow', _max_sends_per_window, 'rateWindowSeconds', _rate_window_seconds,
    'proofTtlSeconds', _proof_ttl_seconds, 'globalRateLimitEnabled', _global_rate_limit_enabled,
    'globalRateLimitMaxPerWindow', _global_rate_limit_max_per_window,
    'globalRateLimitWindowSeconds', _global_rate_limit_window_seconds, 'defaultLocale', _default_locale
  )::text);

  SELECT * INTO _cached FROM public.verification_admin_idempotency WHERE request_id = _request_id FOR UPDATE;
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

  INSERT INTO public.verification_purpose_settings_audit (
    purpose, action, previous_settings, new_settings, actor_profile_id, request_id, ip_hash, user_agent, locale
  ) VALUES (
    _purpose, _action, _previous, public.gv_admin_sanitize_settings(_row), _actor_profile_id, _request_id, _ip_hash, _user_agent, _locale
  );

  _result := jsonb_build_object(
    'settings', public.gv_admin_sanitize_settings(_row),
    'effectiveEnabled', public.gv_admin_effective_enabled(_purpose)
  );

  INSERT INTO public.verification_admin_idempotency (request_id, purpose, request_fingerprint, result)
  VALUES (_request_id, _purpose, _fingerprint, _result);

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
-- 8. Build-time verification.
-- ============================================================
DO $verify$
DECLARE
  p text;
  purposes text[] := ARRAY['signup_email','signup_phone','password_reset','login_step_up','change_email','change_phone','sensitive_action','workspace_invitation'];
  tables text[] := ARRAY['verification_purpose_settings','verification_purpose_settings_audit','verification_admin_idempotency'];
  t text;
  update_fn_sig text := 'public.gv_admin_update_purpose_settings(text, text, text, uuid, integer, boolean, integer, integer, integer, integer, integer, integer, integer, boolean, integer, integer, text, text, text, text)';
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '099: table % was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '099: RLS not enabled on %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION '099: % unexpectedly has a browser-facing RLS policy', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '099: anon/authenticated unexpectedly has SELECT on %', t;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.verification_purpose_settings', 'SELECT') THEN
    RAISE EXCEPTION '099: service_role lacks SELECT on verification_purpose_settings';
  END IF;
  IF has_table_privilege('service_role', 'public.verification_purpose_settings', 'UPDATE') THEN
    RAISE EXCEPTION '099: service_role unexpectedly has direct UPDATE on verification_purpose_settings — all writes must go through the RPC';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.verification_purpose_settings_audit', 'SELECT') THEN
    RAISE EXCEPTION '099: service_role lacks SELECT on verification_purpose_settings_audit';
  END IF;
  IF has_table_privilege('service_role', 'public.verification_purpose_settings_audit', 'INSERT') THEN
    RAISE EXCEPTION '099: service_role unexpectedly has direct INSERT on verification_purpose_settings_audit — all writes must go through the RPC';
  END IF;
  IF has_table_privilege('service_role', 'public.verification_admin_idempotency', 'SELECT')
     OR has_table_privilege('service_role', 'public.verification_admin_idempotency', 'INSERT') THEN
    RAISE EXCEPTION '099: service_role unexpectedly has a grant on verification_admin_idempotency — this table is RPC-internal only';
  END IF;

  -- All eight purposes seeded, all admin_enabled = false.
  FOREACH p IN ARRAY purposes LOOP
    IF NOT EXISTS (SELECT 1 FROM public.verification_purpose_settings WHERE purpose = p) THEN
      RAISE EXCEPTION '099: purpose % was not seeded', p;
    END IF;
    IF (SELECT admin_enabled FROM public.verification_purpose_settings WHERE purpose = p) THEN
      RAISE EXCEPTION '099: purpose % seeded with admin_enabled = true', p;
    END IF;
    IF public.gv_admin_consumer_implemented(p) THEN
      RAISE EXCEPTION '099: gv_admin_consumer_implemented unexpectedly true for %', p;
    END IF;
    IF public.gv_admin_deployment_allowlisted(p) THEN
      RAISE EXCEPTION '099: gv_admin_deployment_allowlisted unexpectedly true for %', p;
    END IF;
    IF public.gv_is_purpose_enabled(p) THEN
      RAISE EXCEPTION '099: gv_is_purpose_enabled (098) unexpectedly true for % — 098 must remain untouched', p;
    END IF;
    IF public.gv_admin_effective_enabled(p) THEN
      RAISE EXCEPTION '099: gv_admin_effective_enabled unexpectedly true for %', p;
    END IF;
  END LOOP;

  -- The activation formula holds even for a HYPOTHETICAL admin_enabled=true
  -- row, proving effective_enabled cannot be forced true by a direct table
  -- write bypassing the RPC: with admin_enabled true but the other three
  -- gates still hardcoded closed, the AND chain must still be false.
  IF (true AND public.gv_admin_consumer_implemented('signup_email') AND public.gv_admin_deployment_allowlisted('signup_email') AND public.gv_is_purpose_enabled('signup_email')) THEN
    RAISE EXCEPTION '099: activation formula would allow effective_enabled=true even though this pass ships zero implemented consumers';
  END IF;

  IF has_function_privilege('anon', update_fn_sig, 'EXECUTE') OR has_function_privilege('authenticated', update_fn_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '099: anon/authenticated can execute gv_admin_update_purpose_settings';
  END IF;
  IF NOT has_function_privilege('service_role', update_fn_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '099: service_role cannot execute gv_admin_update_purpose_settings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc pr WHERE pr.oid = to_regprocedure(update_fn_sig)
      AND pr.prosecdef = true
      AND EXISTS (SELECT 1 FROM unnest(pr.proconfig) c WHERE c LIKE 'search_path=public, pg_temp')
  ) THEN
    RAISE EXCEPTION '099: gv_admin_update_purpose_settings is not SECURITY DEFINER with search_path pinned to public, pg_temp';
  END IF;

  RAISE NOTICE '099: Generic Verification Core Super Admin settings installed — % purposes seeded, admin_enabled=false, effective_enabled=false for all', array_length(purposes, 1);
END
$verify$;
