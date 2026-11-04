-- 295 — Members of one workspace who never see each other (owner,
-- 2026-11-04: "mahmod sees only Maryam and Mojtaba, not Golpari; the same
-- for Golpari").
--
-- public.workspace_member_hidden_pairs: one row hides two members of a
-- workspace from each other, both ways. The server reads it in one place,
-- server/services/teamVisibility.ts: the two are left out of each other's
-- team chat colleague list (web panel, iPhone, Android), team list
-- (GET /api/workspace-members) and team presence, and neither can open a
-- thread with, message or call the other. Everyone else, the owner and
-- admins included, still sees both.
--
-- One row per pair: user_a < user_b (the CHECK), so a pair cannot be written
-- twice in two orders. Both ends must be members of the workspace (the
-- foreign keys to workspace_members (workspace_id, user_id), its unique
-- constraint); a pair goes with either membership (ON DELETE CASCADE), and
-- with the workspace through them.
--
-- Server-only, like 289's tables: RLS on, nothing for anon or authenticated,
-- everything for service_role (the backend's role). No function, nothing a
-- browser can read.
--
-- It writes no data: the owner's pair is written by hand after it. Before
-- it, the server reads no pairs (a missing table hides nobody), so the order
-- of this file and the code is safe either way.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations), after a dry run inside BEGIN … ROLLBACK; by its
-- migrator on RESPOK, on push. Re-runnable: a second run finds the table,
-- its index and its policy and changes nothing. It opens no transaction of
-- its own and touches no archive schema or table. Like 284 to 294, it sets
-- lock_timeout 5s itself (the foreign keys take a SHARE ROW EXCLUSIVE lock on
-- workspace_members for a moment; the table is new, so no row is checked).

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.workspace_member_hidden_pairs (
  workspace_id uuid        NOT NULL,
  user_a       uuid        NOT NULL,
  user_b       uuid        NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_member_hidden_pairs_pkey PRIMARY KEY (workspace_id, user_a, user_b),
  CONSTRAINT workspace_member_hidden_pairs_ordered CHECK (user_a < user_b),
  CONSTRAINT workspace_member_hidden_pairs_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT workspace_member_hidden_pairs_a_member_fkey FOREIGN KEY (workspace_id, user_a)
    REFERENCES public.workspace_members (workspace_id, user_id) ON DELETE CASCADE,
  CONSTRAINT workspace_member_hidden_pairs_b_member_fkey FOREIGN KEY (workspace_id, user_b)
    REFERENCES public.workspace_members (workspace_id, user_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.workspace_member_hidden_pairs IS
  'Two members of a workspace hidden from each other, both ways (user_a < user_b): not in each other''s team chat, colleague calls, team list or team presence. Read by server/services/teamVisibility.ts. Server-only. Migration 295.';

-- The primary key serves user_a; this serves user_b (and the second
-- foreign key's ON DELETE).
CREATE INDEX IF NOT EXISTS workspace_member_hidden_pairs_b_idx
  ON public.workspace_member_hidden_pairs (workspace_id, user_b);

DO $m295$
BEGIN
  ALTER TABLE public.workspace_member_hidden_pairs ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.workspace_member_hidden_pairs FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.workspace_member_hidden_pairs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.workspace_member_hidden_pairs FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.workspace_member_hidden_pairs TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'workspace_member_hidden_pairs'
         AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.workspace_member_hidden_pairs
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$m295$;
