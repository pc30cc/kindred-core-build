-- 276 — Chat widget features (issue #340): the rating after a chat, the
-- transcript by email, message reactions, the queue's place and wait, and the
-- KB article's author.
--
-- 1. conversation_ratings: a visitor's 1–5 rating (and optional comment) of
--    one closure of a widget conversation, i.e. of the `conversation_closed`
--    system message it answers. One rating per closure, never changed
--    (closed_message_id is unique). No foreign key to the message: a rating
--    outlives a message the privacy tools remove, and the table takes no lock
--    on conversation_messages.
-- 2. conversation_transcript_emails: the ledger of transcripts mailed to a
--    visitor (sent or failed), which the per-conversation and per-workspace
--    limits count. No address is stored. And the email template
--    `visitor_conversation_transcript` (Super Admin → Branding → Email
--    templates), seeded for both editions in fa/en/tr; a row that exists
--    (edited or not) is never overwritten. Variables: {brand} {year}
--    {workspace} (HTML-escaped) {workspace_name} (plain: subject and text)
--    {date} {transcript} (HTML table rows) {transcript_text} (plain).
-- 3. conversation_message_reactions: one row per (message, actor, emoji). An
--    actor is the conversation's visitor (actor_type 'visitor', actor_id
--    NULL: a conversation has one visitor side) or a workspace member
--    (actor_type 'operator', actor_id = their user id). Which emojis exist is
--    the code's (shared/messageReactions.ts); the table only bounds their
--    length. Adding or removing a reaction touches its message's updated_at
--    (the thread sync cursor, 216), so GET /api/conversations/:id/messages
--    ?since= returns the message again; a cascaded delete (message,
--    conversation, workspace) touches nothing.
-- 4. The queue (assignment mode 'manual'): chat_queue_stats keeps, per
--    workspace, a moving average of how long a queued chat waits per place in
--    the queue, sampled by a trigger on conversations when a queued row gets
--    its operator (first assignment only: assigned_to NULL → someone, while
--    open or pending, queued_at set, routing_outcome 'manual_queue');
--    chat_queue_status(ws, conversation) answers the place in the queue and,
--    once 3 claims were measured in the last 14 days and the estimate is at
--    most 180 minutes, the wait in minutes. The partial index
--    conversations_manual_queue_idx serves both.
-- 5. knowledge_base_articles.author_user_id: the operator shown as the
--    article's author in the widget (name from profiles); NULL = none. No
--    backfill: no creator was ever recorded, so existing articles show none.
--
-- Every new table is server-only: RLS on, nothing for PUBLIC, anon or
-- authenticated, service_role alone through its policy. The functions pin
-- their search_path; the one SECURITY DEFINER (the claim trigger's, so a
-- claim by any role still records its sample) is executable by no customer
-- role. Server code tolerates this file being absent (42P01 / 42703 → the
-- feature is off, never a 500).
--
-- conversations_manual_queue_idx: on a live database build it by hand FIRST,
-- outside a transaction (a plain build blocks writes to conversations for its
-- whole run); this file then finds it and builds nothing:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_manual_queue_idx
--     ON public.conversations (workspace_id, (metadata->>'queued_at'))
--     WHERE assigned_to IS NULL AND (metadata->>'routing_outcome') = 'manual_queue';
-- An interrupted CONCURRENTLY build leaves an invalid index of that name: the
-- file then stops and says so (drop it with DROP INDEX CONCURRENTLY and build
-- it again).
--
-- Locks: the new tables' foreign keys take SHARE ROW EXCLUSIVE on workspaces,
-- conversations, conversation_messages and profiles for an instant; the
-- trigger the same on conversations; the new column ACCESS EXCLUSIVE on
-- knowledge_base_articles for an instant. Re-runnable: every step is guarded
-- or a no-op the second time, and a second run takes none of those locks.
-- The file sets lock_timeout 5s itself (not one transaction, so for the
-- session, reset at the end): a runner without PGOPTIONS, such as RESPOK's
-- migrator, must not leave every chat write queued behind a lock that waits
-- for an open transaction. A statement stopped by it is simply run again.
-- Dry run: the file inside BEGIN … ROLLBACK. Changes no existing row; drops
-- nothing; touches no archive schema or table.

