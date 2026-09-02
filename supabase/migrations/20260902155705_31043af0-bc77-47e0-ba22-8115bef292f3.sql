-- Hosted mirror of database/migrations/093_workspace_invitations_v51_schema_parity.sql
DROP INDEX IF EXISTS public.idx_workspace_invitations_workspace_id;

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