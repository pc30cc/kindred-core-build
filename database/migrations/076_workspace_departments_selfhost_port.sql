-- 076 — Self-host port of the hosted departments foundation.
--
-- Workspace Invitations v5.1 §4 "Prerequisite": customer-facing invitations
-- must reference at least one same-workspace department, so the self-host
-- chain needs the same two tables the hosted chain has carried since
-- supabase/migrations/20260423182832_4f1a3ff0-00a9-4e7d-a853-5f1fd3cb3b79.sql.
--
-- Ported VERBATIM in structure (columns, FK actions, unique keys, indexes,
-- updated_at trigger) with ONE deliberate difference, matching this chain's
-- established precedent (042/043): the hosted auth.uid()-based RLS policies
-- are NOT ported. Under first-party Auth no browser ever holds a PostgREST
-- identity, so `auth.uid()` is always NULL and such policies would be dead
-- code that merely looks like protection. Self-host uses RLS-enabled +
-- zero-policies (deny-all for every non-superuser role) with service_role
-- grants, exactly like public.workspace_invitations on this chain.
--
-- NOTHING from the hosted Calls / Availability / Notification tables is
-- ported here — v5.1 §21 keeps those explicitly out of scope.

-- ---------- 1. workspace_departments ----------
CREATE TABLE IF NOT EXISTS public.workspace_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  chat_enabled boolean NOT NULL DEFAULT true,
  audio_enabled boolean NOT NULL DEFAULT false,
  video_enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_departments_workspace
  ON public.workspace_departments(workspace_id, enabled, sort_order);

-- Composite key required by v5.1's workspace_invitation_departments FK, which
-- pins (department_id, workspace_id) so a cross-workspace department can never
-- be attached to an invitation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workspace_departments'::regclass
      AND conname = 'workspace_departments_id_workspace_id_key'
  ) THEN
    ALTER TABLE public.workspace_departments
      ADD CONSTRAINT workspace_departments_id_workspace_id_key UNIQUE (id, workspace_id);
  END IF;
END $$;

-- ---------- 2. workspace_department_members ----------
-- user_id deliberately carries NO foreign key, exactly as on hosted: it is a
-- plain uuid pointing at the profile/member, and offboarding (v5.1 §16)
-- deletes these rows EXPLICITLY because nothing cascades to them from
-- workspace_members.
CREATE TABLE IF NOT EXISTS public.workspace_department_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.workspace_departments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_department_members_dept
  ON public.workspace_department_members(department_id);
CREATE INDEX IF NOT EXISTS idx_workspace_department_members_user
  ON public.workspace_department_members(workspace_id, user_id);

-- ---------- 3. updated_at trigger (verbatim hosted function) ----------
CREATE OR REPLACE FUNCTION public.set_workspace_departments_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_departments_updated_at ON public.workspace_departments;
CREATE TRIGGER trg_workspace_departments_updated_at
  BEFORE UPDATE ON public.workspace_departments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workspace_departments_updated_at();

-- ---------- 4. ACL: RLS on, zero policies, service_role only ----------
ALTER TABLE public.workspace_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_department_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.workspace_departments FROM PUBLIC;
REVOKE ALL ON public.workspace_department_members FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.workspace_departments FROM anon';
    EXECUTE 'REVOKE ALL ON public.workspace_department_members FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.workspace_departments FROM authenticated';
    EXECUTE 'REVOKE ALL ON public.workspace_department_members FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_departments TO service_role';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_department_members TO service_role';
  END IF;
END $$;

-- ---------- 5. Privilege proof (043 precedent) ----------
DO $verify$
DECLARE
  _bad text;
BEGIN
  SELECT string_agg(format('%s:%s', t.relname, r.rolname), ', ')
    INTO _bad
  FROM pg_class t
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE t.relname IN ('workspace_departments', 'workspace_department_members')
    AND t.relnamespace = 'public'::regnamespace
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname)
    AND (
      has_table_privilege(r.rolname, t.oid, 'SELECT')
      OR has_table_privilege(r.rolname, t.oid, 'INSERT')
      OR has_table_privilege(r.rolname, t.oid, 'UPDATE')
      OR has_table_privilege(r.rolname, t.oid, 'DELETE')
    );

  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'departments port: unexpected client privileges (%)', _bad;
  END IF;
END
$verify$;
