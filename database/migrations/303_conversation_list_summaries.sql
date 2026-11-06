-- 303 — every Inbox row's summary is its own conversation's, complete
-- (audit 2026-11-06, the shared 2000-message window).
--
-- APPLIED BY HAND on WebYar's database (host.respok.app), BEFORE the merge of
-- the code that calls conversation_list_summaries(), per CLAUDE.md
-- "Migrations": a dry run inside BEGIN … ROLLBACK first. RESPOK's migrator
-- applies it on push. It only adds a function and writes no data; a second
-- run changes nothing. Until it is applied the list keeps its old window
-- (GET /api/conversations falls back on PGRST202 / 42883).
--
-- GET /api/conversations (and GET /:id, the same rows) read ONE window of the
-- 2000 newest messages of ALL the listed conversations together and took
-- every row's last message, last visitor message, unread count, the members
-- who answered (handled_by), needs_reply and waiting_since from it. A busy
-- conversation pushed the others out: their last message read null, unread
-- 0, needs_reply false, handled_by [] (so a resolved/closed thread another
-- operator answered could reach an operator's own list, and the operator's
-- own could leave it), and waiting_since drifted to the oldest visitor turn
-- of the window instead of the start of the current wait.
--
-- conversation_list_summaries(workspace, ids) answers one row per listed
-- conversation of that workspace, each read on its own with the indexes the
-- table has (no new index):
--   last_*        the newest message of any sender that is not a channel
--                 menu tap (both markers, as inboxUnread.ts isChannelMenuEvent):
--                 one ordered probe per sender type on
--                 idx_conversation_messages_conv_sender_created, the newest
--                 of them (created_at, then id, both newest first: the old
--                 window's order);
--   contact_*     the newest visitor message that is not a menu tap (body,
--                 created_at, seen_at), the same index;
--   unread_count  the visitor messages not seen, menu taps left out, on
--                 idx_conv_messages_unseen_visitor;
--   handled_by    the members who wrote in it (sender_type 'agent' with a
--                 sender), as conversation_inbox_counters' Resolved count
--                 reads it, so the list and the tab agree;
--   needs_reply   an open conversation whose newest turn
--                 (conversation_message_turn, 286, the SQL twin of
--                 needsReply.ts) is the visitor's, ties by id as the list's
--                 order (computeNeedsReply); false otherwise;
--   waiting_since the oldest visitor turn after the newest team turn, while
--                 one is owed (computeWaitingSince: an answer resets the wait).
-- SECURITY INVOKER, EXECUTE for service_role only (as 241/284).

DO $guard$
BEGIN
  IF to_regprocedure('public.conversation_message_turn(text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION '303 needs 284/286 (public.conversation_message_turn) applied first';
  END IF;
END $guard$;

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.conversation_list_summaries(
  p_workspace_id     uuid,
  p_conversation_ids uuid[]
) RETURNS TABLE (
  conversation_id    uuid,
  last_id            uuid,
  last_body          text,
  last_created_at    timestamptz,
  last_sender_type   text,
  last_sender_id     uuid,
  last_metadata      jsonb,
  contact_body       text,
  contact_created_at timestamptz,
  contact_seen_at    timestamptz,
  unread_count       bigint,
  handled_by         uuid[],
  needs_reply        boolean,
  waiting_since      timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn_list_summaries$
  WITH listed AS (
    SELECT c.id, c.status::text AS status
      FROM public.conversations c
     WHERE c.workspace_id = p_workspace_id
       AND c.id = ANY (p_conversation_ids)
  ),
  turns AS (
    SELECT l.id, l.status,
           vt.created_at AS v_at, vt.id AS v_id,
           tt.created_at AS t_at, tt.id AS t_id
      FROM listed l
      -- The newest visitor turn and the newest team turn (a person's or the
      -- AI's), only where something can be owed.
      LEFT JOIN LATERAL (
        SELECT m.created_at, m.id
          FROM public.conversation_messages m
         WHERE l.status = 'open'
           AND m.conversation_id = l.id AND m.sender_type = 'contact'
           AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'visitor'
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
      ) vt ON true
      LEFT JOIN LATERAL (
        SELECT t.created_at, t.id
          FROM (
            (SELECT m.created_at, m.id
               FROM public.conversation_messages m
              WHERE l.status = 'open'
                AND m.conversation_id = l.id AND m.sender_type = 'agent'
                AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'team'
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1)
            UNION ALL
            (SELECT m.created_at, m.id
               FROM public.conversation_messages m
              WHERE l.status = 'open'
                AND m.conversation_id = l.id AND m.sender_type = 'ai'
                AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'team'
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1)
          ) t
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT 1
      ) tt ON true
  )
  SELECT t.id,
         last.id, last.body, last.created_at, last.sender_type::text, last.sender_id, last.metadata,
         vis.body, vis.created_at, vis.seen_at,
         coalesce(unread.n, 0),
         coalesce(agents.ids, '{}'::uuid[]),
         owed.needs_reply,
         CASE WHEN owed.needs_reply THEN (
           SELECT min(m.created_at)
             FROM public.conversation_messages m
            WHERE m.conversation_id = t.id AND m.sender_type = 'contact'
              -- The range the index reads; the pair decides a tie.
              AND (t.t_at IS NULL OR m.created_at >= t.t_at)
              AND (t.t_at IS NULL OR (m.created_at, m.id) > (t.t_at, t.t_id))
              AND public.conversation_message_turn(m.sender_type::text, m.body, m.metadata) = 'visitor'
         ) END
    FROM turns t
    CROSS JOIN LATERAL (
      SELECT t.status = 'open' AND t.v_at IS NOT NULL
             AND (t.t_at IS NULL OR (t.v_at, t.v_id) > (t.t_at, t.t_id)) AS needs_reply
    ) owed
    -- The newest message that is not a menu tap: the newest of one probe per
    -- sender type.
    LEFT JOIN LATERAL (
      SELECT p.*
        FROM unnest(enum_range(NULL::public.sender_type)) AS st(sender_type)
        CROSS JOIN LATERAL (
          SELECT m.id, m.body, m.created_at, m.sender_type, m.sender_id, m.metadata
            FROM public.conversation_messages m
           WHERE m.conversation_id = t.id AND m.sender_type = st.sender_type
             AND coalesce(m.metadata->>'channel_menu_event', '') <> 'true'
             AND coalesce(m.metadata->'channel_menu_command', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 1
        ) p
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT 1
    ) last ON true
    LEFT JOIN LATERAL (
      SELECT m.body, m.created_at, m.seen_at
        FROM public.conversation_messages m
       WHERE m.conversation_id = t.id AND m.sender_type = 'contact'
         AND coalesce(m.metadata->>'channel_menu_event', '') <> 'true'
         AND coalesce(m.metadata->'channel_menu_command', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
    ) vis ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n
        FROM public.conversation_messages m
       WHERE m.conversation_id = t.id AND m.sender_type = 'contact' AND m.seen_at IS NULL
         AND coalesce(m.metadata->>'channel_menu_event', '') <> 'true'
         AND coalesce(m.metadata->'channel_menu_command', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
    ) unread ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT m.sender_id ORDER BY m.sender_id) AS ids
        FROM public.conversation_messages m
       WHERE m.conversation_id = t.id AND m.sender_type = 'agent' AND m.sender_id IS NOT NULL
    ) agents ON true;
$fn_list_summaries$;

COMMENT ON FUNCTION public.conversation_list_summaries(uuid, uuid[]) IS
  'One Inbox row summary per listed conversation of the workspace, each read on its own: the last message (menu taps left out), the last visitor message, unread, the members who wrote, needs_reply and waiting_since (conversation_message_turn). GET /api/conversations. Server-only. Migration 303.';

-- ─── Access: the backend (service_role) only ──────────────────────────────
DO $acl$
DECLARE
  f text := 'public.conversation_list_summaries(uuid, uuid[])';
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
