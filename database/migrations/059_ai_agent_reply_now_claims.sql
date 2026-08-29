-- AI Agent — durable, multi-process idempotency for "AI Reply Now".
--
-- "AI Reply Now" produces a real visitor-facing AI message, so collapsing
-- duplicate clicks/retries cannot rely on a per-process in-memory Map: two
-- Core replicas behind a load balancer would each generate a reply.
--
-- The PRIMARY KEY insert is the mutual-exclusion primitive: exactly one
-- caller wins the claim, everybody else observes 'running' or 'completed'.
-- A 'failed' or expired 'running' claim may be re-claimed by exactly one
-- retrying caller via a conditional UPDATE ... RETURNING, so a crashed
-- process never permanently blocks a legitimate retry.

CREATE TABLE IF NOT EXISTS public.ai_agent_reply_now_claims (
  claim_key text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  operation text NOT NULL DEFAULT 'ai_reply_now',
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  result jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reply_now_claims_scope
  ON public.ai_agent_reply_now_claims(workspace_id, conversation_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ai_reply_now_claims_expiry
  ON public.ai_agent_reply_now_claims(expires_at);

GRANT ALL ON public.ai_agent_reply_now_claims TO service_role;

ALTER TABLE public.ai_agent_reply_now_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages ai reply now claims" ON public.ai_agent_reply_now_claims;
CREATE POLICY "Service role manages ai reply now claims"
  ON public.ai_agent_reply_now_claims
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
