
CREATE TABLE IF NOT EXISTS public.ai_agent_debug_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  run_id uuid NULL REFERENCES public.ai_agent_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_user_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_debug_events_ws_created
  ON public.ai_agent_debug_events (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_debug_events_run
  ON public.ai_agent_debug_events (run_id);

ALTER TABLE public.ai_agent_debug_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_debug_events_member_read" ON public.ai_agent_debug_events;
CREATE POLICY "ai_debug_events_member_read"
ON public.ai_agent_debug_events FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.workspace_members wm
  WHERE wm.workspace_id = ai_agent_debug_events.workspace_id
    AND wm.user_id = auth.uid()
));

DROP POLICY IF EXISTS "ai_debug_events_admin_insert" ON public.ai_agent_debug_events;
CREATE POLICY "ai_debug_events_admin_insert"
ON public.ai_agent_debug_events FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.workspace_members wm
  WHERE wm.workspace_id = ai_agent_debug_events.workspace_id
    AND wm.user_id = auth.uid()
    AND wm.role IN ('owner','admin')
));
