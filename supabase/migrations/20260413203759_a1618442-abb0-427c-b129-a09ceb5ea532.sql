
-- RLS policies for user_roles
CREATE POLICY "Users can view own roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Admins can manage all roles"
ON public.user_roles
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Bootstrap function: assigns admin role to a user ONLY if no admin exists yet
CREATE OR REPLACE FUNCTION public.bootstrap_admin(_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin'::app_role) THEN
    RETURN false;
  END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (_user_id, 'admin'::app_role);
  RETURN true;
END;
$$;

-- Allow workspace admins/owners to update member roles
CREATE POLICY "Admins+ can update members"
ON public.workspace_members
FOR UPDATE
TO authenticated
USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Security definer function for admin to list all profiles
CREATE OR REPLACE FUNCTION public.admin_list_profiles(_limit int DEFAULT 50, _offset int DEFAULT 0)
RETURNS SETOF profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM profiles ORDER BY created_at DESC LIMIT _limit OFFSET _offset;
$$;

-- Security definer function for admin to list all workspaces
CREATE OR REPLACE FUNCTION public.admin_list_workspaces(_limit int DEFAULT 50, _offset int DEFAULT 0)
RETURNS TABLE(
  id uuid,
  name text,
  slug text,
  owner_id uuid,
  owner_email text,
  member_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.id, w.name, w.slug, w.owner_id,
    p.email as owner_email,
    (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) as member_count,
    w.created_at, w.updated_at
  FROM workspaces w
  LEFT JOIN profiles p ON p.id = w.owner_id
  ORDER BY w.created_at DESC
  LIMIT _limit OFFSET _offset;
$$;

-- Security definer function for admin to count users
CREATE OR REPLACE FUNCTION public.admin_count_profiles()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM profiles;
$$;

-- Security definer function for admin to count workspaces
CREATE OR REPLACE FUNCTION public.admin_count_workspaces()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM workspaces;
$$;

-- Admin audit log read across all workspaces
CREATE POLICY "Global admins can view all audit logs"
ON public.audit_logs
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));
