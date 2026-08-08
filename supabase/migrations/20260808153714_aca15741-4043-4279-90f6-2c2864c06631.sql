ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS visitor_session_id uuid REFERENCES public.visitor_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_sessions_visitor_session_id_idx
  ON public.call_sessions (visitor_session_id)
  WHERE visitor_session_id IS NOT NULL;

UPDATE public.call_sessions cs
SET visitor_session_id = q.visitor_session_id
FROM public.call_queue_entries q
WHERE q.call_session_id = cs.id
  AND cs.visitor_session_id IS NULL
  AND q.visitor_session_id IS NOT NULL;