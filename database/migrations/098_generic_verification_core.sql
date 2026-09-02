-- 098 — Generic Verification Core v1.
--
-- A domain-neutral, purpose-agnostic OTP/verification engine intended for
-- FUTURE consumers (signup email/phone verification, password reset,
-- login step-up, email/phone change, sensitive-action confirmation,
-- workspace member flows). NOTHING in this migration is called by any
-- existing route, RPC, or trigger — every table/function here is new,
-- additive, and unreferenced by the rest of the schema. No existing
-- table, function, trigger, or column is altered, renamed, or dropped.
--
-- Explicitly NOT migrated here: the existing Workspace Invitations v5.1
-- OTP system (`workspace_invitation_otps`/`workspace_invitation_proofs`,
-- migrations 077-097) and the existing phone-verification OTP system
-- (`phone_verification_challenges`/`user_phone_verifications`, hosted-only
-- migrations from 2026-08-01) both continue completely unchanged. This is
-- a NEW, separate, parallel subsystem — not a replacement, not a shared
-- table, not a dual-write. See docs/GENERIC_VERIFICATION_CORE.md for the
-- full architecture and docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md for
-- how a FUTURE consumer would adopt this (none does yet).
--
-- Every "purpose" this core could ever serve ships DISABLED by default in
-- the application-layer registry (server/services/verification/purposes.ts)
-- — a disabled purpose is rejected by that TypeScript layer BEFORE any
-- database call is made, so this migration installing successfully does
-- not, by itself, let anything be sent. This migration's own DO $verify$
-- block at the bottom proves the ACL/security posture; it does not and
-- cannot prove "dormant" (that is an application-layer guarantee, see the
-- server/services/verification test suite for the "disabled purpose ⇒ zero
-- writes" proof).
--
-- Cryptography: every table stores only HMAC digests/hashes, never a raw
-- OTP code or raw proof token. All HMAC/hash computation happens in Node
-- (server/services/verification/crypto.ts), keyed by a versioned pepper
-- ring (GENERIC_VERIFICATION_PEPPER[_RING/_KEY_VERSION] env vars — entirely
-- separate secrets from INVITATION_OTP_PEPPER/INVITATION_LINK_SECRET and
-- PHONE_VERIFICATION_PEPPER; no secret is reused across subsystems). SQL
-- here only stores and compares opaque hex strings — it never hashes
-- anything itself, matching the already-proven pattern in the Workspace
-- Invitations v5.1 subsystem (see that subsystem's `tokens.ts`).
--
-- Canonical lock order (mirrors the Workspace Invitations v5.1 convention,
-- stated once here rather than re-derived per function): workspace (if
-- bound) → challenge → proof → job. Every RPC below acquires locks in this
-- order to avoid deadlocking against itself under concurrency.

-- ============================================================
-- 1. verification_challenges
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_challenges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  handle text NOT NULL UNIQUE,                    -- opaque, client-facing (never the OTP code)
  purpose text NOT NULL,                          -- from the app-layer purpose registry; not a DB enum
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,  -- optional tenant binding
  subject_kind text NOT NULL CHECK (subject_kind IN ('user', 'pending_account', 'anonymous')),
  subject_ref text,                               -- e.g. an existing user id; NULL for pre-account/anonymous
  subject_ref_hash text,                          -- HMAC of a sensitive subject identifier when subject_ref itself must not be stored raw
  destination_normalized text NOT NULL,           -- normalized email/phone the OTP is actually delivered to (delivery needs the real value)
  destination_hash text NOT NULL,                 -- HMAC of destination_normalized — used for domain separation + rate-limit bucketing, never for delivery
  locale text NOT NULL CHECK (locale IN ('fa', 'tr', 'en')),
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending_delivery' CHECK (
    status IN ('pending_delivery', 'provider_accepted', 'verified', 'revoked', 'expired', 'locked', 'delivery_failed')
  ),
  key_version integer NOT NULL,
  code_digest text NOT NULL,                      -- "v<version>:<hmac-hex>" — never the raw code
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  send_count integer NOT NULL DEFAULT 1,
  max_sends integer NOT NULL,
  resend_cooldown_seconds integer NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  request_ip_hash text,
  idempotency_key text,
  created_by_context text NOT NULL DEFAULT 'self_service' CHECK (created_by_context IN ('self_service', 'admin', 'system')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verification_challenges_destination_window
  ON public.verification_challenges (destination_hash, purpose, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_challenges_subject_window
  ON public.verification_challenges (subject_ref_hash, purpose, created_at) WHERE subject_ref_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_challenges_workspace_window
  ON public.verification_challenges (workspace_id, purpose, created_at) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_challenges_ip_window
  ON public.verification_challenges (request_ip_hash, purpose, created_at) WHERE request_ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_challenges_live_lookup
  ON public.verification_challenges (destination_hash, purpose, channel) WHERE status IN ('pending_delivery', 'provider_accepted');

-- ============================================================
-- 2. verification_attempts — append-only per-attempt audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  result text NOT NULL CHECK (result IN ('correct', 'incorrect', 'expired', 'locked', 'revoked')),
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_attempts_challenge ON public.verification_attempts (challenge_id, created_at);

-- ============================================================
-- 3. verification_proofs — the consumable, single-use credential a
--    successful verification issues. Denormalizes purpose/channel/
--    workspace/subject from the challenge so a future consumer's
--    "wrong purpose/subject/workspace" check never depends on a join
--    surviving (the challenge row can be deleted by CASCADE independent
--    of the proof's own lifecycle needs, though in v1 they cascade
--    together — the denormalization is defense in depth for any future
--    schema evolution that decouples them).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_proofs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  proof_hash text NOT NULL UNIQUE,                -- HMAC of the raw proof token — the raw token is NEVER stored
  purpose text NOT NULL,
  channel text NOT NULL,
  workspace_id uuid,
  subject_kind text NOT NULL,
  subject_ref text,
  subject_ref_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_context text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_proofs_lookup ON public.verification_proofs (proof_hash) WHERE status = 'active';

-- ============================================================
-- 4. verification_delivery_jobs — the outbox. The OTP code is NEVER
--    stored here (or anywhere) — the worker re-derives it deterministically
--    at send time from (purpose, channel, challenge id, generation,
--    destination hash, key version), so a crashed/retried delivery
--    reproduces the exact same code without ever persisting it.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_delivery_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  channel text NOT NULL,
  destination_normalized text NOT NULL,
  purpose text NOT NULL,
  locale text NOT NULL,
  generation integer NOT NULL,
  idempotency_key text NOT NULL UNIQUE,           -- de-dupes a second job for the same logical send
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'claimed', 'retrying', 'provider_accepted', 'permanently_failed')
  ),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  claim_token uuid,
  claim_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_delivery_jobs_claimable
  ON public.verification_delivery_jobs (available_at) WHERE status IN ('queued', 'retrying');
CREATE INDEX IF NOT EXISTS idx_verification_delivery_jobs_stale_claims
  ON public.verification_delivery_jobs (claim_expires_at) WHERE status = 'claimed';

-- ============================================================
-- 5. verification_deliveries — append-only delivery-evidence ledger.
--    "provider_accepted" is the strongest outcome ever recorded — never
--    "delivered" (this codebase cannot know actual mailbox/handset
--    delivery, matching the Workspace Invitations v5.1 convention).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_deliveries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.verification_delivery_jobs(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES public.verification_challenges(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (
    outcome IN ('provider_accepted', 'retry', 'permanently_failed', 'unconfigured', 'derivation_key_unavailable')
  ),
  provider_name text,
  provider_message_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_deliveries_job ON public.verification_deliveries (job_id, created_at);

-- ============================================================
-- 6. verification_idempotency — generic to THIS subsystem only (not
--    reused from workspace_invitation_idempotency, which is CHECK-
--    constrained to invitation-specific operations and FK'd to
--    invitation_id; no other pre-existing generic ledger was found in
--    this codebase — see docs/GENERIC_VERIFICATION_CORE.md §Idempotency).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verification_idempotency (
  key text NOT NULL PRIMARY KEY,
  scope_kind text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('request', 'resend', 'consume', 'revoke')),
  purpose text,
  workspace_id uuid,
  challenge_id uuid,
  result_state text NOT NULL DEFAULT 'in_progress' CHECK (result_state IN ('in_progress', 'committed', 'failed')),
  request_fingerprint text NOT NULL,
  safe_result jsonb,
  actor_ref_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_verification_idempotency_expiry ON public.verification_idempotency (expires_at);

-- ============================================================
-- 7. RLS + GRANTs — every table is backend-only. RLS enabled, ZERO
--    policies (deny-all for anon/authenticated; service_role bypasses RLS
--    via its own BYPASSRLS role attribute, not via a policy). No DELETE
--    grant on the two append-only evidence tables.
-- ============================================================
ALTER TABLE public.verification_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_idempotency ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.verification_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_proofs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_delivery_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_deliveries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.verification_idempotency FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.verification_challenges TO service_role;
GRANT SELECT, INSERT ON public.verification_attempts TO service_role;          -- append-only, no UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE ON public.verification_proofs TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.verification_delivery_jobs TO service_role;
GRANT SELECT, INSERT ON public.verification_deliveries TO service_role;       -- append-only, no UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification_idempotency TO service_role; -- DELETE needed for the purge RPC

-- ============================================================
-- 8. RPCs
-- ============================================================

-- 8a. Idempotent request/resend/verify/consume/revoke dispatch. One RPC,
--     like Workspace Invitations v5.1's wi_execute_idempotent, so Express
--     never writes the ledger directly and every mutating operation is
--     idempotent-by-construction.
CREATE OR REPLACE FUNCTION public.gv_execute_idempotent(
  _key text,
  _scope_kind text,
  _operation text,
  _request_fingerprint text,
  _purpose text,
  _workspace_id uuid,
  _actor_ref_hash text,
  _args jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _row public.verification_idempotency%ROWTYPE;
  _result jsonb;
  _result_code text;
BEGIN
  IF _key IS NULL OR length(_key) < 16 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_INVALID';
  END IF;

  INSERT INTO public.verification_idempotency (key, scope_kind, operation, purpose, workspace_id, request_fingerprint, actor_ref_hash)
  VALUES (_key, _scope_kind, _operation, _purpose, _workspace_id, _request_fingerprint, _actor_ref_hash)
  ON CONFLICT (key) DO NOTHING;

  SELECT * INTO _row FROM public.verification_idempotency WHERE key = _key FOR UPDATE;

  IF _row.operation <> _operation OR _row.scope_kind <> _scope_kind OR _row.request_fingerprint <> _request_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
  END IF;

  IF _row.result_state = 'committed' THEN
    RETURN jsonb_build_object('replayed', true, 'result', _row.safe_result);
  END IF;

  IF _row.result_state = 'failed' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_FAILED_PREVIOUSLY';
  END IF;

  -- NOTE: 'verify' is deliberately NOT dispatched through this ledger (see
  -- public.gv_verify_verification_challenge below, called directly). Each
  -- verification attempt is a counted, mutating event against a shared
  -- attempt counter — request-replay semantics ("same key ⇒ return the
  -- SAME cached result without re-executing") are the wrong model for an
  -- operation where a genuinely new submission (even against the same
  -- challenge) must always be re-evaluated. Concurrency safety for verify
  -- comes from _gv_do_verify's own `FOR UPDATE` row lock instead.
  CASE _operation
    WHEN 'request' THEN
      SELECT public._gv_do_request(_args) INTO _result;
    WHEN 'resend' THEN
      SELECT public._gv_do_resend(_args) INTO _result;
    WHEN 'revoke' THEN
      SELECT public._gv_do_revoke(_args) INTO _result;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_UNKNOWN';
  END CASE;

  UPDATE public.verification_idempotency
  SET result_state = 'committed', safe_result = _result, completed_at = now(),
      challenge_id = NULLIF(_result->>'challengeId', '')::uuid
  WHERE key = _key;

  RETURN jsonb_build_object('replayed', false, 'result', _result);
EXCEPTION
  WHEN OTHERS THEN
    _result_code := SQLERRM;
    UPDATE public.verification_idempotency SET result_state = 'failed', completed_at = now() WHERE key = _key;
    RAISE;
END;
$function$;

-- 8b. Internal (not directly callable by Express — dispatched only via
--     gv_execute_idempotent above) request-a-challenge implementation.
CREATE OR REPLACE FUNCTION public._gv_do_request(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _workspace_id uuid := NULLIF(_args->>'workspaceId', '')::uuid;
  _purpose text := _args->>'purpose';
  _channel text := _args->>'channel';
  _destination_normalized text := _args->>'destinationNormalized';
  _destination_hash text := _args->>'destinationHash';
  _subject_kind text := _args->>'subjectKind';
  _subject_ref text := NULLIF(_args->>'subjectRef', '');
  _subject_ref_hash text := NULLIF(_args->>'subjectRefHash', '');
  _locale text := _args->>'locale';
  _key_version integer := (_args->>'keyVersion')::integer;
  _code_digest text := _args->>'codeDigest';
  _job_idempotency_key text := _args->>'jobIdempotencyKey';
  _ttl_seconds integer := (_args->>'ttlSeconds')::integer;
  _max_attempts integer := (_args->>'maxAttempts')::integer;
  _max_sends integer := (_args->>'maxSends')::integer;
  _resend_cooldown_seconds integer := (_args->>'resendCooldownSeconds')::integer;
  _rate_window_seconds integer := (_args->>'rateWindowSeconds')::integer;
  _max_per_window integer := (_args->>'maxPerWindow')::integer;
  _invalidate_previous boolean := COALESCE((_args->>'invalidatePrevious')::boolean, true);
  _request_ip_hash text := NULLIF(_args->>'requestIpHash', '');
  _handle text := _args->>'handle';
  _challenge_id uuid;
  _generation integer := 1;
  _recent integer;
  _last timestamptz;
BEGIN
  IF _workspace_id IS NOT NULL THEN
    PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  END IF;

  -- Rate limit: rolling-window cap, scoped to (destination, purpose, channel) — same
  -- shape as the proven Workspace Invitations v5.1 policy, generalized to a
  -- purpose-supplied window/cap instead of a hardcoded 3600s/5.
  SELECT count(*)::integer, max(created_at) INTO _recent, _last
  FROM public.verification_challenges
  WHERE destination_hash = _destination_hash AND purpose = _purpose AND channel = _channel
    AND created_at > now() - make_interval(secs => _rate_window_seconds);

  IF _last IS NOT NULL AND _last > now() - make_interval(secs => _resend_cooldown_seconds) THEN
    RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
  END IF;
  IF _recent >= _max_per_window THEN
    RAISE EXCEPTION 'VERIFICATION_RATE_LIMITED';
  END IF;

  IF _invalidate_previous THEN
    UPDATE public.verification_challenges
    SET status = 'revoked', revoked_at = now(), revoked_reason = 'superseded_by_new_generation'
    WHERE destination_hash = _destination_hash AND purpose = _purpose AND channel = _channel
      AND status IN ('pending_delivery', 'provider_accepted')
    RETURNING generation + 1 INTO _generation;
    -- No previous LIVE challenge to invalidate (first-ever request for this
    -- destination/purpose/channel) — RETURNING ... INTO on a zero-row UPDATE
    -- sets the variable to NULL, not "leave it at its default", so this
    -- must be restored explicitly rather than left to fail the NOT NULL
    -- constraint on INSERT below.
    IF _generation IS NULL THEN
      _generation := 1;
    END IF;
  END IF;

  INSERT INTO public.verification_challenges (
    handle, purpose, channel, workspace_id, subject_kind, subject_ref, subject_ref_hash,
    destination_normalized, destination_hash, locale, generation, key_version, code_digest,
    max_attempts, max_sends, resend_cooldown_seconds, expires_at, request_ip_hash
  ) VALUES (
    _handle, _purpose, _channel, _workspace_id, _subject_kind, _subject_ref, _subject_ref_hash,
    _destination_normalized, _destination_hash, _locale, _generation, _key_version, _code_digest,
    _max_attempts, _max_sends, _resend_cooldown_seconds, now() + make_interval(secs => _ttl_seconds), _request_ip_hash
  ) RETURNING id INTO _challenge_id;

  INSERT INTO public.verification_delivery_jobs (
    challenge_id, channel, destination_normalized, purpose, locale, generation, idempotency_key, max_attempts
  ) VALUES (
    _challenge_id, _channel, _destination_normalized, _purpose, _locale, _generation, _job_idempotency_key, 5
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'challengeId', _challenge_id, 'handle', _handle, 'generation', _generation,
    'expiresAt', (now() + make_interval(secs => _ttl_seconds)),
    'resendAvailableAt', (now() + make_interval(secs => _resend_cooldown_seconds))
  );
END;
$function$;

-- 8c. Resend — same rate-limit/invalidate-previous logic as request,
--     reusing _gv_do_request under the hood (a resend IS a new generation).
CREATE OR REPLACE FUNCTION public._gv_do_resend(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public._gv_do_request(_args);
END;
$function$;

-- 8d. Verify — locks the live challenge, enforces attempt/lockout/expiry,
--     compares the caller-supplied candidate digest (computed in Node
--     using the challenge's OWN recorded key_version/generation — never
--     the newest key), and on success issues exactly one proof.
CREATE OR REPLACE FUNCTION public._gv_do_verify(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _handle text := _args->>'handle';
  _candidate_digest text := _args->>'candidateDigest';
  _purpose text := _args->>'purpose';
  _channel text := _args->>'channel';
  _workspace_id uuid := NULLIF(_args->>'workspaceId', '')::uuid;
  _subject_ref_hash text := NULLIF(_args->>'subjectRefHash', '');
  _ip_hash text := NULLIF(_args->>'ipHash', '');
  _issues_proof boolean := COALESCE((_args->>'issuesProof')::boolean, true);
  _proof_hash text := _args->>'proofHash';
  _proof_ttl_seconds integer := (_args->>'proofTtlSeconds')::integer;
  _chal public.verification_challenges%ROWTYPE;
  _next_attempt integer;
BEGIN
  SELECT * INTO _chal FROM public.verification_challenges WHERE handle = _handle FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Wrong purpose/channel/workspace/subject can never verify against this
  -- challenge, and the response is the SAME generic shape as an incorrect
  -- code — no distinguishing signal leaks which check failed.
  IF _chal.purpose <> _purpose OR _chal.channel <> _channel
     OR _chal.workspace_id IS DISTINCT FROM _workspace_id
     OR (_subject_ref_hash IS NOT NULL AND _chal.subject_ref_hash IS DISTINCT FROM _subject_ref_hash) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;

  IF _chal.status = 'verified' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_verified');
  END IF;
  IF _chal.status NOT IN ('pending_delivery', 'provider_accepted') THEN
    RETURN jsonb_build_object('ok', false, 'reason', _chal.status);
  END IF;
  IF _chal.expires_at <= now() THEN
    UPDATE public.verification_challenges SET status = 'expired' WHERE id = _chal.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF _chal.attempt_count >= _chal.max_attempts THEN
    UPDATE public.verification_challenges SET status = 'locked' WHERE id = _chal.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'locked');
  END IF;

  _next_attempt := _chal.attempt_count + 1;

  IF _chal.code_digest <> _candidate_digest THEN
    INSERT INTO public.verification_attempts (challenge_id, attempt_no, result, ip_hash)
    VALUES (_chal.id, _next_attempt, 'incorrect', _ip_hash);

    IF _next_attempt >= _chal.max_attempts THEN
      UPDATE public.verification_challenges SET attempt_count = _next_attempt, status = 'locked' WHERE id = _chal.id;
      RETURN jsonb_build_object('ok', false, 'reason', 'locked');
    END IF;

    UPDATE public.verification_challenges SET attempt_count = _next_attempt WHERE id = _chal.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_code');
  END IF;

  INSERT INTO public.verification_attempts (challenge_id, attempt_no, result, ip_hash)
  VALUES (_chal.id, _next_attempt, 'correct', _ip_hash);

  UPDATE public.verification_challenges
  SET status = 'verified', verified_at = now(), attempt_count = _next_attempt
  WHERE id = _chal.id;

  IF _issues_proof THEN
    INSERT INTO public.verification_proofs (
      challenge_id, proof_hash, purpose, channel, workspace_id, subject_kind, subject_ref, subject_ref_hash, expires_at
    ) VALUES (
      _chal.id, _proof_hash, _chal.purpose, _chal.channel, _chal.workspace_id, _chal.subject_kind, _chal.subject_ref, _chal.subject_ref_hash,
      now() + make_interval(secs => _proof_ttl_seconds)
    );
    RETURN jsonb_build_object('ok', true, 'challengeId', _chal.id, 'proofIssued', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'challengeId', _chal.id, 'proofIssued', false);
END;
$function$;

-- 8d-2. Direct-callable verify entry point — deliberately bypasses
--       gv_execute_idempotent (see that function's own comment on why
--       'verify' is not in its CASE dispatch). This is the ONLY verify
--       entry point Express/service.ts calls.
CREATE OR REPLACE FUNCTION public.gv_verify_verification_challenge(_args jsonb) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT public._gv_do_verify(_args);
$function$;

-- 8e. Revoke — explicit admin/system cancellation, also revokes any live proof.
CREATE OR REPLACE FUNCTION public._gv_do_revoke(_args jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _handle text := _args->>'handle';
  _reason text := COALESCE(_args->>'reason', 'revoked');
  _chal_id uuid;
BEGIN
  UPDATE public.verification_challenges
  SET status = 'revoked', revoked_at = now(), revoked_reason = _reason
  WHERE handle = _handle AND status IN ('pending_delivery', 'provider_accepted', 'verified')
  RETURNING id INTO _chal_id;

  IF _chal_id IS NOT NULL THEN
    UPDATE public.verification_proofs
    SET status = 'revoked', revoked_at = now()
    WHERE challenge_id = _chal_id AND status = 'active';
  END IF;

  RETURN jsonb_build_object('ok', _chal_id IS NOT NULL);
END;
$function$;

-- 8f. Consume a proof — the ONE function a FUTURE consumer calls from
--     WITHIN ITS OWN SECURITY DEFINER function (a plain SQL function call,
--     not a second RPC round-trip) so proof consumption is atomic with
--     that consumer's business mutation in a single transaction. See
--     docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md for the exact pattern.
--     No consumer exists yet — nothing in this codebase calls this today.
CREATE OR REPLACE FUNCTION public.gv_consume_verification_proof(
  _proof_hash text,
  _purpose text,
  _channel text,
  _workspace_id uuid,
  _subject_ref_hash text,
  _consumed_by_context text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _proof public.verification_proofs%ROWTYPE;
BEGIN
  SELECT * INTO _proof FROM public.verification_proofs WHERE proof_hash = _proof_hash FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF _proof.purpose <> _purpose OR _proof.channel <> _channel
     OR _proof.workspace_id IS DISTINCT FROM _workspace_id
     OR (_subject_ref_hash IS NOT NULL AND _proof.subject_ref_hash IS DISTINCT FROM _subject_ref_hash) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'scope_mismatch');
  END IF;

  IF _proof.status = 'consumed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_consumed');
  END IF;
  IF _proof.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', _proof.status);
  END IF;
  IF _proof.expires_at <= now() THEN
    UPDATE public.verification_proofs SET status = 'expired' WHERE id = _proof.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  UPDATE public.verification_proofs
  SET status = 'consumed', consumed_at = now(), consumed_by_context = _consumed_by_context
  WHERE id = _proof.id;

  RETURN jsonb_build_object(
    'ok', true, 'challengeId', _proof.challenge_id, 'subjectKind', _proof.subject_kind,
    'subjectRef', _proof.subject_ref, 'subjectRefHash', _proof.subject_ref_hash
  );
END;
$function$;

-- 8g. Safe status lookup — never returns destination, digest, or code.
CREATE OR REPLACE FUNCTION public.gv_get_verification_status(_handle text) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'status', status, 'purpose', purpose, 'channel', channel, 'generation', generation,
    'expiresAt', expires_at, 'attemptsRemaining', GREATEST(max_attempts - attempt_count, 0),
    'resendAvailableAt', created_at + make_interval(secs => resend_cooldown_seconds)
  )
  FROM public.verification_challenges WHERE handle = _handle;
$function$;

-- 8h. Worker: claim (lease/claim-token pattern, identical shape to the
--     proven Workspace Invitations v5.1 `claim_invitation_jobs`).
CREATE OR REPLACE FUNCTION public.gv_claim_verification_jobs(
  _worker_id text, _limit integer, _lease_seconds integer, _channels text[]
) RETURNS SETOF public.verification_delivery_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT j.id FROM public.verification_delivery_jobs j
    WHERE j.status IN ('queued', 'retrying') AND j.available_at <= now()
      AND j.channel = ANY(_channels)
    ORDER BY j.available_at
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.verification_delivery_jobs j
  SET status = 'claimed', locked_by = _worker_id, locked_at = now(),
      claim_token = gen_random_uuid(),
      claim_expires_at = now() + make_interval(secs => _lease_seconds),
      attempt_count = j.attempt_count + 1, updated_at = now()
  FROM candidates c WHERE j.id = c.id
  RETURNING j.*;
END;
$function$;

-- 8i. Worker: heartbeat.
CREATE OR REPLACE FUNCTION public.gv_heartbeat_verification_job(
  _job_id uuid, _claim_token uuid, _lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF _lease_seconds < 30 OR _lease_seconds > 600 THEN
    RAISE EXCEPTION 'LEASE_SECONDS_OUT_OF_RANGE';
  END IF;

  UPDATE public.verification_delivery_jobs
  SET claim_expires_at = now() + make_interval(secs => _lease_seconds), updated_at = now()
  WHERE id = _job_id AND claim_token = _claim_token AND status = 'claimed' AND claim_expires_at > now();

  RETURN FOUND;
END;
$function$;

-- 8j. Worker: complete (terminal outcomes). A stale claim_token is a
--     silent no-op — a worker that lost its lease can never overwrite
--     newer state.
CREATE OR REPLACE FUNCTION public.gv_complete_verification_job(
  _job_id uuid, _claim_token uuid, _outcome text,
  _provider_name text, _provider_message_id text,
  _error_code text, _error_message text, _retry_in_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _job public.verification_delivery_jobs%ROWTYPE;
  _new_status text;
BEGIN
  SELECT * INTO _job FROM public.verification_delivery_jobs WHERE id = _job_id FOR UPDATE;

  IF NOT FOUND OR _job.claim_token IS DISTINCT FROM _claim_token THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  _new_status := CASE
    WHEN _outcome = 'provider_accepted' THEN 'provider_accepted'
    WHEN _outcome = 'retry' AND _job.attempt_count >= _job.max_attempts THEN 'permanently_failed'
    WHEN _outcome = 'retry' THEN 'retrying'
    ELSE 'permanently_failed'
  END;

  UPDATE public.verification_delivery_jobs
  SET status = _new_status,
      available_at = CASE WHEN _new_status = 'retrying' THEN now() + make_interval(secs => _retry_in_seconds) ELSE available_at END,
      last_error_code = _error_code, last_error_message = left(_error_message, 300),
      locked_by = NULL, locked_at = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = now()
  WHERE id = _job.id;

  IF _new_status = 'permanently_failed' THEN
    UPDATE public.verification_challenges SET status = 'delivery_failed'
    WHERE id = _job.challenge_id AND status IN ('pending_delivery', 'provider_accepted');
  ELSIF _outcome = 'provider_accepted' THEN
    UPDATE public.verification_challenges SET status = 'provider_accepted'
    WHERE id = _job.challenge_id AND status = 'pending_delivery';
  END IF;

  INSERT INTO public.verification_deliveries (job_id, challenge_id, outcome, provider_name, provider_message_id, error_code, error_message)
  VALUES (_job.id, _job.challenge_id, _outcome, _provider_name, _provider_message_id, _error_code, left(_error_message, 300));

  RETURN jsonb_build_object('applied', true, 'status', _new_status);
END;
$function$;

-- 8k. Worker: reclaim expired leases.
CREATE OR REPLACE FUNCTION public.gv_reclaim_expired_verification_jobs() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _n integer;
BEGIN
  WITH updated AS (
    UPDATE public.verification_delivery_jobs
    SET status = CASE WHEN attempt_count >= max_attempts THEN 'permanently_failed' ELSE 'queued' END,
        locked_by = NULL, locked_at = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = now()
    WHERE status = 'claimed' AND claim_expires_at <= now()
    RETURNING 1
  )
  SELECT count(*) INTO _n FROM updated;
  RETURN _n;
END;
$function$;

-- 8l. Purge expired idempotency rows — never blocks/duplicates live claims.
CREATE OR REPLACE FUNCTION public.gv_purge_expired_idempotency(_limit integer) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _n integer;
BEGIN
  WITH victims AS (
    SELECT key FROM public.verification_idempotency
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.verification_idempotency USING victims WHERE public.verification_idempotency.key = victims.key
  RETURNING 1 INTO _n;
  RETURN COALESCE(_n, 0);
END;
$function$;

-- ============================================================
-- 9. ACL lockdown — every RPC above is service_role-only. No browser-
--    reachable verification RPC exists.
-- ============================================================
DO $acl$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'public.gv_execute_idempotent(text, text, text, text, text, uuid, text, jsonb)',
    'public._gv_do_request(jsonb)',
    'public._gv_do_resend(jsonb)',
    'public._gv_do_verify(jsonb)',
    'public.gv_verify_verification_challenge(jsonb)',
    'public._gv_do_revoke(jsonb)',
    'public.gv_consume_verification_proof(text, text, text, uuid, text, text)',
    'public.gv_get_verification_status(text)',
    'public.gv_claim_verification_jobs(text, integer, integer, text[])',
    'public.gv_heartbeat_verification_job(uuid, uuid, integer)',
    'public.gv_complete_verification_job(uuid, uuid, text, text, text, text, text, integer)',
    'public.gv_reclaim_expired_verification_jobs()',
    'public.gv_purge_expired_idempotency(integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$acl$;

-- ============================================================
-- 10. Build-time verification — proves the invariants this migration
--     claims, exactly like the established Workspace Invitations v5.1
--     `DO $verify$` convention: a migration that violates its own
--     security posture fails to apply, it does not silently ship broken.
-- ============================================================
DO $verify$
DECLARE
  t text;
  fn text;
  sig text;
  tables text[] := ARRAY[
    'verification_challenges', 'verification_attempts', 'verification_proofs',
    'verification_delivery_jobs', 'verification_deliveries', 'verification_idempotency'
  ];
  append_only_tables text[] := ARRAY['verification_attempts', 'verification_deliveries'];
  fns text[] := ARRAY[
    'public.gv_execute_idempotent(text, text, text, text, text, uuid, text, jsonb)',
    'public._gv_do_request(jsonb)',
    'public._gv_do_resend(jsonb)',
    'public._gv_do_verify(jsonb)',
    'public.gv_verify_verification_challenge(jsonb)',
    'public._gv_do_revoke(jsonb)',
    'public.gv_consume_verification_proof(text, text, text, uuid, text, text)',
    'public.gv_get_verification_status(text)',
    'public.gv_claim_verification_jobs(text, integer, integer, text[])',
    'public.gv_heartbeat_verification_job(uuid, uuid, integer)',
    'public.gv_complete_verification_job(uuid, uuid, text, text, text, text, text, integer)',
    'public.gv_reclaim_expired_verification_jobs()',
    'public.gv_purge_expired_idempotency(integer)'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '098: table % was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '098: RLS not enabled on %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION '098: % unexpectedly has a browser-facing RLS policy — must be zero policies (service_role bypasses RLS)', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '098: anon/authenticated unexpectedly has SELECT on %', t;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '098: service_role lacks SELECT on %', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY append_only_tables LOOP
    IF has_table_privilege('service_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '098: append-only table % unexpectedly grants DELETE to service_role', t;
    END IF;
    IF has_table_privilege('service_role', 'public.' || t, 'UPDATE') THEN
      RAISE EXCEPTION '098: append-only table % unexpectedly grants UPDATE to service_role', t;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY fns LOOP
    sig := to_regprocedure(fn)::text;
    IF sig IS NULL THEN
      RAISE EXCEPTION '098: function % was not created', fn;
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: anon can execute %', fn;
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: authenticated can execute %', fn;
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '098: service_role cannot execute %', fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(fn)
        AND p.prosecdef = true
        AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=public, pg_temp')
    ) THEN
      RAISE EXCEPTION '098: % is not SECURITY DEFINER with search_path pinned to public, pg_temp', fn;
    END IF;
  END LOOP;

  RAISE NOTICE '098: Generic Verification Core v1 installed — % tables, % RPCs, all service_role-only, RLS enabled with zero browser policies', array_length(tables, 1), array_length(fns, 1);
END
$verify$;
