-- ============================================================
-- 050 — Cross-workspace channel bot ownership reservation
-- ============================================================
--
-- Blocker fixed: `channel_integrations_account_unique` excluded
-- status = 'disconnected', so a disconnected row kept its
-- `external_account_id` while NOT participating in uniqueness. A workspace
-- could therefore re-claim a bot that another workspace had legitimately
-- taken over — and it only discovered the conflict AFTER mutating the
-- provider webhook.
--
-- New model:
--   * ownership == `external_account_id IS NOT NULL`
--   * disconnect RELEASES ownership (external_account_id -> NULL)
--   * the unique index covers EVERY row that still holds an account id,
--     regardless of status, so the database is the only arbiter
--   * `claim_channel_provider_account()` performs the reservation in one
--     statement BEFORE any provider mutation and reports conflicts as a
--     value, never as an unhandled exception
--
-- Idempotent: safe to re-run.

-- ── 1. Release ownership held by already-disconnected rows ────────────
UPDATE public.channel_integrations
   SET external_account_id = NULL,
       updated_at = now()
 WHERE status = 'disconnected'
   AND external_account_id IS NOT NULL;

-- ── 2. Ownership index now participates for every non-null account ────
DROP INDEX IF EXISTS public.channel_integrations_account_unique;
CREATE UNIQUE INDEX IF NOT EXISTS channel_integrations_account_unique
  ON public.channel_integrations (provider, external_account_id)
  WHERE external_account_id IS NOT NULL;

-- ── 3. Atomic reservation RPC ─────────────────────────────────────────
-- Returns 'claimed'   — this integration now owns the provider account
--         'owned'     — it already owned it (idempotent re-claim)
--         'conflict'  — another integration owns it; caller MUST abort
--                       before touching the provider
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

-- ── 4. Release RPC used by disconnect / rollback paths ────────────────
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
