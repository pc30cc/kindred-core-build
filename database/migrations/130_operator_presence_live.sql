-- ============================================================
-- Live operator presence (self-host mirror). Forward-only, idempotent.
--
-- WHY: `operator_activity_samples` is an ANALYTICS table — one row per
-- (workspace, user, 5-minute bucket). Reading it as a liveness signal made
-- a continuously-connected operator flicker to "not_connected" between
-- buckets (bucket timestamp ages past the liveness window before the next
-- bucket is written). Live presence now has its own single-row-per-operator
-- table: bounded size, UPSERT-only, no history growth.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.operator_presence_live (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_presence_live_ws_seen
  ON public.operator_presence_live (workspace_id, last_seen_at DESC);

GRANT SELECT ON public.operator_presence_live TO authenticated;
GRANT ALL ON public.operator_presence_live TO service_role;

ALTER TABLE public.operator_presence_live ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'operator_presence_live'
      AND policyname = 'members read workspace live presence'
  ) THEN
    CREATE POLICY "members read workspace live presence"
      ON public.operator_presence_live FOR SELECT TO authenticated
      USING (public.is_workspace_member(workspace_id, auth.uid()));
  END IF;
END $$;
