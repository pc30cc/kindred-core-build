CREATE TYPE public.call_invitation_status AS ENUM (
  'pending',
  'joined',
  'expired',
  'cancelled',
  'declined'
);

CREATE TYPE public.call_invitation_channel AS ENUM ('audio', 'video');

CREATE TABLE public.call_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL,
  visitor_session_id uuid NULL,
  created_by_user_id uuid NOT NULL,
  channel public.call_invitation_channel NOT NULL,
  status public.call_invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  joined_at timestamptz NULL,
  ended_at timestamptz NULL,
  cancel_reason text NULL,
  call_session_id uuid NULL REFERENCES public.call_sessions(id) ON DELETE SET NULL,
  system_message_id uuid NULL REFERENCES public.conversation_messages(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_invitations_workspace_status
  ON public.call_invitations (workspace_id, status, expires_at);
CREATE INDEX idx_call_invitations_conversation
  ON public.call_invitations (conversation_id, created_at DESC);
CREATE INDEX idx_call_invitations_pending_expiry
  ON public.call_invitations (expires_at)
  WHERE status = 'pending';
CREATE INDEX idx_call_invitations_session
  ON public.call_invitations (call_session_id)
  WHERE call_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_call_invitations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_call_invitations_updated_at
BEFORE UPDATE ON public.call_invitations
FOR EACH ROW
EXECUTE FUNCTION public.set_call_invitations_updated_at();

ALTER TABLE public.call_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can read call invitations"
ON public.call_invitations
FOR SELECT
TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));
