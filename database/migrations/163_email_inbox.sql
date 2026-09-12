-- Migration: 163_email_inbox.sql
--
-- Email Inbox — dedicated schema for the Gmail/Yahoo Mail channel plugins
-- (channels/providers/gmail/, channels/providers/yahoomail/). Deliberately
-- NOT reusing conversations/conversation_messages: those tables carry zero
-- per-channel columns by convention (everything lives in a jsonb metadata
-- column), which is fine for chat but not enough for a real email client —
-- email needs separate HTML/text bodies, From/To/Cc/Bcc, Message-ID/
-- In-Reply-To/References threading headers, and per-message read state.
-- Per product decision this email inbox is intentionally standalone, not
-- merged into the unified chat Inbox — so it never touches `conversations`.
--
-- Still reuses the existing channel-plugin plumbing for everything that
-- generalizes: `channel_integrations` (the connected mailbox — one row per
-- workspace+provider, `external_account_id` = the email address),
-- `plugin_secrets` (encrypted OAuth refresh token), `channel_jobs` (queue).
--
-- One thread groups all messages sharing the provider's own thread id
-- (Gmail's `threadId`; Yahoo Mail will use a normalized root Message-ID in
-- phase 2). All three tables are service-role-only, matching every other
-- channel table (channel_integrations, plugin_secrets) — the workspace's
-- browser client never reads these directly, only through the Express API.

CREATE TABLE IF NOT EXISTS public.email_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  integration_id    uuid NOT NULL REFERENCES public.channel_integrations(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('gmail', 'yahoo')),
  external_thread_id text NOT NULL,
  subject           text,
  participants      jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_message_at   timestamptz,
  is_read           boolean NOT NULL DEFAULT true,
  is_starred        boolean NOT NULL DEFAULT false,
  labels            text[] NOT NULL DEFAULT '{}'::text[],
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_email_threads_workspace ON public.email_threads (workspace_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_integration ON public.email_threads (integration_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_unread ON public.email_threads (workspace_id, is_read) WHERE NOT is_read;

ALTER TABLE public.email_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_threads FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.email_threads TO service_role;

CREATE TRIGGER email_threads_updated_at
  BEFORE UPDATE ON public.email_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Individual messages within a thread — both directions (inbound from the
-- provider, outbound sent by an operator through the Email Inbox UI).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid NOT NULL REFERENCES public.email_threads(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  in_reply_to         text,
  message_references  text[] NOT NULL DEFAULT '{}'::text[],
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_address        text NOT NULL,
  to_addresses        jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses        jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses       jsonb NOT NULL DEFAULT '[]'::jsonb,
  text_body           text,
  html_body           text,
  snippet             text,
  is_read             boolean NOT NULL DEFAULT true,
  sent_by             uuid,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON public.email_messages (thread_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_workspace ON public.email_messages (workspace_id, sent_at DESC);

ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_messages FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.email_messages TO service_role;

COMMENT ON TABLE public.email_messages IS
  'One row per email in a thread. sent_by is the operator profile id for direction=outbound (null for inbound). external_message_id is the provider Message-ID header (Gmail: the RFC 2822 Message-ID, not Gmail''s internal numeric id).';

-- ─────────────────────────────────────────────────────────────────────────
-- Attachments — content lives in the platform's existing storage
-- abstraction (server/services/storage/index.ts), this row is just the
-- pointer + MIME metadata. content_id is set for inline/cid-referenced
-- images (rendered inline in html_body), null for regular attachments.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text,
  size_bytes   bigint,
  storage_key  text NOT NULL,
  content_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON public.email_attachments (message_id);

ALTER TABLE public.email_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_attachments FROM anon, authenticated;
GRANT SELECT, INSERT ON public.email_attachments TO service_role;
