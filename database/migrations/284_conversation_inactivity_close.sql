-- 284 — A website-widget conversation nobody has written in for N hours is
-- closed by the system (owner, 2026-10-23/24). One current conversation per
-- visitor (PR #359) made `closed` the only end a visitor sees: a resolved
-- conversation stays theirs until it is closed, so a quiet one now ends by
-- itself, with «گفتگو به پایان رسید» and the rating card for the visitor. The
-- AI never closes anything, and nothing the team still owes is ever closed.
--
-- 1. widget_settings.inactivity_close_hours (1–48, NULL = the platform's
--    default): how long a widget conversation may go without an exchange
--    before the system closes it. A workspace cannot switch the close off
--    (the owner: on for every workspace, 48 h at most; Core's gs_active bound,
--    activeNow's 48 h, assumes no window is longer). Only the Super Admin's
--    switch below is an off.
-- 2. widget_platform_settings.inactivity_close_enabled (the Super Admin's
--    switch, every workspace at once) and inactivity_close_default_hours
--    (1–48, default 24: what every workspace without its own value uses, now
--    and after the Super Admin changes it). The switch is on by default; on
--    an installation that already holds live conversations (WebYar, RESPOK)
--    this file sets it off once, when it adds the column, so the timer starts
--    only after the backlog was closed by hand and silently
--    (database/backfill/284_inactivity_backlog_close.sql, whose commit turns
--    it on). A new installation (nothing to close) starts on. A second run
--    never touches it.
-- 3. conversation_ratings.subject ('operator' | 'ai', default 'operator';
--    owner, decision B.5): a visitor rates an AI-only conversation too. Such a
--    rating has operator_id NULL and subject 'ai', and stays out of every
--    operator's satisfaction.
-- 4. The functions (service_role only, SECURITY INVOKER, pinned search_path):
--      conversation_message_turn()   a message is a visitor turn, a team
--                                    answer, or neither (needsReply.ts in SQL;
--                                    src/test pins the two together);
--      conversation_idle_check()     the whole decision for one conversation:
--                                    'due', or why not (not live, spam, not a
--                                    widget one, an exchange within the
--                                    window, or something the team owes:
--                                    needs_reply, an AI handoff, routing, a
--                                    call, a callback, an AI guidance request);
--      conversation_idle_due()       what the ticker closes this pass, oldest
--                                    first: nothing while the switch is off,
--                                    never a row untouched for 30 days;
--      conversation_close_if_idle()  the close: row-locked (FOR UPDATE, which
--                                    also waits for a message being inserted:
--                                    its foreign key holds KEY SHARE on the
--                                    row), a compare-and-set on updated_at,
--                                    the decision taken again, then status
--                                    'closed', the close markers, the two
--                                    thread-end stamps, one timeline event as
--                                    the Inbox's PATCH files a close, and the
--                                    visitor's closed line when the caller
--                                    passes one (the timer; never the
--                                    backlog). It never moves updated_at
--                                    (retention locks, the Resolved lists and
--                                    the visitor's history go by it) and never
--                                    touches the AI's hold (ai_state, the
--                                    handoff, the takeover) or routing's state;
--      conversation_reopen_after_idle_close()  a visitor message that raced
--                                    the close (within p_grace_seconds of it)
--                                    puts that conversation back as it was
--                                    and retracts its closed line.
-- 5. A partial index for the ticker's scan, conversations_live_updated_idx.
--    updated_at is already indexed (conversations_contact_recent_idx), so the
--    writes that touch it were already not HOT: no new class of write cost.
-- 6. widget_prechat_settings.history_continue_window_hours is retired (a
--    comment: nothing reads it since PR #359, its route stops writing it; a
--    later migration drops it).
-- 7. conversation_inbox_counters (241): an operator's own Resolved count
--    leaves the AI's conversations out, as the tab's list (the Main Inbox)
--    always did. It counted every resolved or closed conversation nobody had
--    handled, the AI's included, and the close ends the AI's conversations
--    every day, keeping their ai_state (they stay in no queue).
--
-- The index: on a live database build it by hand FIRST, outside a
-- transaction (a plain build blocks writes to conversations while it runs);
-- this file then finds it and builds nothing:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_live_updated_idx
--     ON public.conversations (updated_at)
--     WHERE status IN ('open', 'pending', 'resolved') AND is_spam = false;
-- An interrupted CONCURRENTLY build leaves an invalid index of that name: the
-- file then stops and says so (drop it with DROP INDEX CONCURRENTLY and build
-- it again, then run this file).
--
-- Locks: the new columns take ACCESS EXCLUSIVE on widget_settings,
-- widget_platform_settings and conversation_ratings for an instant (constant
-- defaults: no rewrite; the one-time switch update touches the platform's
-- single row); their checks are added NOT VALID and validated by their own
-- statements (SHARE UPDATE EXCLUSIVE: reads and writes go on). The index
-- takes SHARE on conversations (writes wait) while it is built, unless it was
-- built beforehand as above. Re-runnable: every step is guarded or a no-op
-- the second time.
-- The file sets lock_timeout 5s itself (not one transaction, so for the
-- session, reset at the end): a runner without PGOPTIONS, such as RESPOK's
-- migrator, must not leave every chat write queued behind a lock that waits
-- for an open transaction. A statement stopped by it is simply run again.
-- Dry run: the file inside BEGIN … ROLLBACK. Closes nothing (it only defines
-- the close, and on a running installation the switch is then off), changes
-- no conversation or message, drops nothing, deletes nothing, touches no
-- archive, ledger or other financial table.

SET lock_timeout = '5s';

-- ─── 1. Per workspace ──────────────────────────────────────────────────────
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS inactivity_close_hours integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'widget_settings_inactivity_close_hours_check'
       AND conrelid = 'public.widget_settings'::regclass
  ) THEN
    ALTER TABLE public.widget_settings
      ADD CONSTRAINT widget_settings_inactivity_close_hours_check
        CHECK (inactivity_close_hours IS NULL OR inactivity_close_hours BETWEEN 1 AND 48) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'widget_settings_inactivity_close_hours_check'
       AND conrelid = 'public.widget_settings'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.widget_settings VALIDATE CONSTRAINT widget_settings_inactivity_close_hours_check;
  END IF;
END $$;

COMMENT ON COLUMN public.widget_settings.inactivity_close_hours IS
  'Hours (1–48) a widget conversation may go without an exchange (the visitor, the team, the AI, a connected call) before the system closes it; NULL = widget_platform_settings.inactivity_close_default_hours. Never closes what the team still owes (conversation_idle_check). Migration 284.';

-- ─── 2. Platform ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'widget_platform_settings'
       AND column_name = 'inactivity_close_enabled'
  ) THEN
    ALTER TABLE public.widget_platform_settings
      ADD COLUMN inactivity_close_enabled boolean NOT NULL DEFAULT true;
    -- An installation that already holds live conversations (WebYar,
    -- RESPOK): off until its backlog is closed by hand, whose commit turns
    -- it on. A new one (nothing to close) stays on. Only here, when the
    -- column is new, so a later run never undoes the Super Admin.
    UPDATE public.widget_platform_settings
       SET inactivity_close_enabled = false
     WHERE EXISTS (SELECT 1 FROM public.conversations c WHERE c.status IN ('open', 'pending', 'resolved'));
  END IF;
