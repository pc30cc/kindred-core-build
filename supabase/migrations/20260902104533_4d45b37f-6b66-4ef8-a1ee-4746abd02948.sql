CREATE OR REPLACE FUNCTION public.wi_can_manage_invitation(
  _actor_role public.workspace_role,
  _target_role public.workspace_role
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _target_role = 'owner'::public.workspace_role THEN false
    WHEN _actor_role = 'owner'::public.workspace_role  THEN true
    WHEN _actor_role = 'admin'::public.workspace_role  THEN _target_role <> 'admin'::public.workspace_role
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.wi_can_manage_invitation(public.workspace_role, public.workspace_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_can_manage_invitation(public.workspace_role, public.workspace_role) FROM anon;
REVOKE ALL ON FUNCTION public.wi_can_manage_invitation(public.workspace_role, public.workspace_role) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wi_can_manage_invitation(public.workspace_role, public.workspace_role) TO service_role;