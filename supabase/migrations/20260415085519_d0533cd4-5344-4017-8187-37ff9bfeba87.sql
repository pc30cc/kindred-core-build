
-- Admin can view login attempts for a specific user email
CREATE OR REPLACE FUNCTION public.admin_list_login_attempts(
  _email text,
  _limit integer DEFAULT 50
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
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', la.id,
      'email', la.email,
      'ip_address', la.ip_address,
      'success', la.success,
      'created_at', la.created_at
    ) ORDER BY la.created_at DESC), '[]'::jsonb)
    FROM login_attempts la
    WHERE la.email = _email
    LIMIT _limit
  );
END;
$$;
