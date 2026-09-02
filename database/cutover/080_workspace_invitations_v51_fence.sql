-- 080 — Workspace Invitations v5.1 LEGACY FENCE.
--
-- NOT part of the automatically applied database/migrations chain: this file
-- is applied deliberately at cutover step 9 (docs/DEPLOYMENT.md), AFTER the
-- v5.1 flow is verified end-to-end. It is irreversible by design.
--
-- Effects (v5.1 §4.1 / §19):
--   1. version-1 invitation creation blocked
--   2. legacy acceptance blocked
--   3. legacy token DEFAULT dropped
--   4. remaining version-1 pending invitations revoked
--   5. every remaining plaintext token value erased
--   6. proofs asserted

-- ---------- 0. final version-1 status synchronization ----------
UPDATE public.workspace_invitations
SET status = CASE
      WHEN revoked_at IS NOT NULL                         THEN 'revoked'
      WHEN use_count > 0                                  THEN 'accepted'
      WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
      ELSE 'pending'
    END,
    expired_at = CASE
      WHEN revoked_at IS NULL AND use_count = 0
       AND expires_at IS NOT NULL AND expires_at <= now() THEN COALESCE(expired_at, expires_at)
      ELSE expired_at
    END
WHERE invitation_flow_version = 1;

-- ---------- 1. block version-1 creation ----------
CREATE OR REPLACE FUNCTION public.workspace_invitations_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.invitation_flow_version = 2 AND NEW.token IS NOT NULL THEN
    RAISE EXCEPTION 'v2 invitation must not carry a plaintext token';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.invitation_flow_version <> 2 THEN
    RAISE EXCEPTION 'legacy (version-1) invitations can no longer be created';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.token IS NOT NULL THEN
    RAISE EXCEPTION 'plaintext invitation tokens are no longer accepted';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.token IS NOT NULL THEN
    RAISE EXCEPTION 'plaintext invitation tokens are no longer accepted';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.invitation_flow_version = 1
     AND NEW.invitation_flow_version = 2 THEN
    RAISE EXCEPTION 'legacy invitation cannot be escalated to the secure flow';
  END IF;

  -- No version-1 row may ever be accepted again.
  IF TG_OP = 'UPDATE'
     AND NEW.invitation_flow_version = 1
     AND NEW.status = 'accepted'
     AND OLD.status <> 'accepted' THEN
    RAISE EXCEPTION 'legacy invitation acceptance is fenced';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------- 2. block legacy acceptance at the RPC boundary ----------
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation_as(_token text, _user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'legacy invitation acceptance is fenced — use accept_invitation_*_v2';
END;
$$;

-- ---------- 3. drop the legacy default ----------
ALTER TABLE public.workspace_invitations ALTER COLUMN token DROP DEFAULT;

-- ---------- 4. revoke remaining legacy pending invitations ----------
UPDATE public.workspace_invitations
SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
    revoked_reason = COALESCE(revoked_reason, 'legacy_fence')
WHERE invitation_flow_version = 1 AND status = 'pending';

-- ---------- 5. erase every remaining plaintext token ----------
UPDATE public.workspace_invitations SET token = NULL WHERE token IS NOT NULL;

-- ---------- 6. proofs ----------
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_invitations WHERE token IS NOT NULL) THEN
    RAISE EXCEPTION 'plaintext invitation tokens remain after the fence';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.workspace_invitations'::regclass AND a.attname = 'token'
  ) THEN
    RAISE EXCEPTION 'legacy token default still present after the fence';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.workspace_invitations
    WHERE invitation_flow_version = 1 AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'legacy pending invitations remain after the fence';
  END IF;
END
$verify$;
