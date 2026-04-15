
-- ═══════════════════════════════════════════════════════════════
-- 1. Workspace Usage Counters
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.workspace_usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period text NOT NULL DEFAULT to_char(now(), 'YYYY-MM'),
  messages_count integer NOT NULL DEFAULT 0,
  ai_requests_count integer NOT NULL DEFAULT 0,
  ai_credits_used integer NOT NULL DEFAULT 0,
  ai_credits_balance integer NOT NULL DEFAULT 0,
  visitors_count integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  conversations_count integer NOT NULL DEFAULT 0,
  email_sent_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, period)
);

ALTER TABLE public.workspace_usage_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace admins can view own usage"
  ON public.workspace_usage_counters FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can manage all usage"
  ON public.workspace_usage_counters FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- ═══════════════════════════════════════════════════════════════
-- 2. Workspace Module Overrides
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.workspace_module_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  admin_notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, module_key)
);

ALTER TABLE public.workspace_module_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace admins can view own module overrides"
  ON public.workspace_module_overrides FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can manage module overrides"
  ON public.workspace_module_overrides FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- ═══════════════════════════════════════════════════════════════
-- 3. Workspace Channel Overrides
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.workspace_channel_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  admin_notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, channel_key)
);

ALTER TABLE public.workspace_channel_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace admins can view own channel overrides"
  ON public.workspace_channel_overrides FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can manage channel overrides"
  ON public.workspace_channel_overrides FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- ═══════════════════════════════════════════════════════════════
-- 4. Plan Change Log
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.plan_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  old_plan_id uuid REFERENCES public.billing_plans(id),
  new_plan_id uuid REFERENCES public.billing_plans(id),
  change_type text NOT NULL DEFAULT 'upgrade',
  changed_by uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.plan_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace admins can view own plan changes"
  ON public.plan_change_log FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can manage plan changes"
  ON public.plan_change_log FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- ═══════════════════════════════════════════════════════════════
