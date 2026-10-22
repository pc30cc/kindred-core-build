-- 278 — Chat routing: every conversation a person has to answer gets an
-- operator (owner decisions of 2026-10-21, DECISIONS §3 and §4; audit
-- findings R-01, R-05, R-11, R-12, R-18, R-19, R-24, R-28).
--
-- 1. workspace_members.receives_chats (default true): the member's "Receive
--    chats automatically" switch. Off: routing never picks them (they still
--    answer by hand), and the widget's online/offline does not count them.
--    workspace_members.max_concurrent_chats (1–50, NULL = the workspace
--    default): a member holding that many open or pending conversations is
--    skipped.
-- 2. widget_settings, per workspace:
--      last_agent_routing_enabled (default true) and last_agent_window_days
--      (1–365, default 30): a returning visitor goes back to the operator of
--      their previous conversation of the last N days when that operator can
--      take a chat right now;
--      default_max_concurrent_chats (1–50, default 5);
--      first_response_timeout_minutes (0–60, default 5, 0 = off): a chat
--      routing gave to someone who has not written in it that long goes to
--      the next operator (nobody free: it leaves them and waits for one).
-- 3. chat_routing_cursors: one round-robin cursor per pool (the whole team,
--    or one department), in place of widget_settings.round_robin_cursor_user_id
--    (kept, no longer read). chat_routing_members: when routing last gave each
--    member a conversation (the "least busy" tie-break).
-- 4. chat_routing_state: per conversation, what the routing ticker
--    (server/services/chatRoutingTicker.ts) still has to do — a chat waiting
--    for an operator (auto or round robin found nobody: nobody online, or
--    everyone at capacity), a pre-chat deferral's deadline (routed anyway two
--    minutes later), the last automatic assignment with the time its
--    first-response timeout falls due, and the members a timeout already
--    passed over for this chat.
-- 5. chat_route_claim(): the one place routing assigns a conversation. Under
--    a per-workspace advisory lock, so chats routed at the same instant see
--    each other's assignment: it counts each candidate's current load (open
--    and pending, non-spam conversations assigned to them) against their
--    capacity, picks by the requested order (least busy, ties to whoever was
--    given one least recently; round robin, continuing after the pool's
--    cursor; or the caller's order), and assigns only while the conversation
--    is still unassigned (or, for a timeout, still held by the expected
--    member). chat_routing_wait() and chat_routing_defer_prechat() record a
--    wait and a pre-chat deadline; chat_routing_release() takes a timed-out
--    chat from its silent assignee when nobody can take it over;
--    chat_routing_due() hands the ticker what has fallen due and forgets
--    what no longer applies.
-- 6. Two partial indexes on conversations: the load count
--    (conversations_open_assignee_idx) and a contact's latest conversations
--    (conversations_contact_recent_idx, for the returning visitor's operator).
--
-- Every new table is server-only: RLS on, nothing for PUBLIC, anon or
-- authenticated, service_role alone through its policy. The functions are
-- SECURITY INVOKER with a pinned search_path, executable by service_role
-- only.
--
-- The two indexes: on a live database build them by hand FIRST, outside a
-- transaction (a plain build blocks writes to conversations for its whole
-- run); this file then finds them and builds nothing:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_open_assignee_idx
--     ON public.conversations (workspace_id, assigned_to)
--     WHERE assigned_to IS NOT NULL AND status IN ('open', 'pending') AND is_spam = false;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_contact_recent_idx
--     ON public.conversations (workspace_id, contact_id, updated_at DESC)
--     WHERE contact_id IS NOT NULL;
-- An interrupted CONCURRENTLY build leaves an invalid index of that name: the
-- file then stops and says so (drop it with DROP INDEX CONCURRENTLY and build
-- it again).
--
-- Locks: the new columns take ACCESS EXCLUSIVE on workspace_members and
-- widget_settings for an instant (constant defaults: no rewrite); their
-- checks are added NOT VALID and validated by their own statements (SHARE
-- UPDATE EXCLUSIVE: reads and writes go on). The new tables' foreign keys
-- take SHARE ROW EXCLUSIVE on workspaces and conversations for an instant;
-- the two indexes SHARE on conversations (writes wait) while they are built,
-- unless they were built beforehand as above. Re-runnable: every step is
-- guarded or a no-op the second time.
-- The file sets lock_timeout 5s itself (not one transaction, so for the
-- session, reset at the end): a runner without PGOPTIONS, such as RESPOK's
-- migrator, must not leave every chat write queued behind a lock that waits
-- for an open transaction. A statement stopped by it is simply run again.
-- Dry run: the file inside BEGIN … ROLLBACK. Changes no existing value (the
-- new columns read their defaults); drops nothing; touches no archive schema
-- or table.

SET lock_timeout = '5s';

-- ─── 1. Per member ─────────────────────────────────────────────────────────
ALTER TABLE public.workspace_members
  ADD COLUMN IF NOT EXISTS receives_chats boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_concurrent_chats integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workspace_members_max_concurrent_chats_check'
       AND conrelid = 'public.workspace_members'::regclass
  ) THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_max_concurrent_chats_check
        CHECK (max_concurrent_chats IS NULL OR max_concurrent_chats BETWEEN 1 AND 50) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workspace_members_max_concurrent_chats_check'
       AND conrelid = 'public.workspace_members'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.workspace_members VALIDATE CONSTRAINT workspace_members_max_concurrent_chats_check;
  END IF;
END $$;

COMMENT ON COLUMN public.workspace_members.receives_chats IS
  'Receive chats automatically: false = chat routing never assigns this member a conversation, and the widget''s online/offline does not count them. Migration 278.';
COMMENT ON COLUMN public.workspace_members.max_concurrent_chats IS
  'At most this many open or pending conversations assigned by routing at once (1–50); NULL = widget_settings.default_max_concurrent_chats. Migration 278.';

-- ─── 2. Per workspace ──────────────────────────────────────────────────────
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS last_agent_routing_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_agent_window_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS default_max_concurrent_chats integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS first_response_timeout_minutes integer NOT NULL DEFAULT 5;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('widget_settings_last_agent_window_days_check', 'last_agent_window_days BETWEEN 1 AND 365'),
      ('widget_settings_default_max_concurrent_chats_check', 'default_max_concurrent_chats BETWEEN 1 AND 50'),
      ('widget_settings_first_response_timeout_minutes_check', 'first_response_timeout_minutes BETWEEN 0 AND 60')
    ) AS v(name, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = c.name AND conrelid = 'public.widget_settings'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE public.widget_settings ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.name, c.expr);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.widget_settings'::regclass
       AND conname IN ('widget_settings_last_agent_window_days_check',
                       'widget_settings_default_max_concurrent_chats_check',
                       'widget_settings_first_response_timeout_minutes_check')
       AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE public.widget_settings VALIDATE CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

