ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS is_spam boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spam_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS spam_marked_by uuid;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS is_spam boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spam_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS spam_marked_by uuid;

CREATE INDEX IF NOT EXISTS idx_conversations_workspace_spam
  ON public.conversations (workspace_id, is_spam);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_spam
  ON public.contacts (workspace_id, is_spam);