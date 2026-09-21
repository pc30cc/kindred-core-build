-- 043 — service_role table-level GRANTs for accounts / account_members /
-- workspace_invitations.
--
-- 000_selfhost_roles_bootstrap.sql is explicit: service_role gets NO
-- implicit privileges — "migrations grant exactly what it needs" — and
-- 024_user_credentials.sql's own comment spells out why this matters even
-- though service_role has BYPASSRLS: BYPASSRLS only skips row-security
-- policy evaluation, it does NOT substitute for the base SQL GRANT system.
-- server/supabase.ts's getServiceClient() talks to Postgres over real
-- PostgREST with a service_role JWT — on a self-host deployment PostgREST
-- switches the database session to the literal `service_role` Postgres
-- role, so a missing table-level GRANT makes PostgREST refuse the query
-- with "permission denied for table ..." (42501) before RLS is ever
-- reached, regardless of BYPASSRLS.
--
-- 039_account_workspace_provisioning.sql (accounts, account_members) and
-- 042_workspace_invitations.sql (workspace_invitations) both shipped
-- RLS-enabled-zero-policies tables with an explicit "every real caller is
-- service_role, which bypasses RLS" justification, but neither migration
-- actually added the table-level GRANT service_role needs to reach that
-- point at all. Traced against every current runtime call site that
-- queries these three tables directly (not through a SECURITY DEFINER
-- RPC, which runs as its owner and needs no caller-role grant):
--
--   accounts          — SELECT only (server/routes/workspaces.ts GET
--                        /account, server/routes/privacy.ts)
--   account_members    — SELECT only (server/routes/workspaces.ts GET
--                        /account, server/routes/privacy.ts,
--                        server/services/privacy/exporter.ts)
--   workspace_invitations — SELECT, INSERT, UPDATE, DELETE
--                        (server/routes/workspaceMembers.ts: list, create,
--                        revoke (PATCH), delete)
--
-- No route reads or writes any of these three tables directly over a
-- browser/anon/authenticated PostgREST connection — every access goes
-- through the Express service-role boundary (see 042's own trust-boundary
-- note). Granting anon/authenticated here would open exactly the direct
-- browser/PostgREST seat-creation path that boundary exists to close, so
-- this migration grants service_role only.
-- REVOKE first, and this is the part that was missing.
--
-- The comment above says 000 is explicit that service_role gets no implicit
-- privileges. That is true of 000 and false of the database 000 runs on.
-- The documented self-host image, supabase/postgres, ships
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role
--
-- for both the `postgres` and `supabase_admin` grantors, so every table this
-- chain creates arrives with ALL already granted to all three roles — and
-- nothing in 000 takes it back. The verification block below caught it
-- honestly and stopped the chain here, which is why no self-host deployment
-- has ever reached migration 044.
--
-- Granting the exact set is therefore not enough; the implicit set has to be
-- removed. These three tables are the ones this migration governs, and its
-- model for them is already written down above: service_role only, and on
-- accounts / account_members read-only. anon and authenticated get nothing —
-- leaving them the image's ALL would open the direct browser/PostgREST
-- seat-creation path that 042's trust boundary exists to close, with RLS as
-- the only thing left in the way.
REVOKE ALL ON public.accounts FROM anon, authenticated, service_role;
REVOKE ALL ON public.account_members FROM anon, authenticated, service_role;
REVOKE ALL ON public.workspace_invitations FROM anon, authenticated, service_role;

GRANT SELECT ON public.accounts TO service_role;
GRANT SELECT ON public.account_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_invitations TO service_role;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION '043: public.accounts does not exist — run after 039';
  END IF;
  IF to_regclass('public.account_members') IS NULL THEN
    RAISE EXCEPTION '043: public.account_members does not exist — run after 039';
  END IF;
  IF to_regclass('public.workspace_invitations') IS NULL THEN
    RAISE EXCEPTION '043: public.workspace_invitations does not exist — run after 042';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.accounts', 'SELECT') THEN
    RAISE EXCEPTION '043: service_role lacks SELECT on public.accounts';
  END IF;
  IF has_table_privilege('service_role', 'public.accounts', 'INSERT') THEN
    RAISE EXCEPTION '043: service_role unexpectedly has INSERT on public.accounts (no runtime caller needs it)';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.account_members', 'SELECT') THEN
    RAISE EXCEPTION '043: service_role lacks SELECT on public.account_members';
  END IF;
  IF has_table_privilege('service_role', 'public.account_members', 'INSERT') THEN
    RAISE EXCEPTION '043: service_role unexpectedly has INSERT on public.account_members (no runtime caller needs it)';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.workspace_invitations', 'SELECT') THEN
    RAISE EXCEPTION '043: service_role lacks SELECT on public.workspace_invitations';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.workspace_invitations', 'INSERT') THEN
    RAISE EXCEPTION '043: service_role lacks INSERT on public.workspace_invitations';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.workspace_invitations', 'UPDATE') THEN
    RAISE EXCEPTION '043: service_role lacks UPDATE on public.workspace_invitations';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.workspace_invitations', 'DELETE') THEN
    RAISE EXCEPTION '043: service_role lacks DELETE on public.workspace_invitations';
  END IF;

  IF has_table_privilege('anon', 'public.workspace_invitations', 'SELECT') THEN
    RAISE EXCEPTION '043: anon unexpectedly has SELECT on public.workspace_invitations';
  END IF;
  IF has_table_privilege('authenticated', 'public.workspace_invitations', 'SELECT') THEN
    RAISE EXCEPTION '043: authenticated unexpectedly has SELECT on public.workspace_invitations';
  END IF;

  RAISE NOTICE '043: service_role table-level GRANTs established for accounts / account_members / workspace_invitations';
END
$verify$;
