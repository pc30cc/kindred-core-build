-- 093 — Workspace Invitations v5.1 NORMALIZED SCHEMA PARITY (D.3).
--
-- Forward-only. Applied automatically as part of database/migrations.
--
-- The D.3 comparison between a clean self-host replay (000 → 092) and the
-- hosted database found four non-allowlisted differences on the invitation
-- surface. This migration fixes the self-host side; the hosted mirror
-- migration fixes the hosted side. After both, the invitation surface is
-- byte-identical apart from the allowlisted extension-schema difference
-- (`gen_random_bytes` vs `extensions.gen_random_bytes` in the legacy `token`
-- default, which the cutover contract removes anyway).
--
--   1. redundant index `idx_workspace_invitations_workspace_id`
--      (a strict prefix of `idx_workspace_invitations_ws_status`) exists only
--      in the self-host chain  → dropped here.
--   2. `anon` / `authenticated` DML grants on workspace_invitations exist only
--      on hosted            → revoked in the hosted mirror; asserted here.
--   3. two auth.uid()-based RLS policies on workspace_invitations exist only
--      on hosted            → dropped in the hosted mirror; asserted here.
--      (v5.1 is backend-only: every read/write goes through service_role RPCs,
--      and self-hosted auth does not populate auth.uid() at all.)
--   4. `DELETE` granted to service_role on the append-only evidence tables
--      workspace_invitation_consents / _deliveries exists only on hosted
--                           → revoked in the hosted mirror; asserted here.

-- ---------- 1. drop the redundant index ----------
DROP INDEX IF EXISTS public.idx_workspace_invitations_workspace_id;

-- ---------- 2-4. re-assert the canonical backend-only ACL ----------
REVOKE ALL ON public.workspace_invitations FROM anon, authenticated;
REVOKE ALL ON public.workspace_invitation_consents FROM anon, authenticated;
REVOKE ALL ON public.workspace_invitation_deliveries FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_invitations TO service_role;
REVOKE DELETE ON public.workspace_invitation_consents FROM service_role;
REVOKE DELETE ON public.workspace_invitation_deliveries FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.workspace_invitation_consents TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.workspace_invitation_deliveries TO service_role;

DROP POLICY IF EXISTS "authenticated_read_invitations" ON public.workspace_invitations;
DROP POLICY IF EXISTS "ws_admins_manage_invitations" ON public.workspace_invitations;

-- ---------- proofs ----------
DO $verify$
DECLARE
  r text;
BEGIN
  IF to_regclass('public.idx_workspace_invitations_workspace_id') IS NOT NULL THEN
    RAISE EXCEPTION 'redundant invitation index still present';
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.workspace_invitations', 'SELECT')
       OR has_table_privilege(r, 'public.workspace_invitations', 'INSERT')
       OR has_table_privilege(r, 'public.workspace_invitations', 'UPDATE')
       OR has_table_privilege(r, 'public.workspace_invitations', 'DELETE')
       OR has_table_privilege(r, 'public.workspace_invitation_consents', 'SELECT')
       OR has_table_privilege(r, 'public.workspace_invitation_deliveries', 'SELECT') THEN
      RAISE EXCEPTION 'invitation tables are still reachable by role %', r;
    END IF;
  END LOOP;

  IF has_table_privilege('service_role', 'public.workspace_invitation_consents', 'DELETE')
     OR has_table_privilege('service_role', 'public.workspace_invitation_deliveries', 'DELETE') THEN
    RAISE EXCEPTION 'append-only invitation evidence tables are deletable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'workspace_invitations'
  ) THEN
    RAISE EXCEPTION 'auth.uid()-based invitation policies still present';
  END IF;
END
$verify$;
