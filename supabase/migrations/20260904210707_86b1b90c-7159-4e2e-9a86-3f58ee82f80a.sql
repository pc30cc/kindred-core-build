ALTER TABLE public.operator_presence_fallback_state
  ADD COLUMN IF NOT EXISTS roster_complete boolean NOT NULL DEFAULT false;