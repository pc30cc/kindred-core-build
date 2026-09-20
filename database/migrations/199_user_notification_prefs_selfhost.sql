-- ============================================================
-- 199 — USER NOTIFICATION PREFS FOR THE SELF-HOST CHAIN
--
-- The hosted chain has had this table since
-- `20260421071651_81250994-cc37-40cc-973e-7716411e7e5d.sql`. This chain
-- never received it — `026_identity_root_profiles_not_auth_users.sql` says
-- so in as many words, listing `user_notification_prefs` among the "later
-- hosted-only features this self-host bootstrap never received".
--
-- Unlike the canned-responses gap that 198 closed, this one was not quiet.
-- `136_mobile_push.sql` runs
--
--     ALTER TABLE public.user_notification_prefs ADD COLUMN IF NOT EXISTS ...
--
-- and `IF NOT EXISTS` there guards the COLUMN, not the TABLE. Against a
-- database built from this chain that statement has never had a table to
-- alter, so 136 raised `relation "public.user_notification_prefs" does not
-- exist` and, under `ON_ERROR_STOP`, took the whole chain down with it:
-- every migration from 136 onwards — mobile push, the AI-KB tail, billing
-- v2, 198's own canned responses — was unreachable on a self-host install.
--
-- Nobody had seen it because the job that applies this chain end to end
-- needs a database and a runner, and this account's CI gets neither: every
-- workflow run in the repository, on main included, fails in about three
-- seconds without producing a log. It was found by running that job by
-- hand.
--
-- 136 is now explicit that the table may be absent (its ALTER is wrapped in
-- a to_regclass check), so the chain survives it either way; this file is
-- what actually gives a self-host deployment the table, with the push
-- columns 136 wanted already on it.
--
-- WHAT DIFFERS FROM THE HOSTED FILE, and why:
--
--   * `user_id` references `public.profiles(id)`, not `auth.users(id)`.
--     Migration 026 made `profiles` the free-standing identity root of this
--     chain; a new FK to `auth.users` would reintroduce exactly the
--     dependency 026 removed. 198 does the same for `created_by`.
--   * The push columns from 136 are declared inline rather than bolted on
--     afterwards, so a fresh install gets one CREATE TABLE and no ALTER.
--
-- Everything else — column names, types, defaults, the (user_id,
-- workspace_id) uniqueness, RLS and the four owner policies — is the hosted
-- shape, because the server reads both deployments through the same code.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_notification_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Master switch
  disable_all boolean NOT NULL DEFAULT false,

  -- Push / browser notifications
  push_when_online boolean NOT NULL DEFAULT true,
  push_when_offline boolean NOT NULL DEFAULT true,
  push_visitor_browsing boolean NOT NULL DEFAULT false,
  play_sound boolean NOT NULL DEFAULT true,

  -- Email notifications
  email_unread_messages boolean NOT NULL DEFAULT true,
  email_transcripts boolean NOT NULL DEFAULT false,
  email_user_ratings boolean NOT NULL DEFAULT true,
  email_paid_invoices boolean NOT NULL DEFAULT true,
  email_weekly_summary boolean NOT NULL DEFAULT false,
  email_product_updates boolean NOT NULL DEFAULT false,

  -- Quiet hours (24h, user local timezone)
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start text NULL,  -- HH:MM
  quiet_hours_end text NULL,    -- HH:MM
  quiet_hours_timezone text NULL,

  -- Server-enforced mobile push policy — 136's columns, inline.
  --   push_scope: 'all' | 'assigned' | 'mentions' | 'none'
  --   push_preview: false → privacy mode ("New message in Webyar")
  push_scope text NOT NULL DEFAULT 'all',
  push_preview boolean NOT NULL DEFAULT true,
  push_internal_notes boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_notification_prefs_unique UNIQUE (user_id, workspace_id)
);

-- Re-runnable on a database that already has the table from an earlier
-- partial attempt: the columns are added only where they are missing.
ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS push_scope text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS push_preview boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_internal_notes boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_notification_prefs_push_scope_check'
  ) THEN
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT user_notification_prefs_push_scope_check
      CHECK (push_scope IN ('all', 'assigned', 'mentions', 'none'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_user
  ON public.user_notification_prefs (user_id);

ALTER TABLE public.user_notification_prefs ENABLE ROW LEVEL SECURITY;

-- A row belongs to the user named in it, and to nobody else. The workspace
-- column scopes a preference, it does not share it: a colleague in the same
-- workspace has no business reading how you want to be notified.
DROP POLICY IF EXISTS "users_select_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_select_own_notif_prefs"
  ON public.user_notification_prefs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_insert_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_insert_own_notif_prefs"
  ON public.user_notification_prefs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_update_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_update_own_notif_prefs"
  ON public.user_notification_prefs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_delete_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_delete_own_notif_prefs"
  ON public.user_notification_prefs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regclass('public.user_notification_prefs') IS NULL THEN
    RAISE EXCEPTION '199: public.user_notification_prefs was not created';
  END IF;

  -- The three columns 136 exists to add. If these are missing the mobile
  -- push policy has nowhere to live and the server reads NULL for every
  -- operator's scope.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_notification_prefs'
      AND column_name IN ('push_scope', 'push_preview', 'push_internal_notes')
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION '199: the mobile-push columns are missing from user_notification_prefs';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.user_notification_prefs'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION '199: RLS is not enabled on user_notification_prefs';
  END IF;

  RAISE NOTICE '199: user_notification_prefs installed for the self-host chain';
END
$verify$;
