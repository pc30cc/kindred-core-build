ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS visitor_code text;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_visitor_code_idx
  ON public.contacts (workspace_id, visitor_code)
  WHERE visitor_code IS NOT NULL;