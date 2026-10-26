-- 286 — A quiet conversation of every chat channel closes by itself (owner,
-- 2026-10-26: "extend the automatic close everywhere, precisely and
-- completely"). 284 closed the website widget's only:
-- conversation_idle_check() read 'not_widget' for any other channel and for
-- platform support, and conversation_idle_due() scanned widget rows only. Now
-- the same close covers the widget, Telegram, Bale, WhatsApp, Instagram, X
-- and the platform support threads (both kinds: the chat and the old
-- tickets), with the same window (the conversation's workspace's
-- widget_settings.inactivity_close_hours, else the Super Admin's
-- inactivity_close_default_hours; 1–48 h), the same switch and the same
-- guards: never while the team owes an answer, never spam, never the App
-- Review account. The e-mail inbox (Gmail, Yahoo) holds no conversation
-- (email_threads, which has no status; migration 163): nothing here touches it.
--
-- Silent on every channel but the widget (owner): the ticker writes the
-- closed line for a widget conversation only (conversationClosedNotice.ts
-- prepareClosedLine), so nothing is sent to a Telegram, Bale, WhatsApp,
-- Instagram or X customer and nothing is written into their conversation;
-- their next message starts a new one (ensure_active_conversation never
-- matches a closed conversation). The widget keeps «گفتگو به پایان رسید» and
-- its rating card; the support apps draw their own end and rating from the
-- thread's status.
--
--   1. conversation_message_turn(): 284's, word for word, but a message with
--      an empty body whose metadata.attachments is a non-empty array (a
--      channel's photo, voice note, document or sticker without a caption,
--      Instagram's or X's media) has content, as one with an attachment_id
--      always had: the customer's is a visitor turn, the team's an answer.
--      284 read it as transparent, so an unanswered voice note did not hold
--      the close back. server/services/needsReply.ts changes with it (the
--      Inbox's Needs Reply badge is the same rule);
--      src/test/integration/conversationIdleClose286.pg.test.ts runs the same
--      generated fixtures, the attachments ones too, through both.
--   2. conversation_idle_check(): 285's, word for word, but without the
--      channel and platform-support test, and the App Review account's
--      verdict is 'exempt' ('not_widget' named another channel; no function
--      returns it any more). Exempt: the demo's seeded threads
--      (metadata.app_review_seed), every conversation of the ws_appreview
--      workspace (285), and now a platform support thread that account opens:
--      its requester (platform_support_threads.user_id) is the profile
--      apple@webyar.ai, or it was opened from the ws_appreview workspace
--      (source_workspace_id). A support thread lives in the support
--      workspace, so 285's workspace test does not see it.
--   3. conversation_idle_due(): 284's, but without the widget-only channel
--      filter (the App Review seed's filter, the 1-hour and 30-day bounds, the
--      switch and the 'due' verdict stay).
--
-- A resolved support thread closes too, as a resolved widget conversation
-- does (its requester's apps still show it as resolved: the support service
-- presents a thread closed for quiet from 'resolved' as resolved). A customer
-- message that races the close (a channel's message waits in a queue first)
-- brings that conversation back through 284's
-- conversation_reopen_after_idle_close(), which works on any channel:
-- channel inbound and the support writes call it with a grace of 600 s, the
-- most the function allows (shared/inactivityClose.ts).
-- conversation_close_if_idle() (it takes the decision from
-- conversation_idle_check), that reopen and the scan's index
-- (conversations_live_updated_idx, on status and spam only) stay 284's.
--
-- No new gate: the Super Admin's switch stays the only off. Where it is on
-- (WebYar and RESPOK), the timer's next passes close what this makes due, 50
-- a pass, rows touched in the last 30 days only; one untouched for longer is
-- the hand-run backlog's (database/backfill/284_inactivity_backlog_close.sql,
-- channel-neutral since this file). The owner saw the counts first
-- (2026-10-26, a rolled-back dry run: 6 on WebYar, none on RESPOK;
-- docs/operations/CHAT_ROUTING.md, "Rollout of 286").
--
-- Applied by hand on WebYar shortly before the merge (CLAUDE.md, Migrations),
-- by its migrator on RESPOK. The code merged with it calls 284's functions
-- only and works on 285, so the order is free; the cost of this one is one
-- deploy round (about 15 minutes) in which the old backend's timer already
-- closes what this makes due, silently as the new one does, but without the
-- race reopen on channels and support and without support_update, and a
-- resolved support thread it closes reads 'closed' in the support apps until
-- the new backend presents it as resolved (docs/operations/CHAT_ROUTING.md,
-- "Rollout of 286"). RESPOK has no conversation outside the widget, so
-- nothing more closes there. CREATE OR REPLACE keeps the functions' owner and
-- grants; they are set again below anyway (service_role only), as 284 sets
-- them. Like 284 and 285, it sets lock_timeout 5s itself (a function replace
-- waits on no table, but a hand-run without PGOPTIONS must not queue behind
-- one). Safe to run twice; it needs 285. It writes no data: no row is
-- changed, nothing is dropped or deleted. Dry run: the file inside
-- BEGIN … ROLLBACK (conversation_idle_due(500) inside it lists what becomes
-- due).

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.conversation_idle_check(uuid)') IS NULL
     OR position('ws_appreview' in pg_get_functiondef(to_regprocedure('public.conversation_idle_check(uuid)'))) = 0 THEN
    RAISE EXCEPTION '286 needs 285 (public.conversation_idle_check(uuid) is missing, or is 284''s)';
  END IF;
END $guard$;

-- needsReply.ts in SQL: 'visitor' for an actionable customer turn
-- (isActionableCustomerTurn), 'team' for a qualified customer-facing answer
-- of a person or the AI (isQualifiedCustomerFacingAnswer), NULL for
-- everything the Inbox treats as transparent (system rows, routing notices,
-- menu taps, bot output, provider echoes, empty rows, skipped or failed
-- deliveries, the AI's hand-over line). An empty body is content when the
-- message carries a file (attachment_id) or a channel's media
-- (metadata.attachments, a non-empty array: 286). The whitespace is
-- JavaScript's trim() set. src/test/integration/conversationIdleClose286.pg.test.ts
-- runs the same generated fixtures through both.
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
         AND coalesce(p_metadata->'attachment_id', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
         -- A channel's media (286): metadata.attachments, a non-empty array.
         AND NOT (jsonb_typeof(p_metadata->'attachments') IS NOT DISTINCT FROM 'array'
                  AND p_metadata->'attachments' <> '[]'::jsonb) THEN NULL
    WHEN p_sender_type = 'contact' THEN
      CASE WHEN p_metadata->'provider_echo' = 'true'::jsonb THEN NULL ELSE 'visitor' END
    WHEN coalesce(p_metadata->>'channel_delivery_skip', '') = 'true' THEN NULL
    WHEN coalesce(p_metadata->>'channel_delivery', '') = 'failed' THEN NULL
    WHEN p_sender_type = 'ai' AND p_metadata->'handoff' IN ('true'::jsonb, '"true"'::jsonb) THEN NULL
    ELSE 'team'
  END
$fn_turn$;

COMMENT ON FUNCTION public.conversation_message_turn(text, text, jsonb) IS
  'needsReply.ts in SQL: ''visitor'' (an actionable customer turn), ''team'' (a qualified answer of a person or the AI) or NULL (transparent). An empty body with a file (attachment_id) or a channel''s media (metadata.attachments, a non-empty array) has content. Migrations 284, 286.';

-- The whole decision for one conversation, of any chat channel. verdict, the
-- first that applies:
--   'not_found' | 'not_live' (closed) | 'spam' | 'exempt' (the App Review
--   account, apple@webyar.ai: the demo's seeded threads, any conversation of
--   its workspace ws_appreview, the platform support threads it opens; kept
--   as the reviewer sees them);
--   'recent'       the last exchange (the newest visitor turn, person's
--                  answer or AI answer, or a connected call's end — now while
--                  the 'call' guard believes it live; with none, created_at)
--                  is inside the workspace's window;
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
  -- The App Review demo (migrations 248/249): the workspace Apple's reviewers
  -- sign in to (slug ws_appreview, the account apple@webyar.ai) is never
  -- closed for quiet (owner, 2026-10-26): neither its seeded threads (dated
  -- by their messages, some already past any window when seeded, and kept
  -- in their queues for the reviewer) nor a conversation started there
  -- since, which carries no app_review_seed mark, nor a platform support
  -- thread that account opens (286): it lives in the support workspace, so
  -- it is known by its requester or by the workspace it was opened from.
  IF c.metadata->>'app_review_seed' = 'true'
     OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = c.workspace_id AND w.slug = 'ws_appreview')
     OR EXISTS (
       SELECT 1 FROM public.platform_support_threads p
        WHERE p.conversation_id = c.id
          AND (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p.user_id AND lower(pr.email) = 'apple@webyar.ai')
               OR EXISTS (SELECT 1 FROM public.workspaces sw WHERE sw.id = p.source_workspace_id AND sw.slug = 'ws_appreview'))
     ) THEN
    RETURN QUERY SELECT 'exempt'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text;
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
  'Whether a conversation of any chat channel (the website widget, Telegram, Bale, WhatsApp, Instagram, X, platform support) is due for the inactivity close (verdict ''due''), or why not: not live, spam, exempt (the App Review account apple@webyar.ai: the ws_appreview workspace, its seeded threads and any conversation started there, the platform support threads it opens; migrations 285, 286), an exchange within the window, or something the team owes (needs_reply, ai_handoff, routing, call, callback, guidance). Server-only. Migrations 284, 285, 286.';

-- The ticker's work list: at most p_limit conversations due now, of every
-- chat channel, the longest untouched first. Nothing while the Super Admin's
-- switch is off (or the platform row is unreadable). updated_at (every
-- exchange path touches it) narrows the scan to the partial index's live
-- rows untouched for at least an hour (the index range) and for the
-- workspace's window, and touched in the last 30 days: a row nobody touched
-- for longer is the backlog, closed by hand and silently
-- (database/backfill/284_inactivity_backlog_close.sql), never by a pass that
-- writes visitor lines. The App Review demo's seeded threads are left out of
-- the scan. The decision itself is conversation_idle_check, and the LIMIT
-- counts its 'due' rows only, so rows the team owes or that are exempt never
-- use up the batch.
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
     AND coalesce(c.metadata->>'app_review_seed', '') <> 'true'
     AND chk.verdict = 'due'
   ORDER BY c.updated_at
   LIMIT v_limit;
END;
$fn_idle_due$;

COMMENT ON FUNCTION public.conversation_idle_due(integer) IS
  'The inactivity ticker''s work list: conversations of every chat channel due for the close (conversation_idle_check), longest untouched first, the LIMIT counting due rows only; none while widget_platform_settings.inactivity_close_enabled is off; never one untouched for 30 days (the hand-run backlog close). Server-only. Migrations 284, 286.';

COMMENT ON COLUMN public.widget_settings.inactivity_close_hours IS
  'Hours (1–48) a conversation of this workspace on any chat channel (the website widget, Telegram, Bale, WhatsApp, Instagram, X; platform support in the support workspace) may go without an exchange (the customer, the team, the AI, a connected call) before the system closes it; NULL = widget_platform_settings.inactivity_close_default_hours. Never closes what the team still owes (conversation_idle_check). Not the e-mail inbox. Migrations 284, 286.';
COMMENT ON COLUMN public.widget_platform_settings.inactivity_close_enabled IS
  'Super Admin switch: the conversations of every chat channel (the website widget, Telegram, Bale, WhatsApp, Instagram, X, platform support; not the e-mail inbox) close by themselves after their workspace''s inactivity window (conversation_idle_due, conversation_close_if_idle read it). Off = the timer closes nothing anywhere. Migrations 284, 286.';

-- ─── Access: the backend (service_role) only, as 284 ──────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.conversation_message_turn(text, text, jsonb)',
    'public.conversation_idle_check(uuid)',
    'public.conversation_idle_due(integer)'
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
