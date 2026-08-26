-- ===== hosted 20260819170000_admin_rpcs_actor_param.sql =====
CREATE OR REPLACE FUNCTION public.admin_list_profiles(
  _actor_user_id uuid,
  _limit integer DEFAULT 50, _offset integer DEFAULT 0,
  _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text,
  _phone_status text DEFAULT 'all'::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
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
  _actor_user_id uuid,
  _search text DEFAULT ''::text, _phone_status text DEFAULT 'all'::text)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT count(*) FROM profiles p
    LEFT JOIN user_phone_verifications v ON v.user_id = p.id
    WHERE (_search = '' OR _search IS NULL
      OR p.email ILIKE '%' || _search || '%'
      OR p.full_name ILIKE '%' || _search || '%'
      OR p.company_name ILIKE '%' || _search || '%')
      AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status));
END $function$;

CREATE OR REPLACE FUNCTION public.admin_get_user_detail(_actor_user_id uuid, _user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
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
  _actor_user_id uuid,
  _limit integer DEFAULT 50, _offset integer DEFAULT 0,
  _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text,
  _phone_status text DEFAULT 'all'::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
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
  _actor_user_id uuid,
  _search text DEFAULT ''::text, _phone_status text DEFAULT 'all'::text)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
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

CREATE OR REPLACE FUNCTION public.admin_get_workspace_detail(_actor_user_id uuid, _workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE _result jsonb;
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
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

CREATE OR REPLACE FUNCTION public.admin_delete_workspace(_actor_user_id uuid, _workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = _workspace_id) THEN
    RAISE EXCEPTION 'Workspace not found';
  END IF;
  DELETE FROM plan_change_log WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_channel_overrides WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_module_overrides WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_usage_counters WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_subscriptions WHERE workspace_id = _workspace_id;
  DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = _workspace_id);
  DELETE FROM conversations WHERE workspace_id = _workspace_id;
  DELETE FROM contacts WHERE workspace_id = _workspace_id;
  DELETE FROM visitor_presence WHERE workspace_id = _workspace_id;
  DELETE FROM visitor_sessions WHERE workspace_id = _workspace_id;
  DELETE FROM widget_settings WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_branding WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_branding_localized WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_domains WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_domains_extended WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_settings WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_members WHERE workspace_id = _workspace_id;
  DELETE FROM knowledge_base_articles WHERE workspace_id = _workspace_id;
  DELETE FROM knowledge_base_categories WHERE workspace_id = _workspace_id;
  DELETE FROM email_logs WHERE workspace_id = _workspace_id;
  DELETE FROM email_settings WHERE workspace_id = _workspace_id;
  DELETE FROM email_templates WHERE workspace_id = _workspace_id;
  DELETE FROM provider_configs WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_provider_settings WHERE workspace_id = _workspace_id;
  DELETE FROM audit_logs WHERE workspace_id = _workspace_id;
  DELETE FROM ai_usage_logs WHERE workspace_id = _workspace_id;
  DELETE FROM billing_payments WHERE workspace_id = _workspace_id;
  DELETE FROM billing_events WHERE workspace_id = _workspace_id;
  DELETE FROM feature_flags WHERE workspace_id = _workspace_id;
  DELETE FROM translations WHERE workspace_id = _workspace_id;
  DELETE FROM storage_usage_logs WHERE workspace_id = _workspace_id;
  DELETE FROM security_events WHERE workspace_id = _workspace_id;
  DELETE FROM workspaces WHERE id = _workspace_id;
  RETURN true;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.admin_list_profiles(uuid,integer,integer,text,text,text)',
    'public.admin_count_profiles(uuid,text,text)',
    'public.admin_get_user_detail(uuid,uuid)',
    'public.admin_list_workspaces(uuid,integer,integer,text,text,text)',
    'public.admin_count_workspaces(uuid,text,text)',
    'public.admin_get_workspace_detail(uuid,uuid)',
    'public.admin_delete_workspace(uuid,uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.admin_list_profiles(integer, integer, text, text, text);
DROP FUNCTION IF EXISTS public.admin_count_profiles(text, text);
DROP FUNCTION IF EXISTS public.admin_get_user_detail(uuid);
DROP FUNCTION IF EXISTS public.admin_list_workspaces(integer, integer, text, text, text);
DROP FUNCTION IF EXISTS public.admin_list_workspaces(integer, integer, text, text);
DROP FUNCTION IF EXISTS public.admin_count_workspaces(text, text);
DROP FUNCTION IF EXISTS public.admin_get_workspace_detail(uuid);
DROP FUNCTION IF EXISTS public.admin_delete_workspace(uuid);

