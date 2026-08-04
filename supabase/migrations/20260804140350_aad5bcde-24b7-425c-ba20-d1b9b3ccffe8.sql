CREATE TABLE public.workspace_alert_dismissals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  alert_key TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_until TIMESTAMPTZ,
  UNIQUE (workspace_id, user_id, alert_key)
);

CREATE INDEX idx_wad_lookup ON public.workspace_alert_dismissals (workspace_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_alert_dismissals TO authenticated;
GRANT ALL ON public.workspace_alert_dismissals TO service_role;

ALTER TABLE public.workspace_alert_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wad_own_rows" ON public.workspace_alert_dismissals
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());