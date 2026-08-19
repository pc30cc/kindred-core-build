-- GoTrue-off closure — platform-admin RPCs' internal `has_role(auth.uid(),
-- 'admin')` checks silently fail under service_role (auth.uid() reads the
-- PostgREST JWT-claims GUC, which is unset on a direct service_role
-- connection — has_role(NULL, 'admin') is false, so every one of these
-- calls would RAISE EXCEPTION 'Not authorized' even for a genuinely
-- verified platform admin caller). The real authorization now happens in
-- the Express layer (requirePlatformAdmin(), server/routes/adminUsers.ts /
-- adminWorkspaces.ts), which already re-validates the caller's admin role
-- via has_role() through a normal (non-service_role) path before ever
-- reaching these functions — so this migration's job is narrow: swap the
-- internal check from `auth.uid()` to an explicit `_actor_user_id`
-- parameter, exactly the same pattern already used by
-- create_workspace_atomic. Every other line is byte-identical to the
-- current definition; only the signature and the has_role() argument
-- changed. EXECUTE is also narrowed to service_role only — these are no
-- longer meant to be called directly from the browser at all.
--
-- Self-host note: database/migrations never defined these admin_* RPCs in
-- the first place (this hosted-only platform-admin tooling was never
-- ported to the self-host bootstrap chain — same intentional asymmetry
-- already documented for 025/026 in migrationMirrorParity.test.ts), so
-- there is no self-host mirror for this migration.

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
  DELETE FROM email_settings_localized WHERE workspace_id = _workspace_id;
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

-- ---------- lock EXECUTE to service_role only (Express is the sole gate) --
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

-- Drop the old auth.uid()-based signatures — nothing browser-side should be
-- able to call them at all (they'd fail closed anyway, since auth.uid() is
-- never populated for these users under first-party auth, but an unused
-- overload with a real internal check is attack surface worth removing).
DROP FUNCTION IF EXISTS public.admin_list_profiles(integer, integer, text, text, text);
DROP FUNCTION IF EXISTS public.admin_count_profiles(text, text);
DROP FUNCTION IF EXISTS public.admin_get_user_detail(uuid);
DROP FUNCTION IF EXISTS public.admin_list_workspaces(integer, integer, text, text, text);
DROP FUNCTION IF EXISTS public.admin_list_workspaces(integer, integer, text, text);
DROP FUNCTION IF EXISTS public.admin_count_workspaces(text, text);
DROP FUNCTION IF EXISTS public.admin_get_workspace_detail(uuid);
DROP FUNCTION IF EXISTS public.admin_delete_workspace(uuid);