-- ===== hosted 20260820100000_admin_password_reset_atomic.sql =====
CREATE OR REPLACE FUNCTION public.admin_set_password_and_revoke_sessions(
  _user_id uuid,
  _new_password_hash text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _revoked_count integer;
BEGIN
  INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at, failed_login_count)
  VALUES (_user_id, _new_password_hash, 'argon2id', now(), 0)
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_algo = EXCLUDED.password_algo,
        password_set_at = EXCLUDED.password_set_at,
        failed_login_count = 0,
        updated_at = now();

  UPDATE public.auth_sessions
  SET revoked_at = now(), revoke_reason = 'admin_action'
  WHERE user_id = _user_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN _revoked_count;
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.admin_set_password_and_revoke_sessions(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_set_password_and_revoke_sessions(uuid, text) TO service_role;
END $$;

-- ===== hosted 20260820110000_admin_block_user_atomic.sql =====
CREATE OR REPLACE FUNCTION public.admin_set_user_block_status(
  _user_id uuid,
  _blocked boolean
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _revoked_count integer := 0;
BEGIN
  INSERT INTO public.user_credentials (user_id, status)
  VALUES (_user_id, CASE WHEN _blocked THEN 'disabled' ELSE 'active' END)
  ON CONFLICT (user_id) DO UPDATE
    SET status = EXCLUDED.status,
        updated_at = now();

  IF _blocked THEN
    UPDATE public.auth_sessions
    SET revoked_at = now(), revoke_reason = 'admin_action'
    WHERE user_id = _user_id
      AND revoked_at IS NULL;
    GET DIAGNOSTICS _revoked_count = ROW_COUNT;
  END IF;

  RETURN _revoked_count;
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.admin_set_user_block_status(uuid, boolean) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_set_user_block_status(uuid, boolean) TO service_role;
END $$;

-- ===== hosted 20260820120000_admin_change_user_email_atomic.sql =====
CREATE OR REPLACE FUNCTION public.admin_change_user_email(
  _user_id uuid,
  _new_email text
)
RETURNS TABLE(changed boolean, old_email text, new_email text, sessions_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _normalized_email text := lower(btrim(_new_email));
  _current_email text;
  _revoked_count integer := 0;
BEGIN
  SELECT p.email INTO _current_email
  FROM public.profiles p
  WHERE p.id = _user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_change_user_email: no profile for %', _user_id;
  END IF;

  IF lower(btrim(_current_email)) = _normalized_email THEN
    RETURN QUERY SELECT false, _current_email, _current_email, 0;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET email = _normalized_email, updated_at = now()
  WHERE id = _user_id;

  INSERT INTO public.user_credentials (user_id, email_verified_at)
  VALUES (_user_id, NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET email_verified_at = NULL,
        updated_at = now();

  UPDATE public.auth_reset_tokens
  SET revoked_at = now()
  WHERE user_id = _user_id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  UPDATE public.auth_verify_tokens
  SET revoked_at = now()
  WHERE user_id = _user_id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  UPDATE public.auth_sessions
  SET revoked_at = now(), revoke_reason = 'admin_action'
  WHERE user_id = _user_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN QUERY SELECT true, _current_email, _normalized_email, _revoked_count;
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.admin_change_user_email(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_change_user_email(uuid, text) TO service_role;
END $$;

DO $verify$
DECLARE
  sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.admin_set_password_and_revoke_sessions(uuid,text)',
    'public.admin_set_user_block_status(uuid,boolean)',
    'public.admin_change_user_email(uuid,text)',
    'public.admin_list_profiles(uuid,integer,integer,text,text,text)',
    'public.admin_count_profiles(uuid,text,text)',
    'public.admin_get_user_detail(uuid,uuid)',
    'public.admin_list_workspaces(uuid,integer,integer,text,text,text)',
    'public.admin_count_workspaces(uuid,text,text)',
    'public.admin_get_workspace_detail(uuid,uuid)',
    'public.admin_delete_workspace(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE EXCEPTION 'admin cutover: % missing', sig;
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin cutover: anon can execute %', sig;
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin cutover: authenticated can execute %', sig;
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin cutover: service_role cannot execute %', sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'admin RPCs now actor-parameterized and service_role-only';
END
$verify$;
