-- Chat conversation routing/assignment — professional replacement for the
-- absence of any automatic assignment (chat conversations were previously
-- only ever assigned manually via a plain read-then-write PATCH, which is
-- not atomic and has no algorithm — see server/services/chatRouting.ts).
--
-- assignment_mode: how a conversation is handed to an operator once AI
--   hands off (or AI is off and a visitor starts a human conversation).
--   'auto'         — least-loaded eligible online operator (default)
--   'round_robin'  — fair rotation among eligible online operators
--   'manual'       — conversation goes to the Unassigned inbox; first
--                    operator to claim it (atomically) owns it.
-- round_robin_cursor_user_id: last operator assigned by round-robin, so
--   the next pick continues the rotation instead of restarting from the
--   top every time (persisted, race-safe via the claim function below).
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS assignment_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS round_robin_cursor_user_id uuid NULL;

ALTER TABLE public.widget_settings
  DROP CONSTRAINT IF EXISTS widget_settings_assignment_mode_check;
ALTER TABLE public.widget_settings
  ADD CONSTRAINT widget_settings_assignment_mode_check
  CHECK (assignment_mode IN ('auto', 'round_robin', 'manual'));

-- Atomic "first write wins" conversation claim/assignment. A plain
-- read-then-write PATCH lets two operators (or an auto-assign race and a
-- manual claim) both believe they own the same conversation. This function
-- performs the check-and-set as a single statement, so concurrent callers
-- serialize on the row and only one can ever succeed.
--
-- Returns the assigned conversation row when this call won the claim, or
-- no rows when someone else already holds it (or force=false and it was
-- already assigned to a different operator).
CREATE OR REPLACE FUNCTION public.claim_conversation(
  p_conversation_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_force boolean DEFAULT false
)
RETURNS SETOF public.conversations
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.conversations
  SET assigned_to = p_user_id,
      updated_at = now()
  WHERE id = p_conversation_id
    AND workspace_id = p_workspace_id
    AND (p_force OR assigned_to IS NULL)
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.claim_conversation(uuid, uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_conversation(uuid, uuid, uuid, boolean) TO service_role;
