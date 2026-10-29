-- 289f — Email Inbox: a reply queued for a mailbox is queued once, whatever
-- the number of times the app asks.
--
-- A reply composed in the Email Inbox for a Yahoo mailbox (and the legacy
-- queued Gmail path) becomes an email_messages row in 'queued' and a channel
-- job the Channels Worker sends. The web keeps one request id per reply
-- across retries, but only the live Gmail path read it: a retry after a
-- timeout or a 500 wrote a second row and a second job, and the customer got
-- the reply twice.
--
-- 1. email_messages.client_request_id: the id the app sent with the reply
--    (server/routes/emailInbox.ts `client_request_id`), NULL for every row
--    written without one (inbound mail, older replies).
-- 2. email_messages_client_request_uidx: unique per workspace where set, so
--    a second request with the same id finds the first reply
--    (server/services/email/inbox.ts composeReply) even when both arrive at
--    once.
--
-- The table keeps its RLS and grants (service_role only); nothing is granted
-- here. The index is built in place, not CONCURRENTLY: email_messages holds
-- only the Yahoo mailboxes' mail (a Gmail inbox stores none), a few rows per
-- workspace, so the lock lasts a moment.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The code
-- also runs without it (composeReply then queues without the id, as before),
-- so the order is safe either way. It writes no data, rewrites no row (the
-- column has no default) and drops nothing. Safe to run twice. Dry run: wrap
-- the file in BEGIN; … ROLLBACK; (it opens no transaction of its own). Like
-- 284 to 289b, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS email_messages_client_request_uidx
  ON public.email_messages (workspace_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

COMMENT ON COLUMN public.email_messages.client_request_id IS
  'The request id the app sent with an outbound reply (one per reply, kept across retries): a retry returns the reply already queued. NULL for inbound mail and replies sent without one.';
