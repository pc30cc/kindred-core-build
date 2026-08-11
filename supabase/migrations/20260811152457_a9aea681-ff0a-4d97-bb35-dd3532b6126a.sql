CREATE OR REPLACE FUNCTION public.account_list_auth_sessions(_user_id uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  refreshed_at timestamptz,
  not_after timestamptz,
  user_agent text,
  ip text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT s.id, s.user_id, s.created_at, s.updated_at, s.refreshed_at,
         s.not_after, s.user_agent, host(s.ip)::text
  FROM auth.sessions s
  WHERE s.user_id = _user_id
  ORDER BY COALESCE(s.refreshed_at, s.updated_at, s.created_at) DESC
  LIMIT 50
$$;

REVOKE ALL ON FUNCTION public.account_list_auth_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_list_auth_sessions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.account_revoke_auth_sessions(
  _user_id uuid,
  _session_id uuid DEFAULT NULL,
  _all_except uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  removed integer;
BEGIN
  IF _session_id IS NOT NULL THEN
    DELETE FROM auth.sessions s WHERE s.user_id = _user_id AND s.id = _session_id;
  ELSE
    DELETE FROM auth.sessions s
    WHERE s.user_id = _user_id
      AND (_all_except IS NULL OR s.id <> _all_except);
  END IF;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.account_revoke_auth_sessions(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_revoke_auth_sessions(uuid, uuid, uuid) TO service_role;