
-- ── Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_phone_verifications (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  country_code text NOT NULL DEFAULT 'IR',
  phone_verified_at timestamptz NULL,
  verification_method text NULL,
  verified_by_admin_id uuid NULL,
  manual_verification_reason text NULL,
  last_verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_phone_verifications_method_chk
    CHECK (verification_method IS NULL OR verification_method IN ('sms_otp','admin_manual')),
  CONSTRAINT user_phone_verifications_manual_chk
    CHECK (verification_method = 'admin_manual' OR (verified_by_admin_id IS NULL AND manual_verification_reason IS NULL))
);

CREATE TABLE IF NOT EXISTS public.phone_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  purpose text NOT NULL,
  code_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  sent_at timestamptz NULL,
  consumed_at timestamptz NULL,
  invalidated_at timestamptz NULL,
  is_active boolean NOT NULL DEFAULT true,
  delivery_status text NOT NULL DEFAULT 'pending',
  provider_name text NULL,
  provider_message_id text NULL,
  created_by text NOT NULL DEFAULT 'user',
  created_by_admin_id uuid NULL,
  created_ip_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pvc_delivery_chk CHECK (delivery_status IN ('pending','sent','failed')),
  CONSTRAINT pvc_created_by_chk CHECK (created_by IN ('user','admin'))
);

CREATE INDEX IF NOT EXISTS pvc_user_idx ON public.phone_verification_challenges(user_id);
CREATE INDEX IF NOT EXISTS pvc_phone_idx ON public.phone_verification_challenges(phone_e164);
CREATE INDEX IF NOT EXISTS pvc_created_idx ON public.phone_verification_challenges(created_at);
CREATE INDEX IF NOT EXISTS pvc_expires_idx ON public.phone_verification_challenges(expires_at);
CREATE INDEX IF NOT EXISTS pvc_purpose_idx ON public.phone_verification_challenges(purpose);
CREATE INDEX IF NOT EXISTS pvc_ip_idx ON public.phone_verification_challenges(created_ip_hash);
CREATE UNIQUE INDEX IF NOT EXISTS pvc_one_active_per_user
  ON public.phone_verification_challenges(user_id) WHERE is_active;

