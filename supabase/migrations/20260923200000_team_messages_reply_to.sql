-- Colleagues chat: a message can answer an earlier one of the same pair.
-- The app shows the quoted message above the reply. Additive and re-runnable.
ALTER TABLE public.team_messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid NULL REFERENCES public.team_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS team_messages_reply_to_idx
  ON public.team_messages (reply_to_id)
  WHERE reply_to_id IS NOT NULL;
