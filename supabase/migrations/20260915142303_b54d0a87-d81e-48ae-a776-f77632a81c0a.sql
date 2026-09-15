ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_storage_key TEXT;

COMMENT ON COLUMN public.profiles.avatar_storage_key IS
  'Canonical storage object key for avatar_url, e.g. users/<id>/avatar/<uuid>.<ext>. NULL for legacy pre-migration rows whose key must be recovered by parsing avatar_url.';

ALTER TABLE public.email_attachments
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;

UPDATE public.email_attachments ea
SET workspace_id = em.workspace_id
FROM public.email_messages em
WHERE ea.message_id = em.id
  AND ea.workspace_id IS NULL;

DO $verify_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM public.email_attachments WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'email_attachments.workspace_id backfill left NULL rows';
  END IF;
END
$verify_backfill$;

ALTER TABLE public.email_attachments
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE public.email_attachments
  DROP CONSTRAINT IF EXISTS email_attachments_path_scope_check;

ALTER TABLE public.email_attachments
  ADD CONSTRAINT email_attachments_path_scope_check
    CHECK (
      storage_key LIKE 'workspace/' || workspace_id::text || '/attachments/email/%'
      OR storage_key LIKE 'email-attachments/' || workspace_id::text || '/%'
    );

CREATE INDEX IF NOT EXISTS idx_email_attachments_workspace ON public.email_attachments (workspace_id);

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_avatar_storage_key_scope_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_avatar_storage_key_scope_check
    CHECK (
      avatar_storage_key IS NULL
      OR avatar_storage_key LIKE 'users/' || id::text || '/avatar/%'
      OR avatar_storage_key LIKE 'avatars/' || id::text || '/%'
    );