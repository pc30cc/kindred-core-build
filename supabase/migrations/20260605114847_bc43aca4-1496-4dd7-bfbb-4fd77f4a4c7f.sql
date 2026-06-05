CREATE TABLE IF NOT EXISTS public.call_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  call_session_id UUID NOT NULL,
  visitor_id UUID,
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_session_id)
);

GRANT SELECT ON public.call_ratings TO authenticated;
GRANT ALL ON public.call_ratings TO service_role;

ALTER TABLE public.call_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can read ratings"
  ON public.call_ratings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = call_ratings.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_call_ratings_workspace ON public.call_ratings(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_ratings_call ON public.call_ratings(call_session_id);