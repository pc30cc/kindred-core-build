-- 244 — Platform support: close the conversations still open as tickets.
-- Hosted twin: supabase/migrations/20260930180000_platform_support_close_legacy_tickets.sql
--
-- Tickets are gone (243), but a conversation opened as a ticket before then
-- could still be open: it stayed the operator's "active" conversation, so the
-- app kept writing to it after they had resolved their chat — into a
-- leftover ticket, not the conversation they were looking at. This closes
-- every such conversation that is still open or pending. Closed conversations stay readable in the
-- operator's history and in the inbox; the team can reopen one there.
--
-- Idempotent: a second run finds nothing to close.

UPDATE public.conversations c
   SET status = 'closed',
       updated_at = now()
  FROM public.platform_support_threads t
 WHERE t.conversation_id = c.id
   AND c.status IN ('open', 'pending')
   AND (c.metadata->>'platform_support_kind' = 'ticket'
        OR c.metadata->>'channel_thread_key' LIKE 'platform_support:ticket:%');

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.conversations c
      JOIN public.platform_support_threads t ON t.conversation_id = c.id
     WHERE c.status IN ('open', 'pending')
       AND (c.metadata->>'platform_support_kind' = 'ticket'
            OR c.metadata->>'channel_thread_key' LIKE 'platform_support:ticket:%')
  ) THEN
    RAISE EXCEPTION 'a platform support ticket is still open';
  END IF;
END $verify$;
