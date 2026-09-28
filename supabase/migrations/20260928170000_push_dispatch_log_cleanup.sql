-- ============================================================
-- THE NOTIFICATION LOG CLEANS ITSELF UP, AND THE BADGE IS ONE QUERY
--
-- Self-host twin: database/migrations/236_push_dispatch_log_cleanup.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- `push_dispatch_log` gains one row per notification per operator — the
-- row that stops a notification being sent twice — for the iPhone and the
-- Android app alike, and nothing ever removed one. Super Admin has offered a
-- "delivery log retention (days)" since migration 195; nothing enforced it.
--
--   • push_platform_settings.dispatch_log_auto_purge — whether the server
--     removes rows older than dispatch_log_retention_days on its own
--     (Super Admin → Notifications → Diagnostics)
--   • dispatch_log_purged_at / dispatch_log_purged_count — the last cleanup,
--     automatic or by the "Clean up now" button, for that screen to show
--   • purge_push_dispatch_log(before, batch) — removes one batch of rows
--     created before `before` and says how many; the server calls it until a
--     batch comes back short, so no single statement holds the table long
--   • push_unread_badge(user, workspace) — the number on the app icon in one
--     statement instead of four round trips per notified operator: open
--     conversations in the main queue (not spam, not the AI's own queue,
--     unassigned or theirs) holding an unseen customer message, plus the
--     colleagues with an unread team message for them
--
-- Both functions are for the server's service role only. Additive and
-- idempotent; the switch defaults on, and the retention it applies is the
-- one Super Admin already set (30 days unless changed).
-- ============================================================

ALTER TABLE public.push_platform_settings
  ADD COLUMN IF NOT EXISTS dispatch_log_auto_purge boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dispatch_log_purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_log_purged_count integer;

CREATE OR REPLACE FUNCTION public.purge_push_dispatch_log(
  p_before timestamptz,
  p_batch integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.push_dispatch_log
  WHERE id IN (
    SELECT id
    FROM public.push_dispatch_log
    WHERE created_at < p_before
    ORDER BY created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_batch, 5000), 50000))
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION public.push_unread_badge(
  p_user_id uuid,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ws AS (
    SELECT m.workspace_id
    FROM public.workspace_members m
    WHERE m.user_id = p_user_id
      AND m.suspended_at IS NULL
      AND (p_workspace_id IS NULL OR m.workspace_id = p_workspace_id)
  )
  SELECT (
    (
      SELECT count(*)
      FROM public.conversations c
      WHERE c.workspace_id IN (SELECT workspace_id FROM ws)
        AND c.status = 'open'
        AND c.is_spam = false
        AND (c.ai_state IS NULL OR c.ai_state <> 'ai_managed')
        AND (c.assigned_to IS NULL OR c.assigned_to = p_user_id)
        AND EXISTS (
          SELECT 1
          FROM public.conversation_messages cm
          WHERE cm.conversation_id = c.id
            AND cm.sender_type = 'contact'
            AND cm.seen_at IS NULL
        )
    ) + (
      SELECT count(DISTINCT t.sender_id)
      FROM public.team_messages t
      WHERE t.workspace_id IN (SELECT workspace_id FROM ws)
        AND t.recipient_id = p_user_id
        AND t.read_at IS NULL
    )
  )::integer;
$$;

REVOKE ALL ON FUNCTION public.purge_push_dispatch_log(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_unread_badge(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.purge_push_dispatch_log(timestamptz, integer) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.push_unread_badge(uuid, uuid) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.purge_push_dispatch_log(timestamptz, integer) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.push_unread_badge(uuid, uuid) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.purge_push_dispatch_log(timestamptz, integer) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.push_unread_badge(uuid, uuid) TO service_role';
  END IF;
END $$;
