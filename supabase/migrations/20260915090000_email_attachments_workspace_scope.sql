-- 20260915090000 — Email attachment storage-key workspace scoping.
--
-- Storage ownership standardization (docs/STORAGE_ARCHITECTURE_AUDIT.md):
-- email_attachments had no workspace_id column of its own — the only path
-- to a workspace was message_id -> email_messages.workspace_id, so nothing
-- in the database could ever verify that an attachment's storage_key
-- actually belongs to the workspace that owns its message. This mirrors
-- the same gap conversation_attachments already closed with its
-- conversation_attachments_path_scope_check constraint.
--
-- Denormalizes workspace_id directly onto email_attachments (backfilled
-- from the existing message_id join, then made NOT NULL — every row has a
-- message_id and every email_messages row has a NOT NULL workspace_id, so
-- the backfill is total) and adds a matching CHECK constraint. The CHECK
-- allows both the canonical workspace/<id>/attachments/email/... shape
-- (server/services/storage/keys.ts's emailAttachmentKey()) and the known
-- pre-migration email-attachments/<id>/... legacy shape that
-- isKnownLegacyStorageKey() still recognizes for objects written before
-- the email-attachments/ -> canonical key migration, until the legacy
-- migration tool (docs/STORAGE_ARCHITECTURE_AUDIT.md) rewrites them.

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
    RAISE EXCEPTION 'email_attachments.workspace_id backfill left NULL rows — orphaned message_id?';
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

COMMENT ON COLUMN public.email_attachments.workspace_id IS
  'Denormalized from email_messages.workspace_id at write time — lets the database itself verify storage_key is scoped to the right workspace (email_attachments_path_scope_check) independent of the message_id join.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'email_attachments' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'email_attachments.workspace_id column missing after migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_attachments_path_scope_check') THEN
    RAISE EXCEPTION 'email_attachments_path_scope_check constraint missing after migration';
  END IF;
END
$verify$;
