CREATE TABLE IF NOT EXISTS public.realtime_failover_state (
  id text PRIMARY KEY DEFAULT 'singleton',
  effective_provider text NOT NULL DEFAULT 'centrifugo',
  last_failover_at timestamptz,
  last_failover_reason text,
  candidate_recovery_provider text,
  candidate_recovery_since timestamptz,
  failback_eligible_at timestamptz,
  cooldown_until timestamptz,
  last_health jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_evaluated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_failover_state_singleton CHECK (id = 'singleton')
);

ALTER TABLE public.realtime_failover_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read failover state" ON public.realtime_failover_state;
CREATE POLICY "Admins can read failover state"
  ON public.realtime_failover_state
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.realtime_failover_state (id, effective_provider)
VALUES ('singleton', 'centrifugo')
ON CONFLICT (id) DO NOTHING;