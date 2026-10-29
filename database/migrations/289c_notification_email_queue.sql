-- 289c — The operator notification emails: what a job is about, one open
-- digest per operator, and announcements that go out from the ticker
-- (owner, 2026-10-29: every email problem fixed; email is provider-driven).
--
-- Migration 206's queue (public.notification_email_jobs) kept the payload of
-- every job for good, could not tell which conversations a job told about,
-- and let a digest be queued again every window for the same waiting
-- conversations. The announcement was fanned out inside the Super Admin's
-- request, to every operator at once. This adds what the code
-- (server/services/notificationEmail/) needs to do better:
--
-- 1. notification_email_jobs.conversation_ids: the conversations a job tells
--    about (a transcript's one, a digest's list). A privacy erasure deletes
--    the jobs about the erased conversations by it
--    (services/privacy/anonymizer.ts). The transcript jobs already queued
--    are given theirs from their dedupe key ("transcript:<user>:<conversation>").
-- 2. notification_email_jobs.covered_through: the newest waiting message a
--    digest told about. The next digest goes only when something new is
--    waiting: a conversation the last one did not list, or a newer message.
-- 3. One open digest per operator and workspace (a unique index on pending
--    and sending digests): the sweep replaces the waiting digest's list
--    rather than adding a job per window, so quiet hours end with one
--    digest, not ten. Older open digests of the same operator and workspace
--    (none expected: the digest is off on both brands) are set aside as
--    'skipped' first, so the index can be built; nothing is deleted.
-- 4. public.notification_email_announcements: a Super Admin's announcement
--    (plain text), fanned out by the notification ticker a page at a time,
--    at most a set number of operators an hour, from a cursor; its
--    dedupe_key keeps a double click one announcement.
--
-- Finished jobs are emptied of their payload by the code when they finish,
-- and deleted 30 days later (the dedupe keys' memory); this migration
-- deletes nothing and empties nothing. The new table is the backend's only
-- (service_role): RLS on with a service_role policy, nothing granted to anon
-- or authenticated. No function is added.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The code
-- runs without it until it is applied: a job is queued without the new
-- columns, and an announcement is refused (503) rather than half sent. Safe
-- to run twice. Dry run: wrap the file in BEGIN; … ROLLBACK; (it opens no
-- transaction of its own). Like 284 to 289b, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

-- ---------- 1 and 2. what a job is about ----------
ALTER TABLE public.notification_email_jobs
  ADD COLUMN IF NOT EXISTS conversation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE public.notification_email_jobs
  ADD COLUMN IF NOT EXISTS covered_through timestamptz;

COMMENT ON COLUMN public.notification_email_jobs.conversation_ids IS
  'The conversations this job tells about (a transcript''s one, a digest''s list): a privacy erasure deletes the jobs about the erased conversations by it. Migration 289c.';
COMMENT ON COLUMN public.notification_email_jobs.covered_through IS
  'A digest''s newest waiting message: the next digest goes only for a conversation it did not list or a newer message. Migration 289c.';

UPDATE public.notification_email_jobs
   SET conversation_ids = ARRAY[split_part(dedupe_key, ':', 3)::uuid]
 WHERE type = 'transcripts'
   AND conversation_ids = '{}'::uuid[]
   AND dedupe_key ~ '^transcript:[0-9a-fA-F-]{36}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

CREATE INDEX IF NOT EXISTS idx_notification_email_jobs_conversations
  ON public.notification_email_jobs USING gin (conversation_ids)
  WHERE conversation_ids <> '{}'::uuid[];

-- The retention purge: finished jobs by age.
CREATE INDEX IF NOT EXISTS idx_notification_email_jobs_finished
  ON public.notification_email_jobs (created_at)
  WHERE status IN ('sent', 'skipped', 'failed');

-- ---------- 3. one open digest per operator and workspace ----------
UPDATE public.notification_email_jobs j
   SET status = 'skipped',
       last_error = '289c: an older open digest of the same operator and workspace'
 WHERE j.type = 'unread_messages'
   AND j.status IN ('pending', 'sending')
   AND EXISTS (
     SELECT 1 FROM public.notification_email_jobs n
      WHERE n.type = 'unread_messages'
        AND n.status IN ('pending', 'sending')
        AND n.user_id = j.user_id
        AND n.workspace_id IS NOT DISTINCT FROM j.workspace_id
        AND (n.created_at, n.id) > (j.created_at, j.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_email_jobs_open_digest
  ON public.notification_email_jobs (user_id, workspace_id)
  WHERE type = 'unread_messages' AND status IN ('pending', 'sending');

-- ---------- 4. announcements ----------
CREATE TABLE IF NOT EXISTS public.notification_email_announcements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  body              text NOT NULL,
  dedupe_key        text NOT NULL,
  status            text NOT NULL DEFAULT 'sending',
  fanout_cursor     uuid,
  recipients_queued integer NOT NULL DEFAULT 0,
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  CONSTRAINT notification_email_announcements_status_check
    CHECK (status IN ('sending', 'done', 'cancelled')),
  CONSTRAINT notification_email_announcements_title_check
    CHECK (length(title) BETWEEN 1 AND 160),
  CONSTRAINT notification_email_announcements_body_check
    CHECK (length(body) BETWEEN 1 AND 8000),
  CONSTRAINT notification_email_announcements_dedupe_check
    CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT notification_email_announcements_count_check
    CHECK (recipients_queued >= 0),
  CONSTRAINT notification_email_announcements_final_check
    CHECK ((status = 'sending') = (finished_at IS NULL))
);

COMMENT ON TABLE public.notification_email_announcements IS
  'A Super Admin''s announcement to the operators (plain text), fanned out by the notification email ticker from fanout_cursor (a user id), at most a set number an hour, into notification_email_jobs (type product_updates). Server-only. Migration 289c.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_email_announcements_dedupe
  ON public.notification_email_announcements (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_notification_email_announcements_sending
  ON public.notification_email_announcements (created_at)
  WHERE status = 'sending';

DO $$
BEGIN
  ALTER TABLE public.notification_email_announcements ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.notification_email_announcements FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.notification_email_announcements FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.notification_email_announcements FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.notification_email_announcements TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'notification_email_announcements' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.notification_email_announcements
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

RESET lock_timeout;