-- ── Grants + RLS: server-only ─────────────────────────────────────────────
REVOKE ALL ON public.user_phone_verifications FROM anon, authenticated, public;
REVOKE ALL ON public.phone_verification_challenges FROM anon, authenticated, public;
GRANT ALL ON public.user_phone_verifications TO service_role;
GRANT ALL ON public.phone_verification_challenges TO service_role;
ALTER TABLE public.user_phone_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_verification_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only upv" ON public.user_phone_verifications;
CREATE POLICY "service role only upv" ON public.user_phone_verifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role only pvc" ON public.phone_verification_challenges;
CREATE POLICY "service role only pvc" ON public.phone_verification_challenges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Helpers ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mask_phone_e164(_phone text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _phone IS NULL OR length(regexp_replace(_phone,'\D','','g')) <= 4 THEN NULL
    ELSE (CASE WHEN left(_phone,1)='+' THEN '+' ELSE '' END)
      || left(regexp_replace(_phone,'\D','','g'), 5)
      || repeat('*', length(regexp_replace(_phone,'\D','','g')) - 7)
      || right(regexp_replace(_phone,'\D','','g'), 2)
  END
$$;

CREATE OR REPLACE FUNCTION public.user_phone_verified(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_phone_verifications v
    WHERE v.user_id = _user_id AND v.phone_verified_at IS NOT NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.workspace_owner_phone_verified(_workspace_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces w
    JOIN public.user_phone_verifications v ON v.user_id = w.owner_id
    WHERE w.id = _workspace_id AND v.phone_verified_at IS NOT NULL
  )
$$;

REVOKE ALL ON FUNCTION public.user_phone_verified(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.workspace_owner_phone_verified(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.user_phone_verified(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workspace_owner_phone_verified(uuid) TO authenticated, service_role;

-- ── Atomic challenge lifecycle (service-role only) ────────────────────────
CREATE OR REPLACE FUNCTION public.phone_verification_start(
  _user_id uuid, _phone text, _purpose text, _code_digest text,
  _ttl_seconds integer, _created_by text, _created_by_admin_id uuid,
  _created_ip_hash text, _max_attempts integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id uuid; _last timestamptz; _n int;
BEGIN
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

  INSERT INTO phone_verification_challenges(
    user_id, phone_e164, purpose, code_digest, expires_at, max_attempts,
    created_by, created_by_admin_id, created_ip_hash)
  VALUES (_user_id, _phone, _purpose, _code_digest,
          now() + make_interval(secs => greatest(_ttl_seconds, 60)),
          greatest(coalesce(_max_attempts,5),1),
          _created_by, _created_by_admin_id, _created_ip_hash)
  RETURNING id INTO _id;

  INSERT INTO user_phone_verifications(user_id, phone_e164, country_code)
  VALUES (_user_id, _phone, 'IR')
  ON CONFLICT (user_id) DO UPDATE
    SET phone_e164 = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                          THEN EXCLUDED.phone_e164 ELSE user_phone_verifications.phone_e164 END,
        updated_at = now();

  RETURN jsonb_build_object('challengeId', _id);
END $$;

CREATE OR REPLACE FUNCTION public.phone_verification_mark_delivery(
  _challenge_id uuid, _sent boolean, _provider_name text, _provider_message_id text
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE phone_verification_challenges
     SET delivery_status = CASE WHEN _sent THEN 'sent' ELSE 'failed' END,
         sent_at = CASE WHEN _sent THEN now() ELSE sent_at END,
         is_active = CASE WHEN _sent THEN is_active ELSE false END,
         invalidated_at = CASE WHEN _sent THEN invalidated_at ELSE now() END,
         provider_name = _provider_name,
         provider_message_id = _provider_message_id,
         updated_at = now()
   WHERE id = _challenge_id;
$$;

-- Atomically claims one attempt and returns the stored digest for a
-- constant-time comparison in the application layer.
CREATE OR REPLACE FUNCTION public.phone_verification_claim_attempt(
  _challenge_id uuid, _user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r phone_verification_challenges%ROWTYPE;
BEGIN
  SELECT * INTO r FROM phone_verification_challenges
   WHERE id = _challenge_id AND user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;
  IF r.consumed_at IS NOT NULL OR NOT r.is_active THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.delivery_status <> 'sent' THEN
    RETURN jsonb_build_object('error','phone_verification_unavailable');
  END IF;
  IF r.expires_at <= now() THEN
    UPDATE phone_verification_challenges SET is_active=false, invalidated_at=now(), updated_at=now()
     WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_code_expired');
  END IF;
  IF r.attempt_count >= r.max_attempts THEN
    UPDATE phone_verification_challenges SET is_active=false, invalidated_at=now(), updated_at=now()
     WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_attempts_exceeded');
  END IF;

  UPDATE phone_verification_challenges
     SET attempt_count = attempt_count + 1,
         is_active = CASE WHEN attempt_count + 1 >= max_attempts THEN false ELSE true END,
         invalidated_at = CASE WHEN attempt_count + 1 >= max_attempts THEN now() ELSE invalidated_at END,
         updated_at = now()
   WHERE id = r.id
  RETURNING * INTO r;

  RETURN jsonb_build_object(
    'codeDigest', r.code_digest,
    'phone', r.phone_e164,
    'attemptCount', r.attempt_count,
    'maxAttempts', r.max_attempts);
END $$;

CREATE OR REPLACE FUNCTION public.phone_verification_consume(
  _challenge_id uuid, _user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r phone_verification_challenges%ROWTYPE; _verified_at timestamptz;
BEGIN
  UPDATE phone_verification_challenges
     SET consumed_at = now(), is_active = false, updated_at = now()
   WHERE id = _challenge_id AND user_id = _user_id AND consumed_at IS NULL
   RETURNING * INTO r;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  INSERT INTO user_phone_verifications(user_id, phone_e164, country_code,
      phone_verified_at, verification_method, last_verified_at)
  VALUES (_user_id, r.phone_e164, 'IR', now(), 'sms_otp', now())
  ON CONFLICT (user_id) DO UPDATE SET
      phone_e164 = EXCLUDED.phone_e164,
      phone_verified_at = COALESCE(user_phone_verifications.phone_verified_at, now()),
      verification_method = COALESCE(user_phone_verifications.verification_method, 'sms_otp'),
      verified_by_admin_id = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                                  THEN NULL ELSE user_phone_verifications.verified_by_admin_id END,
      manual_verification_reason = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                                  THEN NULL ELSE user_phone_verifications.manual_verification_reason END,
      last_verified_at = now(),
      updated_at = now()
  RETURNING phone_verified_at INTO _verified_at;

  RETURN jsonb_build_object('verifiedAt', _verified_at,
    'phoneMasked', public.mask_phone_e164(r.phone_e164));
END $$;

CREATE OR REPLACE FUNCTION public.phone_verification_manual_verify(
  _user_id uuid, _admin_id uuid, _reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r user_phone_verifications%ROWTYPE;
BEGIN
  SELECT * INTO r FROM user_phone_verifications WHERE user_id = _user_id FOR UPDATE;
  IF NOT FOUND OR r.phone_e164 IS NULL THEN
    RETURN jsonb_build_object('error','phone_invalid');
  END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  IF r.phone_verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('verifiedAt', r.phone_verified_at,
      'verificationMethod', r.verification_method,
      'phoneMasked', public.mask_phone_e164(r.phone_e164), 'alreadyVerified', true);
  END IF;

  UPDATE user_phone_verifications
     SET phone_verified_at = now(), last_verified_at = now(),
         verification_method = 'admin_manual', verified_by_admin_id = _admin_id,
         manual_verification_reason = _reason, updated_at = now()
   WHERE user_id = _user_id
  RETURNING * INTO r;

  RETURN jsonb_build_object('verifiedAt', r.phone_verified_at,
    'verificationMethod', 'admin_manual',
    'phoneMasked', public.mask_phone_e164(r.phone_e164), 'alreadyVerified', false);
END $$;

CREATE OR REPLACE FUNCTION public.phone_verification_state(_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'userId', _user_id,
    'phone', v.phone_e164,
    'phoneMasked', public.mask_phone_e164(v.phone_e164),
    'country', v.country_code,
    'verified', v.phone_verified_at IS NOT NULL,
    'verifiedAt', v.phone_verified_at,
    'verificationMethod', v.verification_method,
    'verifiedByAdminId', v.verified_by_admin_id,
    'manualVerificationReason', v.manual_verification_reason,
    'hasActiveChallenge', EXISTS (SELECT 1 FROM phone_verification_challenges c
        WHERE c.user_id = _user_id AND c.is_active AND c.expires_at > now()),
    'lastSentAt', (SELECT max(sent_at) FROM phone_verification_challenges c WHERE c.user_id = _user_id),
    'lastCreatedAt', (SELECT max(created_at) FROM phone_verification_challenges c WHERE c.user_id = _user_id),
    'remainingAttempts', (SELECT greatest(c.max_attempts - c.attempt_count, 0)
        FROM phone_verification_challenges c
        WHERE c.user_id = _user_id AND c.is_active AND c.expires_at > now()
        ORDER BY c.created_at DESC LIMIT 1)
  )
  FROM (SELECT * FROM user_phone_verifications WHERE user_id = _user_id) v
  RIGHT JOIN (SELECT 1) dummy ON true
$$;

REVOKE ALL ON FUNCTION public.phone_verification_start(uuid,text,text,text,integer,text,uuid,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_mark_delivery(uuid,boolean,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_claim_attempt(uuid,uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_consume(uuid,uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_manual_verify(uuid,uuid,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_verification_state(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_start(uuid,text,text,text,integer,text,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_mark_delivery(uuid,boolean,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_claim_attempt(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_consume(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_manual_verify(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_verification_state(uuid) TO service_role;

-- ── Widget management write enforcement ───────────────────────────────────
DROP POLICY IF EXISTS "Admins+ can update widget settings" ON public.widget_settings;
CREATE POLICY "Admins+ can update widget settings" ON public.widget_settings
  FOR UPDATE TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id));

DROP POLICY IF EXISTS "Admins+ can insert widget settings" ON public.widget_settings;
CREATE POLICY "Admins+ can insert widget settings" ON public.widget_settings
  FOR INSERT TO authenticated
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
              AND public.workspace_owner_phone_verified(workspace_id));

DROP POLICY IF EXISTS "Workspace admins manage prechat" ON public.widget_prechat_settings;
CREATE POLICY "Workspace admins manage prechat" ON public.widget_prechat_settings
  FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())
         AND get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid())
         AND get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id));

-- ── Admin RPC extensions (signatures unchanged) ───────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_profiles(
  _limit integer DEFAULT 50, _offset integer DEFAULT 0,
  _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text)
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
      WHERE _search = '' OR _search IS NULL
        OR p.email ILIKE '%' || _search || '%'
        OR p.full_name ILIKE '%' || _search || '%'
        OR p.company_name ILIKE '%' || _search || '%'
      ORDER BY
        CASE WHEN _sort = 'newest' THEN p.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN p.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN p.full_name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $function$;

CREATE OR REPLACE FUNCTION public.admin_get_user_detail(_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'profile', row_to_json(p.*),
      'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
      'workspaces', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug,
          'role', wm.role, 'created_at', wm.created_at))
        FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = p.id), '[]'::jsonb),
      'account', (
        SELECT jsonb_build_object('id', a.id, 'name', a.name, 'slug', a.slug, 'role', am.role)
        FROM account_members am JOIN accounts a ON a.id = am.account_id
        WHERE am.user_id = p.id LIMIT 1),
      'phone_verification', public.phone_verification_state(p.id)
    )
    FROM profiles p WHERE p.id = _user_id
  );
END $function$;

CREATE OR REPLACE FUNCTION public.admin_list_workspaces(
  _limit integer DEFAULT 50, _offset integer DEFAULT 0,
  _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text)
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
      WHERE _search = '' OR _search IS NULL
        OR w.name ILIKE '%' || _search || '%'
        OR w.slug ILIKE '%' || _search || '%'
        OR po.email ILIKE '%' || _search || '%'
      ORDER BY
        CASE WHEN _sort = 'newest' THEN w.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN w.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN w.name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $function$;

CREATE OR REPLACE FUNCTION public.admin_get_workspace_detail(_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE _result jsonb;
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT jsonb_build_object(
    'workspace', row_to_json(w.*),
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', wm.id, 'user_id', wm.user_id, 'role', wm.role,
        'created_at', wm.created_at, 'email', p.email, 'full_name', p.full_name))
      FROM workspace_members wm LEFT JOIN profiles p ON p.id = wm.user_id
      WHERE wm.workspace_id = w.id), '[]'::jsonb),
    'branding', (SELECT row_to_json(wb.*) FROM workspace_branding wb WHERE wb.workspace_id = w.id),
    'widget_settings', (SELECT row_to_json(ws.*) FROM widget_settings ws WHERE ws.workspace_id = w.id),
    'contact_count', (SELECT count(*) FROM contacts c WHERE c.workspace_id = w.id),
    'conversation_count', (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id),
    'owner', (SELECT jsonb_build_object('id', po.id, 'email', po.email, 'full_name', po.full_name)
              FROM profiles po WHERE po.id = w.owner_id),
    'owner_phone_verification', public.phone_verification_state(w.owner_id)
  ) INTO _result
  FROM workspaces w WHERE w.id = _workspace_id;
  RETURN _result;
END $function$;
