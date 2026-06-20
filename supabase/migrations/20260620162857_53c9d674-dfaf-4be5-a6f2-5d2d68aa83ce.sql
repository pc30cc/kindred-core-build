-- Contacts create/import boundary: SECURITY DEFINER RPCs.
-- Additive: existing INSERT GRANTs remain in place for backward compatibility.
-- These RPCs become the canonical chokepoint UI hooks call. A future phase
-- (gated on explicit approval) may revoke direct INSERT from authenticated.

CREATE OR REPLACE FUNCTION public.create_contact(
  _workspace_id uuid,
  _email text DEFAULT NULL,
  _name text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _avatar_url text DEFAULT NULL,
  _tags text[] DEFAULT '{}'::text[],
  _notes text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS public.contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.contacts;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: not a workspace member' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.contacts (workspace_id, email, name, phone, avatar_url, tags, notes, metadata)
  VALUES (_workspace_id, _email, _name, _phone, _avatar_url, COALESCE(_tags, '{}'::text[]), _notes, COALESCE(_metadata, '{}'::jsonb))
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_contact(uuid, text, text, text, text, text[], text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_contact(uuid, text, text, text, text, text[], text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_contact(uuid, text, text, text, text, text[], text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.bulk_create_contacts(
  _workspace_id uuid,
  _contacts jsonb
)
RETURNS TABLE(inserted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: not a workspace member' USING ERRCODE = '42501';
  END IF;
  IF _contacts IS NULL OR jsonb_typeof(_contacts) <> 'array' THEN
    RAISE EXCEPTION 'invalid payload: expected jsonb array' USING ERRCODE = '22023';
  END IF;

  WITH src AS (
    SELECT
      _workspace_id AS workspace_id,
      NULLIF(elem->>'email','')      AS email,
      NULLIF(elem->>'name','')       AS name,
      NULLIF(elem->>'phone','')      AS phone,
      NULLIF(elem->>'avatar_url','') AS avatar_url,
      COALESCE(
        CASE WHEN jsonb_typeof(elem->'tags') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(elem->'tags'))
             ELSE '{}'::text[] END,
        '{}'::text[]
      ) AS tags,
      NULLIF(elem->>'notes','')      AS notes,
      COALESCE(elem->'metadata', '{}'::jsonb) AS metadata
    FROM jsonb_array_elements(_contacts) AS elem
  ),
  ins AS (
    INSERT INTO public.contacts (workspace_id, email, name, phone, avatar_url, tags, notes, metadata)
    SELECT workspace_id, email, name, phone, avatar_url, tags, notes, metadata FROM src
    RETURNING id
  )
  SELECT COUNT(*)::int INTO _count FROM ins;

  RETURN QUERY SELECT _count;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_create_contacts(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_create_contacts(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_create_contacts(uuid, jsonb) TO service_role;