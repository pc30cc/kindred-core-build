-- 280b — The visitor's place in the queue counts their own department's
-- queue (audit finding R-22; DECISIONS §4b).
--
-- A visitor who picks a department in the widget (the picker, POST
-- /api/widget/message department_id) waits in that department's queue:
-- routing stores the department on the conversation in every mode
-- (metadata.department_id, chatRouting.ts), the Inbox filters and badges it,
-- and the operators of that department claim it. The place GET
-- /api/widget/queue shows (276's chat_queue_status) still counted every
-- queued conversation of the workspace, so a "Sales" visitor read "you are
-- 7th" behind six "Support" chats nobody in Sales would take first.
--
-- 1. public.chat_queue_status(ws, conversation): the place is 1 + the queued
--    conversations of the workspace IN THE SAME DEPARTMENT (the same
--    metadata->>'department_id'; no department counts among the
--    conversations with none) that were queued before it (queued_at, then
--    id). The wait estimate is unchanged: the workspace's seconds per place
--    (chat_queue_stats) times that place.
-- 2. public.chat_queue_record_return() (the hand-back trigger's function):
--    the place it records on a return (queue_entry_position) is counted the
--    same way, so the next claim's sample is measured per place of the queue
--    the conversation really waited in. chatRouting.ts records the place at
--    entry through chat_queue_status, which (1) already counts per
--    department.
--
-- Same signatures, so every grant (service_role only, 276 §6) and the
-- trigger trg_conversations_queue_return stay as they are. Both reads keep
-- the predicate of conversations_manual_queue_idx (276), which still serves
-- them; the department is one more filter on the rows it returns.
--
-- Locks: none on any table (CREATE OR REPLACE FUNCTION). Re-runnable: the
-- second run replaces the functions with the same text. Dry run: the file
-- inside BEGIN … ROLLBACK. Changes no row; drops nothing; touches no archive
-- schema or table. Needs 276 (the functions and chat_queue_stats).

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.chat_queue_status(p_workspace_id uuid, p_conversation_id uuid)
RETURNS TABLE (queue_position integer, wait_minutes integer)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn_queue_status$
  WITH me AS (
    SELECT c.metadata->>'queued_at' AS q,
           nullif(c.metadata->>'department_id', '') AS d
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
       AND nullif(c.metadata->>'department_id', '') IS NOT DISTINCT FROM me.d
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
  'The place of a manually queued conversation in its department''s queue of its workspace (the same metadata department_id; none counts among none) and the estimated wait in minutes (NULL until 3 claims were measured in the last 14 days, or above 180 minutes). No row when the conversation is not waiting. Server-only. Migrations 276, 280b.';

CREATE OR REPLACE FUNCTION public.chat_queue_record_return()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn_queue_return$
DECLARE
  v_place integer;
BEGIN
  BEGIN
    SELECT 1 + count(*)::integer INTO v_place
      FROM public.conversations c
     WHERE c.workspace_id = NEW.workspace_id
       AND c.assigned_to IS NULL
       AND (c.metadata->>'routing_outcome') = 'manual_queue'
       AND c.status IN ('open', 'pending')
       AND c.is_spam = false
       AND c.id <> NEW.id
       AND (c.metadata->>'queued_at') <= (NEW.metadata->>'queued_at')
       AND ((c.metadata->>'queued_at') < (NEW.metadata->>'queued_at') OR c.id < NEW.id)
       AND nullif(c.metadata->>'department_id', '') IS NOT DISTINCT FROM nullif(NEW.metadata->>'department_id', '');
    NEW.metadata := NEW.metadata || jsonb_build_object(
      'queue_reentered_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'queue_entry_position', v_place
    );
  EXCEPTION WHEN others THEN
    NULL;
  END;
  RETURN NEW;
END;
$fn_queue_return$;

RESET lock_timeout;
