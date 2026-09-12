-- Migration: 165_email_messages_delivery_status.sql
--
-- email_messages needs a durable place to record what happened to an
-- OUTBOUND reply sent through the Email Inbox: the Worker calls Gmail
-- asynchronously (channel_jobs), so the row Core inserts at compose time is
-- optimistic ('queued') until the Worker reports back success or failure —
-- mirrors conversation_messages.metadata.channel_delivery for chat channels,
-- but as real columns since email_messages carries no metadata jsonb column
-- (163_email_inbox.sql deliberately kept that table narrow/structured).
-- Inbound rows are written already-delivered ('sent') and never transition.

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('queued', 'sent', 'failed'));

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS delivery_error text;