END $$;

ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS inactivity_close_default_hours integer NOT NULL DEFAULT 24;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'widget_platform_settings_inactivity_close_default_hours_check'
       AND conrelid = 'public.widget_platform_settings'::regclass
  ) THEN
    ALTER TABLE public.widget_platform_settings
      ADD CONSTRAINT widget_platform_settings_inactivity_close_default_hours_check
        CHECK (inactivity_close_default_hours BETWEEN 1 AND 48) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'widget_platform_settings_inactivity_close_default_hours_check'
       AND conrelid = 'public.widget_platform_settings'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.widget_platform_settings VALIDATE CONSTRAINT widget_platform_settings_inactivity_close_default_hours_check;
  END IF;
END $$;

COMMENT ON COLUMN public.widget_platform_settings.inactivity_close_enabled IS
  'Super Admin switch: widget conversations close by themselves after their workspace''s inactivity window (conversation_idle_due, conversation_close_if_idle read it). Off = the timer closes nothing anywhere. Migration 284.';
COMMENT ON COLUMN public.widget_platform_settings.inactivity_close_default_hours IS
  'Inactivity window (hours, 1–48) of every workspace without its own widget_settings.inactivity_close_hours. Migration 284.';

-- ─── 3. Who a rating is about ──────────────────────────────────────────────
ALTER TABLE public.conversation_ratings
  ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'operator';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversation_ratings_subject_check'
       AND conrelid = 'public.conversation_ratings'::regclass
  ) THEN
    ALTER TABLE public.conversation_ratings
      ADD CONSTRAINT conversation_ratings_subject_check
        CHECK (subject IN ('operator', 'ai')) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversation_ratings_subject_check'
       AND conrelid = 'public.conversation_ratings'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.conversation_ratings VALIDATE CONSTRAINT conversation_ratings_subject_check;
  END IF;
END $$;

COMMENT ON COLUMN public.conversation_ratings.subject IS
  'Who the visitor rated: ''operator'' (a person answered; operator_id the one the closed line names) or ''ai'' (only the AI answered; operator_id NULL, kept out of per-operator satisfaction). Migration 284.';

COMMENT ON COLUMN public.widget_prechat_settings.history_continue_window_hours IS
  'Retired since PR #359 (one current conversation per visitor): nothing reads it, and an idle conversation ends by widget_settings.inactivity_close_hours (migration 284). Kept until no running code writes it; a later migration drops it.';

-- ─── 4. The functions ──────────────────────────────────────────────────────

