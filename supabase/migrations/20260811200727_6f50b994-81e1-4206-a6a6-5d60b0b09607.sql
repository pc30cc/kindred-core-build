CREATE TABLE IF NOT EXISTS public.ai_agent_action_claims (
  idempotency_key text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  action_name text NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_action_claims_conv
  ON public.ai_agent_action_claims(conversation_id, created_at DESC);

GRANT ALL ON public.ai_agent_action_claims TO service_role;

ALTER TABLE public.ai_agent_action_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages ai action claims" ON public.ai_agent_action_claims;
CREATE POLICY "Service role manages ai action claims"
  ON public.ai_agent_action_claims
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);