SET lock_timeout = '5s';

-- ─── 1. The rating after a chat ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_ratings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  closed_message_id uuid NOT NULL,
  operator_id       uuid,
  score             smallint NOT NULL,
  comment           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_ratings_score_check CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT conversation_ratings_comment_check CHECK (comment IS NULL OR char_length(comment) <= 1000),
  CONSTRAINT conversation_ratings_closed_message_key UNIQUE (closed_message_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_ratings_ws_created
  ON public.conversation_ratings (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_ratings_ws_operator
  ON public.conversation_ratings (workspace_id, operator_id, created_at DESC) WHERE operator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_ratings_conversation
  ON public.conversation_ratings (conversation_id);

COMMENT ON TABLE public.conversation_ratings IS
  'A visitor''s 1-5 rating (and optional comment) of one closure of a widget conversation: the conversation_closed system message it answers (one rating each, never changed). operator_id: the operator assigned at the close, else the closer. Server-only. Migration 276.';

DO $$
BEGIN
  ALTER TABLE public.conversation_ratings ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.conversation_ratings FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.conversation_ratings FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.conversation_ratings FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.conversation_ratings TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'conversation_ratings' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.conversation_ratings
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- ─── 2. The transcript by email ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_transcript_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  status          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_transcript_emails_status_check CHECK (status IN ('sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_transcript_emails_conversation
  ON public.conversation_transcript_emails (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_transcript_emails_ws_created
  ON public.conversation_transcript_emails (workspace_id, created_at DESC);

COMMENT ON TABLE public.conversation_transcript_emails IS
  'Every transcript a visitor asked to be mailed (sent or failed), which the per-conversation and per-workspace limits count. No address is stored. Server-only. Migration 276.';

DO $$
BEGIN
  ALTER TABLE public.conversation_transcript_emails ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.conversation_transcript_emails FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.conversation_transcript_emails FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.conversation_transcript_emails FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.conversation_transcript_emails TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'conversation_transcript_emails' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.conversation_transcript_emails
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- The email. Seeded in both editions in fa/en/tr, like 264's; a row that
-- exists is never overwritten. The layout is 264's with the workspace's name
-- in the header (the mail is from the visitor's chat with that workspace) and
-- the platform's in the footer. The pg_temp helpers do not outlive a session.
CREATE OR REPLACE FUNCTION pg_temp._email_276_layout(p_locale text, p_title text, p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $f$
  SELECT '<!DOCTYPE html><html lang="' || p_locale || '" dir="' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || '">'
    || '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' || p_title || '</title></head>'
    || '<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Tahoma,sans-serif;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;">'
    || '<tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{workspace}</h1></td></tr>'
    || '<tr><td style="padding:40px;text-align:' || CASE WHEN p_locale = 'fa' THEN 'right' ELSE 'left' END || ';direction:' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || ';">'
    || '<h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">' || p_title || '</h2>'
    || p_body
    || '</td></tr>'
    || '<tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr>'
    || '</table></td></tr></table></body></html>'
$f$;

CREATE OR REPLACE FUNCTION pg_temp._email_276_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_intro text, p_footer text, p_text text
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $f$
DECLARE
  v_edition text;
  v_body text := '<p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:24px;">' || p_intro || '</p>'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">{transcript}</table>'
    || '<p style="margin:24px 0 0;color:#94a3b8;font-size:13px;line-height:20px;">' || p_footer || '</p>';
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_276_layout(p_locale, p_title, v_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_276_seed('visitor_conversation_transcript', 'fa',
  'متن گفتگوی شما با {workspace_name}', 'متن گفتگوی شما با {workspace}',
  'این متن گفتگوی شما با {workspace} است ({date})، همان‌طور که از پنجره‌ی گفتگو خواستید.',
  'اگر این ایمیل را شما نخواسته‌اید، آن را نادیده بگیرید.',
  E'این متن گفتگوی شما با {workspace_name} است ({date})، همان‌طور که از پنجره‌ی گفتگو خواستید.\n\n{transcript_text}\n\nاگر این ایمیل را شما نخواسته‌اید، آن را نادیده بگیرید.');
SELECT pg_temp._email_276_seed('visitor_conversation_transcript', 'en',
  'Your conversation with {workspace_name}', 'Your conversation with {workspace}',
  'Here is your conversation with {workspace} ({date}), as you asked from the chat window.',
  'If you did not ask for this email, you can ignore it.',
  E'Here is your conversation with {workspace_name} ({date}), as you asked from the chat window.\n\n{transcript_text}\n\nIf you did not ask for this email, you can ignore it.');
SELECT pg_temp._email_276_seed('visitor_conversation_transcript', 'tr',
  '{workspace_name} ile sohbetiniz', '{workspace} ile sohbetiniz',
  'Sohbet penceresinden istediğiniz üzere {workspace} ile sohbetiniz ({date}):',
  'Bu e-postayı siz istemediyseniz yok sayabilirsiniz.',
  E'Sohbet penceresinden istediğiniz üzere {workspace_name} ile sohbetiniz ({date}):\n\n{transcript_text}\n\nBu e-postayı siz istemediyseniz yok sayabilirsiniz.');

-- ─── 3. Message reactions ─────────────────────────────────────────────────
-- (NULLS NOT DISTINCT needs PostgreSQL 15+: production pg17, CI 15, 16, 17.)
CREATE TABLE IF NOT EXISTS public.conversation_message_reactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES public.conversation_messages(id) ON DELETE CASCADE,
  actor_type      text NOT NULL,
  actor_id        uuid,
  emoji           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_message_reactions_actor_check CHECK (
    (actor_type = 'visitor' AND actor_id IS NULL) OR (actor_type = 'operator' AND actor_id IS NOT NULL)),
  CONSTRAINT conversation_message_reactions_emoji_check CHECK (char_length(emoji) BETWEEN 1 AND 16),
  CONSTRAINT conversation_message_reactions_one_per_actor
    UNIQUE NULLS NOT DISTINCT (message_id, actor_type, actor_id, emoji)
);

-- message_id is covered by the unique constraint (its leading column).
CREATE INDEX IF NOT EXISTS idx_conversation_message_reactions_conversation
  ON public.conversation_message_reactions (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_message_reactions_workspace
  ON public.conversation_message_reactions (workspace_id);

COMMENT ON TABLE public.conversation_message_reactions IS
  'Reactions to chat messages, one row per (message, actor, emoji): the conversation''s visitor (actor_id NULL) or a workspace member. Emojis: shared/messageReactions.ts. A change touches the message''s updated_at. Server-only. Migration 276.';

DO $$
BEGIN
  ALTER TABLE public.conversation_message_reactions ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.conversation_message_reactions FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.conversation_message_reactions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.conversation_message_reactions FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.conversation_message_reactions TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'conversation_message_reactions' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.conversation_message_reactions
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tg_conversation_message_reactions_touch_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn_reaction_touch$
BEGIN
  -- A cascade (the message, its conversation or the workspace going away)
  -- has nothing left to touch.
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  UPDATE public.conversation_messages SET updated_at = clock_timestamp()
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.message_id ELSE NEW.message_id END;
  RETURN NULL;
END;
$fn_reaction_touch$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_conversation_message_reactions_touch_message'
       AND tgrelid = 'public.conversation_message_reactions'::regclass
  ) THEN
    CREATE TRIGGER trg_conversation_message_reactions_touch_message
      AFTER INSERT OR DELETE ON public.conversation_message_reactions
      FOR EACH ROW
      EXECUTE FUNCTION public.tg_conversation_message_reactions_touch_message();
  END IF;
END $$;

-- ─── 4. The queue: place and wait ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_queue_stats (
  workspace_id      uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  seconds_per_place double precision NOT NULL,
  samples           integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_queue_stats_seconds_per_place_check CHECK (seconds_per_place > 0),
  CONSTRAINT chat_queue_stats_samples_check CHECK (samples >= 0)
);

COMMENT ON TABLE public.chat_queue_stats IS
  'Per workspace: a moving average (0.3 to the newest, restarted after 14 idle days) of how long a manually queued chat waits per place in the queue, and how many claims it has seen. Written by the trigger trg_conversations_queue_claim; read by chat_queue_status(). Server-only. Migration 276.';

DO $$
BEGIN
  ALTER TABLE public.chat_queue_stats ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.chat_queue_stats FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.chat_queue_stats FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.chat_queue_stats FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.chat_queue_stats TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'chat_queue_stats' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.chat_queue_stats
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- Built CONCURRENTLY beforehand on a live database (see the header): then
-- nothing is built here and no lock is taken on conversations.
DO $$
BEGIN
  IF to_regclass('public.conversations_manual_queue_idx') IS NULL THEN
    CREATE INDEX conversations_manual_queue_idx
      ON public.conversations (workspace_id, (metadata->>'queued_at'))
      WHERE assigned_to IS NULL AND (metadata->>'routing_outcome') = 'manual_queue';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid = 'public.conversations_manual_queue_idx'::regclass AND indisvalid
  ) THEN
    RAISE EXCEPTION '276: conversations_manual_queue_idx is invalid (an interrupted CREATE INDEX CONCURRENTLY); DROP INDEX CONCURRENTLY public.conversations_manual_queue_idx, build it again, then run this file';
  END IF;
END $$;

-- The visitor's place: 1 + the queued conversations of the workspace that
-- were queued before it (queued_at, then id, so two places never share a
-- number). Every channel counts: it is the team's one Unassigned queue. No
-- row when the conversation is not waiting in the queue.
CREATE OR REPLACE FUNCTION public.chat_queue_status(p_workspace_id uuid, p_conversation_id uuid)
RETURNS TABLE (queue_position integer, wait_minutes integer)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn_queue_status$
  WITH me AS (
    SELECT c.metadata->>'queued_at' AS q
      FROM public.conversations c
     WHERE c.id = p_conversation_id
       AND c.workspace_id = p_workspace_id
       AND c.assigned_to IS NULL
       AND (c.metadata->>'routing_outcome') = 'manual_queue'
       AND c.metadata ? 'queued_at'
       AND c.status IN ('open', 'pending')
       AND c.is_spam = false
  ), pos AS (
    SELECT 1 + count(*)::integer AS n
      FROM public.conversations c, me
     WHERE c.workspace_id = p_workspace_id
       AND c.assigned_to IS NULL
       AND (c.metadata->>'routing_outcome') = 'manual_queue'
       AND (c.metadata->>'queued_at') <= me.q
       AND ((c.metadata->>'queued_at') < me.q OR c.id < p_conversation_id)
       AND c.status IN ('open', 'pending')
       AND c.is_spam = false
  )
  SELECT pos.n,
         CASE WHEN s.samples >= 3
               AND s.updated_at >= now() - interval '14 days'
               AND s.seconds_per_place * pos.n <= 10800
              THEN greatest(1, ceil(s.seconds_per_place * pos.n / 60.0))::integer
         END
    FROM me
   CROSS JOIN pos
    LEFT JOIN public.chat_queue_stats s ON s.workspace_id = p_workspace_id;
$fn_queue_status$;

COMMENT ON FUNCTION public.chat_queue_status(uuid, uuid) IS
  'The place of a manually queued conversation in its workspace''s queue and the estimated wait in minutes (NULL until 3 claims were measured in the last 14 days, or above 180 minutes). No row when the conversation is not waiting. Server-only. Migration 276.';

-- One sample per first assignment of a queued row: the seconds it waited,
-- per place it entered at. Cosmetic: any error is swallowed, so an
-- assignment never fails because of it. Nor does it wait: the workspace's
-- stats row is locked by every claim until that claim commits, and a lock
-- held longer (a claim inside a longer transaction) would otherwise hold the
-- next operator's assignment up for as long, or deadlock it; the function's
-- own lock_timeout (well under deadlock_timeout) gives up on the sample
-- instead. SECURITY DEFINER so a claim made by any role records its sample
-- in the server-only table.
CREATE OR REPLACE FUNCTION public.chat_queue_record_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '100ms'
AS $fn_queue_claim$
DECLARE
  v_wait double precision;
  v_place double precision;
BEGIN
  BEGIN
    v_wait := extract(epoch FROM (now() - (OLD.metadata->>'queued_at')::timestamptz));
    v_place := v_wait / greatest(coalesce((OLD.metadata->>'queue_entry_position')::integer, 1), 1);
    IF v_place > 0 AND v_wait < 86400 THEN
      INSERT INTO public.chat_queue_stats AS s (workspace_id, seconds_per_place, samples, updated_at)
      VALUES (NEW.workspace_id, v_place, 1, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        seconds_per_place = CASE WHEN s.updated_at < now() - interval '14 days' THEN EXCLUDED.seconds_per_place
                                 ELSE s.seconds_per_place * 0.7 + EXCLUDED.seconds_per_place * 0.3 END,
        samples = CASE WHEN s.updated_at < now() - interval '14 days' THEN 1 ELSE s.samples + 1 END,
        updated_at = now();
    END IF;
  EXCEPTION WHEN others THEN
    NULL;
  END;
  RETURN NULL;
END;
$fn_queue_claim$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_conversations_queue_claim' AND tgrelid = 'public.conversations'::regclass
  ) THEN
    CREATE TRIGGER trg_conversations_queue_claim
      AFTER UPDATE OF assigned_to ON public.conversations
      FOR EACH ROW
      WHEN (OLD.assigned_to IS NULL AND NEW.assigned_to IS NOT NULL
            AND OLD.status IN ('open', 'pending')
            AND OLD.metadata ? 'queued_at'
            AND (OLD.metadata->>'routing_outcome') = 'manual_queue')
      EXECUTE FUNCTION public.chat_queue_record_claim();
  END IF;
END $$;

-- ─── 5. The KB article's author ───────────────────────────────────────────
-- The column never exists without its foreign key (one ALTER); the key is
-- added NOT VALID and validated by its own statement (under a lock that does
-- not block writes; the new column is all NULL, so there is nothing to read).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.knowledge_base_articles'::regclass AND attname = 'author_user_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.knowledge_base_articles
      ADD COLUMN author_user_id uuid,
      ADD CONSTRAINT knowledge_base_articles_author_user_id_fkey
        FOREIGN KEY (author_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL NOT VALID;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'knowledge_base_articles_author_user_id_fkey'
       AND conrelid = 'public.knowledge_base_articles'::regclass
  ) THEN
    ALTER TABLE public.knowledge_base_articles
      ADD CONSTRAINT knowledge_base_articles_author_user_id_fkey
        FOREIGN KEY (author_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'knowledge_base_articles_author_user_id_fkey'
       AND conrelid = 'public.knowledge_base_articles'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.knowledge_base_articles VALIDATE CONSTRAINT knowledge_base_articles_author_user_id_fkey;
  END IF;
END $$;

-- A profile's deletion looks its articles up here.
DO $$
BEGIN
  IF to_regclass('public.idx_knowledge_base_articles_author') IS NULL THEN
    CREATE INDEX idx_knowledge_base_articles_author
      ON public.knowledge_base_articles (author_user_id) WHERE author_user_id IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.knowledge_base_articles.author_user_id IS
  'The operator shown as the article''s author in the widget (name from profiles); NULL = no author shown. A new article''s author defaults to its creator (server). Migration 276.';

-- ─── 6. Access: the backend (service_role) only ──────────────────────────
-- The trigger functions run as triggers whatever their EXECUTE grants; nobody
-- calls them directly.
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.chat_queue_status(uuid, uuid)',
    'public.chat_queue_record_claim()',
    'public.tg_conversation_message_reactions_touch_message()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.chat_queue_status(uuid, uuid) TO service_role;
  END IF;
END $acl$;

RESET lock_timeout;