-- needsReply.ts in SQL: 'visitor' for an actionable customer turn
-- (isActionableCustomerTurn), 'team' for a qualified customer-facing answer
-- of a person or the AI (isQualifiedCustomerFacingAnswer), NULL for
-- everything the Inbox treats as transparent (system rows, routing notices,
-- menu taps, bot output, provider echoes, empty rows, skipped or failed
-- deliveries, the AI's hand-over line). The whitespace is JavaScript's
-- trim() set. src/test/integration/conversationIdleClose284.pg.test.ts runs
-- the same generated fixtures through both.
CREATE OR REPLACE FUNCTION public.conversation_message_turn(p_sender_type text, p_body text, p_metadata jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_turn$
  SELECT CASE
    WHEN p_sender_type IS NULL OR p_sender_type NOT IN ('contact', 'agent', 'ai') THEN NULL
    WHEN jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)->'routing_notice') = 'string' THEN NULL
    WHEN coalesce(p_metadata->>'channel_menu_event', '') = 'true' THEN NULL
    WHEN coalesce(p_metadata->'channel_menu_command', 'null'::jsonb) NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) THEN NULL
    WHEN btrim(coalesce(p_body, ''),
               E' \t\n\r\u000b\f                 　﻿') = ''
         AND coalesce(p_metadata->'attachment_id', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) THEN NULL
    WHEN p_sender_type = 'contact' THEN
      CASE WHEN p_metadata->'provider_echo' = 'true'::jsonb THEN NULL ELSE 'visitor' END
    WHEN coalesce(p_metadata->>'channel_delivery_skip', '') = 'true' THEN NULL
    WHEN coalesce(p_metadata->>'channel_delivery', '') = 'failed' THEN NULL
    WHEN p_sender_type = 'ai' AND p_metadata->'handoff' IN ('true'::jsonb, '"true"'::jsonb) THEN NULL
    ELSE 'team'
  END
$fn_turn$;

COMMENT ON FUNCTION public.conversation_message_turn(text, text, jsonb) IS
  'needsReply.ts in SQL: ''visitor'' (an actionable customer turn), ''team'' (a qualified answer of a person or the AI) or NULL (transparent). Migration 284.';

