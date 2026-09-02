-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 §E — persisted notification locale (fa/tr/en)
-- Forward-only. 077–094 are NOT modified.
-- =========================================================================

ALTER TABLE public.workspace_invitations
  ADD COLUMN IF NOT EXISTS locale text;

DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workspace_invitations'::regclass
      AND conname = 'workspace_invitations_locale_supported'
  ) THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_locale_supported
      CHECK (locale IS NULL OR locale IN ('fa', 'tr', 'en'));
  END IF;
END
$c$;

-- Resolution order at INSERT: explicit value → workspace panel language →
-- workspace default language → application last resort ('en').
-- Accept-Language is never consulted anywhere in this chain.
CREATE OR REPLACE FUNCTION public.wi_default_invitation_locale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _panel text;
  _default text;
BEGIN
  IF NEW.locale IS NULL THEN
    SELECT w.panel_locale, w.default_locale INTO _panel, _default
    FROM public.workspaces w WHERE w.id = NEW.workspace_id;
    NEW.locale := COALESCE(
      NULLIF(lower(split_part(_panel, '-', 1)), ''),
      NULLIF(lower(split_part(_default, '-', 1)), ''),
      'en');
  END IF;
  IF NEW.locale NOT IN ('fa', 'tr', 'en') THEN NEW.locale := 'en'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wi_default_invitation_locale ON public.workspace_invitations;
CREATE TRIGGER trg_wi_default_invitation_locale
  BEFORE INSERT ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.wi_default_invitation_locale();

UPDATE public.workspace_invitations SET locale = 'en' WHERE locale IS NULL;

-- Backend-only: record the effective locale that the management surface
-- resolved for this invitation. Only while the invitation is still pending,
-- and only to a supported locale.
CREATE OR REPLACE FUNCTION public.wi_set_invitation_locale(_invitation_id uuid, _locale text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _lc text := lower(split_part(coalesce(_locale, ''), '-', 1));
  _applied boolean := false;
BEGIN
  IF _lc NOT IN ('fa', 'tr', 'en') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'UNSUPPORTED_LOCALE');
  END IF;

  UPDATE public.workspace_invitations
  SET locale = _lc
  WHERE id = _invitation_id AND status = 'pending' AND locale IS DISTINCT FROM _lc;
  GET DIAGNOSTICS _applied = ROW_COUNT;

  RETURN jsonb_build_object('applied', _applied, 'locale', _lc);
END;
$$;

-- Prepare RPC rebased on 082 with ONE addition: the invitation locale is
-- returned so the worker can render fa/tr/en templates. Everything else
-- (locking order, token rotation, cancellation semantics) is unchanged.
CREATE OR REPLACE FUNCTION public.wi_prepare_invitation_job(
  _job_id uuid,
  _claim_token uuid,
  _token_hash text DEFAULT NULL,
  _token_prefix text DEFAULT NULL,
  _token_expires_at timestamptz DEFAULT NULL,
  _derivation_key_version integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _job public.workspace_invitation_jobs%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _ws_name text;
BEGIN
  SELECT * INTO _job FROM public.workspace_invitation_jobs WHERE id = _job_id;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _job.workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _job.invitation_id FOR UPDATE;
  SELECT * INTO _job FROM public.workspace_invitation_jobs WHERE id = _job_id FOR UPDATE;

  IF _job.claim_token IS DISTINCT FROM _claim_token
     OR _job.status <> 'claimed'
     OR _job.claim_expires_at IS NULL
     OR _job.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'JOB_CLAIM_LOST';
  END IF;

  IF _inv.id IS NULL
     OR _inv.status <> 'pending'
     OR _inv.invitation_flow_version <> 2
     OR _job.notification_generation <> _inv.notification_generation THEN
    UPDATE public.workspace_invitation_jobs
    SET status = 'cancelled', claim_token = NULL, locked_by = NULL,
        claim_expires_at = NULL, updated_at = now()
    WHERE id = _job_id;
    RETURN jsonb_build_object('cancelled', true);
  END IF;

  IF _job.channel = 'email' THEN
    IF _token_hash IS NULL OR _token_prefix IS NULL OR _token_expires_at IS NULL THEN
      RAISE EXCEPTION 'EMAIL_TOKEN_REQUIRED';
    END IF;

    UPDATE public.workspace_invitation_tokens
    SET revoked_at = now()
    WHERE invitation_id = _inv.id AND purpose = 'email_claim'
      AND consumed_at IS NULL AND revoked_at IS NULL
      AND token_hash <> _token_hash;

    INSERT INTO public.workspace_invitation_tokens (
      invitation_id, workspace_id, purpose, token_hash, token_prefix,
      token_generation, notification_generation, derivation_key_version, expires_at
    ) VALUES (
      _inv.id, _inv.workspace_id, 'email_claim', _token_hash, _token_prefix,
      COALESCE(_job.email_token_generation, 1), _inv.notification_generation,
      _derivation_key_version, _token_expires_at
    )
    ON CONFLICT (token_hash) DO NOTHING;

    UPDATE public.workspace_invitation_jobs
    SET derivation_key_version = COALESCE(derivation_key_version, _derivation_key_version),
        updated_at = now()
    WHERE id = _job_id;
  END IF;

  SELECT w.name INTO _ws_name FROM public.workspaces w WHERE w.id = _inv.workspace_id;

  RETURN jsonb_build_object(
    'cancelled', false,
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _ws_name,
    'channel', _job.channel,
    'email', _inv.invited_email_normalized,
    'phone', _inv.invited_phone_e164,
    'first_name', _inv.first_name,
    'last_name', _inv.last_name,
    'role', _inv.role,
    'locale', COALESCE(_inv.locale, 'en'),
    'expires_at', _inv.expires_at,
    'attempt_number', _job.attempt_count,
    'notification_generation', _inv.notification_generation
  );
END;
$$;

-- OTP send-state rebased on 090 with ONE addition: the invitation locale.
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
       'locale', COALESCE(i.locale, 'en'),
       'key_version', public.wi_otp_digest_key_version(o.code_digest),
       'expires_at', o.expires_at)
     FROM public.workspace_invitation_jobs j
     JOIN public.workspace_invitation_otps o ON o.id = j.otp_id
     LEFT JOIN public.workspace_invitations i ON i.id = o.invitation_id
     WHERE j.id = _job_id
       AND j.claim_token = _claim_token
       AND j.status = 'claimed'
       AND j.claim_expires_at > now()),
    jsonb_build_object('sendable', false));
$$;

-- ACL: backend service role only. Never PUBLIC / anon / authenticated.
DO $acl$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_default_invitation_locale()',
    'wi_set_invitation_locale(uuid,text)',
    'wi_prepare_invitation_job(uuid,uuid,text,text,timestamptz,integer)',
    'wi_otp_job_sendable(uuid,uuid)'
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
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_invitations' AND column_name = 'locale'
  ) THEN
    RAISE EXCEPTION 'LOCALE_COLUMN_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wi_prepare_invitation_job'
      AND pg_get_functiondef(p.oid) LIKE '%''locale''%'
  ) THEN
    RAISE EXCEPTION 'PREPARE_LOCALE_REBASE_FAILED';
  END IF;
END
$verify$;