-- Phase 7 — Read Receipts + Delivery States
-- Adds the minimum schema needed for honest, monotonic message lifecycle tracking.
--
-- Lifecycle in v1: sending → sent → seen
-- (delivered is intentionally skipped — see Phase 7 spec)
--
-- seen_at: nullable timestamptz on conversation_messages.
--   Set ONLY when an operator actually opens/selects the conversation in the
--   inbox. Monotonic: never cleared, never moved backwards.
--
-- read_receipts_enabled: workspace-level toggle on widget_settings.
--   When false, the widget shows only sending → sent (no seen state).

-- ── 1. conversation_messages.seen_at ─────────────────────────────
ALTER TABLE public.conversation_messages
  ADD COLUMN IF NOT EXISTS seen_at timestamptz NULL;

-- Partial index: operator-side "mark unseen visitor messages as seen" query
-- only ever scans messages from contacts that haven't been seen yet.
CREATE INDEX IF NOT EXISTS idx_conv_messages_unseen_visitor
  ON public.conversation_messages (conversation_id, created_at)
  WHERE seen_at IS NULL AND sender_type = 'contact';

-- ── 2. widget_settings.read_receipts_enabled ─────────────────────
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS read_receipts_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.conversation_messages.seen_at IS
  'Phase 7: Set when an operator opens/selects the conversation. Monotonic — never cleared.';
COMMENT ON COLUMN public.widget_settings.read_receipts_enabled IS
  'Phase 7: When false, widget shows only sending/sent (no seen indicator).';