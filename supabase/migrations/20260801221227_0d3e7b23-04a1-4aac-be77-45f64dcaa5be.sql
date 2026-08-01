-- ═══ Phase 6-S3B-R — Phone Verification Remediation (forward-only) ═══

-- ── 1. Neutralize legacy placeholder-digest challenges ────────────────────
UPDATE public.phone_verification_challenges
   SET is_active = false,
       delivery_status = 'failed',
       invalidated_at = COALESCE(invalidated_at, now()),
       updated_at = now()
 WHERE code_digest = 'pending';

-- ── 2. Atomic start with a real digest + per-user advisory lock ───────────
DROP FUNCTION IF EXISTS public.phone_verification_start(uuid,text,text,text,integer,text,uuid,text,integer);

CREATE OR REPLACE FUNCTION public.phone_verification_start(
  _challenge_id uuid, _user_id uuid, _phone text, _purpose text, _code_digest text,
  _ttl_seconds integer, _created_by text, _created_by_admin_id uuid,
  _created_ip_hash text, _max_attempts integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _last timestamptz; _n int; _expires timestamptz;
BEGIN
  IF _code_digest IS NULL OR length(_code_digest) < 32 OR _code_digest = 'pending' THEN
    RETURN jsonb_build_object('error','phone_verification_unavailable');
  END IF;

  -- Serializes every concurrent start/resend for this user inside one tx.
  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  IF EXISTS (SELECT 1 FROM user_phone_verifications
              WHERE user_id = _user_id AND phone_verified_at IS NOT NULL) THEN
    RETURN jsonb_build_object('error','phone_already_verified');
  END IF;

  SELECT max(created_at) INTO _last FROM phone_verification_challenges
   WHERE user_id = _user_id AND created_at > now() - interval '10 minutes';
  IF _last IS NOT NULL AND _last > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('error','phone_resend_too_soon',
      'retryAfterSeconds', ceil(extract(epoch from (_last + interval '60 seconds' - now()))));
  END IF;

  SELECT count(*) INTO _n FROM phone_verification_challenges
   WHERE user_id = _user_id AND created_at > now() - interval '1 hour';
  IF _n >= 5 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;

  IF _created_by = 'admin' THEN
    SELECT count(*) INTO _n FROM phone_verification_challenges
     WHERE user_id = _user_id AND created_by = 'admin' AND created_at > now() - interval '1 hour';
    IF _n >= 5 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;
  END IF;

  SELECT count(*) INTO _n FROM phone_verification_challenges
   WHERE phone_e164 = _phone AND created_at > now() - interval '24 hours';
  IF _n >= 10 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;

  IF _created_ip_hash IS NOT NULL THEN
    SELECT count(*) INTO _n FROM phone_verification_challenges
     WHERE created_ip_hash = _created_ip_hash AND created_at > now() - interval '24 hours';
    IF _n >= 20 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;
  END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  _expires := now() + make_interval(secs => greatest(_ttl_seconds, 60));

  INSERT INTO phone_verification_challenges(
    id, user_id, phone_e164, purpose, code_digest, expires_at, max_attempts,
    created_by, created_by_admin_id, created_ip_hash)
  VALUES (_challenge_id, _user_id, _phone, _purpose, _code_digest, _expires,
          greatest(coalesce(_max_attempts,5),1),
          _created_by, _created_by_admin_id, _created_ip_hash);

  INSERT INTO user_phone_verifications(user_id, phone_e164, country_code)
  VALUES (_user_id, _phone, 'IR')
  ON CONFLICT (user_id) DO UPDATE
    SET phone_e164 = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                          THEN EXCLUDED.phone_e164 ELSE user_phone_verifications.phone_e164 END,
        updated_at = now();

  RETURN jsonb_build_object('challengeId', _challenge_id,
                            'expiresAt', _expires,
                            'maxAttempts', greatest(coalesce(_max_attempts,5),1));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error','phone_resend_too_soon','retryAfterSeconds',60);
END $$;

-- ── 3. Mark delivery must report success ──────────────────────────────────
DROP FUNCTION IF EXISTS public.phone_verification_mark_delivery(uuid,boolean,text,text);

CREATE OR REPLACE FUNCTION public.phone_verification_mark_delivery(
  _challenge_id uuid, _sent boolean, _provider_name text, _provider_message_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows int;
BEGIN
  UPDATE phone_verification_challenges
     SET delivery_status = CASE WHEN _sent THEN 'sent' ELSE 'failed' END,
         sent_at = CASE WHEN _sent THEN now() ELSE sent_at END,
         is_active = CASE WHEN _sent THEN is_active ELSE false END,
         invalidated_at = CASE WHEN _sent THEN invalidated_at ELSE now() END,
         provider_name = _provider_name,
         provider_message_id = _provider_message_id,
         updated_at = now()
   WHERE id = _challenge_id;
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', _rows = 1);
END $$;

-- Fail-closed helper: used when delivery bookkeeping could not be completed.
CREATE OR REPLACE FUNCTION public.phone_verification_invalidate(
  _challenge_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows int;
BEGIN
  UPDATE phone_verification_challenges
     SET is_active = false, delivery_status = 'failed',
         invalidated_at = COALESCE(invalidated_at, now()), updated_at = now()
   WHERE id = _challenge_id;
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', _rows = 1);
END $$;

-- ── 4. Manual verify + mandatory audit in one transaction ─────────────────
CREATE OR REPLACE FUNCTION public.phone_verification_manual_verify(
  _user_id uuid, _admin_id uuid, _reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r user_phone_verifications%ROWTYPE; _already boolean := false;
BEGIN
  IF _reason IS NULL OR length(btrim(_reason)) < 5 OR length(btrim(_reason)) > 500 THEN
    RETURN jsonb_build_object('error','phone_verification_not_allowed');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT * INTO r FROM user_phone_verifications WHERE user_id = _user_id FOR UPDATE;
  IF NOT FOUND OR r.phone_e164 IS NULL THEN
    RETURN jsonb_build_object('error','phone_invalid');
  END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  IF r.phone_verified_at IS NOT NULL THEN
    _already := true;
  ELSE
    UPDATE user_phone_verifications
       SET phone_verified_at = now(), last_verified_at = now(),
           verification_method = 'admin_manual', verified_by_admin_id = _admin_id,
           manual_verification_reason = btrim(_reason), updated_at = now()
     WHERE user_id = _user_id
    RETURNING * INTO r;
  END IF;

  -- Mandatory audit: same transaction as the state change.
  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_manual_verify', 'user_phone_verification',
          _user_id, _admin_id,
          jsonb_build_object('verified', true, 'method', r.verification_method,
                             'reason', btrim(_reason), 'already_verified', _already,
                             'actor_admin_id', _admin_id, 'target_user_id', _user_id,
                             'phone_masked', public.mask_phone_e164(r.phone_e164)));

  RETURN jsonb_build_object('verifiedAt', r.phone_verified_at,
    'verificationMethod', r.verification_method,
    'phoneMasked', public.mask_phone_e164(r.phone_e164), 'alreadyVerified', _already);
END $$;

-- ── 5. Status: resumable challenge metadata ───────────────────────────────
CREATE OR REPLACE FUNCTION public.phone_verification_state(_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (SELECT * FROM user_phone_verifications WHERE user_id = _user_id),
       c AS (SELECT * FROM phone_verification_challenges
              WHERE user_id = _user_id AND is_active AND expires_at > now()
                AND delivery_status = 'sent'
              ORDER BY created_at DESC LIMIT 1)
  SELECT jsonb_build_object(
    'userId', _user_id,
    'phone', (SELECT phone_e164 FROM v),
    'phoneMasked', public.mask_phone_e164((SELECT phone_e164 FROM v)),
    'country', (SELECT country_code FROM v),
    'verified', (SELECT phone_verified_at FROM v) IS NOT NULL,
    'verifiedAt', (SELECT phone_verified_at FROM v),
    'verificationMethod', (SELECT verification_method FROM v),
    'verifiedByAdminId', (SELECT verified_by_admin_id FROM v),
    'manualVerificationReason', (SELECT manual_verification_reason FROM v),
    'hasActiveChallenge', EXISTS (SELECT 1 FROM c),
    'activeChallengeId', (SELECT id FROM c),
    'challengeExpiresInSeconds', (SELECT greatest(0, ceil(extract(epoch from (expires_at - now()))))::int FROM c),
    'lastSentAt', (SELECT max(sent_at) FROM phone_verification_challenges x WHERE x.user_id = _user_id),
    'lastCreatedAt', (SELECT max(created_at) FROM phone_verification_challenges x WHERE x.user_id = _user_id),
    'remainingAttempts', (SELECT greatest(max_attempts - attempt_count, 0) FROM c)
  )
$$;

REVOKE ALL ON FUNCTION public.phone_verification_start(uuid,uuid,text,text,text,integer,text,uuid,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_mark_delivery(uuid,boolean,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_invalidate(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_start(uuid,uuid,text,text,text,integer,text,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_mark_delivery(uuid,boolean,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_invalidate(uuid) TO service_role;

-- ── 6. Server-side phone filters for the super-admin lists ────────────────
CREATE OR REPLACE FUNCTION public.phone_status_matches(
  _phone text, _verified_at timestamptz, _filter text
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE coalesce(_filter,'all')
    WHEN 'verified'   THEN _phone IS NOT NULL AND _verified_at IS NOT NULL
    WHEN 'unverified' THEN _phone IS NOT NULL AND _verified_at IS NULL
    WHEN 'no_phone'   THEN _phone IS NULL
    ELSE true END
$$;
REVOKE ALL ON FUNCTION public.phone_status_matches(text,timestamptz,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.phone_status_matches(text,timestamptz,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_list_profiles(
  _limit integer DEFAULT 50, _offset integer DEFAULT 0,
  _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text,
  _phone_status text DEFAULT 'all'::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id, 'email', p.email, 'full_name', p.full_name,
        'avatar_url', p.avatar_url, 'company_name', p.company_name,
        'website_domain', p.website_domain, 'ai_mode', p.ai_mode,
        'preferred_locale', p.preferred_locale, 'signup_locale', p.signup_locale,
        'signup_ip', p.signup_ip, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'workspace_count', (SELECT count(*) FROM workspace_members wm WHERE wm.user_id = p.id),
        'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
        'phone_masked', public.mask_phone_e164(v.phone_e164),
        'phone_verified', v.phone_verified_at IS NOT NULL,
        'phone_verified_at', v.phone_verified_at,
        'phone_verification_method', v.verification_method
      ) AS row_data
      FROM profiles p
      LEFT JOIN user_phone_verifications v ON v.user_id = p.id
      WHERE (_search = '' OR _search IS NULL
        OR p.email ILIKE '%' || _search || '%'
        OR p.full_name ILIKE '%' || _search || '%'
        OR p.company_name ILIKE '%' || _search || '%')
        AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status)
      ORDER BY
        CASE WHEN _sort = 'newest' THEN p.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN p.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN p.full_name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $function$;

CREATE OR REPLACE FUNCTION public.admin_count_profiles(
  _search text DEFAULT ''::text, _phone_status text DEFAULT 'all'::text)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT count(*) FROM profiles p
    LEFT JOIN user_phone_verifications v ON v.user_id = p.id
    WHERE (_search = '' OR _search IS NULL
      OR p.email ILIKE '%' || _search || '%'
      OR p.full_name ILIKE '%' || _search || '%'
      OR p.company_name ILIKE '%' || _search || '%')
      AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status));
END $function$;

CREATE OR REPLACE FUNCTION public.admin_list_workspaces(
  _limit integer DEFAULT 50, _offset integer DEFAULT 0,
  _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text,
  _phone_status text DEFAULT 'all'::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', w.id, 'name', w.name, 'slug', w.slug, 'owner_id', w.owner_id,
        'owner_email', po.email,
        'member_count', (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id),
        'contact_count', (SELECT count(*) FROM contacts c WHERE c.workspace_id = w.id),
        'conversation_count', (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id),
        'created_at', w.created_at, 'updated_at', w.updated_at,
        'owner_phone_masked', public.mask_phone_e164(v.phone_e164),
        'owner_phone_verified', v.phone_verified_at IS NOT NULL,
        'owner_phone_verified_at', v.phone_verified_at,
        'owner_phone_verification_method', v.verification_method
      ) AS row_data
      FROM workspaces w
      LEFT JOIN profiles po ON po.id = w.owner_id
      LEFT JOIN user_phone_verifications v ON v.user_id = w.owner_id
      WHERE (_search = '' OR _search IS NULL
        OR w.name ILIKE '%' || _search || '%'
        OR w.slug ILIKE '%' || _search || '%'
        OR po.email ILIKE '%' || _search || '%')
        AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status)
      ORDER BY
        CASE WHEN _sort = 'newest' THEN w.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN w.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN w.name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $function$;

CREATE OR REPLACE FUNCTION public.admin_count_workspaces(
  _search text DEFAULT ''::text, _phone_status text DEFAULT 'all'::text)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT count(*) FROM workspaces w
    LEFT JOIN profiles po ON po.id = w.owner_id
    LEFT JOIN user_phone_verifications v ON v.user_id = w.owner_id
    WHERE (_search = '' OR _search IS NULL
      OR w.name ILIKE '%' || _search || '%'
      OR w.slug ILIKE '%' || _search || '%'
      OR po.email ILIKE '%' || _search || '%')
      AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status));
END $function$;

REVOKE ALL ON FUNCTION public.admin_list_profiles(integer,integer,text,text,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_list_workspaces(integer,integer,text,text,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_count_profiles(text,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.admin_count_workspaces(text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles(integer,integer,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_workspaces(integer,integer,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_count_profiles(text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_count_workspaces(text,text) TO authenticated, service_role;

-- ── 7. Widget domain management also requires a verified owner ────────────
DROP POLICY IF EXISTS "Admins+ can manage ws domains extended" ON public.workspace_domains_extended;
DROP POLICY IF EXISTS "Admins can manage workspace domains extended" ON public.workspace_domains_extended;
CREATE POLICY "Admins+ manage ws domains extended (phone gated)"
  ON public.workspace_domains_extended
  FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id));