-- 5. AI Credit Deduction Function (atomic, fail-closed)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.deduct_ai_credits(
  _workspace_id uuid,
  _credits integer DEFAULT 1,
  _period text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _current_period text;
  _row workspace_usage_counters%ROWTYPE;
  _plan_limit integer;
  _entitlement_result jsonb;
BEGIN
  _current_period := COALESCE(_period, to_char(now(), 'YYYY-MM'));

  -- Ensure counter row exists
  INSERT INTO workspace_usage_counters (workspace_id, period)
  VALUES (_workspace_id, _current_period)
  ON CONFLICT (workspace_id, period) DO NOTHING;

  -- Lock row for atomic update
  SELECT * INTO _row FROM workspace_usage_counters
  WHERE workspace_id = _workspace_id AND period = _current_period
  FOR UPDATE;

  -- Get plan limit
  _entitlement_result := check_workspace_entitlement(_workspace_id, 'ai_credits');

  IF NOT (_entitlement_result->>'allowed')::boolean THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'ai_not_allowed',
      'credits_used', _row.ai_credits_used
    );
  END IF;

  _plan_limit := COALESCE((_entitlement_result->>'limit')::integer, 0);

  -- -1 means unlimited
  IF _plan_limit != -1 AND (_row.ai_credits_used + _credits) > _plan_limit THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'credits_exhausted',
      'credits_used', _row.ai_credits_used,
      'credits_limit', _plan_limit
    );
  END IF;

  -- Deduct
  UPDATE workspace_usage_counters
  SET ai_credits_used = ai_credits_used + _credits,
      ai_requests_count = ai_requests_count + 1,
      updated_at = now()
  WHERE workspace_id = _workspace_id AND period = _current_period;

  RETURN jsonb_build_object(
    'success', true,
    'credits_used', _row.ai_credits_used + _credits,
    'credits_limit', _plan_limit,
    'credits_remaining', CASE WHEN _plan_limit = -1 THEN -1 ELSE _plan_limit - (_row.ai_credits_used + _credits) END
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 6. Check Module Access (plan + override, fail-closed)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_module_access(
  _workspace_id uuid,
  _module_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _override workspace_module_overrides%ROWTYPE;
  _entitlement jsonb;
BEGIN
  -- Check workspace-level override first
  SELECT * INTO _override FROM workspace_module_overrides
  WHERE workspace_id = _workspace_id AND module_key = _module_key;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', _override.enabled, 'source', 'override');
  END IF;

  -- Fall back to plan entitlement
  _entitlement := check_workspace_entitlement(_workspace_id, _module_key);
  RETURN jsonb_build_object(
    'allowed', COALESCE((_entitlement->>'allowed')::boolean, false),
    'source', 'plan',
    'plan', _entitlement->>'plan'
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 7. Check Channel Access (plan + override, fail-closed)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_channel_access(
  _workspace_id uuid,
  _channel_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _override workspace_channel_overrides%ROWTYPE;
  _entitlement jsonb;
BEGIN
  -- Check workspace-level override first
  SELECT * INTO _override FROM workspace_channel_overrides
  WHERE workspace_id = _workspace_id AND channel_key = _channel_key;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', _override.enabled, 'source', 'override');
  END IF;

  -- Fall back to plan entitlement
  _entitlement := check_workspace_entitlement(_workspace_id, _channel_key);
  RETURN jsonb_build_object(
    'allowed', COALESCE((_entitlement->>'allowed')::boolean, false),
    'source', 'plan',
    'plan', _entitlement->>'plan'
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 8. Increment Usage Counter Helper
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.increment_usage_counter(
  _workspace_id uuid,
  _counter_name text,
  _amount integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _current_period text;
BEGIN
  _current_period := to_char(now(), 'YYYY-MM');

  INSERT INTO workspace_usage_counters (workspace_id, period)
  VALUES (_workspace_id, _current_period)
  ON CONFLICT (workspace_id, period) DO NOTHING;

  EXECUTE format(
    'UPDATE workspace_usage_counters SET %I = %I + $1, updated_at = now() WHERE workspace_id = $2 AND period = $3',
    _counter_name, _counter_name
  ) USING _amount, _workspace_id, _current_period;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 9. Update admin_delete_workspace to include new tables
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_delete_workspace(_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = _workspace_id) THEN
    RAISE EXCEPTION 'Workspace not found';
  END IF;

  DELETE FROM plan_change_log WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_channel_overrides WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_module_overrides WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_usage_counters WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_subscriptions WHERE workspace_id = _workspace_id;
  DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = _workspace_id);
  DELETE FROM conversations WHERE workspace_id = _workspace_id;
  DELETE FROM contacts WHERE workspace_id = _workspace_id;
  DELETE FROM visitor_presence WHERE workspace_id = _workspace_id;
  DELETE FROM visitor_sessions WHERE workspace_id = _workspace_id;
  DELETE FROM widget_settings WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_branding WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_branding_localized WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_domains WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_domains_extended WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_settings WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_members WHERE workspace_id = _workspace_id;
  DELETE FROM knowledge_base_articles WHERE workspace_id = _workspace_id;
  DELETE FROM knowledge_base_categories WHERE workspace_id = _workspace_id;
  DELETE FROM email_logs WHERE workspace_id = _workspace_id;
  DELETE FROM email_settings WHERE workspace_id = _workspace_id;
  DELETE FROM email_settings_localized WHERE workspace_id = _workspace_id;
  DELETE FROM email_templates WHERE workspace_id = _workspace_id;
  DELETE FROM provider_configs WHERE workspace_id = _workspace_id;
  DELETE FROM workspace_provider_settings WHERE workspace_id = _workspace_id;
  DELETE FROM audit_logs WHERE workspace_id = _workspace_id;
  DELETE FROM ai_usage_logs WHERE workspace_id = _workspace_id;
  DELETE FROM billing_payments WHERE workspace_id = _workspace_id;
  DELETE FROM billing_events WHERE workspace_id = _workspace_id;
  DELETE FROM feature_flags WHERE workspace_id = _workspace_id;
  DELETE FROM translations WHERE workspace_id = _workspace_id;
  DELETE FROM storage_usage_logs WHERE workspace_id = _workspace_id;
  DELETE FROM security_events WHERE workspace_id = _workspace_id;
  DELETE FROM workspaces WHERE id = _workspace_id;

  RETURN true;
END;
$$;
