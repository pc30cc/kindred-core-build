-- 018 — Canonical visitor-session relation for the Call Center.
--
-- `conversations`, `call_queue_entries` and `callback_requests` already point at
-- `visitor_sessions`, but `call_sessions` did not. Without it a call could only
-- be tied back to a visitor through the contact's *newest* session, which shows
-- the wrong IP/geo whenever the visitor has more than one session. This adds the
-- missing relation so every visitor-facing surface resolves the same session.

ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS visitor_session_id uuid REFERENCES public.visitor_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_sessions_visitor_session_id_idx
  ON public.call_sessions (visitor_session_id)
  WHERE visitor_session_id IS NOT NULL;

-- Backfill from the queue entry that produced the call (same visitor, same
-- session) so historical calls also resolve a network profile.
UPDATE public.call_sessions cs
SET visitor_session_id = q.visitor_session_id
FROM public.call_queue_entries q
WHERE q.call_session_id = cs.id
  AND cs.visitor_session_id IS NULL
  AND q.visitor_session_id IS NOT NULL;