COMMENT ON COLUMN public.widget_settings.last_agent_routing_enabled IS
  'Return returning visitors to the same operator: a new conversation goes first to the operator of the contact''s previous conversation (last_agent_window_days) when they can take it now. Super Admin → Advanced routing can switch it off for every workspace. Migration 278.';
COMMENT ON COLUMN public.widget_settings.last_agent_window_days IS
  'How far back (days, 1–365) the contact''s previous conversation may be for last-agent routing. Migration 278.';
COMMENT ON COLUMN public.widget_settings.default_max_concurrent_chats IS
  'Chats an operator may hold at once (open + pending, 1–50) unless their own max_concurrent_chats says otherwise. Migration 278.';
COMMENT ON COLUMN public.widget_settings.first_response_timeout_minutes IS
  'Minutes (0–60, 0 = off) an operator routing assigned a chat to has to write in it before it goes to the next operator. Migration 278.';

-- ─── 3. Cursors and member stats ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_routing_cursors (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pool_key     text NOT NULL,
  last_user_id uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_key),
  CONSTRAINT chat_routing_cursors_pool_key_check CHECK (length(pool_key) BETWEEN 1 AND 64)
);

COMMENT ON TABLE public.chat_routing_cursors IS
  'Round-robin chat routing: per workspace and pool (''team'', or a department id), the member the last rotation picked. Written by chat_route_claim(). Server-only. Migration 278.';

