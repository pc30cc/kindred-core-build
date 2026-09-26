-- Hosted chain only: deduct_ai_credits() and the ai_usage_logs trigger below
-- exist nowhere in database/migrations.
--
-- deduct_ai_credits() moves AI credits and no longer counts the request.
--
-- It also added 1 to workspace_usage_counters.ai_requests_count, but every AI
-- completion already writes one ai_usage_logs row (success or failure), and
-- trg_ai_usage_logs_count_request counts that row (20260901084743). Both
-- callers of this function -- POST /api/ai/complete and the AI-KB builder --
-- complete through that path, so each of their requests was counted twice.
-- The counter is informational (PlanUsagePanel) and gates nothing;
-- ai_credits_used, which the plan limit is enforced on, was always right.
--
-- The body is the one production runs (20260415220905) minus that single
-- assignment. CREATE OR REPLACE keeps the function's ACL; it is restated
-- here so this file does not rely on the migrations before it having set it.

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

  -- Deduct. The request is counted by the ai_usage_logs row it writes.
  UPDATE workspace_usage_counters
  SET ai_credits_used = ai_credits_used + _credits,
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

REVOKE ALL ON FUNCTION public.deduct_ai_credits(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_ai_credits(uuid, integer, text) TO service_role;
