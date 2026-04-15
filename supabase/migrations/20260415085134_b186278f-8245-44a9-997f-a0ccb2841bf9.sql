
-- Drop old overloads
DROP FUNCTION IF EXISTS public.admin_list_profiles(integer, integer);

-- New admin_list_profiles with search/sort
CREATE OR REPLACE FUNCTION public.admin_list_profiles(
  _limit integer DEFAULT 50,
  _offset integer DEFAULT 0,
  _search text DEFAULT '',
  _sort text DEFAULT 'newest'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'email', p.email,
        'full_name', p.full_name,
        'avatar_url', p.avatar_url,
        'company_name', p.company_name,
        'website_domain', p.website_domain,
        'ai_mode', p.ai_mode,
        'preferred_locale', p.preferred_locale,
        'signup_locale', p.signup_locale,
        'signup_ip', p.signup_ip,
        'created_at', p.created_at,
        'updated_at', p.updated_at,
        'workspace_count', (SELECT count(*) FROM workspace_members wm WHERE wm.user_id = p.id),
        'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb)
      ) AS row_data
      FROM profiles p
      WHERE
        _search = '' OR _search IS NULL
        OR p.email ILIKE '%' || _search || '%'
        OR p.full_name ILIKE '%' || _search || '%'
        OR p.company_name ILIKE '%' || _search || '%'
      ORDER BY
        CASE WHEN _sort = 'newest' THEN p.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN p.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN p.full_name END ASC
      LIMIT _limit
      OFFSET _offset
    ) sub
  );
END;
$$;

-- User detail function
CREATE OR REPLACE FUNCTION public.admin_get_user_detail(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'profile', row_to_json(p.*),
      'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
      'workspaces', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', w.id,
          'name', w.name,
          'slug', w.slug,
          'role', wm.role,
          'created_at', wm.created_at
        ))
        FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = p.id
      ), '[]'::jsonb),
      'account', (
        SELECT jsonb_build_object(
          'id', a.id,
          'name', a.name,
          'slug', a.slug,
          'role', am.role
        )
        FROM account_members am
        JOIN accounts a ON a.id = am.account_id
        WHERE am.user_id = p.id
        LIMIT 1
      )
    )
    FROM profiles p
    WHERE p.id = _user_id
  );
END;
$$;