CREATE TABLE IF NOT EXISTS public.chat_routing_members (
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  last_assigned_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

COMMENT ON TABLE public.chat_routing_members IS
  'When chat routing last assigned each member a conversation (least-busy tie-break: the one given a chat least recently first). Written by chat_route_claim(). Server-only. Migration 278.';

-- ─── 4. What the ticker still has to do ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_routing_state (
  conversation_id  uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  waiting_since    timestamptz,
  wait_reason      text,
  waiting_retry_at timestamptz,
  waiting_active_at timestamptz,
  prechat_deadline timestamptz,
  assigned_to      uuid,
  assigned_at      timestamptz,
  assign_method    text,
  timeout_due_at   timestamptz,
  skip_user_ids    uuid[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_routing_state_wait_reason_check CHECK (wait_reason IS NULL OR wait_reason IN ('nobody_online', 'all_busy')),
  CONSTRAINT chat_routing_state_skip_check CHECK (cardinality(skip_user_ids) <= 50)
);

COMMENT ON TABLE public.chat_routing_state IS
  'Per conversation, the chat routing ticker''s work: waiting_since (no operator could take it; retried from waiting_retry_at; waiting_active_at = the last attempt that was not the ticker''s own, a wait idle for a day is forgotten), prechat_deadline (routing waited for the pre-chat form; route anyway from then), the last automatic assignment (assigned_to, assigned_at, assign_method) with its first-response timeout (timeout_due_at), and skip_user_ids (members a timeout passed over). Server-only. Migration 278.';

CREATE INDEX IF NOT EXISTS chat_routing_state_waiting_idx
  ON public.chat_routing_state (waiting_since) WHERE waiting_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_routing_state_prechat_idx
  ON public.chat_routing_state (prechat_deadline) WHERE prechat_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_routing_state_timeout_idx
  ON public.chat_routing_state (timeout_due_at) WHERE timeout_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_routing_state_workspace_idx
  ON public.chat_routing_state (workspace_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_routing_cursors', 'chat_routing_members', 'chat_routing_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'service_role_only'
      ) THEN
        EXECUTE format('CREATE POLICY service_role_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ─── 5. The functions ──────────────────────────────────────────────────────

-- Pick and assign, atomically per workspace. p_candidates: the members the
-- caller found routable and present for this pool, in its preferred order
-- (only members of the workspace who are not suspended and receive chats
-- are considered here again; a member a timeout passed over for this chat,
-- and p_expected_assignee, never). p_order: 'least_busy' (fewest open +
-- pending, then the one routing gave a chat least recently, then the given
-- order), 'round_robin' (the next id after the pool's cursor, wrapping
-- round; the cursor moves to the pick) or 'given' (the given order). A
-- candidate at capacity is skipped. p_expected_assignee: NULL = assign only
-- an unassigned conversation; a user id = reassign only while that member
-- still holds it (a first-response timeout), who then joins skip_user_ids.
-- outcome: 'assigned' (picked_user_id), 'already_assigned' / 'assignment_changed'
-- (picked_user_id = the holder), 'all_busy' (every candidate at capacity),
-- 'none' (no candidate left), 'not_routable' (closed, resolved or spam),
-- 'not_found'.
CREATE OR REPLACE FUNCTION public.chat_route_claim(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_candidates uuid[],
  p_order text,
  p_pool_key text,
  p_method text,
  p_expected_assignee uuid DEFAULT NULL
)
RETURNS TABLE (outcome text, picked_user_id uuid)
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_route_claim$
DECLARE
  v_assigned uuid;
  v_status text;
  v_spam boolean;
  v_default_cap integer;
  v_timeout integer;
  v_skip uuid[];
  v_cursor uuid;
  v_any boolean;
  v_pick uuid;
BEGIN
  IF p_order IS NULL OR p_order NOT IN ('least_busy', 'round_robin', 'given') THEN
    RAISE EXCEPTION 'chat_route_claim: unknown order %', p_order;
  END IF;
  IF p_method IS NULL OR length(p_method) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'chat_route_claim: invalid method';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('chat_route_claim:' || p_workspace_id::text, 0));

  SELECT c.assigned_to, c.status::text, c.is_spam
    INTO v_assigned, v_status, v_spam
    FROM public.conversations c
   WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_status NOT IN ('open', 'pending') OR v_spam THEN
    RETURN QUERY SELECT 'not_routable'::text, v_assigned;
    RETURN;
  END IF;
  IF p_expected_assignee IS NULL AND v_assigned IS NOT NULL THEN
    RETURN QUERY SELECT 'already_assigned'::text, v_assigned;
    RETURN;
  END IF;
  IF p_expected_assignee IS NOT NULL AND v_assigned IS DISTINCT FROM p_expected_assignee THEN
    RETURN QUERY SELECT 'assignment_changed'::text, v_assigned;
    RETURN;
  END IF;

  SELECT w.default_max_concurrent_chats, w.first_response_timeout_minutes
    INTO v_default_cap, v_timeout
    FROM public.widget_settings w
   WHERE w.workspace_id = p_workspace_id;
  v_default_cap := coalesce(v_default_cap, 5);
  v_timeout := coalesce(v_timeout, 5);

  SELECT s.skip_user_ids INTO v_skip
    FROM public.chat_routing_state s
   WHERE s.conversation_id = p_conversation_id;
  v_skip := coalesce(v_skip, '{}'::uuid[]);

  IF p_order = 'round_robin' THEN
    SELECT r.last_user_id INTO v_cursor
      FROM public.chat_routing_cursors r
     WHERE r.workspace_id = p_workspace_id AND r.pool_key = p_pool_key;
  END IF;

  WITH cand AS (
    SELECT DISTINCT ON (u.id) u.id AS user_id, u.ord
      FROM unnest(coalesce(p_candidates, '{}'::uuid[])) WITH ORDINALITY AS u(id, ord)
     WHERE u.id IS NOT NULL
     ORDER BY u.id, u.ord
  ), eligible AS (
    SELECT cand.user_id,
           cand.ord,
           coalesce(m.max_concurrent_chats, v_default_cap) AS cap,
           (SELECT count(*)
              FROM public.conversations c2
             WHERE c2.workspace_id = p_workspace_id
               AND c2.assigned_to = cand.user_id
               AND c2.status IN ('open', 'pending')
               AND c2.is_spam = false) AS open_load,
           rm.last_assigned_at
      FROM cand
      JOIN public.workspace_members m
        ON m.workspace_id = p_workspace_id AND m.user_id = cand.user_id
      LEFT JOIN public.chat_routing_members rm
        ON rm.workspace_id = p_workspace_id AND rm.user_id = cand.user_id
     WHERE m.suspended_at IS NULL
       AND m.receives_chats
       AND NOT (cand.user_id = ANY (v_skip))
       AND cand.user_id IS DISTINCT FROM p_expected_assignee
  )
  SELECT count(*) > 0,
         (array_agg(e.user_id ORDER BY
            CASE WHEN p_order = 'least_busy' THEN e.open_load END,
            CASE WHEN p_order = 'least_busy' THEN e.last_assigned_at END NULLS FIRST,
            CASE WHEN p_order = 'round_robin' THEN v_cursor IS NOT NULL AND e.user_id <= v_cursor END,
            CASE WHEN p_order = 'round_robin' THEN e.user_id END,
            e.ord,
            e.user_id
          ) FILTER (WHERE e.open_load < e.cap))[1]
    INTO v_any, v_pick
    FROM eligible e;

  IF v_pick IS NULL THEN
    RETURN QUERY SELECT (CASE WHEN v_any THEN 'all_busy' ELSE 'none' END)::text, NULL::uuid;
    RETURN;
  END IF;

  UPDATE public.conversations
     SET assigned_to = v_pick, updated_at = now()
   WHERE id = p_conversation_id;

  INSERT INTO public.chat_routing_members (workspace_id, user_id, last_assigned_at)
  VALUES (p_workspace_id, v_pick, now())
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_assigned_at = EXCLUDED.last_assigned_at;

  IF p_order = 'round_robin' THEN
    INSERT INTO public.chat_routing_cursors (workspace_id, pool_key, last_user_id, updated_at)
    VALUES (p_workspace_id, p_pool_key, v_pick, now())
    ON CONFLICT (workspace_id, pool_key) DO UPDATE SET last_user_id = EXCLUDED.last_user_id, updated_at = now();
  END IF;

  INSERT INTO public.chat_routing_state AS s (
    conversation_id, workspace_id, assigned_to, assigned_at, assign_method, timeout_due_at, skip_user_ids, updated_at
  ) VALUES (
    p_conversation_id, p_workspace_id, v_pick, now(), p_method,
    CASE WHEN v_timeout > 0 THEN now() + make_interval(mins => v_timeout) END,
    CASE WHEN p_expected_assignee IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_expected_assignee] END,
    now()
  )
  ON CONFLICT (conversation_id) DO UPDATE SET
    assigned_to = EXCLUDED.assigned_to,
    assigned_at = EXCLUDED.assigned_at,
    assign_method = EXCLUDED.assign_method,
    timeout_due_at = EXCLUDED.timeout_due_at,
    skip_user_ids = CASE
      WHEN p_expected_assignee IS NULL OR p_expected_assignee = ANY (s.skip_user_ids) THEN s.skip_user_ids
      ELSE (s.skip_user_ids || p_expected_assignee)[greatest(1, cardinality(s.skip_user_ids) - 48):]
    END,
    waiting_since = NULL,
    wait_reason = NULL,
    waiting_retry_at = NULL,
    waiting_active_at = NULL,
    prechat_deadline = NULL,
    updated_at = now();

  RETURN QUERY SELECT 'assigned'::text, v_pick;
END;
$fn_route_claim$;

COMMENT ON FUNCTION public.chat_route_claim(uuid, uuid, uuid[], text, text, text, uuid) IS
  'Chat routing''s atomic pick-and-assign under a per-workspace advisory lock: current load against capacity, least busy / round robin / given order, assigns only an unassigned conversation (or one still held by p_expected_assignee). Server-only. Migration 278.';

-- The conversation waits for an operator (routing found nobody): the first
-- wait's start is kept, the reason follows the latest attempt; a pre-chat
-- deadline is spent (routing ran). p_reason NULL: it no longer waits for
-- routing (the workspace queues by hand now). p_from_ticker: the attempt was
-- the ticker's own retry, which leaves the wait's last activity
-- (waiting_active_at) and the retry time chat_routing_due() chose as they
-- are; any other attempt (the visitor wrote, the chat was handed back) is
-- activity, and the next retry comes in 25 seconds.
CREATE OR REPLACE FUNCTION public.chat_routing_wait(p_workspace_id uuid, p_conversation_id uuid, p_reason text, p_from_ticker boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_routing_wait$
BEGIN
  IF p_reason IS NULL THEN
    UPDATE public.chat_routing_state
       SET waiting_since = NULL, wait_reason = NULL, waiting_retry_at = NULL, waiting_active_at = NULL, updated_at = now()
     WHERE conversation_id = p_conversation_id
       AND workspace_id = p_workspace_id
       AND waiting_since IS NOT NULL;
    RETURN;
  END IF;
  INSERT INTO public.chat_routing_state AS s (conversation_id, workspace_id, waiting_since, wait_reason, waiting_retry_at, waiting_active_at, updated_at)
  SELECT c.id, c.workspace_id, now(), p_reason, now() + interval '25 seconds', now(), now()
    FROM public.conversations c
   WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id
  ON CONFLICT (conversation_id) DO UPDATE SET
    waiting_since = coalesce(s.waiting_since, EXCLUDED.waiting_since),
    wait_reason = EXCLUDED.wait_reason,
    waiting_retry_at = CASE
      WHEN coalesce(p_from_ticker, false) AND s.waiting_since IS NOT NULL
        THEN greatest(s.waiting_retry_at, EXCLUDED.waiting_retry_at)
      ELSE EXCLUDED.waiting_retry_at
    END,
    waiting_active_at = CASE
      WHEN coalesce(p_from_ticker, false) AND s.waiting_since IS NOT NULL
        THEN coalesce(s.waiting_active_at, s.waiting_since)
      ELSE EXCLUDED.waiting_active_at
    END,
    prechat_deadline = NULL,
    updated_at = now();
END;
$fn_routing_wait$;

COMMENT ON FUNCTION public.chat_routing_wait(uuid, uuid, text, boolean) IS
  'Records that routing found no operator for the conversation (p_reason: nobody_online | all_busy; NULL: no longer waiting); the routing ticker retries it. p_from_ticker: the ticker''s own retry, which is not activity. Server-only. Migration 278.';

-- A first-response timeout nobody else could take over: the chat leaves the
-- member who did not answer (only while they still hold it), who joins its
-- skip list, and waits for the next operator (the ticker retries it).
-- Returns whether it was released.
CREATE OR REPLACE FUNCTION public.chat_routing_release(p_workspace_id uuid, p_conversation_id uuid, p_from uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_routing_release$
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('nobody_online', 'all_busy') THEN
    RAISE EXCEPTION 'chat_routing_release: invalid reason %', p_reason;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_route_claim:' || p_workspace_id::text, 0));
  UPDATE public.conversations
     SET assigned_to = NULL, updated_at = now()
   WHERE id = p_conversation_id
     AND workspace_id = p_workspace_id
     AND assigned_to = p_from
     AND status IN ('open', 'pending');
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.chat_routing_state AS s (
    conversation_id, workspace_id, skip_user_ids, waiting_since, wait_reason, waiting_retry_at, waiting_active_at, updated_at
  ) VALUES (
    p_conversation_id, p_workspace_id, ARRAY[p_from], now(), p_reason, now() + interval '25 seconds', now(), now()
  )
  ON CONFLICT (conversation_id) DO UPDATE SET
    assigned_to = NULL,
    assigned_at = NULL,
    assign_method = NULL,
    timeout_due_at = NULL,
    skip_user_ids = CASE
      WHEN p_from = ANY (s.skip_user_ids) THEN s.skip_user_ids
      ELSE (s.skip_user_ids || p_from)[greatest(1, cardinality(s.skip_user_ids) - 48):]
    END,
    waiting_since = coalesce(s.waiting_since, now()),
    wait_reason = p_reason,
    waiting_retry_at = now() + interval '25 seconds',
    waiting_active_at = now(),
    updated_at = now();
  RETURN true;
END;
$fn_routing_release$;

COMMENT ON FUNCTION public.chat_routing_release(uuid, uuid, uuid, text) IS
  'First-response timeout with nobody to take over: unassigns the conversation from p_from (only while they hold it), adds them to its skip list and makes it wait for the next operator. Server-only. Migration 278.';

-- Routing waits for the pre-chat form until p_deadline (an earlier deadline
-- already set is kept).
CREATE OR REPLACE FUNCTION public.chat_routing_defer_prechat(p_workspace_id uuid, p_conversation_id uuid, p_deadline timestamptz)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $fn_routing_defer$
  INSERT INTO public.chat_routing_state AS s (conversation_id, workspace_id, prechat_deadline, updated_at)
  SELECT c.id, c.workspace_id, p_deadline, now()
    FROM public.conversations c
   WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id
  ON CONFLICT (conversation_id) DO UPDATE SET
    prechat_deadline = CASE
      WHEN s.prechat_deadline IS NOT NULL AND s.prechat_deadline < EXCLUDED.prechat_deadline THEN s.prechat_deadline
      ELSE EXCLUDED.prechat_deadline
    END,
    updated_at = now();
$fn_routing_defer$;

COMMENT ON FUNCTION public.chat_routing_defer_prechat(uuid, uuid, timestamptz) IS
  'Records that routing waits for the visitor''s pre-chat form; the routing ticker routes the conversation anyway from p_deadline. Server-only. Migration 278.';

-- What the routing ticker has to do now, at most p_limit rows of each kind:
--   'prechat'  the pre-chat deadline passed and the conversation still waits
--              for routing (metadata.routing_pending), unassigned and open;
--   'waiting'  no operator could take it last time; still unassigned, open
--              or pending, not spam, not the AI's. The rows whose retry fell
--              due longest ago go first (each row handed out goes behind the
--              ones not tried yet, so more than p_limit waiting chats take
--              turns instead of the oldest p_limit forever), and a pass's
--              rows come back oldest wait first. A row handed out is due
--              again in 25 seconds while the wait saw activity (a visitor
--              message, a hand-back: waiting_active_at) in the last hour,
--              else in 2 minutes; a wait without activity for 24 hours is
--              forgotten (the chat stays in Unassigned, and the visitor's
--              next message routes it again: as released chats,
--              RELEASE_REROUTE_MAX_AGE_MS, stale threads do not fill the
--              team's capacity);
--   'timeout'  routing assigned it and that member (due_assignee) has not
--              written in it since (handed out again after 2 minutes should
--              a pass fail; for 24 hours at most).
-- Anything that no longer applies (assigned by hand, answered, resolved,
-- closed, spam, the timeout switched off) is forgotten on the way.
CREATE OR REPLACE FUNCTION public.chat_routing_due(p_limit integer DEFAULT 100)
RETURNS TABLE (due_conversation_id uuid, due_workspace_id uuid, due_kind text, due_assignee uuid)
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_routing_due$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
BEGIN
  -- Pre-chat deadlines that fell due: spent either way.
  RETURN QUERY
  WITH due AS (
    SELECT s.conversation_id
      FROM public.chat_routing_state s
     WHERE s.prechat_deadline IS NOT NULL AND s.prechat_deadline <= now()
     ORDER BY s.prechat_deadline
     LIMIT v_limit
     FOR UPDATE OF s SKIP LOCKED
  ), spent AS (
    UPDATE public.chat_routing_state s
       SET prechat_deadline = NULL, updated_at = now()
      FROM due
     WHERE s.conversation_id = due.conversation_id
    RETURNING s.conversation_id, s.workspace_id
  )
  SELECT sp.conversation_id, sp.workspace_id, 'prechat'::text, NULL::uuid
    FROM spent sp
    JOIN public.conversations c ON c.id = sp.conversation_id
   WHERE c.assigned_to IS NULL
     AND c.status IN ('open', 'pending')
     AND c.is_spam = false
     AND (c.metadata->>'routing_pending') = 'true';

  -- Waits that are over (someone has it, or it is no longer open), and waits
  -- nothing but the ticker touched for 24 hours.
  UPDATE public.chat_routing_state s
     SET waiting_since = NULL, wait_reason = NULL, waiting_retry_at = NULL, waiting_active_at = NULL, updated_at = now()
    FROM public.conversations c
   WHERE s.waiting_since IS NOT NULL
     AND c.id = s.conversation_id
     AND (c.assigned_to IS NOT NULL OR c.status NOT IN ('open', 'pending') OR c.is_spam
          OR coalesce(s.waiting_active_at, s.waiting_since) < now() - interval '24 hours');

  RETURN QUERY
  WITH due AS (
    SELECT s.conversation_id
      FROM public.chat_routing_state s
      JOIN public.conversations c ON c.id = s.conversation_id
     WHERE s.waiting_since IS NOT NULL
       AND coalesce(s.waiting_retry_at, s.waiting_since) <= now()
       AND c.assigned_to IS NULL
       AND c.status IN ('open', 'pending')
       AND c.is_spam = false
       AND (c.metadata->>'ai_state') IS DISTINCT FROM 'ai_managed'
     ORDER BY coalesce(s.waiting_retry_at, s.waiting_since), s.waiting_since
     LIMIT v_limit
     FOR UPDATE OF s SKIP LOCKED
  ), handed AS (
    UPDATE public.chat_routing_state s
       SET waiting_retry_at = now() + CASE
             WHEN coalesce(s.waiting_active_at, s.waiting_since) > now() - interval '1 hour' THEN interval '25 seconds'
             ELSE interval '2 minutes'
           END,
           updated_at = now()
      FROM due
     WHERE s.conversation_id = due.conversation_id
    RETURNING s.conversation_id, s.workspace_id, s.waiting_since
  )
  SELECT h.conversation_id, h.workspace_id, 'waiting'::text, NULL::uuid
    FROM handed h
   ORDER BY h.waiting_since, h.conversation_id;

  -- Timeouts that no longer apply.
  UPDATE public.chat_routing_state s
     SET timeout_due_at = NULL, updated_at = now()
    FROM public.conversations c
   WHERE s.timeout_due_at IS NOT NULL
     AND s.timeout_due_at <= now()
     AND c.id = s.conversation_id
     AND (c.assigned_to IS DISTINCT FROM s.assigned_to
          OR c.status NOT IN ('open', 'pending')
          OR c.is_spam
          OR s.assigned_at IS NULL
          OR s.assigned_at < now() - interval '24 hours'
          OR coalesce((SELECT w.first_response_timeout_minutes FROM public.widget_settings w
                        WHERE w.workspace_id = s.workspace_id), 5) = 0
          OR EXISTS (
            SELECT 1 FROM public.conversation_messages m
             WHERE m.conversation_id = s.conversation_id
               AND m.sender_type = 'agent'
               AND m.sender_id = s.assigned_to
               AND m.created_at >= s.assigned_at
          ));

  RETURN QUERY
  WITH due AS (
    SELECT s.conversation_id
      FROM public.chat_routing_state s
     WHERE s.timeout_due_at IS NOT NULL AND s.timeout_due_at <= now()
     ORDER BY s.timeout_due_at
     LIMIT v_limit
     FOR UPDATE OF s SKIP LOCKED
  )
  UPDATE public.chat_routing_state s
     SET timeout_due_at = now() + interval '2 minutes', updated_at = now()
    FROM due
   WHERE s.conversation_id = due.conversation_id
  RETURNING s.conversation_id, s.workspace_id, 'timeout'::text, s.assigned_to;
END;
$fn_routing_due$;

COMMENT ON FUNCTION public.chat_routing_due(integer) IS
  'The chat routing ticker''s work list: pre-chat deadlines, waiting chats and first-response timeouts that fell due (see migration 278). Server-only.';

-- ─── 6. Indexes on conversations (built CONCURRENTLY beforehand on a live database) ─
DO $$
DECLARE
  i record;
BEGIN
  FOR i IN
    SELECT * FROM (VALUES
      ('conversations_open_assignee_idx',
       'CREATE INDEX conversations_open_assignee_idx ON public.conversations (workspace_id, assigned_to) '
       'WHERE assigned_to IS NOT NULL AND status IN (''open'', ''pending'') AND is_spam = false'),
      ('conversations_contact_recent_idx',
       'CREATE INDEX conversations_contact_recent_idx ON public.conversations (workspace_id, contact_id, updated_at DESC) '
       'WHERE contact_id IS NOT NULL')
    ) AS v(name, ddl)
  LOOP
    IF to_regclass('public.' || i.name) IS NULL THEN
      EXECUTE i.ddl;
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_index WHERE indexrelid = ('public.' || i.name)::regclass AND indisvalid
    ) THEN
      RAISE EXCEPTION '278: % is invalid (an interrupted CREATE INDEX CONCURRENTLY); DROP INDEX CONCURRENTLY public.%, build it again, then run this file', i.name, i.name;
    END IF;
  END LOOP;
END $$;

-- ─── Access: the backend (service_role) only ──────────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.chat_route_claim(uuid, uuid, uuid[], text, text, text, uuid)',
    'public.chat_routing_wait(uuid, uuid, text, boolean)',
    'public.chat_routing_release(uuid, uuid, uuid, text)',
    'public.chat_routing_defer_prechat(uuid, uuid, timestamptz)',
    'public.chat_routing_due(integer)'
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
