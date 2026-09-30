-- Inbox counters in one query.
--
-- GET /api/conversations/inbox-counts ran four HEAD count(*) queries and
-- GET /api/conversations/inbox-tab-counts six more — and, for any operator
-- who does not see every thread, then fetched up to 2 000 resolved
-- conversations and up to 5 000 agent messages to work out the Resolved tab
-- in JavaScript. Every operator's dashboard refetches both on each realtime
-- inbox event, so under load these were the most frequent queries in the
-- database. This function computes every number both endpoints return in a
-- single pass over the workspace's conversations, with the same rules:
--
--   scope        p_sees_all, or assigned to nobody / to p_user_id
--   inbox_*      not spam, not closed; main = not AI-managed,
--                automated = AI-managed and unclaimed, needs_human
--   tab_*        not spam and not AI-managed (the Main Inbox list), by status;
--                tab_automated = the AI tab's own narrowing
--   tab_resolved for a scoped operator: resolved/closed threads assigned to
--                nobody or to them, that no other agent handled — no agent
--                message at all, or one from them (the list's ownership rule)
--
-- SECURITY INVOKER and service_role only: the API server calls it after its
-- own workspace authorization, exactly like the queries it replaces.
-- Idempotent: CREATE OR REPLACE.

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
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.conversation_inbox_counters(uuid, uuid, boolean) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.conversation_inbox_counters(uuid, uuid, boolean) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.conversation_inbox_counters(uuid, uuid, boolean) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.conversation_inbox_counters(uuid, uuid, boolean) TO service_role';
  END IF;
END $$;
