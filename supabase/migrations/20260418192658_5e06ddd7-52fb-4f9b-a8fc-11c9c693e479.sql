-- ════════════════════════════════════════════════════════════════════
-- Phase 3: Global Realtime Provider — Audit Trail
-- Records every change to the global realtime provider configuration
-- so admins can review historical state.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.realtime_provider_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_by UUID,
  action TEXT NOT NULL,                           -- 'configure' | 'remove' | 'test' | 'enable' | 'disable'
  vendor TEXT,                                    -- centrifugo | polling_builtin | disabled
  prev_vendor TEXT,
  config_diff JSONB DEFAULT '{}'::jsonb,          -- masked diff (no secrets)
  result TEXT,                                    -- 'success' | 'failed' | 'unknown'
  error_message TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_realtime_provider_audit_created
  ON public.realtime_provider_audit (created_at DESC);

ALTER TABLE public.realtime_provider_audit ENABLE ROW LEVEL SECURITY;

-- Only global admins can read; only service role inserts.
CREATE POLICY "admins_read_realtime_audit"
ON public.realtime_provider_audit
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Helper: list recent audit entries (admin-only)
CREATE OR REPLACE FUNCTION public.admin_list_realtime_audit(_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'action', a.action,
      'vendor', a.vendor,
      'prev_vendor', a.prev_vendor,
      'config_diff', a.config_diff,
      'result', a.result,
      'error_message', a.error_message,
      'changed_by', a.changed_by,
      'created_at', a.created_at
    ) ORDER BY a.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT * FROM realtime_provider_audit
      ORDER BY created_at DESC
      LIMIT _limit
    ) a
  );
END;
$$;