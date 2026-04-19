
-- Phase 4 schema (pre-approved): conversation_notes + conversation_events
-- Used by Phase 3 (events for status/priority/assignee/tags/resolve/reopen)
-- and Phase 4 (notes UI + activity timeline).

-- ─── conversation_notes — operator-only internal notes ─────────────
CREATE TABLE IF NOT EXISTS public.conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_conv
  ON public.conversation_notes(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_workspace
  ON public.conversation_notes(workspace_id);

ALTER TABLE public.conversation_notes ENABLE ROW LEVEL SECURITY;

-- Workspace members can read notes
CREATE POLICY "Members can view notes"
  ON public.conversation_notes
  FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Workspace members can insert their own notes
CREATE POLICY "Members can insert notes"
  ON public.conversation_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_workspace_member(workspace_id, auth.uid())
    AND author_id = auth.uid()
  );

-- Authors can update their own notes
CREATE POLICY "Authors can update own notes"
  ON public.conversation_notes
  FOR UPDATE
  TO authenticated
  USING (author_id = auth.uid() AND is_workspace_member(workspace_id, auth.uid()));

-- Authors or workspace admins/owners can delete notes
CREATE POLICY "Authors or admins can delete notes"
  ON public.conversation_notes
  FOR DELETE
  TO authenticated
  USING (
    (author_id = auth.uid() AND is_workspace_member(workspace_id, auth.uid()))
    OR get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])
  );

-- Service role full access (server-side mutations)
CREATE POLICY "Service role full access notes"
  ON public.conversation_notes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_conversation_notes_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_notes_updated_at ON public.conversation_notes;
CREATE TRIGGER trg_conversation_notes_updated_at
  BEFORE UPDATE ON public.conversation_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_conversation_notes_updated_at();

-- ─── conversation_events — UI-optimized activity timeline ──────────
CREATE TABLE IF NOT EXISTS public.conversation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_conv
  ON public.conversation_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_events_workspace
  ON public.conversation_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_conversation_events_type
  ON public.conversation_events(event_type);

ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;

-- Workspace members can read timeline events
CREATE POLICY "Members can view conv events"
  ON public.conversation_events
  FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Service role only writes (server-side via recordConversationEvent)
CREATE POLICY "Service role full access conv events"
  ON public.conversation_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
