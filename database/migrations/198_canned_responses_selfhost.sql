-- ============================================================
-- 198 — CANNED RESPONSES (SAVED REPLIES) FOR THE SELF-HOST CHAIN
--
-- The hosted chain has had this table since
-- `20260419114312_799ae494-dcea-48cc-a508-86c2ee3024ba.sql`. This chain never
-- received it — `026_identity_root_profiles_not_auth_users.sql` says so in as
-- many words, listing `canned_responses` among the "later hosted-only
-- features this self-host bootstrap never received".
--
-- Nothing was broken while nothing asked for the rows. The iOS app now does:
-- its composer has a saved-replies button, and against a database built from
-- this chain that button reached a table that was not there. What the
-- operator saw was a network error, which is the wrong answer to "this
-- workspace has no saved replies yet" and an even worse answer to "this
-- deployment never installed the feature".
--
-- WHO CAN DO WHAT, and it is deliberately not per-operator:
--
--   View   : any workspace member
--   Create : any workspace member, as themselves
--   Edit   : the author, or a workspace owner/admin
--   Delete : the author, or a workspace owner/admin
--
-- `created_by` is a permission, not a scope. A saved reply belongs to the
-- workspace and everybody in it can send it — which is the point: the company
-- answers, not the individual, and an operator who joined this morning starts
-- with the same drawer as everyone else. The unique index says the same
-- thing: `/refund` is one thing in a workspace, so two people cannot each
-- mean something different by it.
--
-- DIFFERENCES FROM THE HOSTED FILE, and why this is not in the mirror-parity
-- list in `migrationMirrorParity.test.ts`:
--
--   * `created_by` references `public.profiles(id)` directly. The hosted file
--     wrote `auth.users(id)` and was repointed later, by that chain's own
--     `20260819130000_identity_root_profiles_not_auth_users.sql`. There is no
--     reason to lay down a constraint here only to rewrite it, so the end
--     state is identical and the route to it is shorter.
--   * The trigram indexes are conditional on `pg_trgm`. The hosted database
--     has the extension; a self-host Postgres may not, and may not be allowed
--     to create it. They only make search faster — the route works without
--     them, on a table this size, indistinguishably.
--
-- Idempotent throughout: this file can be applied to a database that already
-- has the table without doing anything.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.canned_responses (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id    UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by      UUID        NOT NULL REFERENCES public.profiles(id)   ON DELETE CASCADE,
  locale          TEXT        NOT NULL CHECK (locale IN ('en', 'fa', 'tr')),
  shortcut        TEXT        NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  title           TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body            TEXT        NOT NULL CHECK (char_length(body)  BETWEEN 1 AND 4000),
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  usage_count     INTEGER     NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One `/shortcut` per language per workspace. `lower()` because the shortcut
-- is typed, and somebody typing `/Refund` means the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS canned_responses_workspace_locale_shortcut_uniq
  ON public.canned_responses (workspace_id, locale, lower(shortcut));

CREATE INDEX IF NOT EXISTS canned_responses_workspace_locale_idx
  ON public.canned_responses (workspace_id, locale, is_active);

-- The picker orders by how often a reply is actually used, so this is the
-- index behind the first screen anybody sees.
CREATE INDEX IF NOT EXISTS canned_responses_usage_idx
  ON public.canned_responses (workspace_id, usage_count DESC, last_used_at DESC NULLS LAST);

-- Search, when the extension is available. `CREATE EXTENSION` needs rights a
-- self-host role may not have, so this asks rather than assumes.
DO $trgm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS canned_responses_title_trgm_idx
      ON public.canned_responses USING GIN (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS canned_responses_shortcut_trgm_idx
      ON public.canned_responses USING GIN (shortcut gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS canned_responses_body_trgm_idx
      ON public.canned_responses USING GIN (body gin_trgm_ops);
  ELSE
    RAISE NOTICE 'pg_trgm is not installed; canned_responses search runs without trigram indexes.';
  END IF;
END
$trgm$;

CREATE OR REPLACE FUNCTION public.set_canned_responses_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canned_responses_set_updated_at ON public.canned_responses;
CREATE TRIGGER canned_responses_set_updated_at
  BEFORE UPDATE ON public.canned_responses
  FOR EACH ROW
  EXECUTE FUNCTION public.set_canned_responses_updated_at();

ALTER TABLE public.canned_responses ENABLE ROW LEVEL SECURITY;

-- The policies are re-asserted rather than created, so re-running this file
-- cannot leave a stale definition behind.
DROP POLICY IF EXISTS "Members can view canned responses"        ON public.canned_responses;
DROP POLICY IF EXISTS "Members can create own canned responses"  ON public.canned_responses;
DROP POLICY IF EXISTS "Author or admin can update canned responses" ON public.canned_responses;
DROP POLICY IF EXISTS "Author or admin can delete canned responses" ON public.canned_responses;

-- SELECT: any workspace member. No `created_by` here on purpose — see above.
CREATE POLICY "Members can view canned responses"
  ON public.canned_responses
  FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- INSERT: any workspace member, but only as themselves.
CREATE POLICY "Members can create own canned responses"
  ON public.canned_responses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_workspace_member(workspace_id, auth.uid())
    AND created_by = auth.uid()
  );

-- UPDATE: author or workspace admin/owner. The WITH CHECK repeats the test so
-- an edit cannot move a row into a workspace the editor does not belong to.
CREATE POLICY "Author or admin can update canned responses"
  ON public.canned_responses
  FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid()
    OR get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
  )
  WITH CHECK (
    is_workspace_member(workspace_id, auth.uid())
    AND (
      created_by = auth.uid()
      OR get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
    )
  );

CREATE POLICY "Author or admin can delete canned responses"
  ON public.canned_responses
  FOR DELETE
  TO authenticated
  USING (
    created_by = auth.uid()
    OR get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
  );
