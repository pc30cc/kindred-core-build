-- Phase 6a: Conversation attachments
-- Provider-agnostic metadata table. All files live under
-- workspace/{workspace_id}/attachments/... in the active Storage Provider.
-- Backend is the only authority for storage_path; widget never picks it.

CREATE TABLE IF NOT EXISTS public.conversation_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id UUID NULL REFERENCES public.conversation_messages(id) ON DELETE SET NULL,

  storage_provider TEXT NOT NULL,        -- e.g. 'bunny_storage' | 's3' | 'local'
  storage_path TEXT NOT NULL,            -- always begins with 'workspace/{workspace_id}/attachments/'
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,

  uploaded_by_type TEXT NOT NULL,        -- 'visitor' | 'contact' | 'agent' | 'system'
  uploaded_by_id UUID NULL,
  visitor_session_id UUID NULL,

  status TEXT NOT NULL DEFAULT 'uploading',  -- 'uploading' | 'uploaded' | 'attached' | 'failed'
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ NULL,

  CONSTRAINT conversation_attachments_status_check
    CHECK (status IN ('uploading','uploaded','attached','failed')),
  CONSTRAINT conversation_attachments_uploader_check
    CHECK (uploaded_by_type IN ('visitor','contact','agent','system')),
  -- Hard guarantee: storage path is always workspace-scoped
  CONSTRAINT conversation_attachments_path_scope_check
    CHECK (storage_path LIKE 'workspace/' || workspace_id::text || '/attachments/%')
);

CREATE INDEX IF NOT EXISTS idx_conversation_attachments_workspace ON public.conversation_attachments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_conversation ON public.conversation_attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_message ON public.conversation_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_status ON public.conversation_attachments(status);

ALTER TABLE public.conversation_attachments ENABLE ROW LEVEL SECURITY;

-- All visitor-side reads/writes go through the server using the service role
-- (widget token + conversation ownership are validated in Express). Authenticated
-- workspace members may read attachments for their own workspace via dashboard.

CREATE POLICY "Workspace members can read attachments"
ON public.conversation_attachments
FOR SELECT
TO authenticated
USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace admins can delete attachments"
ON public.conversation_attachments
FOR DELETE
TO authenticated
USING (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role]));

CREATE POLICY "Service role full access attachments"
ON public.conversation_attachments
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Widget settings: minimal config for attachment UX (admin-controlled)
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS attachments_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attachments_max_size_mb INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS attachments_allowed_mimes TEXT[] NOT NULL
    DEFAULT ARRAY[
      'image/png','image/jpeg','image/webp','image/gif',
      'application/pdf','text/plain'
    ];