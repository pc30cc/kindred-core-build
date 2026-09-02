-- 081 — Workspace Invitations v5.1 CONTRACT migration.
--
-- NOT part of the automatically applied database/migrations chain: applied
-- deliberately at cutover step 12, AFTER 080 (the legacy fence) has been live
-- long enough that no rollback to a legacy build is contemplated.

-- ---------- 1. legacy compatibility mechanism ----------
DROP TRIGGER IF EXISTS trg_workspace_invitations_legacy_status_sync ON public.workspace_invitations;
DROP FUNCTION IF EXISTS public.workspace_invitations_legacy_status_sync();

-- ---------- 2. legacy RPCs ----------
DROP FUNCTION IF EXISTS public.get_invitation_info(text);
DROP FUNCTION IF EXISTS public.accept_workspace_invitation_as(text, uuid);
DROP FUNCTION IF EXISTS public.accept_workspace_invitation(text);

-- ---------- 3. legacy columns ----------
ALTER TABLE public.workspace_invitations
  DROP COLUMN IF EXISTS token,
  DROP COLUMN IF EXISTS max_uses,
  DROP COLUMN IF EXISTS use_count;

-- The v2 required-field CHECK referenced `token IS NULL`; recreate it without
-- the dropped column (Postgres drops dependent constraints with the column).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_v2_required_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_v2_required_chk
      CHECK (
        invitation_flow_version <> 2 OR (
              first_name IS NOT NULL AND btrim(first_name) <> ''
          AND last_name  IS NOT NULL AND btrim(last_name)  <> ''
          AND invited_email_normalized IS NOT NULL
          AND invited_email_normalized = lower(btrim(invited_email_normalized))
          AND invited_phone_e164 IS NOT NULL
          AND invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
          AND member_type IS NOT NULL
          AND role IS NOT NULL AND role <> 'owner'::public.workspace_role
          AND workspace_id IS NOT NULL
          AND created_by   IS NOT NULL
          AND created_at   IS NOT NULL
          AND expires_at   IS NOT NULL AND expires_at > created_at
          AND notification_generation IS NOT NULL AND notification_generation >= 1
        )
      );
  END IF;
END $$;

-- ---------- 4. simplified guard (no token column left to police) ----------
CREATE OR REPLACE FUNCTION public.workspace_invitations_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.invitation_flow_version <> 2 THEN
    RAISE EXCEPTION 'legacy (version-1) invitations can no longer be created';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.invitation_flow_version = 1
     AND NEW.invitation_flow_version = 2 THEN
    RAISE EXCEPTION 'legacy invitation cannot be escalated to the secure flow';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.invitation_flow_version = 1
     AND NEW.status = 'accepted'
     AND OLD.status <> 'accepted' THEN
    RAISE EXCEPTION 'legacy invitation acceptance is fenced';
  END IF;

  RETURN NEW;
END;
$$;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_invitations'
      AND column_name IN ('token', 'max_uses', 'use_count')
  ) THEN
    RAISE EXCEPTION 'legacy invitation columns still present after contract';
  END IF;
END
$verify$;
