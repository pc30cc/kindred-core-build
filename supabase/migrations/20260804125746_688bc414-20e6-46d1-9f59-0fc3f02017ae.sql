CREATE TABLE IF NOT EXISTS public.team_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_messages_ws_pair_idx ON public.team_messages (workspace_id, sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS team_messages_ws_recipient_unread_idx ON public.team_messages (workspace_id, recipient_id) WHERE read_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.team_messages TO authenticated;
GRANT ALL ON public.team_messages TO service_role;

ALTER TABLE public.team_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_messages_select_participants"
ON public.team_messages FOR SELECT TO authenticated
USING (
  public.is_workspace_member(workspace_id, auth.uid())
  AND (sender_id = auth.uid() OR recipient_id = auth.uid())
);

CREATE POLICY "team_messages_insert_sender"
ON public.team_messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND public.is_workspace_member(workspace_id, auth.uid())
  AND public.is_workspace_member(workspace_id, recipient_id)
);

CREATE POLICY "team_messages_update_recipient"
ON public.team_messages FOR UPDATE TO authenticated
USING (recipient_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()))
WITH CHECK (recipient_id = auth.uid());

ALTER PUBLICATION supabase_realtime ADD TABLE public.team_messages;