-- 285 — The App Review workspace is never closed for quiet (owner,
-- 2026-10-26: "the account apple@webyar.ai is Apple's test and must not be
-- closed"). 284 left out only the demo's seeded threads
-- (metadata.app_review_seed); a conversation started in that workspace since
-- (the reviewer trying the widget, a colleague's test) carried no mark, so
-- the timer would have closed it after the workspace's window. Now the
-- whole workspace (slug ws_appreview, migrations 248/249) reads 'not_widget'
-- in conversation_idle_check(), which the ticker's work list
-- (conversation_idle_due), the close itself (conversation_close_if_idle,
-- which takes the decision again) and the hand-run backlog close
-- (database/backfill/284_inactivity_backlog_close.sql) all go by.
--
-- The function is 284's, word for word, but for that one condition. CREATE
-- OR REPLACE keeps its owner and grants; they are set again below anyway
-- (service_role only), as 284 sets them. Safe to run twice; it needs 284.
-- Like 284, it sets lock_timeout 5s itself (a function replace waits on no
-- table, but a hand-run without PGOPTIONS must not queue behind one).

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.conversation_idle_check(uuid)') IS NULL THEN
    RAISE EXCEPTION '285 needs 284 (public.conversation_idle_check(uuid) is missing)';
  END IF;
END $guard$;

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
  -- The App Review demo (migrations 248/249): the workspace Apple's reviewers
  -- sign in to (slug ws_appreview, the account apple@webyar.ai) is never
  -- closed for quiet (owner, 2026-10-26): neither its seeded threads (dated
  -- by their messages, some already past any window when seeded, and kept
  -- in their queues for the reviewer) nor a conversation started there
  -- since, which carries no app_review_seed mark.
  IF c.metadata->>'app_review_seed' = 'true'
     OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = c.workspace_id AND w.slug = 'ws_appreview') THEN
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
  'Whether a widget conversation is due for the inactivity close (verdict ''due''), or why not: not live, spam, not a widget one (or the App Review workspace, ws_appreview: its seeded threads and any conversation started there; migration 285), an exchange within the window, or something the team owes (needs_reply, ai_handoff, routing, call, callback, guidance). Server-only. Migrations 284, 285.';

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
