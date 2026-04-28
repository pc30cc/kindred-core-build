-- 1) Ensure paid plans expose `knowledge_base` and `ai_kb_builder` entitlements.
--    Free plan stays strict (knowledge_base true, ai_kb_builder false).
UPDATE billing_plans
SET entitlements = entitlements
  || jsonb_build_object('knowledge_base', true)
  || jsonb_build_object('ai_kb_builder', true)
WHERE slug IN ('pro', 'business', 'enterprise')
  AND is_active = true;

-- Free already has knowledge_base:true and ai_kb_builder:false — leave it.
-- Make sure key exists explicitly even if missing:
UPDATE billing_plans
SET entitlements = entitlements
  || CASE WHEN entitlements ? 'knowledge_base' THEN '{}'::jsonb
          ELSE jsonb_build_object('knowledge_base', true) END
  || CASE WHEN entitlements ? 'ai_kb_builder'  THEN '{}'::jsonb
          ELSE jsonb_build_object('ai_kb_builder', false) END
WHERE slug = 'free' AND is_active = true;

-- 2) Admin override columns on ai_kb_jobs for diagnostic / test jobs created
--    by global admins. Worker uses these to relax monthly-limit checks.
ALTER TABLE public.ai_kb_jobs
  ADD COLUMN IF NOT EXISTS admin_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by_global_admin uuid NULL;

-- 3) Audit log table for global-admin gate bypass events.
CREATE TABLE IF NOT EXISTS public.admin_gate_bypass_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid NULL,
  module_key text NOT NULL,
  route text NOT NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_gate_bypass_log ENABLE ROW LEVEL SECURITY;

-- Only global admins can read this audit table from clients.
DROP POLICY IF EXISTS "admins_read_gate_bypass" ON public.admin_gate_bypass_log;
CREATE POLICY "admins_read_gate_bypass"
ON public.admin_gate_bypass_log
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- No public insert: writes happen only via service role from backend.

CREATE INDEX IF NOT EXISTS idx_admin_gate_bypass_log_user
  ON public.admin_gate_bypass_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_gate_bypass_log_ws
  ON public.admin_gate_bypass_log(workspace_id, created_at DESC);
