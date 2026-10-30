-- 289g — Three follow-ups of the 2026-10-29 email work, found by its review
-- (owner, 2026-10-29: every email problem fixed; email is provider-driven,
-- so each works the same through every provider):
--
-- 1. user_email_notification_prefs.offline_messages: the owners' and admins'
--    own switch for the mail they get when a visitor leaves a message while
--    the team is away (server/services/widget/offlineNotice.ts). That mail
--    had no way out but losing the role; it now carries List-Unsubscribe
--    and a line under its text, like the other operator notification
--    emails, and Settings → Notifications has its switch. On by default, as
--    every switch of that table: nobody stops getting it until they say so.
-- 2. email_outbox.supersede_rank: which of the mails waiting under one
--    supersede_key is the one to send when they reach the queue in another
--    order than they were made in (server/services/email/outbox.ts). The
--    offline-message summary of a burst could go out with a lower count than
--    arrived, because the newer row cancelled the older one by its insert
--    time; the highest rank now wins. NULL for every other mail, which keeps
--    the newer-wins rule.
-- 3. public.email_send_quota_return(): gives back one use of a send quota
--    (289d) that was taken for a mail that was then not made. The invitation
--    limits used to peek first and count only after the invitation was made,
--    so requests sent at the same moment all passed on the same count; they
--    are now taken before the invitation is made, atomically, and given back
--    when it is refused (server/routes/workspaceInvitations.ts). Only within
--    the window the use was taken in, and never below zero.
--
-- Access: the function is the backend's only (service_role), SECURITY
-- INVOKER with a pinned search_path; nothing is granted to anon or
-- authenticated. Both tables keep their RLS and service_role policy.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The code
-- runs without it: the offline notice goes to every owner and admin and its
-- switch is not offered (it could not be saved), a newer summary replaces an
-- older one by time as before, and an invitation the RPC refuses keeps its
-- counted use (the window ends within the hour or the day). It writes no
-- data (the two columns are added with their defaults), drops nothing and
-- empties nothing. Safe to run twice. Dry run: wrap the file in BEGIN; …
-- ROLLBACK; (it opens no transaction of its own). Like 284 to 289d, it sets
-- lock_timeout 5s itself.

SET lock_timeout = '5s';

-- ─── 1. The offline-message notice's own switch ───────────────────────────

ALTER TABLE public.user_email_notification_prefs
  ADD COLUMN IF NOT EXISTS offline_messages boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_email_notification_prefs.offline_messages IS
  'Whether this owner or admin gets the mail when a visitor leaves a message while the team is away (services/widget/offlineNotice.ts). It has no platform switch; this and the mail''s unsubscribe link stop it. Migration 289g.';

-- ─── 2. The rank among mails that supersede each other ───────────────────

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS supersede_rank integer;

COMMENT ON COLUMN public.email_outbox.supersede_rank IS
  'Among the rows of one supersede_key, the highest rank is the one sent, whatever order they were queued in (the offline-message summary''s count); NULL: the newer row wins. Migration 289g.';

-- ─── 3. Giving a quota's use back ─────────────────────────────────────────

-- One use of (scope, key) given back, in the window that started at
-- p_window_started_at only (a window that ended, or a newer one, is left as
-- it is), never below zero. True when a use was given back. The start is
-- compared to the millisecond: the backend holds it as a JavaScript Date.
CREATE OR REPLACE FUNCTION public.email_send_quota_return(
  p_scope text,
  p_key text,
  p_window_started_at timestamptz
) RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH given AS (
    UPDATE public.email_send_quota q
       SET hits = q.hits - 1,
           updated_at = now()
     WHERE q.scope = p_scope
       AND q.quota_key = p_key
       AND date_trunc('milliseconds', q.window_started_at) = date_trunc('milliseconds', p_window_started_at)
       AND q.window_ends_at > now()
       AND q.hits > 0
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM given);
$fn$;

COMMENT ON FUNCTION public.email_send_quota_return(text, text, timestamptz) IS
  'Gives back one use of an email send quota taken for a mail that was then not made (an invitation the RPC refused), within the window it was taken in, never below zero. Server-only. Migration 289g.';

DO $acl$
DECLARE
  f text := 'public.email_send_quota_return(text, text, timestamptz)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $acl$;

RESET lock_timeout;
