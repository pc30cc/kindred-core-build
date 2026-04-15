
CREATE OR REPLACE FUNCTION public.admin_list_workspaces(
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
    SELECT jsonb_agg(row_data)
    FROM (
      SELECT jsonb_build_object(
        'id', w.id,
        'name', w.name,
        'slug', w.slug,
        'owner_id', w.owner_id,
        'owner_email', COALESCE(p.email, ''),
        'member_count', (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id),
        'contact_count', (SELECT count(*) FROM contacts c WHERE c.workspace_id = w.id),
        'conversation_count', (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id),
        'created_at', w.created_at,
        'updated_at', w.updated_at
      ) AS row_data
      FROM workspaces w
      LEFT JOIN profiles p ON p.id = w.owner_id
      WHERE
        _search = '' OR _search IS NULL
        OR w.name ILIKE '%' || _search || '%'
        OR w.slug ILIKE '%' || _search || '%'
        OR p.email ILIKE '%' || _search || '%'
      ORDER BY
        CASE WHEN _sort = 'newest' THEN w.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN w.created_at END ASC,
        CASE WHEN _sort = 'most_members' THEN (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) END DESC,
        CASE WHEN _sort = 'most_active' THEN (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id) END DESC
      LIMIT _limit
      OFFSET _offset
    ) sub
  );
END;
$$;
