ALTER TABLE public.workspace_branding
  ADD COLUMN IF NOT EXISTS contact_info JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.workspace_branding.contact_info IS
  'Public contact channels for the workspace: { phone, messenger, telegram, twitter, whatsapp, instagram }. Used by the Workspace Information settings screen.';
