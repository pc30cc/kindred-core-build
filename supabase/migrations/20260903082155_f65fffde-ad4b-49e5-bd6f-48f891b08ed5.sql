ALTER TABLE public.team_messages
  ADD COLUMN IF NOT EXISTS attachment_id uuid NULL REFERENCES public.conversation_attachments(id) ON DELETE SET NULL;

ALTER TABLE public.team_messages ALTER COLUMN body SET DEFAULT '';

CREATE INDEX IF NOT EXISTS team_messages_attachment_id_idx
  ON public.team_messages (attachment_id) WHERE attachment_id IS NOT NULL;