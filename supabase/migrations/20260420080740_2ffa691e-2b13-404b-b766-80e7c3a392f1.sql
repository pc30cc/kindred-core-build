-- Lightweight append-only page-view history per visitor session.
-- Used by the Visitor Intelligence drawer to render a session journey.
-- Backed by visitor_sessions(id) so RLS can defer to existing membership check.
CREATE TABLE IF NOT EXISTS public.visitor_page_views (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_session_id UUID NOT NULL REFERENCES public.visitor_sessions(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_page_views_session_time
  ON public.visitor_page_views(visitor_session_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_visitor_page_views_workspace_time
  ON public.visitor_page_views(workspace_id, viewed_at DESC);

ALTER TABLE public.visitor_page_views ENABLE ROW LEVEL SECURITY;

-- Operators (workspace members) can read their workspace's history.
CREATE POLICY "Members can view page views"
  ON public.visitor_page_views FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Anonymous widget cannot read; writes happen via service role from the
-- backend track/heartbeat endpoints, which already validate origin + workspace
-- tracking flag. No anon write policy is needed (service role bypasses RLS).