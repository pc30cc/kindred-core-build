-- Phase 8E — Callback scheduling: add visitor-chosen callback time.
-- The existing `scheduled_at` column tracks WHEN the status was changed to
-- 'scheduled' (operator action). The new `scheduled_for` column records WHEN
-- the visitor wants to be called back. Null = "as soon as possible" (existing
-- behavior, fully backward compatible).
ALTER TABLE public.callback_requests
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

-- Index for "upcoming" lookups in admin UI (small, partial).
CREATE INDEX IF NOT EXISTS idx_callback_requests_scheduled_for
  ON public.callback_requests (workspace_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL
    AND status IN ('requested', 'scheduled', 'in_progress');

COMMENT ON COLUMN public.callback_requests.scheduled_for IS
  'Visitor-chosen callback time. NULL = immediate. Phase 8E.';