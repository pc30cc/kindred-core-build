-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 — Phase 0 runtime hardening (forward-only).
-- Migrations 077/078/082/083/087/088/089 are NOT edited.
--
-- 1. Index support for bounded priority claiming (OTP first, then email/sms).
-- 2. wi_fail_otp_job_atomic: ONE transaction that revokes the undelivered OTP
--    and writes the terminal job/delivery state under a claim-token guard.
-- 3. OTP derivation key ring: the non-secret key version travels inside the
--    stored digest ("v<version>:<hmac>"), so a pepper rotation can never make
--    the worker e-mail a code that will not verify. No raw OTP or pepper is
--    ever stored.
-- =========================================================================

-- 1. Claim-path indexes -----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_workspace_invitation_jobs_channel_priority
  ON public.workspace_invitation_jobs (channel, available_at)
  WHERE status IN ('queued', 'retrying');

CREATE INDEX IF NOT EXISTS idx_workspace_invitation_jobs_lease
  ON public.workspace_invitation_jobs (claim_expires_at)
  WHERE status = 'claimed';

-- 2. Atomic OTP terminal failure -------------------------------------------
CREATE OR REPLACE FUNCTION public.wi_fail_otp_job_atomic(
  _job_id uuid,
  _claim_token uuid,
  _worker_id text,
  _outcome text,
  _provider_name text DEFAULT NULL,
  _error_code text DEFAULT NULL,
  _safe_error_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _job public.workspace_invitation_jobs%ROWTYPE;
  _revoked boolean := false;
BEGIN
  IF _outcome NOT IN ('permanently_failed', 'unconfigured', 'derivation_key_unavailable') THEN
    RAISE EXCEPTION 'INVALID_JOB_OUTCOME';
  END IF;

  SELECT * INTO _job FROM public.workspace_invitation_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  IF _job.channel <> 'otp_email' THEN RAISE EXCEPTION 'JOB_CHANNEL_MISMATCH'; END IF;

  -- Ownership: claim token, worker identity and a live lease must all match.
  IF _job.claim_token IS DISTINCT FROM _claim_token
     OR _job.locked_by IS DISTINCT FROM _worker_id
     OR _job.status <> 'claimed'
     OR _job.claim_expires_at IS NULL
     OR _job.claim_expires_at <= now() THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  IF _job.otp_id IS NOT NULL THEN
    UPDATE public.workspace_invitation_otps
    SET revoked_at = now()
    WHERE id = _job.otp_id AND consumed_at IS NULL AND revoked_at IS NULL;
    _revoked := FOUND;
  END IF;

  UPDATE public.workspace_invitation_jobs
  SET status = _outcome,
      last_error = _safe_error_message,
      locked_by = NULL,
      locked_at = NULL,
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = now()
  WHERE id = _job_id;

  INSERT INTO public.workspace_invitation_deliveries (
    invitation_id, workspace_id, job_id, channel, notification_generation,
    attempt_number, provider_name, provider_message_id, status, error_code,
    safe_error_message, failed_at
  ) VALUES (
    _job.invitation_id, _job.workspace_id, _job.id, _job.channel,
    _job.notification_generation, _job.attempt_count, _provider_name, NULL,
    _outcome, _error_code, _safe_error_message, now()
  );

  RETURN jsonb_build_object('applied', true, 'status', _outcome, 'otp_revoked', _revoked);
END;
$$;

-- 3. OTP derivation key version --------------------------------------------
-- The digest column already carries the version prefix written by Express;
-- these helpers expose it without ever exposing the digest itself.
CREATE OR REPLACE FUNCTION public.wi_otp_digest_key_version(_digest text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _digest ~ '^v[0-9]+:' THEN substring(_digest from 2 for position(':' in _digest) - 2)::integer
    ELSE 1
  END;
$$;

-- Worker preflight now reports the key version the code must be derived with.
CREATE OR REPLACE FUNCTION public.wi_otp_job_sendable(_job_id uuid, _claim_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
       'sendable', o.consumed_at IS NULL AND o.revoked_at IS NULL AND o.expires_at > now(),
       'otp_id', o.id,
       'invitation_id', o.invitation_id,
       'workspace_id', o.workspace_id,
       'email', o.email_normalized,
       'key_version', public.wi_otp_digest_key_version(o.code_digest),
       'expires_at', o.expires_at)
     FROM public.workspace_invitation_jobs j
     JOIN public.workspace_invitation_otps o ON o.id = j.otp_id
     WHERE j.id = _job_id
       AND j.claim_token = _claim_token
       AND j.status = 'claimed'
       AND j.claim_expires_at > now()),
    jsonb_build_object('sendable', false));
$$;

-- Verify path: which key version must Express use to digest the submitted
-- code? A LIVE OTP wins; when none is live the most recent generation's
-- version is returned so an idempotent REPLAY of a verify that already
-- consumed the code still digests with the same key and replays instead of
-- failing. Returns NULL only when the token never had an OTP. The value is a
-- non-secret integer and never reveals invitation or account existence.
CREATE OR REPLACE FUNCTION public.wi_otp_pending_key_version(_token_hash text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.wi_otp_digest_key_version(o.code_digest)
  FROM public.workspace_invitation_otps o
  JOIN public.workspace_invitation_tokens t ON t.id = o.manual_token_id
  WHERE t.token_hash = _token_hash
  ORDER BY (o.consumed_at IS NULL AND o.revoked_at IS NULL AND o.expires_at > now()) DESC,
           o.created_at DESC
  LIMIT 1;
$$;

-- 4. ACL — service_role only ------------------------------------------------
DO $acl$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_fail_otp_job_atomic(uuid,uuid,text,text,text,text,text)',
    'wi_otp_digest_key_version(text)',
    'wi_otp_job_sendable(uuid,uuid)',
    'wi_otp_pending_key_version(text)'
  ];
BEGIN
  FOREACH _fn IN ARRAY _fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', _fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', _fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', _fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', _fn);
    END IF;
  END LOOP;
END
$acl$;

DO $verify$
DECLARE _fn text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.wi_fail_otp_job_atomic(uuid,uuid,text,text,text,text,text)',
    'public.wi_otp_digest_key_version(text)',
    'public.wi_otp_job_sendable(uuid,uuid)',
    'public.wi_otp_pending_key_version(text)'
  ] LOOP
    IF to_regprocedure(_fn) IS NULL THEN
      RAISE EXCEPTION 'missing function %', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'OTP runtime ACL proof failed for %', _fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_workspace_invitation_jobs_channel_priority'
  ) THEN
    RAISE EXCEPTION 'priority claim index missing';
  END IF;
END
$verify$;
