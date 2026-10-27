-- 287 — A pre-chat wait counts only while nobody holds the conversation
-- (owner, 2026-10-27: «درست کن»). 286's conversation_idle_check() read
-- metadata.routing_pending as "the team still owes routing" whoever held the
-- conversation, and the flag outlived the wait whenever a person answered
-- first: a widget conversation whose visitor's first message waits for the
-- pre-chat form is flagged (chatRoutingPrechat.ts deferRoutingForPrechat:
-- routing_pending, routing_pending_at, and a deadline in chat_routing_state);
-- an operator who answers before routing runs takes it with that reply
-- (conversations.ts claimUnassigned, which wrote assigned_to only); then
-- every later routing run stops at "already assigned" before the line that
-- clears the flag (chatRouting.ts routeConversationToOperator), the
-- visitor's next message stops at "the assignee keeps it"
-- (routeHumanBoundConversation), and the ticker's pre-chat deadline routes
-- unassigned rows only (278's chat_routing_due). So the flag stayed 'true'
-- for good on a conversation a person holds, which read 'routing' once its
-- operator had answered and was never closed for quiet. On WebYar
-- (2026-10-27) 2 open conversations carry it, both assigned; neither is held
-- back by it yet, as both read needs_reply.
--
-- conversation_idle_check() is 286's, word for word, but for that one
-- condition (and the two comment lines above it): routing_pending counts only
-- while the conversation has no assignee (c.assigned_to IS NULL). The
-- needs_reply check above it already decides whether the visitor waits for
-- an answer: an open conversation whose visitor's turn is the newest, with no
-- answer and no call connected after it, reads needs_reply first, held or
-- not. A held one that is past that check was answered (by its person, the
-- AI or a connected call), or parked (pending, which the customer's next
-- message reopens) or resolved by the team, so nothing is left to route and
-- the wait is over. Unassigned, the flag still reads 'routing' (routing has
-- given it to nobody yet). Nothing else changes: 286's other routing conditions
-- already end on a held conversation (the manual queue counts only while
-- unassigned; chat_routing_due() forgets a waiting_since once somebody has
-- it and spends a prechat_deadline when it falls due, two minutes on; a
-- timeout_due_at is the assignee's own first-response timeout, owed until
-- they write), and conversation_idle_due(), conversation_close_if_idle() and
-- the backlog script (database/backfill/284_inactivity_backlog_close.sql)
-- take their decision from this function, so they follow unchanged. The code
-- merged with it also clears the flag when the wait ends with a person
-- taking the conversation: the first reply's claim and the visitor
-- outreach's (conversations.ts claimUnassigned), the Claim button (POST
-- /:id/claim) and a routing run that finds it assigned (the form sent after
-- the claim). An assignment by hand (PATCH), a transfer or a take-over leave
-- the flag, as does a claim that races the wait's own start; this file is
-- what makes those harmless for the close, and what lets the conversations
-- flagged before it close.
--
-- Applied by hand on WebYar BEFORE the merge (CLAUDE.md, Migrations;
-- docs/operations/CHAT_ROUTING.md, "Rollout of 287"): the backend does not
-- need 287 and 287 needs no new backend (the timer closes through the same
-- functions either way). By its migrator on RESPOK, on push. It closes
-- nothing at once on WebYar: there (2026-10-27) the 2 flagged conversations
-- read needs_reply, and once their operator answers they close after the
-- window, as any other. RESPOK's migrator does not wait for anyone, so the
-- same dry run (inside BEGIN … ROLLBACK, the verdicts of every live row
-- carrying routing_pending, before and with 287) runs there too before the
-- merge, and a held row it would make due goes to the owner first.
--
-- CREATE OR REPLACE keeps the function's owner and grants; they are set again
-- below anyway (service_role only), as 284 to 286 set them. Like 284 to 286,
-- it sets lock_timeout 5s itself (a function replace waits on no table, but a
-- hand-run without PGOPTIONS must not queue behind one). Safe to run twice;
-- it needs 286. It writes no data: no row is changed, nothing is dropped or
-- deleted.

SET lock_timeout = '5s';

-- 286's conversation_idle_check() names the App Review verdict 'exempt';
-- 284's and 285's read 'not_widget' there.
DO $guard$
BEGIN
  IF to_regprocedure('public.conversation_idle_check(uuid)') IS NULL
     OR position('''exempt''::text' in pg_get_functiondef(to_regprocedure('public.conversation_idle_check(uuid)'))) = 0 THEN
    RAISE EXCEPTION '287 needs 286 (public.conversation_idle_check(uuid) is missing, or is 284''s or 285''s)';
  END IF;
END $guard$;

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
--                  requested), 'routing' (routing_pending while nobody holds
--                  the conversation (287), the manual queue, a routing wait,
--                  a pre-chat deadline, a first-response timeout), 'call' (a
--                  call ringing or live in the last 12 h, an invitation or a
--                  queue entry still open), 'callback' (a callback request
--                  still open), 'guidance' (the AI asked the team and waits);
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
  -- A pre-chat wait counts only while nobody holds the conversation (287):
  -- once a person has it, routing has nothing left to do.
  IF (c.metadata->>'routing_pending' = 'true' AND c.assigned_to IS NULL)
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
  'Whether a conversation of any chat channel (the website widget, Telegram, Bale, WhatsApp, Instagram, X, platform support) is due for the inactivity close (verdict ''due''), or why not: not live, spam, exempt (the App Review account apple@webyar.ai: the ws_appreview workspace, its seeded threads and any conversation started there, the platform support threads it opens; migrations 285, 286), an exchange within the window, or something the team owes (needs_reply, ai_handoff, routing, call, callback, guidance; a pre-chat wait counts as routing only while nobody holds the conversation, migration 287). Server-only. Migrations 284, 285, 286, 287.';

-- ─── Access: the backend (service_role) only, as 284 ──────────────────────
REVOKE ALL ON FUNCTION public.conversation_idle_check(uuid) FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.conversation_idle_check(uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.conversation_idle_check(uuid) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.conversation_idle_check(uuid) TO service_role;
  END IF;
END $acl$;

RESET lock_timeout;
