-- 050 — Cross-workspace channel bot ownership reservation

UPDATE public.channel_integrations
   SET external_account_id = NULL,
       updated_at = now()
 WHERE status = 'disconnected'
   AND external_account_id IS NOT NULL;

DROP INDEX IF EXISTS public.channel_integrations_account_unique;
CREATE UNIQUE INDEX IF NOT EXISTS channel_integrations_account_unique
  ON public.channel_integrations (provider, external_account_id)
  WHERE external_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_channel_provider_account(
  _integration_id uuid,
  _provider text,
  _external_account_id text
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current text;
BEGIN
  IF _external_account_id IS NULL OR length(btrim(_external_account_id)) = 0 THEN
    RAISE EXCEPTION 'external account id is required';
  END IF;

  SELECT external_account_id INTO _current
    FROM public.channel_integrations
   WHERE id = _integration_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF _current IS NOT DISTINCT FROM _external_account_id THEN
    RETURN 'owned';
  END IF;

  BEGIN
    UPDATE public.channel_integrations
       SET external_account_id = _external_account_id,
           updated_at = now()
     WHERE id = _integration_id
       AND provider = _provider;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN 'conflict';
  END;

  RETURN 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_channel_provider_account(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_channel_provider_account(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_channel_provider_account(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_channel_provider_account(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.release_channel_provider_account(
  _integration_id uuid
) RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.channel_integrations
     SET external_account_id = NULL,
         updated_at = now()
   WHERE id = _integration_id;
$$;

REVOKE ALL ON FUNCTION public.release_channel_provider_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_channel_provider_account(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_channel_provider_account(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_channel_provider_account(uuid) TO service_role;