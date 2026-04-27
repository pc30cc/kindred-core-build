-- Add call end metadata fields used by the new end-call propagation flow.
-- All columns are nullable so existing rows remain valid; backend is the
-- single writer and treats absence as "no termination metadata yet".

ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_by TEXT,
  ADD COLUMN IF NOT EXISTS ended_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS end_reason TEXT;

-- Soft constraint via CHECK (immutable predicate is fine — pure enum check).
ALTER TABLE public.call_sessions
  DROP CONSTRAINT IF EXISTS call_sessions_ended_by_check;
ALTER TABLE public.call_sessions
  ADD CONSTRAINT call_sessions_ended_by_check
  CHECK (ended_by IS NULL OR ended_by IN ('operator','visitor','system'));

ALTER TABLE public.call_sessions
  DROP CONSTRAINT IF EXISTS call_sessions_end_reason_check;
ALTER TABLE public.call_sessions
  ADD CONSTRAINT call_sessions_end_reason_check
  CHECK (end_reason IS NULL OR end_reason IN ('operator_ended','visitor_ended','system_ended','failed'));
