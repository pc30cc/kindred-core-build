CREATE TABLE IF NOT EXISTS public.operator_activity_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bucket timestamptz NOT NULL,
  available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_operator_activity_ws_bucket
  ON public.operator_activity_samples (workspace_id, bucket DESC);
CREATE INDEX IF NOT EXISTS idx_operator_activity_user_bucket
  ON public.operator_activity_samples (user_id, bucket DESC);

GRANT SELECT ON public.operator_activity_samples TO authenticated;
GRANT ALL ON public.operator_activity_samples TO service_role;

ALTER TABLE public.operator_activity_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read workspace operator activity"
  ON public.operator_activity_samples FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));