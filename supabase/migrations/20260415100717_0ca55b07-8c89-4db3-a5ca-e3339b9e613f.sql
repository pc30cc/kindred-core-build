ALTER TABLE public.workspace_invitations ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE public.workspace_invitations ALTER COLUMN expires_at DROP DEFAULT;