-- =========================================================
-- 1. Fix mutable search_path on the 4 remaining functions
-- =========================================================
ALTER FUNCTION public.ai_kb_set_updated_at() SET search_path = public;
ALTER FUNCTION public.cc_touch_updated_at() SET search_path = public;
ALTER FUNCTION public.touch_ai_agent_test_cases_updated_at() SET search_path = public;
ALTER FUNCTION public.touch_ai_source_sync_jobs() SET search_path = public;

-- =========================================================
-- 2. Security definer view -> security invoker
-- =========================================================
ALTER VIEW public.billing_plans_public SET (security_invoker = on);

-- =========================================================
-- 3. RLS: remove overly broad read policies
-- =========================================================

-- platform_call_center_settings: was readable by anyone incl. anon
DROP POLICY IF EXISTS "pcc_read_anyone" ON public.platform_call_center_settings;
CREATE POLICY "pcc_read_authenticated"
  ON public.platform_call_center_settings
  FOR SELECT TO authenticated
  USING (true);
REVOKE SELECT ON public.platform_call_center_settings FROM anon;

-- widget_platform_settings: drop the anon read policy
DROP POLICY IF EXISTS "Anon can read widget platform settings" ON public.widget_platform_settings;
REVOKE SELECT ON public.widget_platform_settings FROM anon;

-- workspace_domains: drop cross-tenant "USING (true)" read policy.
-- The membership-scoped "Members can view domains" policy remains.
DROP POLICY IF EXISTS "Authenticated users can view domains" ON public.workspace_domains;

-- =========================================================
-- 4. Narrow the public widget settings RPC to safe fields only
-- =========================================================
CREATE OR REPLACE FUNCTION public.get_widget_platform_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'max_message_length', s.max_message_length,
    'rate_limit_messages_per_minute', s.rate_limit_messages_per_minute,
    'default_welcome_message', s.default_welcome_message,
    'realtime_reconnect_jitter_pct', s.realtime_reconnect_jitter_pct,
    'realtime_pending_max', s.realtime_pending_max,
    'realtime_message_dedupe_enabled', s.realtime_message_dedupe_enabled,
    'realtime_message_dedupe_window', s.realtime_message_dedupe_window
  )
  FROM public.widget_platform_settings s
  LIMIT 1;
$$;

-- =========================================================
-- 5. Lock down EXECUTE on SECURITY DEFINER functions
-- =========================================================

-- 5a. Trigger helper functions: never callable via the API.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.apply_storage_usage_log()',
    'public.enforcement_rules_protect_builtin()',
    'public.handle_new_user()',
    'public.protect_workspace_domain_fields()',
    'public.set_conversation_notes_updated_at()',
    'public.slo_definitions_protect_builtin()',
    'public.tg_call_sessions_bill_minutes()',
    'public.tg_visitor_sessions_count_visitor()',
    'public.validate_widget_template_slug()',
    'public.workspaces_auto_register_owner_domain()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END $$;

-- 5b. Backend/service-only functions: revoke anon + authenticated,
--     grant to service_role (the Express server uses the service key).
--     Every signature is classified by the provenance audit; the manifest is
--     resolved through to_regprocedure(), and a REQUIRED_BEFORE_ACL signature
--     that is missing is a hard failure (no silent skip, no swallowed
--     exception). All 22 signatures below are created by migrations that sort
--     before this file, so all are REQUIRED_BEFORE_ACL.
DO $service_acl$
DECLARE
  item record;
  fn_oid regprocedure;
BEGIN
  FOR item IN
    SELECT *
    FROM (
      VALUES
        ('public.activate_auto_actions()', 'REQUIRED_BEFORE_ACL'),
        ('public.business_metrics_rollup_and_prune()', 'REQUIRED_BEFORE_ACL'),
        ('public.cleanup_expired_auth_tokens()', 'REQUIRED_BEFORE_ACL'),
        ('public.cleanup_expired_widget_identity()', 'REQUIRED_BEFORE_ACL'),
        ('public.evaluate_alert_rules()', 'REQUIRED_BEFORE_ACL'),
        ('public.expire_stale_trials()', 'REQUIRED_BEFORE_ACL'),
        ('public.perf_metrics_rollup_and_prune()', 'REQUIRED_BEFORE_ACL'),
        ('public.realtime_metrics_rollup_and_prune()', 'REQUIRED_BEFORE_ACL'),
        ('public.sla_reliability_rollup_and_prune()', 'REQUIRED_BEFORE_ACL'),
        ('public.workspace_health_snapshot_compute()', 'REQUIRED_BEFORE_ACL'),
        ('public.admin_list_realtime_audit(integer)', 'REQUIRED_BEFORE_ACL'),
        ('public.count_recent_login_failures(text, text, integer)', 'REQUIRED_BEFORE_ACL'),
        ('public.is_ip_blocked(text)', 'REQUIRED_BEFORE_ACL'),
        ('public.deduct_ai_credits(uuid, integer, text)', 'REQUIRED_BEFORE_ACL'),
        ('public.increment_usage_counter(uuid, text, integer)', 'REQUIRED_BEFORE_ACL'),
        ('public.merge_visitor_into_contact(uuid, text, uuid, text, jsonb)', 'REQUIRED_BEFORE_ACL'),
        ('public.resolve_privacy_subject(uuid, text, text)', 'REQUIRED_BEFORE_ACL'),
        ('public.register_workspace_domain(uuid, text, boolean)', 'REQUIRED_BEFORE_ACL'),
        ('public.bulk_create_contacts(uuid, jsonb)', 'REQUIRED_BEFORE_ACL'),
        ('public.create_contact(uuid, text, text, text, text, text[], text, jsonb)', 'REQUIRED_BEFORE_ACL'),
        ('public.check_channel_access(uuid, text)', 'REQUIRED_BEFORE_ACL'),
        ('public.kb_search_articles(uuid, text, text, integer)', 'REQUIRED_BEFORE_ACL')
    ) AS v(signature, classification)
  LOOP
    fn_oid := to_regprocedure(item.signature);

    IF fn_oid IS NULL THEN
      IF item.classification = 'REQUIRED_BEFORE_ACL' THEN
        RAISE EXCEPTION
          'required function missing before ACL migration: %', item.signature;
      END IF;

      RAISE NOTICE
        'optional/later function absent at this point: % (%)',
        item.signature, item.classification;

      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn_oid);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn_oid);
  END LOOP;
END
$service_acl$;

-- 5c. Functions the signed-in app legitimately calls from the browser:
--     revoke anon (and PUBLIC), keep authenticated + service_role.
--     Each of these already enforces its own admin/membership check.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.admin_count_profiles()',
    'public.admin_count_workspaces()',
    'public.admin_delete_workspace(uuid)',
    'public.admin_get_user_detail(uuid)',
    'public.admin_get_workspace_detail(uuid)',
    'public.admin_list_login_attempts(text, integer)',
    'public.admin_list_profiles(integer, integer, text, text)',
    'public.admin_list_workspaces(integer, integer)',
    'public.admin_list_workspaces(integer, integer, text, text)',
    'public.admin_security_stats()',
    'public.bootstrap_admin(uuid)',
    'public.check_module_access(uuid, text)',
    'public.check_workspace_entitlement(uuid, text)',
    'public.create_workspace_atomic(uuid, text, text, uuid)',
    'public.provision_account_on_signup(uuid)',
    'public.mark_conversation_seen(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;