-- The whole decision for one conversation. verdict, the first that applies:
--   'not_found' | 'not_live' (closed) | 'spam' | 'not_widget' (another
--   channel, platform support);
--   'recent'       the last exchange (the newest visitor turn, person's
--                  answer or AI answer, or a connected call's end — now while
--                  the 'call' guard believes it live; with none,
--                  created_at) is inside the
--                  workspace's window;
--   the team owes: 'needs_reply' (open, and the visitor's turn is the newest:
--                  no answer and no call connected after it; a tie is owed),
--                  'ai_handoff' (needs_human / human_assigned / a handoff
--                  requested), 'routing' (routing_pending, the manual queue,
--                  a routing wait, a pre-chat deadline, a first-response
--                  timeout), 'call' (a call ringing or live in the last 12 h,
--                  an invitation or a queue entry still open), 'callback' (a
--                  callback request still open), 'guidance' (the AI asked
--                  the team and waits);
--   'due'          close it now.
-- closed_outcome (reports, 'due' only): 'no_visitor_message' (the visitor
-- never wrote: a greeting, an opening line), 'human' (a person answered, in
-- writing or on a connected call), 'ai_resolved' / 'ai_unresolved' (only the
-- AI answered, never by its greeting alone; ai_memory.issueStatus),
-- 'unanswered' (pending or resolved with the visitor's turn unanswered).
CREATE OR REPLACE FUNCTION public.conversation_idle_check(p_conversation_id uuid)
RETURNS TABLE (verdict text, idle_hours integer, last_exchange_at timestamptz, last_visitor_at timestamptz, closed_outcome text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_idle_check$
DECLARE
  c record;
  v_hours integer;
  v_default integer;
  v_visitor timestamptz;
  v_agent timestamptz;
  v_ai timestamptz;
  v_call_end timestamptz;
  v_call_connected timestamptz;
  v_last timestamptz;
BEGIN
  SELECT cv.id, cv.workspace_id, cv.status::text AS status, cv.is_spam, cv.assigned_to,
         coalesce(cv.metadata, '{}'::jsonb) AS metadata, cv.created_at
    INTO c
    FROM public.conversations cv
   WHERE cv.id = p_conversation_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  IF c.status NOT IN ('open', 'pending', 'resolved') THEN
    RETURN QUERY SELECT 'not_live'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  IF c.is_spam THEN
    RETURN QUERY SELECT 'spam'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  -- isWidgetConversation: no channel, or the widget's own; never platform support.
  IF lower(btrim(coalesce(c.metadata->>'channel', ''))) NOT IN ('', 'widget')
     OR EXISTS (SELECT 1 FROM public.platform_support_threads p WHERE p.conversation_id = c.id) THEN
    RETURN QUERY SELECT 'not_widget'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  SELECT s.inactivity_close_default_hours INTO v_default FROM public.widget_platform_settings s LIMIT 1;
  SELECT w.inactivity_close_hours INTO v_hours FROM public.widget_settings w WHERE w.workspace_id = c.workspace_id;
  v_hours := least(48, greatest(1, coalesce(v_hours, v_default, 24)));

  -- The newest visitor turn, person's answer and AI answer: each one ordered
  -- read of idx_conversation_messages_conv_sender_created.
  SELECT m.created_at INTO v_visitor
    FROM public.conversation_messages m
   WHERE m.conversation_id = c.id AND m.sender_type = 'contact'
     AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'visitor'
   ORDER BY m.created_at DESC
   LIMIT 1;
  SELECT m.created_at INTO v_agent
    FROM public.conversation_messages m
   WHERE m.conversation_id = c.id AND m.sender_type = 'agent'
     AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'team'
   ORDER BY m.created_at DESC
   LIMIT 1;
  SELECT m.created_at INTO v_ai
    FROM public.conversation_messages m
   WHERE m.conversation_id = c.id AND m.sender_type = 'ai'
     AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'team'
   ORDER BY m.created_at DESC
   LIMIT 1;
  -- A call that connected is an exchange (until it ends), and the team's
  -- answer to a turn the visitor wrote before it connected (the timer's
  -- rule only: the Inbox's needsReply.ts is unchanged). One whose end was
  -- never recorded (a lost webhook, a crashed worker) is live only as long
  -- as the 'call' guard below believes it (a live state, created in the
  -- last 12 h); after that its connect is its last exchange, or it would
  -- read 'recent' for ever.
  SELECT max(coalesce(cs.ended_at,
                      CASE WHEN cs.state IN ('pending', 'ringing', 'connecting', 'active')
                                AND cs.created_at > now() - interval '12 hours'
                           THEN now()
                           ELSE cs.connected_at
                      END)),
         max(cs.connected_at)
    INTO v_call_end, v_call_connected
    FROM public.call_sessions cs
   WHERE cs.context_type = 'conversation' AND cs.context_id = c.id AND cs.connected_at IS NOT NULL;

  v_last := coalesce(greatest(v_visitor, v_agent, v_ai, v_call_end), c.created_at);

  IF v_last > now() - make_interval(hours => v_hours) THEN
    RETURN QUERY SELECT 'recent'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;

  -- Never while the team owes an answer (computeNeedsReply: open only; the
  -- visitor's turn is the newest relevant one, a tie counts as owed).
  IF c.status = 'open' AND v_visitor IS NOT NULL
     AND v_visitor >= coalesce(greatest(v_agent, v_ai, v_call_connected), '-infinity'::timestamptz) THEN
    RETURN QUERY SELECT 'needs_reply'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;
  IF coalesce(c.metadata->>'ai_state', '') IN ('needs_human', 'human_assigned')
     OR c.metadata->>'ai_handoff_requested' = 'true' THEN
    RETURN QUERY SELECT 'ai_handoff'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;
  IF c.metadata->>'routing_pending' = 'true'
     OR (c.assigned_to IS NULL
         AND jsonb_typeof(c.metadata->'queued_at') = 'string'
         AND c.metadata->>'routing_outcome' = 'manual_queue')
     OR EXISTS (
       SELECT 1 FROM public.chat_routing_state s
        WHERE s.conversation_id = c.id
          AND (s.waiting_since IS NOT NULL OR s.prechat_deadline IS NOT NULL OR s.timeout_due_at IS NOT NULL)
     ) THEN
    RETURN QUERY SELECT 'routing'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.call_sessions cs
        WHERE cs.context_type = 'conversation' AND cs.context_id = c.id
          AND cs.state IN ('pending', 'ringing', 'connecting', 'active')
          AND cs.created_at > now() - interval '12 hours'
     )
     OR EXISTS (
       SELECT 1 FROM public.call_invitations ci
        WHERE ci.conversation_id = c.id AND ci.status = 'pending' AND ci.expires_at > now()
     )
     OR EXISTS (
       SELECT 1 FROM public.call_queue_entries q
        WHERE q.conversation_id = c.id AND q.state IN ('queued', 'offered', 'accepted') AND q.expires_at > now()
     ) THEN
    RETURN QUERY SELECT 'call'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.callback_requests r
        WHERE r.conversation_id = c.id AND r.status IN ('requested', 'scheduled', 'in_progress')
     ) THEN
    RETURN QUERY SELECT 'callback'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.ai_agent_guidance_requests g
        WHERE g.conversation_id = c.id AND g.status = 'pending'
     ) THEN
    RETURN QUERY SELECT 'guidance'::text, v_hours, v_last, v_visitor, NULL::text;
    RETURN;
  END IF;

  -- Who answered, for closed_outcome (conversationRatings.ts answeredBy):
  -- a person (a message, or a call that connected), else the AI with a
  -- real answer: its greeting (source ai_agent_intro*, written before the
  -- visitor's first word) answers nothing.
  RETURN QUERY SELECT 'due'::text, v_hours, v_last, v_visitor,
    CASE
      WHEN v_visitor IS NULL THEN 'no_visitor_message'
      WHEN v_agent IS NOT NULL OR v_call_connected IS NOT NULL THEN 'human'
      WHEN v_ai IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.conversation_messages m
         WHERE m.conversation_id = c.id AND m.sender_type = 'ai'
           AND NOT starts_with(coalesce(m.metadata->>'source', ''), 'ai_agent_intro')
           AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'team'
      ) THEN
        CASE WHEN c.metadata->'ai_memory'->>'issueStatus' = 'resolved' THEN 'ai_resolved' ELSE 'ai_unresolved' END
      ELSE 'unanswered'
    END;
END;
$fn_idle_check$;

COMMENT ON FUNCTION public.conversation_idle_check(uuid) IS
  'Whether a widget conversation is due for the inactivity close (verdict ''due''), or why not: not live, spam, not a widget one, an exchange within the window, or something the team owes (needs_reply, ai_handoff, routing, call, callback, guidance). Server-only. Migration 284.';

-- The ticker's work list: at most p_limit conversations due now, the longest
-- untouched first. Nothing while the Super Admin's switch is off (or the
-- platform row is unreadable). updated_at (every exchange path touches it)
-- narrows the scan to the partial index's live rows untouched for at least
-- an hour (the index range) and for the workspace's window, and touched in
-- the last 30 days: a row nobody touched for longer is the backlog, closed by
-- hand and silently (database/backfill/284_inactivity_backlog_close.sql),
-- never by a pass that writes visitor lines. The decision itself is
-- conversation_idle_check, and the LIMIT counts its 'due' rows only, so rows
-- the team owes never use up the batch.
CREATE OR REPLACE FUNCTION public.conversation_idle_due(p_limit integer DEFAULT 50)
RETURNS TABLE (
  due_conversation_id uuid,
  due_workspace_id uuid,
  due_status text,
  due_updated_at timestamptz,
  due_last_exchange_at timestamptz,
  due_has_visitor_turn boolean,
  due_idle_hours integer,
  due_closed_outcome text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_idle_due$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_enabled boolean;
  v_default integer;
BEGIN
  SELECT s.inactivity_close_enabled, s.inactivity_close_default_hours
    INTO v_enabled, v_default
    FROM public.widget_platform_settings s
   LIMIT 1;
  IF NOT coalesce(v_enabled, false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.workspace_id, c.status::text, c.updated_at,
         chk.last_exchange_at, chk.last_visitor_at IS NOT NULL, chk.idle_hours, chk.closed_outcome
    FROM public.conversations c
    LEFT JOIN public.widget_settings w ON w.workspace_id = c.workspace_id
    CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk
   WHERE c.status IN ('open', 'pending', 'resolved')
     AND c.is_spam = false
     AND c.updated_at >= now() - interval '30 days'
     AND c.updated_at < now() - interval '1 hour'
     AND c.updated_at < now() - make_interval(hours => least(48, greatest(1, coalesce(w.inactivity_close_hours, v_default, 24))))
     AND (c.metadata->>'channel' IS NULL OR c.metadata->>'channel' = 'widget')
     AND chk.verdict = 'due'
   ORDER BY c.updated_at
   LIMIT v_limit;
END;
$fn_idle_due$;

COMMENT ON FUNCTION public.conversation_idle_due(integer) IS
  'The inactivity ticker''s work list: widget conversations due for the close (conversation_idle_check), longest untouched first, the LIMIT counting due rows only; none while widget_platform_settings.inactivity_close_enabled is off; never one untouched for 30 days (the hand-run backlog close). Server-only. Migration 284.';

-- The close. p_expected_updated_at: the row's updated_at as the caller read
-- it (conversation_idle_due); anything written since (a message, a status
-- change, an assignment, a metadata patch) and nothing is closed
-- ('changed'). Under FOR UPDATE (which also waits for a message being
-- inserted into it: the message's foreign key holds KEY SHARE on the row)
-- the decision is taken again by a new statement, on a fresh snapshot, so a
-- visitor turn committed a moment ago keeps it open. p_source: 'timer' (the
-- switch must be on; p_line_body / p_line_metadata: the visitor's closed
-- line, conversationClosedNotice.ts prepareClosedLine, written in the same
-- transaction) or 'backlog' (the hand-run silent close: the switch is not
-- consulted, and it refuses a line).
-- Written: status 'closed' (updated_at untouched); the close markers
-- (shared/inactivityClose.ts CLOSED_KEYS) and the two thread-end stamps
-- (routing_thread_ended_at, ai_thread_reset_at: the widget's endedAt, the
-- next thread's start), their previous values kept in closed_prev_stamps for
-- the race reopen; one timeline event; the line. Never written: updated_at,
-- the AI's hold (ai_state, managed_by_ai, ai_managed_by_ai, ai_handoff_*,
-- human_takeover_*), routing_pending, routing_department_only,
-- chat_routing_state and its skip list, audit_log.
-- outcome: 'closed', or 'disabled' | 'not_found' | 'changed' | a verdict of
-- conversation_idle_check.
CREATE OR REPLACE FUNCTION public.conversation_close_if_idle(
  p_conversation_id uuid,
  p_expected_updated_at timestamptz,
  p_source text DEFAULT 'timer',
  p_line_body text DEFAULT NULL,
  p_line_metadata jsonb DEFAULT NULL
)
RETURNS TABLE (
  closed boolean,
  outcome text,
  workspace_id uuid,
  from_status text,
  closed_at timestamptz,
  event_id uuid,
  event_type text,
  event_created_at timestamptz,
  line_id uuid,
  line_created_at timestamptz,
  closed_outcome text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_close_idle$
DECLARE
  v_ws uuid;
  v_status text;
  v_updated timestamptz;
  v_meta jsonb;
  v_enabled boolean;
  chk record;
  v_now timestamptz := now();
  v_iso text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_last_iso text;
  v_source text;
  v_event uuid;
  v_event_type text;
  v_event_at timestamptz;
  v_line uuid;
  v_line_at timestamptz;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('timer', 'backlog') THEN
    RAISE EXCEPTION 'conversation_close_if_idle: unknown source %', p_source;
  END IF;
  IF p_source = 'backlog' AND (p_line_body IS NOT NULL OR p_line_metadata IS NOT NULL) THEN
    RAISE EXCEPTION 'conversation_close_if_idle: the backlog close writes no visitor line';
  END IF;
  v_source := CASE WHEN p_source = 'backlog' THEN 'inactivity_backlog' ELSE 'inactivity_timer' END;

  IF p_source = 'timer' THEN
    SELECT s.inactivity_close_enabled INTO v_enabled FROM public.widget_platform_settings s LIMIT 1;
    IF NOT coalesce(v_enabled, false) THEN
      RETURN QUERY SELECT false, 'disabled'::text, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::uuid, NULL::text, NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::text;
      RETURN;
    END IF;
  END IF;

  SELECT cv.workspace_id, cv.status::text, cv.updated_at, coalesce(cv.metadata, '{}'::jsonb)
    INTO v_ws, v_status, v_updated, v_meta
    FROM public.conversations cv
   WHERE cv.id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::uuid, NULL::text, NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  IF p_expected_updated_at IS NULL OR v_updated IS DISTINCT FROM p_expected_updated_at THEN
    RETURN QUERY SELECT false, 'changed'::text, v_ws, v_status, NULL::timestamptz,
      NULL::uuid, NULL::text, NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO chk FROM public.conversation_idle_check(p_conversation_id);
  IF chk.verdict IS DISTINCT FROM 'due' THEN
    RETURN QUERY SELECT false, coalesce(chk.verdict, 'not_found'), v_ws, v_status, NULL::timestamptz,
      NULL::uuid, NULL::text, NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  v_last_iso := to_char(chk.last_exchange_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- The visitor's closed line (the timer only, when the caller has one),
  -- forced to read as the system's: no closer, no name; operator_* (who the
  -- rating is about) and rated_line_id come from the caller.
  IF p_source = 'timer' AND p_line_body IS NOT NULL THEN
    INSERT INTO public.conversation_messages (conversation_id, sender_type, body, metadata)
    VALUES (
      p_conversation_id, 'system', p_line_body,
      (CASE WHEN jsonb_typeof(p_line_metadata) = 'object' THEN p_line_metadata ELSE '{}'::jsonb END - 'internal')
        || jsonb_build_object('kind', 'conversation_closed', 'by', 'system', 'closed_reason', 'inactivity',
                              'status', 'closed', 'agent_id', NULL, 'agent_name', NULL)
    )
    RETURNING id, created_at INTO v_line, v_line_at;
  END IF;

  UPDATE public.conversations cv
     SET status = 'closed',
         metadata = coalesce(cv.metadata, '{}'::jsonb)
           || jsonb_build_object(
                'closed_reason', 'inactivity',
                'closed_by', 'system',
                'closed_at', v_iso,
                'closed_from', v_status,
                'closed_source', v_source,
                'closed_idle_hours', chk.idle_hours,
                'closed_last_exchange_at', v_last_iso,
                'closed_outcome', chk.closed_outcome,
                'closed_line_id', v_line,
                'closed_prev_stamps', jsonb_build_object(
                  'routing_thread_ended_at', v_meta->'routing_thread_ended_at',
                  'ai_thread_reset_at', v_meta->'ai_thread_reset_at'),
                -- The thread is over (threadEndPatch's two stamps, nothing
                -- else of it): the widget's endedAt, and the next thread
                -- starts afresh for routing and the AI.
                'routing_thread_ended_at', v_iso,
                'ai_thread_reset_at', v_iso)
   WHERE cv.id = p_conversation_id;

  -- The timeline, as the Inbox's PATCH files a close: open/pending → closed
  -- is a 'resolved' event with to 'closed' ("Closed"), resolved → closed a
  -- 'status_changed' one.
  v_event_type := CASE WHEN v_status = 'resolved' THEN 'status_changed' ELSE 'resolved' END;
  INSERT INTO public.conversation_events (workspace_id, conversation_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_ws, p_conversation_id, v_event_type, 'system', NULL,
    jsonb_build_object(
      'from', v_status,
      'to', 'closed',
      'reason', 'inactivity',
      'source', v_source,
      'idle_hours', chk.idle_hours
    )
  )
  RETURNING id, created_at INTO v_event, v_event_at;

  RETURN QUERY SELECT true, 'closed'::text, v_ws, v_status, v_now,
    v_event, v_event_type, v_event_at, v_line, v_line_at, chk.closed_outcome;
END;
$fn_close_idle$;

COMMENT ON FUNCTION public.conversation_close_if_idle(uuid, timestamptz, text, text, jsonb) IS
  'The inactivity close: row-locked compare-and-set on updated_at, conversation_idle_check again, then status closed with the close markers and the two thread-end stamps (updated_at untouched), a timeline event and (timer only) the visitor''s closed line. Server-only. Migration 284.';

-- A visitor message that raced the close: written within p_grace_seconds
-- (at most 600) of an inactivity close (the widget had not heard of it yet,
-- or the message was being inserted while the close committed). The
-- conversation goes back to what it was (closed_from: open, pending or
-- resolved) with the thread-end stamps it had (closed_prev_stamps), its close
-- markers removed and idle_close_undone_at stamped; the line this close
-- inserted is retracted (metadata.internal: the widget no longer gets it,
-- the Inbox still shows it); the timeline says so. The caller then runs the
-- message's lifecycle, routing and the AI as if the close had not happened.
-- Only an inactivity close, only while it is that recent, once (the status
-- compare-and-set): otherwise restored_status is NULL.
CREATE OR REPLACE FUNCTION public.conversation_reopen_after_idle_close(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_message_id uuid DEFAULT NULL,
  p_grace_seconds integer DEFAULT 60
)
RETURNS TABLE (restored_status text, updated_at timestamptz, event_id uuid, event_created_at timestamptz, retracted_line_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_reopen_idle$
DECLARE
  v_grace integer := least(greatest(coalesce(p_grace_seconds, 60), 0), 600);
  v_ws uuid;
  v_status text;
  v_meta jsonb;
  v_prev jsonb;
  v_closed_at timestamptz;
  v_restored text;
  v_line uuid;
  v_updated timestamptz;
  v_event uuid;
  v_event_at timestamptz;
BEGIN
  SELECT cv.workspace_id, cv.status::text, coalesce(cv.metadata, '{}'::jsonb)
    INTO v_ws, v_status, v_meta
    FROM public.conversations cv
   WHERE cv.id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND OR v_ws IS DISTINCT FROM p_workspace_id OR v_status <> 'closed'
     OR v_meta->>'closed_reason' IS DISTINCT FROM 'inactivity'
     OR jsonb_typeof(v_meta->'closed_at') IS DISTINCT FROM 'string' THEN
    RETURN QUERY SELECT NULL::text, NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;
  BEGIN
    v_closed_at := (v_meta->>'closed_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_closed_at := NULL;
  END;
  IF v_closed_at IS NULL OR now() - v_closed_at > make_interval(secs => v_grace) THEN
    RETURN QUERY SELECT NULL::text, NULL::timestamptz, NULL::uuid, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;

  v_restored := CASE WHEN v_meta->>'closed_from' IN ('open', 'pending', 'resolved') THEN v_meta->>'closed_from' ELSE 'open' END;
  v_prev := CASE WHEN jsonb_typeof(v_meta->'closed_prev_stamps') = 'object' THEN v_meta->'closed_prev_stamps' ELSE '{}'::jsonb END;
  IF coalesce(v_meta->>'closed_line_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_line := (v_meta->>'closed_line_id')::uuid;
  END IF;

  UPDATE public.conversations cv
     SET status = v_restored::public.conversation_status,
         updated_at = now(),
         metadata = (coalesce(cv.metadata, '{}'::jsonb)
                      - 'closed_reason' - 'closed_by' - 'closed_at' - 'closed_from' - 'closed_source'
                      - 'closed_idle_hours' - 'closed_last_exchange_at' - 'closed_outcome' - 'closed_line_id'
                      - 'closed_prev_stamps' - 'routing_thread_ended_at' - 'ai_thread_reset_at')
           -- The stamps as they were before the close (a null removes the key).
           || jsonb_strip_nulls(jsonb_build_object(
                'routing_thread_ended_at', v_prev->'routing_thread_ended_at',
                'ai_thread_reset_at', v_prev->'ai_thread_reset_at'))
           || jsonb_build_object('idle_close_undone_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   WHERE cv.id = p_conversation_id
  RETURNING cv.updated_at INTO v_updated;

  IF v_line IS NOT NULL THEN
    UPDATE public.conversation_messages m
       SET metadata = coalesce(m.metadata, '{}'::jsonb) || '{"internal": true}'::jsonb
     WHERE m.id = v_line AND m.conversation_id = p_conversation_id;
  END IF;

  INSERT INTO public.conversation_events (workspace_id, conversation_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_ws, p_conversation_id, 'reopened', 'visitor', NULL,
    jsonb_build_object('from', 'closed', 'to', v_restored, 'reason', 'customer_replied_after_inactivity_close',
                       'message_id', p_message_id)
  )
  RETURNING id, created_at INTO v_event, v_event_at;

  RETURN QUERY SELECT v_restored, v_updated, v_event, v_event_at, v_line;
END;
$fn_reopen_idle$;

COMMENT ON FUNCTION public.conversation_reopen_after_idle_close(uuid, uuid, uuid, integer) IS
  'A visitor message that raced an inactivity close (within p_grace_seconds, at most 600) puts that conversation back as it was before the close and retracts the closed line it inserted; restored_status NULL otherwise. Server-only. Migration 284.';

-- ─── 5. The scan's index (built CONCURRENTLY beforehand on a live database) ─
DO $$
BEGIN
  IF to_regclass('public.conversations_live_updated_idx') IS NULL THEN
    CREATE INDEX conversations_live_updated_idx ON public.conversations (updated_at)
      WHERE status IN ('open', 'pending', 'resolved') AND is_spam = false;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid = 'public.conversations_live_updated_idx'::regclass AND indisvalid
  ) THEN
    RAISE EXCEPTION '284: conversations_live_updated_idx is invalid (an interrupted CREATE INDEX CONCURRENTLY); DROP INDEX CONCURRENTLY public.conversations_live_updated_idx, build it again, then run this file';
  END IF;
END $$;

-- ─── 7. The Resolved tab's count for an operator ───────────────────────────
-- 241's function, the one change being mine_resolved's AI filter (the
-- tab_resolved_all count beside it, and the list, already had it).
CREATE OR REPLACE FUNCTION public.conversation_inbox_counters(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_sees_all     boolean
) RETURNS TABLE (
  inbox_main        bigint,
  inbox_automated   bigint,
  inbox_needs_human bigint,
  inbox_spam        bigint,
  tab_open          bigint,
  tab_pending       bigint,
  tab_resolved      bigint,
  tab_all           bigint,
  tab_needs_human   bigint,
  tab_automated     bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_inbox_counters$
  WITH scoped AS (
    SELECT c.id, c.status::text AS status, c.ai_state, c.is_spam, c.assigned_to
      FROM public.conversations c
     WHERE c.workspace_id = p_workspace_id
       AND (p_sees_all OR c.assigned_to IS NULL OR c.assigned_to = p_user_id)
  ),
  agg AS (
    SELECT
      count(*) FILTER (WHERE NOT is_spam AND status <> 'closed'
                         AND (ai_state IS NULL OR ai_state <> 'ai_managed'))            AS inbox_main,
      count(*) FILTER (WHERE NOT is_spam AND status <> 'closed'
                         AND ai_state = 'ai_managed' AND assigned_to IS NULL)            AS inbox_automated,
      count(*) FILTER (WHERE NOT is_spam AND status <> 'closed'
                         AND ai_state = 'needs_human')                                   AS inbox_needs_human,
      count(*) FILTER (WHERE is_spam)                                                    AS inbox_spam,
      count(*) FILTER (WHERE NOT is_spam AND (ai_state IS NULL OR ai_state <> 'ai_managed')
                         AND status = 'open')                                            AS tab_open,
      count(*) FILTER (WHERE NOT is_spam AND (ai_state IS NULL OR ai_state <> 'ai_managed')
                         AND status = 'pending')                                         AS tab_pending,
      count(*) FILTER (WHERE NOT is_spam AND (ai_state IS NULL OR ai_state <> 'ai_managed')
                         AND status IN ('resolved', 'closed'))                           AS tab_resolved_all,
      count(*) FILTER (WHERE NOT is_spam AND (ai_state IS NULL OR ai_state <> 'ai_managed')) AS tab_all,
      count(*) FILTER (WHERE NOT is_spam AND ai_state = 'needs_human')                   AS tab_needs_human,
      count(*) FILTER (WHERE NOT is_spam AND ai_state = 'ai_managed'
                         AND status <> 'closed' AND assigned_to IS NULL)                 AS tab_automated
    FROM scoped
  ),
  mine_resolved AS (
    -- Only evaluated for a scoped operator with something in the tab.
    SELECT count(*) AS n
      FROM scoped s, agg
     WHERE NOT p_sees_all
       AND agg.tab_resolved_all > 0
       AND NOT s.is_spam
       AND (s.ai_state IS NULL OR s.ai_state <> 'ai_managed')
       AND s.status IN ('resolved', 'closed')
       AND (s.assigned_to IS NULL OR s.assigned_to = p_user_id)
       AND (
         NOT EXISTS (SELECT 1 FROM public.conversation_messages m
                      WHERE m.conversation_id = s.id AND m.sender_type = 'agent'
                        AND m.sender_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.conversation_messages m
                     WHERE m.conversation_id = s.id AND m.sender_type = 'agent'
                       AND m.sender_id = p_user_id)
       )
  )
  SELECT agg.inbox_main, agg.inbox_automated, agg.inbox_needs_human, agg.inbox_spam,
         agg.tab_open, agg.tab_pending,
         CASE WHEN p_sees_all OR agg.tab_resolved_all = 0 THEN agg.tab_resolved_all
              ELSE (SELECT n FROM mine_resolved) END,
         agg.tab_all, agg.tab_needs_human, agg.tab_automated
    FROM agg;
$fn_inbox_counters$;

-- ─── Access: the backend (service_role) only ──────────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.conversation_message_turn(text, text, jsonb)',
    'public.conversation_idle_check(uuid)',
    'public.conversation_idle_due(integer)',
    'public.conversation_close_if_idle(uuid, timestamptz, text, text, jsonb)',
    'public.conversation_reopen_after_idle_close(uuid, uuid, uuid, integer)',
    'public.conversation_inbox_counters(uuid, uuid, boolean)'
  ] LOOP
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
  END LOOP;
END $acl$;

RESET lock_timeout;
