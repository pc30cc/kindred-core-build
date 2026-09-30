-- 238 — Self-host parity with the hosted chain.
--
-- WHY: database/migrations fell behind supabase/migrations. A database built
-- from this chain alone was missing objects the server calls on every request
-- — `is_ip_blocked` first among them, so every API request answered
-- 503 IP_CHECK_UNAVAILABLE — plus 100+ tables (conversation_attachments,
-- conversation_events, role_permissions, …), 110+ functions
-- (check_workspace_entitlement, mark_conversation_seen, claim_conversation, …),
-- their indexes, constraints, triggers and RLS policies, the columns the
-- hosted chain added to shared tables, and the seed rows hosted migrations
-- insert (role_permissions, billing_plans, alert_rules, platform settings, …).
-- It also still carried anon-facing policies the hosted chain removed in
-- April 2026 — among them "Public can read runtime config", which let an
-- anonymous PostgREST caller read app_runtime_config (provider credentials).
--
-- WHAT: generated mechanically by diffing a database built from each chain
-- (pg_dump / pg_restore of every object present in the hosted build and
-- absent from the self-host build, plus catalog comparisons for columns,
-- enum values, privileges, policies and seed rows). It is ADD-ONLY with two
-- deliberate exceptions, both hardening the hosted chain already shipped:
--   * policies the hosted chain dropped are dropped here too, and policies it
--     tightened are replaced with the hosted definition;
--   * privileges on public objects are set to exactly what the hosted chain
--     grants (REVOKE from PUBLIC/anon/authenticated/service_role, then the
--     hosted GRANTs), so a Supabase image's default privileges cannot leave a
--     customer role holding EXECUTE on a SECURITY DEFINER function.
-- Objects that exist in both chains with different definitions (function
-- bodies, check constraints, column nullability) are left untouched, and
-- self-host-only objects (ai_agent_reply_now_claims,
-- patch_conversation_runtime_flags, the billing wallet additions) are kept.
--
-- Idempotent: CREATE … IF NOT EXISTS / OR REPLACE, and constraints, policies
-- and types wrapped so an object that already exists is skipped.

SET check_function_bodies = false;
SET client_min_messages = warning;

-- ── extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── types ───────────────────────────────────────────────────
-- TYPE: ai_kb_generated_status
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE TYPE public.ai_kb_generated_status AS ENUM (
    'pending',
    'accepted',
    'rejected',
    'published'
)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- TYPE: ai_kb_job_status
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE TYPE public.ai_kb_job_status AS ENUM (
    'queued',
    'running',
    'crawling',
    'extracting',
    'generating',
    'completed',
    'partial',
    'failed',
    'canceled'
)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- TYPE: ai_kb_page_status
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE TYPE public.ai_kb_page_status AS ENUM (
    'pending',
    'fetched',
    'extracted',
    'skipped',
    'failed'
)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- TYPE: ai_kb_source_kind
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE TYPE public.ai_kb_source_kind AS ENUM (
    'workspace_domain',
    'profile_domain'
)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- TYPE: call_invitation_channel
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE TYPE public.call_invitation_channel AS ENUM (
    'audio',
    'video'
)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- TYPE: call_invitation_status
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE TYPE public.call_invitation_status AS ENUM (
    'pending',
    'joined',
    'expired',
    'cancelled',
    'declined'
)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

ALTER TYPE public.sender_type ADD VALUE IF NOT EXISTS 'ai';

-- ── functions, tables, sequences ────────────────────────────
-- FUNCTION: accept_workspace_invitation(text)
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _inv workspace_invitations%ROWTYPE;
  _user_id uuid;
  _user_email text;
  _ws_name text;
  _ws_slug text;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Get user email
  SELECT email INTO _user_email FROM profiles WHERE id = _user_id;

  -- Find invitation
  SELECT * INTO _inv FROM workspace_invitations WHERE token = _token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation token';
  END IF;

  -- Check revoked
  IF _inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has been revoked';
  END IF;

  -- Check expiry (NULL expires_at = no expiration)
  IF _inv.expires_at IS NOT NULL AND _inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  -- Check email match if invitation is email-bound
  IF _inv.invited_email IS NOT NULL AND lower(trim(_user_email)) != lower(trim(_inv.invited_email)) THEN
    RAISE EXCEPTION 'This invitation is for a different email address';
  END IF;

  -- Check if already a member
  IF EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = _inv.workspace_id AND user_id = _user_id) THEN
    -- Return success with already_member flag instead of error
    SELECT name, slug INTO _ws_name, _ws_slug FROM workspaces WHERE id = _inv.workspace_id;
    RETURN jsonb_build_object(
      'success', true,
      'already_member', true,
      'workspace_id', _inv.workspace_id,
      'workspace_name', _ws_name,
      'workspace_slug', _ws_slug,
      'role', (SELECT role FROM workspace_members WHERE workspace_id = _inv.workspace_id AND user_id = _user_id)
    );
  END IF;

  -- Add member
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _user_id, _inv.role);

  -- Increment use count (keep for analytics)
  UPDATE workspace_invitations SET use_count = use_count + 1 WHERE id = _inv.id;

  -- Get workspace info
  SELECT name, slug INTO _ws_name, _ws_slug FROM workspaces WHERE id = _inv.workspace_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_member', false,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _ws_name,
    'workspace_slug', _ws_slug,
    'role', _inv.role
  );
END;
$$;

-- FUNCTION: activate_auto_actions()
CREATE OR REPLACE FUNCTION public.activate_auto_actions() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_def RECORD;
  v_alert RECORD;
  v_active RECORD;
  v_last_started TIMESTAMPTZ;
  v_expired INTEGER := 0;
  v_activated INTEGER := 0;
  v_resolved INTEGER := 0;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Step A: auto-expire any active action past its expires_at.
  UPDATE public.auto_action_events
     SET state = 'expired',
         ended_at = v_now,
         ended_reason = 'expired'
   WHERE state = 'active'
     AND expires_at <= v_now;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- Step B: auto-resolve any active action whose trigger alert is no longer open.
  UPDATE public.auto_action_events e
     SET state = 'resolved',
         ended_at = v_now,
         ended_reason = 'alert_resolved'
   WHERE e.state = 'active'
     AND e.trigger_alert_event_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.alert_events a
        WHERE a.id = e.trigger_alert_event_id
          AND a.state = 'open'
     );
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  -- Step C: try to activate enabled definitions whose trigger alert is open.
  FOR v_def IN
    SELECT * FROM public.auto_action_definitions
     WHERE enabled = TRUE
       AND trigger_rule_slug IS NOT NULL
  LOOP
    -- Skip if already active for this definition.
    SELECT 1 INTO v_active
      FROM public.auto_action_events
     WHERE definition_id = v_def.id
       AND state = 'active'
     LIMIT 1;
    IF FOUND THEN
      CONTINUE;
    END IF;

    -- Cooldown gate: require last activation older than cooldown_seconds.
    SELECT MAX(started_at) INTO v_last_started
      FROM public.auto_action_events
     WHERE definition_id = v_def.id;
    IF v_last_started IS NOT NULL
       AND v_last_started > v_now - make_interval(secs => v_def.cooldown_seconds) THEN
      CONTINUE;
    END IF;

    -- Find a matching open alert at or above min_severity.
    SELECT * INTO v_alert
      FROM public.alert_events
     WHERE rule_slug = v_def.trigger_rule_slug
       AND state = 'open'
       AND (
         v_def.min_severity = 'warn'
         OR severity = 'critical'
       )
     ORDER BY fired_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO public.auto_action_events (
      definition_id, action_slug, action_type,
      trigger_rule_slug, trigger_alert_event_id, trigger_severity,
      state, started_at, expires_at, details
    ) VALUES (
      v_def.id, v_def.slug, v_def.action_type,
      v_def.trigger_rule_slug, v_alert.id, v_alert.severity,
      'active', v_now,
      v_now + make_interval(secs => v_def.max_duration_seconds),
      jsonb_build_object(
        'metric_value', v_alert.metric_value,
        'threshold_value', v_alert.threshold_value,
        'window_seconds', v_alert.window_seconds
      )
    );
    v_activated := v_activated + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'expired', v_expired,
    'resolved', v_resolved,
    'activated', v_activated,
    'ran_at', v_now
  );
END;
$$;

-- FUNCTION: admin_count_profiles()
CREATE OR REPLACE FUNCTION public.admin_count_profiles() RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT count(*) FROM profiles;
$$;

-- FUNCTION: admin_count_profiles(uuid, text, text)
CREATE OR REPLACE FUNCTION public.admin_count_profiles(_actor_user_id uuid, _search text DEFAULT ''::text, _phone_status text DEFAULT 'all'::text) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT count(*) FROM profiles p
    LEFT JOIN user_phone_verifications v ON v.user_id = p.id
    WHERE (_search = '' OR _search IS NULL
      OR p.email ILIKE '%' || _search || '%'
      OR p.full_name ILIKE '%' || _search || '%'
      OR p.company_name ILIKE '%' || _search || '%')
      AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status));
END $$;

-- FUNCTION: admin_count_workspaces()
CREATE OR REPLACE FUNCTION public.admin_count_workspaces() RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT count(*) FROM workspaces;
$$;

-- FUNCTION: admin_count_workspaces(uuid, text, text)
CREATE OR REPLACE FUNCTION public.admin_count_workspaces(_actor_user_id uuid, _search text DEFAULT ''::text, _phone_status text DEFAULT 'all'::text) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT count(*) FROM workspaces w
    LEFT JOIN profiles po ON po.id = w.owner_id
    LEFT JOIN user_phone_verifications v ON v.user_id = w.owner_id
    WHERE (_search = '' OR _search IS NULL
      OR w.name ILIKE '%' || _search || '%'
      OR w.slug ILIKE '%' || _search || '%'
      OR po.email ILIKE '%' || _search || '%')
      AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status));
END $$;

-- FUNCTION: admin_get_user_detail(uuid, uuid)
CREATE OR REPLACE FUNCTION public.admin_get_user_detail(_actor_user_id uuid, _user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'profile', row_to_json(p.*),
      'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
      'workspaces', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug,
          'role', wm.role, 'created_at', wm.created_at))
        FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = p.id), '[]'::jsonb),
      'account', (
        SELECT jsonb_build_object('id', a.id, 'name', a.name, 'slug', a.slug, 'role', am.role)
        FROM account_members am JOIN accounts a ON a.id = am.account_id
        WHERE am.user_id = p.id LIMIT 1),
      'phone_verification', public.phone_verification_state(p.id)
    )
    FROM profiles p WHERE p.id = _user_id
  );
END $$;

-- FUNCTION: admin_get_workspace_detail(uuid, uuid)
CREATE OR REPLACE FUNCTION public.admin_get_workspace_detail(_actor_user_id uuid, _workspace_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _result jsonb;
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT jsonb_build_object(
    'workspace', row_to_json(w.*),
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', wm.id, 'user_id', wm.user_id, 'role', wm.role,
        'created_at', wm.created_at, 'email', p.email, 'full_name', p.full_name))
      FROM workspace_members wm LEFT JOIN profiles p ON p.id = wm.user_id
      WHERE wm.workspace_id = w.id), '[]'::jsonb),
    'branding', (SELECT row_to_json(wb.*) FROM workspace_branding wb WHERE wb.workspace_id = w.id),
    'widget_settings', (SELECT row_to_json(ws.*) FROM widget_settings ws WHERE ws.workspace_id = w.id),
    'contact_count', (SELECT count(*) FROM contacts c WHERE c.workspace_id = w.id),
    'conversation_count', (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id),
    'owner', (SELECT jsonb_build_object('id', po.id, 'email', po.email, 'full_name', po.full_name)
              FROM profiles po WHERE po.id = w.owner_id),
    'owner_phone_verification', public.phone_verification_state(w.owner_id)
  ) INTO _result
  FROM workspaces w WHERE w.id = _workspace_id;
  RETURN _result;
END $$;

-- FUNCTION: admin_list_login_attempts(text, integer)
CREATE OR REPLACE FUNCTION public.admin_list_login_attempts(_email text, _limit integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', la.id,
      'email', la.email,
      'ip_address', la.ip_address,
      'success', la.success,
      'created_at', la.created_at
    ) ORDER BY la.created_at DESC), '[]'::jsonb)
    FROM login_attempts la
    WHERE la.email = _email
    LIMIT _limit
  );
END;
$$;

-- FUNCTION: admin_list_profiles(integer, integer, text, text)
CREATE OR REPLACE FUNCTION public.admin_list_profiles(_limit integer DEFAULT 50, _offset integer DEFAULT 0, _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id, 'email', p.email, 'full_name', p.full_name,
        'avatar_url', p.avatar_url, 'company_name', p.company_name,
        'website_domain', p.website_domain, 'ai_mode', p.ai_mode,
        'preferred_locale', p.preferred_locale, 'signup_locale', p.signup_locale,
        'signup_ip', p.signup_ip, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'workspace_count', (SELECT count(*) FROM workspace_members wm WHERE wm.user_id = p.id),
        'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
        'phone_masked', public.mask_phone_e164(v.phone_e164),
        'phone_verified', v.phone_verified_at IS NOT NULL,
        'phone_verified_at', v.phone_verified_at,
        'phone_verification_method', v.verification_method
      ) AS row_data
      FROM profiles p
      LEFT JOIN user_phone_verifications v ON v.user_id = p.id
      WHERE _search = '' OR _search IS NULL
        OR p.email ILIKE '%' || _search || '%'
        OR p.full_name ILIKE '%' || _search || '%'
        OR p.company_name ILIKE '%' || _search || '%'
      ORDER BY
        CASE WHEN _sort = 'newest' THEN p.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN p.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN p.full_name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $$;

-- FUNCTION: admin_list_profiles(uuid, integer, integer, text, text, text)
CREATE OR REPLACE FUNCTION public.admin_list_profiles(_actor_user_id uuid, _limit integer DEFAULT 50, _offset integer DEFAULT 0, _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text, _phone_status text DEFAULT 'all'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id, 'email', p.email, 'full_name', p.full_name,
        'avatar_url', p.avatar_url, 'company_name', p.company_name,
        'website_domain', p.website_domain, 'ai_mode', p.ai_mode,
        'preferred_locale', p.preferred_locale, 'signup_locale', p.signup_locale,
        'signup_ip', p.signup_ip, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'workspace_count', (SELECT count(*) FROM workspace_members wm WHERE wm.user_id = p.id),
        'roles', COALESCE((SELECT jsonb_agg(ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '[]'::jsonb),
        'phone_masked', public.mask_phone_e164(v.phone_e164),
        'phone_verified', v.phone_verified_at IS NOT NULL,
        'phone_verified_at', v.phone_verified_at,
        'phone_verification_method', v.verification_method
      ) AS row_data
      FROM profiles p
      LEFT JOIN user_phone_verifications v ON v.user_id = p.id
      WHERE (_search = '' OR _search IS NULL
        OR p.email ILIKE '%' || _search || '%'
        OR p.full_name ILIKE '%' || _search || '%'
        OR p.company_name ILIKE '%' || _search || '%')
        AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status)
      ORDER BY
        CASE WHEN _sort = 'newest' THEN p.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN p.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN p.full_name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $$;

-- FUNCTION: admin_list_realtime_audit(integer)
CREATE OR REPLACE FUNCTION public.admin_list_realtime_audit(_limit integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
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

-- FUNCTION: admin_list_workspaces(integer, integer)
CREATE OR REPLACE FUNCTION public.admin_list_workspaces(_limit integer DEFAULT 50, _offset integer DEFAULT 0) RETURNS TABLE(id uuid, name text, slug text, owner_id uuid, owner_email text, member_count bigint, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT
    w.id, w.name, w.slug, w.owner_id,
    p.email as owner_email,
    (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) as member_count,
    w.created_at, w.updated_at
  FROM workspaces w
  LEFT JOIN profiles p ON p.id = w.owner_id
  ORDER BY w.created_at DESC
  LIMIT _limit OFFSET _offset;
$$;

-- FUNCTION: admin_list_workspaces(uuid, integer, integer, text, text, text)
CREATE OR REPLACE FUNCTION public.admin_list_workspaces(_actor_user_id uuid, _limit integer DEFAULT 50, _offset integer DEFAULT 0, _search text DEFAULT ''::text, _sort text DEFAULT 'newest'::text, _phone_status text DEFAULT 'all'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT has_role(_actor_user_id, 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', w.id, 'name', w.name, 'slug', w.slug, 'owner_id', w.owner_id,
        'owner_email', po.email,
        'member_count', (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id),
        'contact_count', (SELECT count(*) FROM contacts c WHERE c.workspace_id = w.id),
        'conversation_count', (SELECT count(*) FROM conversations cv WHERE cv.workspace_id = w.id),
        'created_at', w.created_at, 'updated_at', w.updated_at,
        'owner_phone_masked', public.mask_phone_e164(v.phone_e164),
        'owner_phone_verified', v.phone_verified_at IS NOT NULL,
        'owner_phone_verified_at', v.phone_verified_at,
        'owner_phone_verification_method', v.verification_method
      ) AS row_data
      FROM workspaces w
      LEFT JOIN profiles po ON po.id = w.owner_id
      LEFT JOIN user_phone_verifications v ON v.user_id = w.owner_id
      WHERE (_search = '' OR _search IS NULL
        OR w.name ILIKE '%' || _search || '%'
        OR w.slug ILIKE '%' || _search || '%'
        OR po.email ILIKE '%' || _search || '%')
        AND public.phone_status_matches(v.phone_e164, v.phone_verified_at, _phone_status)
      ORDER BY
        CASE WHEN _sort = 'newest' THEN w.created_at END DESC,
        CASE WHEN _sort = 'oldest' THEN w.created_at END ASC,
        CASE WHEN _sort = 'name_asc' THEN w.name END ASC
      LIMIT _limit OFFSET _offset
    ) sub
  );
END $$;

-- FUNCTION: admin_reset_billing_data(text)
CREATE OR REPLACE FUNCTION public.admin_reset_billing_data(p_confirm text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tables text[] := ARRAY[
    'billing_notification_jobs',
    'billing_retention_signals',
    'billing_invoice_applications',
    'billing_subscription_applications',
    'billing_invoice_collections',
    'billing_payment_allocations',
    'billing_payments',
    'billing_payment_intents',
    'billing_invoice_lines',
    'billing_invoices',
    'billing_coupon_redemptions',
    'billing_period_allowance_grants',
    'billing_entitlement_cycles',
    'billing_subscription_periods',
    'billing_wallet_ledger',
    'billing_wallet_deposits',
    'billing_wallet_accounts',
    'billing_v2_jobs',
    'billing_v2_audit',
    'billing_events',
    'plan_change_log',
    'ai_billing_adjustments',
    'ai_billing_audit_log',
    'ai_billing_commands',
    'ai_usage_event_conflicts',
    'ai_usage_events',
    'ai_run_settlements',
    'ai_run_steps',
    'ai_runs',
    'ai_usage_logs',
    'workspace_subscriptions'
  ];
  v_present text[] := ARRAY[]::text[];
  v_name text;
BEGIN
  IF p_confirm IS DISTINCT FROM 'RESET-BILLING' THEN
    RAISE EXCEPTION 'confirmation_required';
  END IF;

  FOREACH v_name IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_name) IS NOT NULL THEN
      v_present := v_present || ('public.' || v_name);
    END IF;
  END LOOP;

  IF array_length(v_present, 1) IS NULL THEN
    RETURN jsonb_build_object('cleared', ARRAY[]::text[]);
  END IF;

  -- TRUNCATE bypasses the append-only row triggers that (correctly) protect
  -- financial history during normal operation. This entry point exists only
  -- for an explicit operator-initiated full reset.
  EXECUTE 'TRUNCATE TABLE ' || array_to_string(v_present, ', ') || ' RESTART IDENTITY CASCADE';

  RETURN jsonb_build_object('cleared', v_present, 'cleared_at', now());
END;
$$;

-- FUNCTION: admin_security_stats()
CREATE OR REPLACE FUNCTION public.admin_security_stats() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'total_events_24h', (SELECT count(*) FROM security_events WHERE created_at > now() - interval '24 hours'),
    'failed_logins_24h', (SELECT count(*) FROM security_events WHERE event_type = 'login_failed' AND created_at > now() - interval '24 hours'),
    'rate_limited_24h', (SELECT count(*) FROM security_events WHERE event_type = 'rate_limited' AND created_at > now() - interval '24 hours'),
    'captcha_failed_24h', (SELECT count(*) FROM security_events WHERE event_type = 'captcha_failed' AND created_at > now() - interval '24 hours'),
    'blocked_ips', (SELECT count(*) FROM ip_blocklist WHERE blocked_until IS NULL OR blocked_until > now()),
    'brute_force_24h', (SELECT count(*) FROM security_events WHERE event_type = 'brute_force' AND created_at > now() - interval '24 hours'),
    'abuse_detected_24h', (SELECT count(*) FROM security_events WHERE event_type = 'abuse_detected' AND created_at > now() - interval '24 hours'),
    'critical_events_24h', (SELECT count(*) FROM security_events WHERE severity = 'critical' AND created_at > now() - interval '24 hours'),
    'unresolved_events', (SELECT count(*) FROM security_events WHERE resolved = false AND severity IN ('error', 'critical'))
  )
$$;

-- FUNCTION: ai_kb_set_updated_at()
CREATE OR REPLACE FUNCTION public.ai_kb_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- FUNCTION: alert_rules_touch()
CREATE OR REPLACE FUNCTION public.alert_rules_touch() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- FUNCTION: alert_rules_validate_fields()
CREATE OR REPLACE FUNCTION public.alert_rules_validate_fields() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.kind = 'count' THEN
    IF NEW.metric IS NULL THEN RAISE EXCEPTION 'count rules require metric'; END IF;
  ELSIF NEW.kind = 'ratio' THEN
    IF NEW.numerator IS NULL OR NEW.denominator IS NULL THEN
      RAISE EXCEPTION 'ratio rules require numerator and denominator';
    END IF;
  ELSIF NEW.kind IN ('perf_p95','perf_p99','perf_error_rate') THEN
    IF NEW.route_group IS NULL THEN
      RAISE EXCEPTION '% rules require route_group', NEW.kind;
    END IF;
  ELSIF NEW.kind IN ('process_avg','process_ratio') THEN
    IF NEW.metric IS NULL THEN
      RAISE EXCEPTION '% rules require metric', NEW.kind;
    END IF;
  ELSIF NEW.kind = 'combined' THEN
    IF jsonb_typeof(NEW.subrules) <> 'array' OR jsonb_array_length(NEW.subrules) = 0 THEN
      RAISE EXCEPTION 'combined rules require non-empty subrules array';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: apply_storage_usage_log()
CREATE OR REPLACE FUNCTION public.apply_storage_usage_log() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_delta  bigint := 0;
BEGIN
  -- Ignore failed ops, non-upload/delete ops, and rows missing file_size.
  IF NEW.success IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;
  IF NEW.file_size IS NULL OR NEW.file_size <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.operation = 'upload' THEN
    v_delta := NEW.file_size;
  ELSIF NEW.operation = 'delete' THEN
    v_delta := -NEW.file_size;
  ELSE
    RETURN NEW;
  END IF;

  -- A new month's row is seeded with the prior period's occupancy by
  -- trg_workspace_usage_counters_seed_storage (migration 221), whichever
  -- writer creates it, so only the delta is inserted here.
  INSERT INTO public.workspace_usage_counters (workspace_id, period, storage_bytes)
  VALUES (NEW.workspace_id, v_period, v_delta)
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET storage_bytes = GREATEST(public.workspace_usage_counters.storage_bytes + v_delta, 0),
        updated_at = now();

  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

-- TABLE: backup_commands
CREATE TABLE IF NOT EXISTS public.backup_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    command text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    CONSTRAINT backup_commands_command_check CHECK ((command = ANY (ARRAY['run_logical_backup'::text, 'run_base_backup'::text, 'verify_latest_backup'::text]))),
    CONSTRAINT backup_commands_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'succeeded'::text, 'failed'::text, 'expired'::text])))
);

-- FUNCTION: backup_claim_command()
CREATE OR REPLACE FUNCTION public.backup_claim_command() RETURNS SETOF public.backup_commands
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.backup_commands c
     SET status = 'claimed', claimed_at = now()
   WHERE c.id = (
     SELECT id FROM public.backup_commands
      WHERE status = 'pending' AND requested_at > now() - interval '1 hour'
      ORDER BY requested_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING c.*;
$$;

-- FUNCTION: backup_health()
CREATE OR REPLACE FUNCTION public.backup_health() RETURNS TABLE(kind text, backup_id text, status text, finished_at timestamp with time zone, age_seconds double precision, bytes bigint, encrypted boolean, verification_status text, verified_at timestamp with time zone, last_restore_tested_at timestamp with time zone, destination text, lsn text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT DISTINCT ON (b.kind)
    b.kind, b.backup_id, b.status, b.finished_at,
    extract(epoch FROM (now() - coalesce(b.finished_at, b.started_at))),
    b.bytes, b.encrypted, b.verification_status, b.verified_at,
    b.last_restore_tested_at, b.destination, b.lsn
  FROM public.backup_runs b
  ORDER BY b.kind, b.started_at DESC
$$;

-- FUNCTION: backup_reject_credentials()
CREATE OR REPLACE FUNCTION public.backup_reject_credentials() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  blob text;
BEGIN
  blob := coalesce(NEW.destination, '') || ' ' || coalesce(NEW.metadata::text, '');
  IF TG_TABLE_NAME = 'backup_restore_drills' THEN
    blob := coalesce(NEW.notes, '') || ' ' || coalesce(NEW.findings::text, '');
  END IF;
  IF blob ~* '(://[^/[:space:]]*:[^/@[:space:]]+@)'
     OR blob ~* '(password|passwd|secret_access_key|aws_secret|private_key|service_role_key)[[:space:]]*[:=]'
     OR blob ~* 'AKIA[0-9A-Z]{16}'
  THEN
    RAISE EXCEPTION 'backup_metadata_contains_credentials';
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: backup_touch_updated_at()
CREATE OR REPLACE FUNCTION public.backup_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- FUNCTION: backup_wal_status()
CREATE OR REPLACE FUNCTION public.backup_wal_status() RETURNS TABLE(archive_mode text, wal_level text, archive_timeout_seconds integer, archived_count bigint, last_archived_wal text, last_archived_time timestamp with time zone, archive_lag_seconds double precision, failed_count bigint, last_failed_wal text, last_failed_time timestamp with time zone, stats_reset timestamp with time zone, current_lsn text, database_bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
  SELECT
    current_setting('archive_mode'),
    current_setting('wal_level'),
    current_setting('archive_timeout')::integer,
    a.archived_count,
    a.last_archived_wal,
    a.last_archived_time,
    extract(epoch FROM (now() - a.last_archived_time)),
    a.failed_count,
    a.last_failed_wal,
    a.last_failed_time,
    a.stats_reset,
    pg_current_wal_lsn()::text,
    pg_database_size(current_database())
  FROM pg_stat_archiver a
$$;

-- FUNCTION: bootstrap_admin(uuid)
CREATE OR REPLACE FUNCTION public.bootstrap_admin(_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin'::app_role) THEN
    RETURN false;
  END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (_user_id, 'admin'::app_role);
  RETURN true;
END;
$$;

-- FUNCTION: bulk_create_contacts(uuid, jsonb)
CREATE OR REPLACE FUNCTION public.bulk_create_contacts(_workspace_id uuid, _contacts jsonb) RETURNS TABLE(inserted integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: not a workspace member' USING ERRCODE = '42501';
  END IF;
  IF _contacts IS NULL OR jsonb_typeof(_contacts) <> 'array' THEN
    RAISE EXCEPTION 'invalid payload: expected jsonb array' USING ERRCODE = '22023';
  END IF;

  WITH src AS (
    SELECT
      _workspace_id AS workspace_id,
      NULLIF(elem->>'email','')      AS email,
      NULLIF(elem->>'name','')       AS name,
      NULLIF(elem->>'phone','')      AS phone,
      NULLIF(elem->>'avatar_url','') AS avatar_url,
      COALESCE(
        CASE WHEN jsonb_typeof(elem->'tags') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(elem->'tags'))
             ELSE '{}'::text[] END,
        '{}'::text[]
      ) AS tags,
      NULLIF(elem->>'notes','')      AS notes,
      COALESCE(elem->'metadata', '{}'::jsonb) AS metadata
    FROM jsonb_array_elements(_contacts) AS elem
  ),
  ins AS (
    INSERT INTO public.contacts (workspace_id, email, name, phone, avatar_url, tags, notes, metadata)
    SELECT workspace_id, email, name, phone, avatar_url, tags, notes, metadata FROM src
    RETURNING id
  )
  SELECT COUNT(*)::int INTO _count FROM ins;

  RETURN QUERY SELECT _count;
END;
$$;

-- FUNCTION: bump_usage_counter_for(uuid, text, integer, timestamp with time zone)
CREATE OR REPLACE FUNCTION public.bump_usage_counter_for(_workspace_id uuid, _counter_name text, _amount integer, _at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  _period text;
BEGIN
  IF _workspace_id IS NULL THEN RETURN; END IF;
  _period := to_char(COALESCE(_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM');

  INSERT INTO workspace_usage_counters (workspace_id, period)
  VALUES (_workspace_id, _period)
  ON CONFLICT (workspace_id, period) DO NOTHING;

  EXECUTE format(
    'UPDATE workspace_usage_counters SET %I = COALESCE(%I,0) + $1, updated_at = now() WHERE workspace_id = $2 AND period = $3',
    _counter_name, _counter_name
  ) USING _amount, _workspace_id, _period;
END;
$_$;

-- FUNCTION: business_metrics_rollup_and_prune()
CREATE OR REPLACE FUNCTION public.business_metrics_rollup_and_prune() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  bucket      timestamptz := date_trunc('hour', now()) - interval '1 hour';
  bucket_end  timestamptz := bucket + interval '1 hour';
  rolled      integer := 0;
  pruned      integer := 0;
BEGIN
  WITH conv_window AS (
    SELECT c.id, c.workspace_id, c.created_at, c.updated_at, c.status
      FROM public.conversations c
     WHERE c.created_at >= bucket AND c.created_at < bucket_end
  ),
  resolved_window AS (
    SELECT c.workspace_id, c.id,
           EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) AS dur_s
      FROM public.conversations c
     WHERE c.status = 'resolved'
       AND c.updated_at >= bucket AND c.updated_at < bucket_end
  ),
  msgs_window AS (
    SELECT cm.id, cm.conversation_id, cm.sender_type, cm.created_at, cm.sender_id,
           c.workspace_id
      FROM public.conversation_messages cm
      JOIN public.conversations c ON c.id = cm.conversation_id
     WHERE cm.created_at >= bucket AND cm.created_at < bucket_end
  ),
  first_contact AS (
    SELECT DISTINCT ON (cm.conversation_id) cm.conversation_id, cm.created_at AS contact_at, c.workspace_id
      FROM public.conversation_messages cm
      JOIN public.conversations c ON c.id = cm.conversation_id
     WHERE cm.sender_type = 'contact'
       AND cm.created_at >= bucket - interval '6 hours'
     ORDER BY cm.conversation_id, cm.created_at ASC
  ),
  first_agent AS (
    SELECT DISTINCT ON (cm.conversation_id) cm.conversation_id, cm.created_at AS agent_at, c.workspace_id
      FROM public.conversation_messages cm
      JOIN public.conversations c ON c.id = cm.conversation_id
     WHERE cm.sender_type = 'agent'
       AND cm.created_at >= bucket - interval '6 hours'
     ORDER BY cm.conversation_id, cm.created_at ASC
  ),
  frt AS (
    SELECT fc.workspace_id,
           EXTRACT(EPOCH FROM (fa.agent_at - fc.contact_at)) AS frt_s
      FROM first_contact fc
      JOIN first_agent fa ON fa.conversation_id = fc.conversation_id
     WHERE fa.agent_at >= bucket AND fa.agent_at < bucket_end
       AND fa.agent_at >= fc.contact_at
  ),
  per_ws AS (
    SELECT
      w.id AS workspace_id,
      (SELECT COUNT(*) FROM conv_window x WHERE x.workspace_id = w.id) AS new_c,
      (SELECT COUNT(*) FROM resolved_window x WHERE x.workspace_id = w.id) AS res_c,
      (SELECT AVG(dur_s) FROM resolved_window x WHERE x.workspace_id = w.id) AS avg_res_s,
      (SELECT COUNT(*) FROM msgs_window x WHERE x.workspace_id = w.id) AS msgs,
      (SELECT COUNT(DISTINCT sender_id) FROM msgs_window x
        WHERE x.workspace_id = w.id AND sender_type = 'agent') AS active_ops,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id AND x.status IN ('open','pending')) AS active_c,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id
          AND x.status IN ('open','pending')
          AND NOT EXISTS (
            SELECT 1 FROM public.conversation_messages m
             WHERE m.conversation_id = x.id AND m.sender_type = 'agent')
      ) AS unanswered,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id
          AND x.status IN ('open','pending')
          AND x.updated_at < now() - interval '24 hours'
      ) AS stale_open,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY frt_s) FROM frt f WHERE f.workspace_id = w.id) AS frt_p50,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY frt_s) FROM frt f WHERE f.workspace_id = w.id) AS frt_p95
    FROM public.workspaces w
   WHERE EXISTS (
     SELECT 1 FROM conv_window x WHERE x.workspace_id = w.id
     UNION SELECT 1 FROM msgs_window x WHERE x.workspace_id = w.id
     UNION SELECT 1 FROM resolved_window x WHERE x.workspace_id = w.id
   )
  )
  INSERT INTO public.business_metrics_hourly (
    bucket_hour, workspace_id,
    new_conversations, resolved_conversations, unanswered_conversations, stale_open_conversations,
    avg_conversation_duration_seconds,
    avg_messages_per_conversation,
    first_response_time_p50, first_response_time_p95,
    messages_sent, active_operators, active_conversations,
    conversation_to_resolution_rate,
    avg_resolution_time_seconds,
    support_load_score
  )
  SELECT
    bucket,
    workspace_id,
    new_c,
    res_c,
    unanswered,
    stale_open,
    avg_res_s,
    CASE WHEN new_c > 0 THEN msgs::numeric / NULLIF(new_c,0) ELSE NULL END,
    frt_p50,
    frt_p95,
    msgs,
    active_ops,
    active_c,
    CASE WHEN new_c > 0 THEN res_c::numeric / NULLIF(new_c,0) ELSE NULL END,
    avg_res_s,
    LEAST(1.0, (
      COALESCE(active_c,0)::numeric / GREATEST(1, COALESCE(active_ops,1)) / 25.0
      + COALESCE(unanswered,0)::numeric / 10.0
      + COALESCE(stale_open,0)::numeric / 10.0
    ) / 3.0)
  FROM per_ws
  ON CONFLICT (bucket_hour, workspace_id) DO UPDATE SET
    new_conversations = EXCLUDED.new_conversations,
    resolved_conversations = EXCLUDED.resolved_conversations,
    unanswered_conversations = EXCLUDED.unanswered_conversations,
    stale_open_conversations = EXCLUDED.stale_open_conversations,
    avg_conversation_duration_seconds = EXCLUDED.avg_conversation_duration_seconds,
    avg_messages_per_conversation = EXCLUDED.avg_messages_per_conversation,
    first_response_time_p50 = EXCLUDED.first_response_time_p50,
    first_response_time_p95 = EXCLUDED.first_response_time_p95,
    messages_sent = EXCLUDED.messages_sent,
    active_operators = EXCLUDED.active_operators,
    active_conversations = EXCLUDED.active_conversations,
    conversation_to_resolution_rate = EXCLUDED.conversation_to_resolution_rate,
    avg_resolution_time_seconds = EXCLUDED.avg_resolution_time_seconds,
    support_load_score = EXCLUDED.support_load_score;
  GET DIAGNOSTICS rolled = ROW_COUNT;

  DELETE FROM public.business_metrics_hourly WHERE bucket_hour < now() - interval '180 days';
  GET DIAGNOSTICS pruned = ROW_COUNT;

  RETURN jsonb_build_object('rolled', rolled, 'pruned', pruned, 'bucket', bucket, 'ran_at', now());
END
$$;

-- FUNCTION: cc_touch_updated_at()
CREATE OR REPLACE FUNCTION public.cc_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- FUNCTION: check_channel_access(uuid, text)
CREATE OR REPLACE FUNCTION public.check_channel_access(_workspace_id uuid, _channel_key text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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

-- FUNCTION: check_module_access(uuid, text)
CREATE OR REPLACE FUNCTION public.check_module_access(_workspace_id uuid, _module_key text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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

-- FUNCTION: check_workspace_entitlement(uuid, text)
CREATE OR REPLACE FUNCTION public.check_workspace_entitlement(_workspace_id uuid, _feature text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _sub workspace_subscriptions%ROWTYPE;
  _plan billing_plans%ROWTYPE;
  _entitlements jsonb;
  _limits jsonb;
  _override_value integer;
  _sub_valid boolean := false;
BEGIN
  SELECT * INTO _sub FROM workspace_subscriptions
    WHERE workspace_id = _workspace_id;

  IF FOUND AND _sub.plan_id IS NOT NULL THEN
    IF _sub.status = 'active' THEN
      _sub_valid := true;
    ELSIF _sub.status = 'past_due' AND _sub.free_fallback_at IS NULL THEN
      _sub_valid := true;
    ELSIF _sub.status = 'trialing' AND (_sub.trial_end IS NULL OR _sub.trial_end > now()) THEN
      _sub_valid := true;
    ELSIF _sub.status IN ('canceled', 'cancelled')
      AND _sub.cancel_at_period_end IS TRUE
      AND _sub.current_period_end > now() THEN
      _sub_valid := true;
    END IF;
  END IF;

  IF _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE id = _sub.plan_id;
    _sub_valid := FOUND;
  END IF;

  IF NOT _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE slug = 'free' AND is_active = true LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed', false, 'plan', 'none', 'reason', 'no_plan_found');
    END IF;
  END IF;

  _entitlements := COALESCE(_plan.entitlements, '{}'::jsonb);
  _limits := COALESCE(_plan.limits, '{}'::jsonb);

  IF _entitlements ? _feature THEN
    RETURN jsonb_build_object('allowed', (_entitlements->>_feature)::boolean, 'plan', _plan.slug);
  END IF;

  SELECT limit_value INTO _override_value
    FROM workspace_limit_overrides
    WHERE workspace_id = _workspace_id AND limit_key = _feature;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'limit', _override_value, 'plan', _plan.slug, 'source', 'override');
  END IF;

  IF _limits ? _feature THEN
    RETURN jsonb_build_object('allowed', true, 'limit', (_limits->>_feature)::int, 'plan', _plan.slug, 'source', 'plan');
  END IF;

  RETURN jsonb_build_object('allowed', false, 'plan', _plan.slug, 'reason', 'feature_not_in_plan');
END;
$$;

-- FUNCTION: claim_conversation(uuid, uuid, uuid, boolean)
CREATE OR REPLACE FUNCTION public.claim_conversation(p_conversation_id uuid, p_workspace_id uuid, p_user_id uuid, p_force boolean DEFAULT false) RETURNS SETOF public.conversations
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.conversations
  SET assigned_to = p_user_id,
      updated_at = now()
  WHERE id = p_conversation_id
    AND workspace_id = p_workspace_id
    AND (p_force OR assigned_to IS NULL)
  RETURNING *;
$$;

-- FUNCTION: claim_kb_change_events(text, integer, integer)
CREATE OR REPLACE FUNCTION public.claim_kb_change_events(_worker_id text, _limit integer DEFAULT 100, _lease_seconds integer DEFAULT 300) RETURNS TABLE(id uuid, workspace_id uuid, event_type text, attempts integer, claim_token uuid, claim_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _token uuid := gen_random_uuid();
  _lease integer := GREATEST(COALESCE(_lease_seconds, 300), 30);
  _batch integer := GREATEST(LEAST(COALESCE(_limit, 100), 500), 1);
BEGIN
  IF _worker_id IS NULL OR btrim(_worker_id) = '' THEN
    RAISE EXCEPTION 'worker_id_required';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM public.knowledge_base_change_events e
    WHERE e.processed_at IS NULL
      AND e.dead_lettered_at IS NULL
      AND e.next_attempt_at <= now()
      AND (e.claim_token IS NULL OR e.claim_expires_at IS NULL OR e.claim_expires_at < now())
    ORDER BY e.next_attempt_at ASC, e.created_at ASC
    LIMIT _batch
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.knowledge_base_change_events e
  SET claim_token = _token,
      claimed_by = _worker_id,
      claimed_at = now(),
      claim_expires_at = now() + make_interval(secs => _lease),
      locked_at = now(),
      locked_by = _worker_id,
      updated_at = now()
  FROM candidate c
  WHERE e.id = c.id
  RETURNING e.id, e.workspace_id, e.event_type, e.attempts, e.claim_token, e.claim_expires_at;
END;
$$;

-- FUNCTION: cleanup_expired_auth_tokens()
CREATE OR REPLACE FUNCTION public.cleanup_expired_auth_tokens() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Delete expired sessions older than 1 day past expiry
  DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day';
  -- Delete expired/used reset tokens older than 1 day
  DELETE FROM auth_reset_tokens WHERE expires_at < now() - interval '1 day';
  -- Delete expired/used verify tokens older than 1 day
  DELETE FROM auth_verify_tokens WHERE expires_at < now() - interval '1 day';
END;
$$;

-- FUNCTION: cleanup_expired_widget_identity()
CREATE OR REPLACE FUNCTION public.cleanup_expired_widget_identity() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM public.contact_verifications WHERE expires_at < now() - interval '1 day';
  DELETE FROM public.user_continuity_tokens WHERE expires_at < now() - interval '7 days' AND revoked_at IS NOT NULL;
END;
$$;

-- FUNCTION: commerce_purge_expired_deletions()
CREATE OR REPLACE FUNCTION public.commerce_purge_expired_deletions() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM public.commerce_deleted_entities
   WHERE deleted_at < now() - interval '7 days';
END;
$$;

-- FUNCTION: commerce_sweep_absent_products(uuid, timestamp with time zone)
CREATE OR REPLACE FUNCTION public.commerce_sweep_absent_products(p_connection_id uuid, p_sweep_epoch timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer;
  v_now text := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
  WITH gone AS (
    DELETE FROM public.commerce_products
     WHERE connection_id = p_connection_id
       AND (last_seen_at IS NULL OR last_seen_at < p_sweep_epoch)
    RETURNING external_id
  ), recorded AS (
    INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
    SELECT p_connection_id, 'product', external_id, v_now FROM gone
    ON CONFLICT (connection_id, kind, external_id) DO UPDATE
      SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version),
          deleted_at     = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM recorded;

  PERFORM public.commerce_purge_expired_deletions();
  RETURN v_count;
END;
$$;

-- FUNCTION: complete_kb_change_events(uuid, text, uuid[])
CREATE OR REPLACE FUNCTION public.complete_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _n integer;
BEGIN
  IF _claim_token IS NULL OR _worker_id IS NULL OR _ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.knowledge_base_change_events e
  SET processed_at = now(),
      claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL,
      locked_at = NULL, locked_by = NULL,
      last_error = NULL, last_error_code = NULL, last_error_detail = NULL,
      updated_at = now()
  WHERE e.id = ANY(_ids)
    AND e.processed_at IS NULL
    AND e.claim_token = _claim_token
    AND e.claimed_by = _worker_id
    AND e.claim_expires_at IS NOT NULL
    AND e.claim_expires_at > now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- FUNCTION: count_recent_login_failures(text, text, integer)
CREATE OR REPLACE FUNCTION public.count_recent_login_failures(_ip text, _email text, _window_minutes integer DEFAULT 15) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT count(*)::integer FROM login_attempts
  WHERE ip_address = _ip
  AND email = _email
  AND success = false
  AND created_at > now() - (_window_minutes || ' minutes')::interval
$$;

-- FUNCTION: create_contact(uuid, text, text, text, text, text[], text, jsonb)
CREATE OR REPLACE FUNCTION public.create_contact(_workspace_id uuid, _email text DEFAULT NULL::text, _name text DEFAULT NULL::text, _phone text DEFAULT NULL::text, _avatar_url text DEFAULT NULL::text, _tags text[] DEFAULT '{}'::text[], _notes text DEFAULT NULL::text, _metadata jsonb DEFAULT '{}'::jsonb) RETURNS public.contacts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _row public.contacts;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: not a workspace member' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.contacts (workspace_id, email, name, phone, avatar_url, tags, notes, metadata)
  VALUES (_workspace_id, _email, _name, _phone, _avatar_url, COALESCE(_tags, '{}'::text[]), _notes, COALESCE(_metadata, '{}'::jsonb))
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

-- FUNCTION: deduct_ai_credits(uuid, integer, text)
CREATE OR REPLACE FUNCTION public.deduct_ai_credits(_workspace_id uuid, _credits integer DEFAULT 1, _period text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
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

-- FUNCTION: default_workspace_permission(text, text)
CREATE OR REPLACE FUNCTION public.default_workspace_permission(_role text, _permission_key text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN _permission_key IN ('can_manage_knowledge_base', 'can_publish_knowledge_base')
      THEN _role IN ('owner', 'admin')
    WHEN _role IN ('owner', 'admin') THEN true
    ELSE false
  END
$$;

-- FUNCTION: defer_kb_change_events(uuid, text, uuid[], text, integer)
CREATE OR REPLACE FUNCTION public.defer_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _retry_seconds integer DEFAULT 300) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _n integer;
BEGIN
  IF _claim_token IS NULL OR _worker_id IS NULL OR _ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.knowledge_base_change_events e
  SET claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL,
      locked_at = NULL, locked_by = NULL,
      last_error_code = LEFT(COALESCE(_error_code, 'deferred'), 100),
      last_error = LEFT(COALESCE(_error_code, 'deferred'), 500),
      next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(_retry_seconds, 300), 30)),
      updated_at = now()
  WHERE e.id = ANY(_ids)
    AND e.processed_at IS NULL
    AND e.claim_token = _claim_token
    AND e.claimed_by = _worker_id
    AND e.claim_expires_at IS NOT NULL
    AND e.claim_expires_at > now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- FUNCTION: enforcement_rules_protect_builtin()
CREATE OR REPLACE FUNCTION public.enforcement_rules_protect_builtin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF OLD.is_builtin THEN
    IF NEW.slug          IS DISTINCT FROM OLD.slug          THEN RAISE EXCEPTION 'cannot rename builtin rule slug'; END IF;
    IF NEW.trigger_type  IS DISTINCT FROM OLD.trigger_type  THEN RAISE EXCEPTION 'cannot change builtin rule trigger_type'; END IF;
    IF NEW.condition_json IS DISTINCT FROM OLD.condition_json THEN RAISE EXCEPTION 'cannot change builtin rule condition_json'; END IF;
    IF NEW.actions_json  IS DISTINCT FROM OLD.actions_json  THEN RAISE EXCEPTION 'cannot change builtin rule actions_json'; END IF;
    IF NEW.is_builtin    IS DISTINCT FROM OLD.is_builtin    THEN RAISE EXCEPTION 'cannot toggle is_builtin'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: enqueue_kb_catchup(uuid)
CREATE OR REPLACE FUNCTION public.enqueue_kb_catchup(_workspace_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _n integer := 0;
BEGIN
  IF _workspace_id IS NULL THEN RETURN 0; END IF;

  -- Deferred events for this workspace become immediately eligible again.
  UPDATE public.knowledge_base_change_events
  SET next_attempt_at = now(), updated_at = now()
  WHERE workspace_id = _workspace_id
    AND processed_at IS NULL
    AND dead_lettered_at IS NULL
    AND next_attempt_at > now();

  IF EXISTS (
    SELECT 1 FROM public.knowledge_base_change_events
    WHERE workspace_id = _workspace_id
      AND event_type = 'catchup'
      AND processed_at IS NULL
      AND dead_lettered_at IS NULL
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.knowledge_base_change_events (workspace_id, event_type)
  VALUES (_workspace_id, 'catchup');
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- FUNCTION: expire_stale_trials()
CREATE OR REPLACE FUNCTION public.expire_stale_trials() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _count integer := 0;
BEGIN
  WITH updated AS (
    UPDATE workspace_subscriptions
       SET status = 'expired',
           updated_at = now()
     WHERE status = 'trialing'
       AND trial_end IS NOT NULL
       AND trial_end < now()
    RETURNING 1
  )
  SELECT count(*) INTO _count FROM updated;
  RETURN _count;
END;
$$;

-- FUNCTION: fail_kb_change_events(uuid, text, uuid[], text, text, integer, boolean, integer)
CREATE OR REPLACE FUNCTION public.fail_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _error_detail text DEFAULT NULL::text, _retry_seconds integer DEFAULT 60, _permanent boolean DEFAULT false, _max_attempts integer DEFAULT 10) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _n integer;
BEGIN
  IF _claim_token IS NULL OR _worker_id IS NULL OR _ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.knowledge_base_change_events e
  SET attempts = e.attempts + 1,
      last_error_code = LEFT(COALESCE(_error_code, 'unknown'), 100),
      last_error_detail = LEFT(_error_detail, 500),
      last_error = LEFT(COALESCE(_error_code, 'unknown'), 500),
      claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL,
      locked_at = NULL, locked_by = NULL,
      next_attempt_at = now() + make_interval(
        secs => GREATEST(COALESCE(_retry_seconds, 60), 5) * LEAST(e.attempts + 1, 10)
      ),
      dead_lettered_at = CASE
        WHEN COALESCE(_permanent, false) THEN now()
        WHEN e.attempts + 1 >= GREATEST(COALESCE(_max_attempts, 10), 1) THEN now()
        ELSE NULL
      END,
      updated_at = now()
  WHERE e.id = ANY(_ids)
    AND e.processed_at IS NULL
    AND e.claim_token = _claim_token
    AND e.claimed_by = _worker_id
    AND e.claim_expires_at IS NOT NULL
    AND e.claim_expires_at > now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- FUNCTION: get_account_role(uuid, uuid)
CREATE OR REPLACE FUNCTION public.get_account_role(_account_id uuid, _user_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT role FROM account_members WHERE account_id = _account_id AND user_id = _user_id LIMIT 1
$$;

-- FUNCTION: has_workspace_permission(uuid, uuid, text)
CREATE OR REPLACE FUNCTION public.has_workspace_permission(_workspace_id uuid, _user_id uuid, _permission_key text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _role text;
  _granted boolean;
BEGIN
  IF _workspace_id IS NULL OR _user_id IS NULL OR _permission_key IS NULL THEN
    RETURN false;
  END IF;

  SELECT role::text INTO _role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  SELECT granted INTO _granted
  FROM public.role_permissions
  WHERE workspace_id = _workspace_id
    AND role_slug = _role
    AND permission_key = _permission_key
  LIMIT 1;

  IF _granted IS NOT NULL THEN
    RETURN _granted;
  END IF;

  RETURN public.default_workspace_permission(_role, _permission_key);
END;
$$;

-- FUNCTION: increment_usage_counter(uuid, text, integer)
CREATE OR REPLACE FUNCTION public.increment_usage_counter(_workspace_id uuid, _counter_name text, _amount integer DEFAULT 1) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
$_$;

-- FUNCTION: is_ip_blocked(text)
CREATE OR REPLACE FUNCTION public.is_ip_blocked(_ip text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM ip_blocklist
    WHERE ip_address = _ip
    AND (blocked_until IS NULL OR blocked_until > now())
  )
$$;

-- FUNCTION: kb_detach_articles_before_category_delete()
CREATE OR REPLACE FUNCTION public.kb_detach_articles_before_category_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.knowledge_base_articles
  SET category_id = NULL
  WHERE category_id = OLD.id
    AND workspace_id = OLD.workspace_id;
  RETURN OLD;
END;
$$;

-- FUNCTION: kb_search_articles(uuid, text, text, integer)
CREATE OR REPLACE FUNCTION public.kb_search_articles(p_workspace_id uuid, p_locale text, p_query text, p_limit integer DEFAULT 8) RETURNS TABLE(id uuid, title text, slug text, excerpt text, category_id uuid, category_slug text, category_name text, score real)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH q AS (
    SELECT trim(lower(coalesce(p_query, ''))) AS qtext
  )
  SELECT
    a.id,
    a.title,
    a.slug,
    a.excerpt,
    a.category_id,
    c.slug AS category_slug,
    c.name AS category_name,
    GREATEST(
      similarity(lower(a.title), (SELECT qtext FROM q)),
      similarity(lower(coalesce(a.excerpt, '')), (SELECT qtext FROM q)) * 0.7,
      similarity(lower(coalesce(a.content, '')), (SELECT qtext FROM q)) * 0.4,
      CASE WHEN lower(a.title) ILIKE '%' || (SELECT qtext FROM q) || '%' THEN 0.5 ELSE 0 END
    )::real AS score
  FROM public.knowledge_base_articles a
  LEFT JOIN public.knowledge_base_categories c ON c.id = a.category_id
  WHERE a.workspace_id = p_workspace_id
    AND a.locale = p_locale
    AND a.status = 'published'
    AND (SELECT length(qtext) FROM q) >= 2
    AND (
      lower(a.title)             ILIKE '%' || (SELECT qtext FROM q) || '%'
      OR lower(coalesce(a.excerpt, '')) ILIKE '%' || (SELECT qtext FROM q) || '%'
      OR lower(coalesce(a.content, '')) ILIKE '%' || (SELECT qtext FROM q) || '%'
      OR similarity(lower(a.title), (SELECT qtext FROM q)) > 0.2
    )
  ORDER BY score DESC, a.sort_order ASC NULLS LAST, a.updated_at DESC
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 8), 50));
$$;

-- FUNCTION: knowledge_base_emit_change_event()
CREATE OR REPLACE FUNCTION public.knowledge_base_emit_change_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.knowledge_base_change_events (workspace_id, article_id, event_type, locale, status)
    VALUES (OLD.workspace_id, OLD.id, 'deleted', OLD.locale, OLD.status);
    RETURN OLD;
  END IF;

  INSERT INTO public.knowledge_base_change_events (workspace_id, article_id, event_type, locale, status)
  VALUES (NEW.workspace_id, NEW.id, LOWER(TG_OP), NEW.locale, NEW.status);
  RETURN NEW;
END;
$$;

-- FUNCTION: mark_conversation_seen(uuid)
CREATE OR REPLACE FUNCTION public.mark_conversation_seen(_conversation_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _workspace_id uuid;
  _affected integer;
BEGIN
  -- Resolve and authorize: operator must be a member of the conversation's workspace.
  SELECT c.workspace_id INTO _workspace_id
    FROM public.conversations c
    WHERE c.id = _conversation_id;

  IF _workspace_id IS NULL THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- Monotonic update: only fill seen_at if it's still NULL.
  -- Only visitor (contact) messages can be "seen" by an operator.
  UPDATE public.conversation_messages
     SET seen_at = now()
   WHERE conversation_id = _conversation_id
     AND sender_type = 'contact'
     AND seen_at IS NULL;

  GET DIAGNOSTICS _affected = ROW_COUNT;
  RETURN _affected;
END;
$$;

-- FUNCTION: mask_phone_e164(text)
CREATE OR REPLACE FUNCTION public.mask_phone_e164(_phone text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN _phone IS NULL OR length(regexp_replace(_phone,'\D','','g')) <= 4 THEN NULL
    ELSE (CASE WHEN left(_phone,1)='+' THEN '+' ELSE '' END)
      || left(regexp_replace(_phone,'\D','','g'), 5)
      || repeat('*', length(regexp_replace(_phone,'\D','','g')) - 7)
      || right(regexp_replace(_phone,'\D','','g'), 2)
  END
$$;

-- FUNCTION: merge_visitor_into_contact(uuid, text, uuid, text, jsonb)
CREATE OR REPLACE FUNCTION public.merge_visitor_into_contact(_workspace_id uuid, _visitor_id text, _contact_id uuid, _method text, _metadata jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _merged_count integer := 0;
BEGIN
  -- Attach visitor sessions to contact
  UPDATE public.visitor_sessions
  SET contact_id = _contact_id,
      identity_state = 'identified'
  WHERE workspace_id = _workspace_id
    AND visitor_id = _visitor_id
    AND (contact_id IS NULL OR contact_id = _contact_id);

  -- Re-link conversations from this visitor to the contact
  WITH updated AS (
    UPDATE public.conversations c
    SET contact_id = _contact_id,
        updated_at = now()
    WHERE c.workspace_id = _workspace_id
      AND c.visitor_session_id IN (
        SELECT vs.id FROM public.visitor_sessions vs
        WHERE vs.workspace_id = _workspace_id AND vs.visitor_id = _visitor_id
      )
      AND (c.contact_id IS NULL OR c.contact_id = _contact_id)
    RETURNING c.id
  )
  SELECT count(*) INTO _merged_count FROM updated;

  -- Audit
  INSERT INTO public.identity_merges (workspace_id, visitor_id, contact_id, method, conversations_merged, metadata)
  VALUES (_workspace_id, _visitor_id, _contact_id, _method, _merged_count, COALESCE(_metadata, '{}'::jsonb));

  RETURN jsonb_build_object(
    'success', true,
    'contact_id', _contact_id,
    'visitor_id', _visitor_id,
    'conversations_merged', _merged_count
  );
END;
$$;

-- FUNCTION: normalize_domain(text)
CREATE OR REPLACE FUNCTION public.normalize_domain(_input text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v text;
BEGIN
  IF _input IS NULL THEN RETURN NULL; END IF;
  v := lower(trim(_input));
  IF v = '' THEN RETURN NULL; END IF;
  -- strip protocol
  v := regexp_replace(v, '^https?://', '');
  -- strip path
  v := split_part(v, '/', 1);
  -- strip port
  v := split_part(v, ':', 1);
  -- strip leading www.
  IF v LIKE 'www.%' THEN
    v := substring(v from 5);
  END IF;
  IF v = '' THEN RETURN NULL; END IF;
  RETURN v;
END;
$$;

-- FUNCTION: partition_ensure_all(integer)
CREATE OR REPLACE FUNCTION public.partition_ensure_all(_months integer DEFAULT 2) RETURNS TABLE(parent_table text, partitions text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  r record;
begin
  for r in select m.parent_table from public.partition_managed_tables() m loop
    parent_table := r.parent_table;
    partitions := public.partition_ensure_future(r.parent_table, _months);
    return next;
  end loop;
end;
$$;

-- FUNCTION: partition_ensure_future(text, integer)
CREATE OR REPLACE FUNCTION public.partition_ensure_future(_parent text, _months integer DEFAULT 2) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_created text[] := '{}';
  v_name text;
  i int;
begin
  for i in 0 .. greatest(coalesce(_months, 2), 0) loop
    v_name := public.partition_ensure_month(_parent, (date_trunc('month', now()) + make_interval(months => i))::date);
    v_created := array_append(v_created, v_name);
  end loop;
  return v_created;
end;
$$;

-- FUNCTION: partition_ensure_month(text, date)
CREATE OR REPLACE FUNCTION public.partition_ensure_month(_parent text, _month date) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_start date := date_trunc('month', _month)::date;
  v_end   date := (date_trunc('month', _month) + interval '1 month')::date;
  v_name  text;
begin
  if not exists (select 1 from public.partition_managed_tables() m where m.parent_table = _parent) then
    raise exception 'not_a_managed_partitioned_table: %', _parent using errcode = '22023';
  end if;

  v_name := _parent || '_' || to_char(v_start, 'YYYY_MM');

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = v_name
  ) then
    return v_name;
  end if;

  execute format(
    'create table public.%I partition of public.%I for values from (%L) to (%L)',
    v_name, _parent, v_start::text, v_end::text
  );
  -- Direct-access lockdown. No policies here on purpose.
  execute format('alter table public.%I enable row level security', v_name);
  execute format('revoke all on public.%I from anon, authenticated', v_name);

  return v_name;
end;
$$;

-- FUNCTION: partition_exact_count(text)
CREATE OR REPLACE FUNCTION public.partition_exact_count(_partition text) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_n bigint;
begin
  if not exists (
    select 1 from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'public' and p.relkind = 'p' and c.relname = _partition
  ) then
    raise exception 'not_a_known_partition: %', _partition using errcode = '22023';
  end if;
  execute format('select count(*) from public.%I', _partition) into v_n;
  return v_n;
end;
$$;

-- FUNCTION: partition_health()
CREATE OR REPLACE FUNCTION public.partition_health() RETURNS TABLE(parent_table text, partition_key text, partition_count integer, current_partition text, next_partition text, next_partition_ready boolean, oldest_partition text, oldest_start timestamp with time zone, newest_partition text, newest_end timestamp with time zone, total_rows bigint, total_bytes bigint, largest_partition text, largest_bytes bigint, has_default boolean, default_rows bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  m record;
  v_cur  text;
  v_next text;
begin
  for m in select * from public.partition_managed_tables() loop
    parent_table  := m.parent_table;
    partition_key := m.partition_key;
    v_cur  := m.parent_table || '_' || to_char(date_trunc('month', now()), 'YYYY_MM');
    v_next := m.parent_table || '_' || to_char(date_trunc('month', now()) + interval '1 month', 'YYYY_MM');

    select count(*) filter (where not i.is_default),
           coalesce(sum(i.est_rows) filter (where not i.is_default), 0),
           coalesce(sum(i.total_bytes), 0)
      into partition_count, total_rows, total_bytes
      from public.partition_inventory() i where i.parent_table = m.parent_table;

    current_partition := case when exists (
      select 1 from public.partition_inventory() i
      where i.parent_table = m.parent_table and i.partition_name = v_cur) then v_cur end;
    next_partition := v_next;
    next_partition_ready := exists (
      select 1 from public.partition_inventory() i
      where i.parent_table = m.parent_table and i.partition_name = v_next);

    select i.partition_name, i.range_start into oldest_partition, oldest_start
      from public.partition_inventory() i
     where i.parent_table = m.parent_table and not i.is_default
     order by i.range_start asc limit 1;

    select i.partition_name, i.range_end into newest_partition, newest_end
      from public.partition_inventory() i
     where i.parent_table = m.parent_table and not i.is_default
     order by i.range_start desc limit 1;

    select i.partition_name, i.total_bytes into largest_partition, largest_bytes
      from public.partition_inventory() i
     where i.parent_table = m.parent_table and not i.is_default
     order by i.total_bytes desc limit 1;

    has_default := exists (
      select 1 from public.partition_inventory() i
      where i.parent_table = m.parent_table and i.is_default);

    default_rows := 0;
    if has_default then
      select public.partition_exact_count(i.partition_name) into default_rows
        from public.partition_inventory() i
       where i.parent_table = m.parent_table and i.is_default limit 1;
    end if;

    return next;
  end loop;
end;
$$;

-- FUNCTION: partition_inventory()
CREATE OR REPLACE FUNCTION public.partition_inventory() RETURNS TABLE(parent_table text, partition_name text, is_default boolean, range_start timestamp with time zone, range_end timestamp with time zone, est_rows bigint, total_bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  with parts as (
    select p.relname::text as parent_table,
           c.relname::text as partition_name,
           c.oid            as part_oid,
           pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class p on p.oid = i.inhparent
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'public' and p.relkind = 'p'
  ), expanded as (
    select parts.parent_table,
           parts.partition_name,
           (parts.bound = 'DEFAULT') as is_default,
           nullif((regexp_match(parts.bound, $re$FROM \('([^']+)'\)$re$))[1], '')::timestamptz as range_start,
           nullif((regexp_match(parts.bound, $re$TO \('([^']+)'\)$re$))[1], '')::timestamptz as range_end,
           greatest(pg_class.reltuples, 0)::bigint as est_rows,
           pg_total_relation_size(parts.part_oid) as total_bytes
    from parts join pg_class on pg_class.oid = parts.part_oid
  )
  select expanded.parent_table, expanded.partition_name, expanded.is_default,
         expanded.range_start, expanded.range_end, expanded.est_rows, expanded.total_bytes
  from expanded
  order by expanded.parent_table, expanded.range_start nulls first, expanded.partition_name;
$_$;

-- FUNCTION: partition_managed_tables()
CREATE OR REPLACE FUNCTION public.partition_managed_tables() RETURNS TABLE(parent_table text, partition_key text, key_type text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select c.relname::text,
         a.attname::text,
         format_type(a.atttypid, a.atttypmod)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_partitioned_table p on p.partrelid = c.oid
  join pg_attribute a on a.attrelid = c.oid and a.attnum = p.partattrs[0]
  where n.nspname = 'public'
    and c.relkind = 'p'
    and p.partstrat = 'r'
    and p.partnatts = 1
    and a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype)
  order by c.relname;
$$;

-- FUNCTION: partition_retention_candidates(text, timestamp with time zone)
CREATE OR REPLACE FUNCTION public.partition_retention_candidates(_parent text, _cutoff timestamp with time zone) RETURNS TABLE(partition_name text, range_start timestamp with time zone, range_end timestamp with time zone, est_rows bigint, total_bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select i.partition_name, i.range_start, i.range_end, i.est_rows, i.total_bytes
  from public.partition_inventory() i
  where i.parent_table = _parent
    and not i.is_default
    and i.range_end is not null
    and i.range_end <= _cutoff
  order by i.range_start;
$$;

-- FUNCTION: phone_status_matches(text, timestamp with time zone, text)
CREATE OR REPLACE FUNCTION public.phone_status_matches(_phone text, _verified_at timestamp with time zone, _filter text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
BEGIN
  CASE coalesce(_filter, 'all')
    WHEN 'all'        THEN RETURN true;
    WHEN 'verified'   THEN RETURN _phone IS NOT NULL AND _verified_at IS NOT NULL;
    WHEN 'unverified' THEN RETURN _phone IS NOT NULL AND _verified_at IS NULL;
    WHEN 'no_phone'   THEN RETURN _phone IS NULL;
    ELSE RAISE EXCEPTION 'invalid phone status filter';
  END CASE;
END $$;

-- FUNCTION: phone_verification_admin_resend_requested(uuid, uuid, uuid, text)
CREATE OR REPLACE FUNCTION public.phone_verification_admin_resend_requested(_challenge_id uuid, _user_id uuid, _admin_id uuid, _phone_masked text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _rows int; _exists boolean;
BEGIN
  IF _challenge_id IS NULL OR _user_id IS NULL THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT EXISTS(
    SELECT 1 FROM phone_verification_challenges
     WHERE id = _challenge_id AND user_id = _user_id
       AND is_active = true AND consumed_at IS NULL AND invalidated_at IS NULL
  ) INTO _exists;
  IF NOT _exists THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;

  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_resend_requested','user_phone_verification', _user_id,
          _admin_id,
          jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', _user_id,
                             'phone_masked', _phone_masked, 'challenge_id', _challenge_id,
                             'requested_at', now()));
  GET DIAGNOSTICS _rows = ROW_COUNT;
  IF _rows <> 1 THEN
    RETURN jsonb_build_object('error','phone_verification_unavailable');
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- FUNCTION: phone_verification_cancel(uuid, uuid, uuid, uuid, text)
CREATE OR REPLACE FUNCTION public.phone_verification_cancel(_user_id uuid, _challenge_id uuid DEFAULT NULL::uuid, _actor_user_id uuid DEFAULT NULL::uuid, _workspace_id uuid DEFAULT NULL::uuid, _purpose text DEFAULT 'widget_access'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _n int; _row record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  WITH cancelled AS (
    UPDATE phone_verification_challenges
       SET is_active = false, invalidated_at = now(), updated_at = now()
     WHERE user_id = _user_id
       AND is_active
       AND consumed_at IS NULL
       AND invalidated_at IS NULL
       AND (_challenge_id IS NULL OR id = _challenge_id)
    RETURNING id, phone_e164, purpose
  )
  SELECT count(*)::int AS n,
         (array_agg(id))[1] AS first_id,
         (array_agg(phone_e164))[1] AS phone
    INTO _row FROM cancelled;

  _n := COALESCE(_row.n, 0);

  IF _n > 0 THEN
    INSERT INTO audit_logs(action, entity_type, entity_id, user_id, workspace_id, new_value)
    VALUES ('phone_verification_cancelled','user_phone_verification', _user_id,
            _actor_user_id, _workspace_id,
            jsonb_build_object('purpose', _purpose,
                               'target_user_id', _user_id,
                               'phone_masked', public.mask_phone_e164(_row.phone),
                               'cancelled', _n,
                               'challenge_id', _row.first_id,
                               'cancelled_at', now()));
  END IF;

  RETURN jsonb_build_object('ok', true, 'cancelled', _n);
END $$;

-- FUNCTION: phone_verification_claim_attempt(uuid, uuid)
CREATE OR REPLACE FUNCTION public.phone_verification_claim_attempt(_challenge_id uuid, _user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN jsonb_build_object('error','phone_verification_unavailable');
END $$;

-- FUNCTION: phone_verification_consume(uuid, uuid)
CREATE OR REPLACE FUNCTION public.phone_verification_consume(_challenge_id uuid, _user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN jsonb_build_object('error','phone_verification_unavailable');
END $$;

-- FUNCTION: phone_verification_finalize_admin_resend(uuid, uuid, boolean, text, text, text)
CREATE OR REPLACE FUNCTION public.phone_verification_finalize_admin_resend(_challenge_id uuid, _admin_id uuid, _sent boolean, _provider_name text DEFAULT NULL::text, _provider_message_id text DEFAULT NULL::text, _error_code text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r phone_verification_challenges%ROWTYPE; _user_id uuid;
BEGIN
  SELECT user_id INTO _user_id FROM phone_verification_challenges WHERE id = _challenge_id;
  IF _user_id IS NULL THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT * INTO r FROM phone_verification_challenges WHERE id = _challenge_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  IF _sent THEN
    -- A cancelled / consumed / invalidated / expired challenge can never be
    -- resurrected into a sent state.
    UPDATE phone_verification_challenges
       SET delivery_status = 'sent', sent_at = now(),
           provider_name = _provider_name, provider_message_id = _provider_message_id,
           updated_at = now()
     WHERE id = r.id
       AND user_id = _user_id
       AND is_active = true
       AND consumed_at IS NULL
       AND invalidated_at IS NULL
       AND delivery_status = 'pending'
       AND expires_at > now()
    RETURNING * INTO r;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

    INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
    VALUES ('phone_verification_admin_resend','user_phone_verification', r.user_id, _admin_id,
            jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', r.user_id,
                               'phone_masked', public.mask_phone_e164(r.phone_e164),
                               'challenge_id', r.id, 'sent_at', r.sent_at,
                               'provider', _provider_name));
    RETURN jsonb_build_object('ok', true, 'sentAt', r.sent_at);
  END IF;

  -- Failure path is idempotent: an already-closed challenge is not reopened
  -- and does not produce a duplicate audit row.
  IF r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR r.is_active = false THEN
    RETURN jsonb_build_object('ok', false, 'alreadyClosed', true);
  END IF;

  UPDATE phone_verification_challenges
     SET delivery_status = 'failed', is_active = false, invalidated_at = now(),
         provider_name = _provider_name, updated_at = now()
   WHERE id = r.id;

  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_resend_failed','user_phone_verification', r.user_id, _admin_id,
          jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', r.user_id,
                             'phone_masked', public.mask_phone_e164(r.phone_e164),
                             'challenge_id', r.id, 'error_code', _error_code,
                             'provider', _provider_name));
  RETURN jsonb_build_object('ok', false);
END $$;

-- FUNCTION: phone_verification_invalidate(uuid)
CREATE OR REPLACE FUNCTION public.phone_verification_invalidate(_challenge_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _rows int; _user_id uuid;
BEGIN
  SELECT user_id INTO _user_id FROM phone_verification_challenges WHERE id = _challenge_id;
  IF _user_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  UPDATE phone_verification_challenges
     SET is_active = false, delivery_status = 'failed',
         invalidated_at = COALESCE(invalidated_at, now()), updated_at = now()
   WHERE id = _challenge_id;
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', _rows = 1);
END $$;

-- FUNCTION: phone_verification_manual_verify(uuid, uuid, text)
CREATE OR REPLACE FUNCTION public.phone_verification_manual_verify(_user_id uuid, _admin_id uuid, _reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r user_phone_verifications%ROWTYPE; _already boolean := false;
BEGIN
  IF _reason IS NULL OR length(btrim(_reason)) < 5 OR length(btrim(_reason)) > 500 THEN
    RETURN jsonb_build_object('error','phone_verification_not_allowed');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT * INTO r FROM user_phone_verifications WHERE user_id = _user_id FOR UPDATE;
  IF NOT FOUND OR r.phone_e164 IS NULL THEN
    RETURN jsonb_build_object('error','phone_invalid');
  END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  IF r.phone_verified_at IS NOT NULL THEN
    _already := true;
  ELSE
    UPDATE user_phone_verifications
       SET phone_verified_at = now(), last_verified_at = now(),
           verification_method = 'admin_manual', verified_by_admin_id = _admin_id,
           manual_verification_reason = btrim(_reason), updated_at = now()
     WHERE user_id = _user_id
    RETURNING * INTO r;
  END IF;

  -- Mandatory audit: same transaction as the state change.
  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_manual_verify', 'user_phone_verification',
          _user_id, _admin_id,
          jsonb_build_object('verified', true, 'method', r.verification_method,
                             'reason', btrim(_reason), 'already_verified', _already,
                             'actor_admin_id', _admin_id, 'target_user_id', _user_id,
                             'phone_masked', public.mask_phone_e164(r.phone_e164)));

  RETURN jsonb_build_object('verifiedAt', r.phone_verified_at,
    'verificationMethod', r.verification_method,
    'phoneMasked', public.mask_phone_e164(r.phone_e164), 'alreadyVerified', _already);
END $$;

-- FUNCTION: phone_verification_mark_delivery(uuid, boolean, text, text)
CREATE OR REPLACE FUNCTION public.phone_verification_mark_delivery(_challenge_id uuid, _sent boolean, _provider_name text DEFAULT NULL::text, _provider_message_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _rows int; _user_id uuid;
BEGIN
  SELECT user_id INTO _user_id FROM phone_verification_challenges WHERE id = _challenge_id;
  IF _user_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  UPDATE phone_verification_challenges
     SET delivery_status = CASE WHEN _sent THEN 'sent' ELSE 'failed' END,
         sent_at = CASE WHEN _sent THEN now() ELSE sent_at END,
         is_active = CASE WHEN _sent THEN is_active ELSE false END,
         invalidated_at = CASE WHEN _sent THEN invalidated_at ELSE COALESCE(invalidated_at, now()) END,
         provider_name = _provider_name,
         provider_message_id = _provider_message_id,
         updated_at = now()
   WHERE id = _challenge_id
     AND consumed_at IS NULL
     AND invalidated_at IS NULL
     AND delivery_status = 'pending';
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', _rows = 1);
END $$;

-- FUNCTION: phone_verification_start(uuid, uuid, text, text, text, integer, text, uuid, text, integer)
CREATE OR REPLACE FUNCTION public.phone_verification_start(_challenge_id uuid, _user_id uuid, _phone text, _purpose text, _code_digest text, _ttl_seconds integer, _created_by text, _created_by_admin_id uuid, _created_ip_hash text, _max_attempts integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE _last timestamptz; _n int; _expires timestamptz;
BEGIN
  IF _code_digest IS NULL OR length(_code_digest) < 32 OR _code_digest = 'pending' THEN
    RETURN jsonb_build_object('error','phone_verification_unavailable');
  END IF;

  -- Serializes every concurrent start/resend for this user inside one tx.
  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  IF EXISTS (SELECT 1 FROM user_phone_verifications
              WHERE user_id = _user_id AND phone_verified_at IS NOT NULL) THEN
    RETURN jsonb_build_object('error','phone_already_verified');
  END IF;

  SELECT max(created_at) INTO _last FROM phone_verification_challenges
   WHERE user_id = _user_id AND created_at > now() - interval '10 minutes';
  IF _last IS NOT NULL AND _last > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('error','phone_resend_too_soon',
      'retryAfterSeconds', ceil(extract(epoch from (_last + interval '60 seconds' - now()))));
  END IF;

  SELECT count(*) INTO _n FROM phone_verification_challenges
   WHERE user_id = _user_id AND created_at > now() - interval '1 hour';
  IF _n >= 5 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;

  IF _created_by = 'admin' THEN
    SELECT count(*) INTO _n FROM phone_verification_challenges
     WHERE user_id = _user_id AND created_by = 'admin' AND created_at > now() - interval '1 hour';
    IF _n >= 5 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;
  END IF;

  SELECT count(*) INTO _n FROM phone_verification_challenges
   WHERE phone_e164 = _phone AND created_at > now() - interval '24 hours';
  IF _n >= 10 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;

  IF _created_ip_hash IS NOT NULL THEN
    SELECT count(*) INTO _n FROM phone_verification_challenges
     WHERE created_ip_hash = _created_ip_hash AND created_at > now() - interval '24 hours';
    IF _n >= 20 THEN RETURN jsonb_build_object('error','phone_rate_limited'); END IF;
  END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  _expires := now() + make_interval(secs => greatest(_ttl_seconds, 60));

  INSERT INTO phone_verification_challenges(
    id, user_id, phone_e164, purpose, code_digest, expires_at, max_attempts,
    created_by, created_by_admin_id, created_ip_hash)
  VALUES (_challenge_id, _user_id, _phone, _purpose, _code_digest, _expires,
          greatest(coalesce(_max_attempts,5),1),
          _created_by, _created_by_admin_id, _created_ip_hash);

  INSERT INTO user_phone_verifications(user_id, phone_e164, country_code)
  VALUES (_user_id, _phone, 'IR')
  ON CONFLICT (user_id) DO UPDATE
    SET phone_e164 = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                          THEN EXCLUDED.phone_e164 ELSE user_phone_verifications.phone_e164 END,
        updated_at = now();

  RETURN jsonb_build_object('challengeId', _challenge_id,
                            'expiresAt', _expires,
                            'maxAttempts', greatest(coalesce(_max_attempts,5),1));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error','phone_resend_too_soon','retryAfterSeconds',60);
END $$;

-- FUNCTION: phone_verification_state(uuid)
CREATE OR REPLACE FUNCTION public.phone_verification_state(_user_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH v AS (SELECT * FROM user_phone_verifications WHERE user_id = _user_id),
       c AS (SELECT * FROM phone_verification_challenges
              WHERE user_id = _user_id AND is_active AND expires_at > now()
                AND delivery_status = 'sent'
              ORDER BY created_at DESC LIMIT 1)
  SELECT jsonb_build_object(
    'userId', _user_id,
    'phone', (SELECT phone_e164 FROM v),
    'phoneMasked', public.mask_phone_e164((SELECT phone_e164 FROM v)),
    'country', (SELECT country_code FROM v),
    'verified', (SELECT phone_verified_at FROM v) IS NOT NULL,
    'verifiedAt', (SELECT phone_verified_at FROM v),
    'verificationMethod', (SELECT verification_method FROM v),
    'verifiedByAdminId', (SELECT verified_by_admin_id FROM v),
    'verifiedByAdminEmail', (SELECT p.email FROM profiles p
                              WHERE p.id = (SELECT verified_by_admin_id FROM v)),
    'manualVerificationReason', (SELECT manual_verification_reason FROM v),
    'hasActiveChallenge', EXISTS (SELECT 1 FROM c),
    'activeChallengeId', (SELECT id FROM c),
    'challengeExpiresInSeconds', (SELECT greatest(0, ceil(extract(epoch from (expires_at - now()))))::int FROM c),
    'lastSentAt', (SELECT max(sent_at) FROM phone_verification_challenges x WHERE x.user_id = _user_id),
    'lastCreatedAt', (SELECT max(created_at) FROM phone_verification_challenges x WHERE x.user_id = _user_id),
    'remainingAttempts', (SELECT greatest(max_attempts - attempt_count, 0) FROM c)
  )
$$;

-- FUNCTION: phone_verification_verify(uuid, uuid, text, uuid, uuid, text)
CREATE OR REPLACE FUNCTION public.phone_verification_verify(_challenge_id uuid, _user_id uuid, _candidate_digest text, _actor_user_id uuid DEFAULT NULL::uuid, _workspace_id uuid DEFAULT NULL::uuid, _purpose text DEFAULT 'widget_access'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE r phone_verification_challenges%ROWTYPE; _verified_at timestamptz; _left int;
BEGIN
  IF _candidate_digest IS NULL OR _candidate_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('error','phone_code_invalid');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT * INTO r FROM phone_verification_challenges
   WHERE id = _challenge_id AND user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;
  IF r.purpose IS DISTINCT FROM _purpose THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR NOT r.is_active THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.delivery_status <> 'sent' THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.expires_at <= now() THEN
    UPDATE phone_verification_challenges
       SET is_active=false, invalidated_at=now(), updated_at=now() WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_code_expired');
  END IF;
  IF r.attempt_count >= r.max_attempts THEN
    UPDATE phone_verification_challenges
       SET is_active=false, invalidated_at=now(), updated_at=now() WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_attempts_exceeded');
  END IF;
  IF r.code_digest IS NULL OR r.code_digest !~ '^[0-9a-f]{64}$' THEN
    UPDATE phone_verification_challenges
       SET is_active=false, invalidated_at=now(), updated_at=now() WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_code_invalid');
  END IF;

  -- Wrong code: burn one attempt, invalidate at the cap.
  IF r.code_digest <> _candidate_digest THEN
    UPDATE phone_verification_challenges
       SET attempt_count = attempt_count + 1,
           is_active = CASE WHEN attempt_count + 1 >= max_attempts THEN false ELSE true END,
           invalidated_at = CASE WHEN attempt_count + 1 >= max_attempts THEN now() ELSE invalidated_at END,
           updated_at = now()
     WHERE id = r.id
    RETURNING * INTO r;
    _left := greatest(r.max_attempts - r.attempt_count, 0);
    INSERT INTO audit_logs(action, entity_type, entity_id, user_id, workspace_id, new_value)
    VALUES ('phone_verification_code_failed','user_phone_verification', r.user_id,
            _actor_user_id, _workspace_id,
            jsonb_build_object('purpose', r.purpose,
                               'phone_masked', public.mask_phone_e164(r.phone_e164),
                               'attempts_left', _left,
                               'challenge_id', r.id));
    RETURN jsonb_build_object(
      'error', CASE WHEN _left = 0 THEN 'phone_attempts_exceeded' ELSE 'phone_code_invalid' END,
      'attemptsLeft', _left);
  END IF;

  -- Correct code: consume, verify the account, kill sibling challenges.
  UPDATE phone_verification_challenges
     SET consumed_at = now(), is_active = false, updated_at = now()
   WHERE id = r.id RETURNING * INTO r;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  INSERT INTO user_phone_verifications(user_id, phone_e164, country_code,
      phone_verified_at, verification_method, last_verified_at)
  VALUES (_user_id, r.phone_e164, 'IR', now(), 'sms_otp', now())
  ON CONFLICT (user_id) DO UPDATE SET
      phone_e164 = EXCLUDED.phone_e164,
      phone_verified_at = COALESCE(user_phone_verifications.phone_verified_at, now()),
      verification_method = COALESCE(user_phone_verifications.verification_method, 'sms_otp'),
      verified_by_admin_id = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                                  THEN NULL ELSE user_phone_verifications.verified_by_admin_id END,
      manual_verification_reason = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                                  THEN NULL ELSE user_phone_verifications.manual_verification_reason END,
      last_verified_at = now(),
      updated_at = now()
  RETURNING phone_verified_at INTO _verified_at;

  -- Single canonical success event, same transaction as the state change.
  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, workspace_id, new_value)
  VALUES ('phone_verification_succeeded','user_phone_verification', _user_id,
          _actor_user_id, _workspace_id,
          jsonb_build_object('purpose', r.purpose,
                             'verification_method','sms_otp',
                             'target_user_id', _user_id,
                             'phone_masked', public.mask_phone_e164(r.phone_e164),
                             'verified_at', _verified_at,
                             'challenge_id', r.id));

  RETURN jsonb_build_object('verifiedAt', _verified_at,
                            'phoneMasked', public.mask_phone_e164(r.phone_e164));
END $_$;

-- FUNCTION: protect_workspace_domain_fields()
CREATE OR REPLACE FUNCTION public.protect_workspace_domain_fields() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF (
    COALESCE(OLD.widget_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_base_url, '') OR
    COALESCE(OLD.widget_public_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_public_base_url, '') OR
    COALESCE(OLD.widget_loader_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_loader_base_url, '') OR
    COALESCE(OLD.widget_api_base_url, '') IS DISTINCT FROM COALESCE(NEW.widget_api_base_url, '') OR
    COALESCE(OLD.canonical_base_url, '') IS DISTINCT FROM COALESCE(NEW.canonical_base_url, '') OR
    COALESCE(OLD.panel_base_url, '') IS DISTINCT FROM COALESCE(NEW.panel_base_url, '') OR
    COALESCE(OLD.asset_base_url, '') IS DISTINCT FROM COALESCE(NEW.asset_base_url, '')
  ) THEN
    IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
      NEW.widget_base_url := OLD.widget_base_url;
      NEW.widget_public_base_url := OLD.widget_public_base_url;
      NEW.widget_loader_base_url := OLD.widget_loader_base_url;
      NEW.widget_api_base_url := OLD.widget_api_base_url;
      NEW.canonical_base_url := OLD.canonical_base_url;
      NEW.panel_base_url := OLD.panel_base_url;
      NEW.asset_base_url := OLD.asset_base_url;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- FUNCTION: register_workspace_domain(uuid, text, boolean)
CREATE OR REPLACE FUNCTION public.register_workspace_domain(_workspace_id uuid, _raw_domain text, _make_primary boolean DEFAULT true) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_domain text;
  v_existing_id uuid;
  v_allowed text[];
BEGIN
  v_domain := public.normalize_domain(_raw_domain);
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN;
  END IF;

  -- Insert into workspace_domains (verified, optionally primary)
  SELECT id INTO v_existing_id
  FROM public.workspace_domains
  WHERE workspace_id = _workspace_id AND domain = v_domain
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    -- If we're making this primary, unset any existing primary first
    IF _make_primary THEN
      UPDATE public.workspace_domains
      SET is_primary = false
      WHERE workspace_id = _workspace_id AND is_primary = true;
    END IF;

    INSERT INTO public.workspace_domains (workspace_id, domain, verified, is_primary)
    VALUES (_workspace_id, v_domain, true, _make_primary);
  END IF;

  -- Ensure widget_settings exists, append domain to allowed_domains, enable subdomains
  INSERT INTO public.widget_settings (workspace_id, allowed_domains, allow_subdomains)
  VALUES (_workspace_id, ARRAY[v_domain], true)
  ON CONFLICT (workspace_id) DO UPDATE
    SET allowed_domains = (
      SELECT ARRAY(
        SELECT DISTINCT unnest(
          COALESCE(public.widget_settings.allowed_domains, ARRAY[]::text[]) || ARRAY[v_domain]
        )
      )
    ),
    allow_subdomains = true,
    updated_at = now();
END;
$$;

-- FUNCTION: resolve_privacy_subject(uuid, text, text)
CREATE OR REPLACE FUNCTION public.resolve_privacy_subject(_workspace_id uuid, _subject_type text, _subject_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _contact_ids uuid[] := ARRAY[]::uuid[];
  _visitor_ids text[] := ARRAY[]::text[];
  _emails text[] := ARRAY[]::text[];
  _root_contact_id uuid;
  _root_visitor_id text;
BEGIN
  IF _subject_type = 'contact' THEN
    _root_contact_id := _subject_id::uuid;
    _contact_ids := ARRAY[_root_contact_id];

    -- Pull email/phone from contacts row
    SELECT ARRAY_REMOVE(ARRAY[email], NULL) INTO _emails
    FROM public.contacts
    WHERE id = _root_contact_id AND workspace_id = _workspace_id;

    -- Find all visitor_ids merged into this contact
    SELECT ARRAY_AGG(DISTINCT visitor_id) INTO _visitor_ids
    FROM public.identity_merges
    WHERE workspace_id = _workspace_id AND contact_id = _root_contact_id;

    -- Also pull visitor_ids directly attached via visitor_sessions
    _visitor_ids := COALESCE(_visitor_ids, ARRAY[]::text[]) || COALESCE(
      (SELECT ARRAY_AGG(DISTINCT vs.visitor_id)
       FROM public.visitor_sessions vs
       WHERE vs.workspace_id = _workspace_id AND vs.contact_id = _root_contact_id),
      ARRAY[]::text[]
    );

  ELSIF _subject_type = 'visitor' THEN
    _root_visitor_id := _subject_id;
    _visitor_ids := ARRAY[_root_visitor_id];

    -- Find any contact this visitor was merged into
    SELECT ARRAY_AGG(DISTINCT contact_id) INTO _contact_ids
    FROM public.identity_merges
    WHERE workspace_id = _workspace_id AND visitor_id = _root_visitor_id;

    _contact_ids := COALESCE(_contact_ids, ARRAY[]::uuid[]) || COALESCE(
      (SELECT ARRAY_AGG(DISTINCT vs.contact_id)
       FROM public.visitor_sessions vs
       WHERE vs.workspace_id = _workspace_id
         AND vs.visitor_id = _root_visitor_id
         AND vs.contact_id IS NOT NULL),
      ARRAY[]::uuid[]
    );

    -- Pull emails from any matching contacts
    IF array_length(_contact_ids, 1) > 0 THEN
      SELECT ARRAY_AGG(DISTINCT email) INTO _emails
      FROM public.contacts
      WHERE id = ANY(_contact_ids) AND email IS NOT NULL;
    END IF;

  ELSIF _subject_type = 'user' THEN
    -- User subjects: not workspace-scoped here; resolver returns user identifiers
    SELECT ARRAY_REMOVE(ARRAY[email], NULL) INTO _emails
    FROM public.profiles WHERE id = _subject_id::uuid;
  END IF;

  RETURN jsonb_build_object(
    'contact_ids', COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(_contact_ids))), '[]'::jsonb),
    'visitor_ids', COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(_visitor_ids))), '[]'::jsonb),
    'emails', COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(COALESCE(_emails, ARRAY[]::text[])))), '[]'::jsonb)
  );
END;
$$;

-- FUNCTION: retention_partition_preview(text)
CREATE OR REPLACE FUNCTION public.retention_partition_preview(_policy_key text) RETURNS TABLE(policy_key text, parent_table text, partition_key text, cutoff timestamp with time zone, partition_name text, range_start timestamp with time zone, range_end timestamp with time zone, est_rows bigint, est_bytes bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  p record;
  v_days int;
  v_cutoff timestamptz;
  v_key text;
begin
  select * into p from public.data_retention_policies where data_retention_policies.policy_key = _policy_key;
  if p is null then
    raise exception 'policy_not_found: %', _policy_key using errcode = '22023';
  end if;

  -- Protected policies never yield a droppable partition. Three independent
  -- conditions, matching server/services/retention/types.ts exactly.
  if p.retention_mode = 'permanent'
     or p.category in ('financial', 'core')
     or p.table_name like 'billing\_%'
     or p.table_name in (
       'profiles','users','workspaces','accounts','account_members','conversations',
       'conversation_messages','contacts','knowledge_base_articles','knowledge_base_categories',
       'ai_agent_sources','ai_source_pages','ai_knowledge_chunks','ai_run_settlements','financial_settlements'
     )
  then
    return;
  end if;

  if not p.enabled then
    return;
  end if;

  v_days := case when p.retention_mode = 'archive_then_delete'
                 then p.archive_after_days else p.hot_retention_days end;
  if v_days is null or v_days <= 0 then
    return;
  end if;

  select m.partition_key into v_key
  from public.partition_managed_tables() m
  where m.parent_table = p.table_name;
  if v_key is null then
    return; -- not partitioned: the row-based retention engine handles it
  end if;

  v_cutoff := now() - make_interval(days => v_days);

  return query
  select _policy_key, p.table_name, v_key, v_cutoff,
         c.partition_name, c.range_start, c.range_end, c.est_rows, c.total_bytes
  from public.partition_retention_candidates(p.table_name, v_cutoff) c;
end;
$$;

-- FUNCTION: set_call_invitations_updated_at()
CREATE OR REPLACE FUNCTION public.set_call_invitations_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: set_conversation_notes_updated_at()
CREATE OR REPLACE FUNCTION public.set_conversation_notes_updated_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: set_operator_call_avail_updated_at()
CREATE OR REPLACE FUNCTION public.set_operator_call_avail_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: set_role_permissions_updated_at()
CREATE OR REPLACE FUNCTION public.set_role_permissions_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: set_widget_templates_updated_at()
CREATE OR REPLACE FUNCTION public.set_widget_templates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- FUNCTION: sla_reliability_rollup_and_prune()
CREATE OR REPLACE FUNCTION public.sla_reliability_rollup_and_prune() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  bucket           timestamptz := date_trunc('hour', now()) - interval '1 hour';
  bucket_end       timestamptz := bucket + interval '1 hour';
  rolled           integer := 0;
  pruned           integer := 0;
  v_critical       integer;
  v_warn           integer;
  v_failovers      integer;
  v_recoveries     integer;
  v_unhealthy_mins numeric;
  v_degraded_mins  numeric;
  v_polling_mins   numeric;
  v_recovery_avg   numeric;
  v_uptime_pct     numeric;
  v_realtime_pct   numeric;
BEGIN
  -- ── Platform-scope ────────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE severity = 'critical'),
    COUNT(*) FILTER (WHERE severity = 'warn')
  INTO v_critical, v_warn
  FROM public.alert_events
  WHERE fired_at >= bucket AND fired_at < bucket_end;

  SELECT
    COUNT(*) FILTER (WHERE action = 'failover'),
    COUNT(*) FILTER (WHERE action = 'failback')
  INTO v_failovers, v_recoveries
  FROM public.realtime_provider_audit
  WHERE created_at >= bucket AND created_at < bucket_end;

  -- Degraded / polling minutes derived from auto-action events that overlap the bucket
  SELECT
    COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(ended_at, expires_at), bucket_end) - GREATEST(started_at, bucket)
      )) / 60.0
    ), 0)
  INTO v_degraded_mins
  FROM public.auto_action_events
  WHERE action_type IN ('enable_degraded_mode','force_polling_temporarily','disable_typing_temporarily')
    AND started_at < bucket_end
    AND COALESCE(ended_at, expires_at) > bucket;

  SELECT
    COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(ended_at, expires_at), bucket_end) - GREATEST(started_at, bucket)
      )) / 60.0
    ), 0)
  INTO v_polling_mins
  FROM public.auto_action_events
  WHERE action_type = 'force_polling_temporarily'
    AND started_at < bucket_end
    AND COALESCE(ended_at, expires_at) > bucket;

  -- Mean recovery seconds: time between resolution and prior fire of critical alerts
  SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - fired_at)))
    INTO v_recovery_avg
    FROM public.alert_events
   WHERE resolved_at IS NOT NULL
     AND resolved_at >= bucket AND resolved_at < bucket_end
     AND severity IN ('critical','warn','resolved');

  v_unhealthy_mins := LEAST(60, v_degraded_mins);
  v_uptime_pct := GREATEST(0, 100 - (v_unhealthy_mins / 60.0 * 100));
  v_realtime_pct := GREATEST(0, 100 - (v_polling_mins / 60.0 * 100));

  INSERT INTO public.sla_reliability_hourly
    (bucket_hour, scope_type, scope_key, uptime_pct, realtime_availability_pct,
     degraded_minutes, forced_polling_minutes, critical_alert_count, warn_alert_count,
     failover_count, recovery_count, mean_failover_recovery_seconds, unhealthy_minutes, details)
  VALUES
    (bucket, 'platform', 'platform', v_uptime_pct, v_realtime_pct,
     v_degraded_mins, v_polling_mins, COALESCE(v_critical,0), COALESCE(v_warn,0),
     COALESCE(v_failovers,0), COALESCE(v_recoveries,0), v_recovery_avg, v_unhealthy_mins,
     '{}'::jsonb)
  ON CONFLICT (bucket_hour, scope_type, scope_key) DO UPDATE SET
    uptime_pct = EXCLUDED.uptime_pct,
    realtime_availability_pct = EXCLUDED.realtime_availability_pct,
    degraded_minutes = EXCLUDED.degraded_minutes,
    forced_polling_minutes = EXCLUDED.forced_polling_minutes,
    critical_alert_count = EXCLUDED.critical_alert_count,
    warn_alert_count = EXCLUDED.warn_alert_count,
    failover_count = EXCLUDED.failover_count,
    recovery_count = EXCLUDED.recovery_count,
    mean_failover_recovery_seconds = EXCLUDED.mean_failover_recovery_seconds,
    unhealthy_minutes = EXCLUDED.unhealthy_minutes;
  rolled := rolled + 1;

  -- ── Provider-scope (one row per known provider id involved this hour) ──
  INSERT INTO public.sla_reliability_hourly
    (bucket_hour, scope_type, scope_key, failover_count, recovery_count, details)
  SELECT
    bucket,
    'provider',
    vendor,
    COUNT(*) FILTER (WHERE action = 'failover'),
    COUNT(*) FILTER (WHERE action = 'failback'),
    '{}'::jsonb
  FROM public.realtime_provider_audit
  WHERE created_at >= bucket AND created_at < bucket_end AND vendor IS NOT NULL
  GROUP BY vendor
  ON CONFLICT (bucket_hour, scope_type, scope_key) DO UPDATE SET
    failover_count = EXCLUDED.failover_count,
    recovery_count = EXCLUDED.recovery_count;

  -- Prune > 90 days
  DELETE FROM public.sla_reliability_hourly WHERE bucket_hour < now() - interval '90 days';
  GET DIAGNOSTICS pruned = ROW_COUNT;

  RETURN jsonb_build_object('rolled', rolled, 'pruned', pruned, 'bucket', bucket, 'ran_at', now());
END $$;

-- FUNCTION: slo_definitions_protect_builtin()
CREATE OR REPLACE FUNCTION public.slo_definitions_protect_builtin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF OLD.is_builtin = true THEN
    NEW.slug := OLD.slug;
    NEW.scope_type := OLD.scope_type;
    NEW.metric_key := OLD.metric_key;
    NEW.target_type := OLD.target_type;
    NEW.is_builtin := true;
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: slo_definitions_touch()
CREATE OR REPLACE FUNCTION public.slo_definitions_touch() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- FUNCTION: tg_ai_usage_logs_count_request()
CREATE OR REPLACE FUNCTION public.tg_ai_usage_logs_count_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.bump_usage_counter_for(NEW.workspace_id, 'ai_requests_count', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

-- FUNCTION: tg_conversation_messages_count_message()
CREATE OR REPLACE FUNCTION public.tg_conversation_messages_count_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  _ws uuid;
BEGIN
  SELECT workspace_id INTO _ws FROM public.conversations WHERE id = NEW.conversation_id;
  PERFORM public.bump_usage_counter_for(_ws, 'messages_count', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

-- FUNCTION: tg_conversations_count_conversation()
CREATE OR REPLACE FUNCTION public.tg_conversations_count_conversation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.bump_usage_counter_for(NEW.workspace_id, 'conversations_count', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

-- FUNCTION: tg_visitor_sessions_count_visitor()
CREATE OR REPLACE FUNCTION public.tg_visitor_sessions_count_visitor() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_period       text;
  v_period_start timestamptz;
  v_existing     int;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.visitor_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_period       := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM');
  v_period_start := date_trunc('month', (now() AT TIME ZONE 'UTC'))
                    AT TIME ZONE 'UTC';

  SELECT count(*) INTO v_existing
  FROM public.visitor_sessions
  WHERE workspace_id = NEW.workspace_id
    AND visitor_id   = NEW.visitor_id
    AND id <> NEW.id
    AND COALESCE(started_at, last_seen_at, now()) >= v_period_start;

  IF v_existing > 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.workspace_usage_counters
    (workspace_id, period, visitors_count)
  VALUES
    (NEW.workspace_id, v_period, 1)
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET visitors_count = public.workspace_usage_counters.visitors_count + 1,
        updated_at     = now();

  RETURN NEW;
END;
$$;

-- FUNCTION: touch_ai_agent_test_cases_updated_at()
CREATE OR REPLACE FUNCTION public.touch_ai_agent_test_cases_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: touch_ai_source_sync_jobs()
CREATE OR REPLACE FUNCTION public.touch_ai_source_sync_jobs() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- FUNCTION: touch_auto_action_definitions()
CREATE OR REPLACE FUNCTION public.touch_auto_action_definitions() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: touch_enforcement_rules()
CREATE OR REPLACE FUNCTION public.touch_enforcement_rules() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- FUNCTION: touch_updated_at_e10()
CREATE OR REPLACE FUNCTION public.touch_updated_at_e10() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- FUNCTION: touch_user_notification_prefs()
CREATE OR REPLACE FUNCTION public.touch_user_notification_prefs() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: user_availability_prefs_set_updated_at()
CREATE OR REPLACE FUNCTION public.user_availability_prefs_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- FUNCTION: user_phone_verified(uuid)
CREATE OR REPLACE FUNCTION public.user_phone_verified(_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_phone_verifications v
    WHERE v.user_id = _user_id AND v.phone_verified_at IS NOT NULL
  )
$$;

-- FUNCTION: validate_email_log_status()
CREATE OR REPLACE FUNCTION public.validate_email_log_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'sent', 'failed', 'bounced') THEN
    RAISE EXCEPTION 'Invalid email_logs status: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: validate_widget_template_slug()
CREATE OR REPLACE FUNCTION public.validate_widget_template_slug() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Allow 'default' always (runtime fallback).
  IF NEW.template_slug = 'default' THEN
    RETURN NEW;
  END IF;
  -- Otherwise the slug must exist in widget_templates and be enabled.
  IF NOT EXISTS (
    SELECT 1 FROM public.widget_templates
    WHERE slug = NEW.template_slug AND enabled = true
  ) THEN
    RAISE EXCEPTION 'Widget template "%" is not registered or not enabled', NEW.template_slug;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: widget_platform_settings_validate_phase1()
CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.typing_rate_limit_window_ms < 250 OR NEW.typing_rate_limit_window_ms > 60000 THEN
    RAISE EXCEPTION 'typing_rate_limit_window_ms must be between 250 and 60000';
  END IF;
  IF NEW.typing_rate_limit_max_events < 1 OR NEW.typing_rate_limit_max_events > 100 THEN
    RAISE EXCEPTION 'typing_rate_limit_max_events must be between 1 and 100';
  END IF;
  IF NEW.realtime_reconnect_jitter_pct < 0 OR NEW.realtime_reconnect_jitter_pct > 50 THEN
    RAISE EXCEPTION 'realtime_reconnect_jitter_pct must be between 0 and 50';
  END IF;
  IF NEW.realtime_token_ttl_seconds < 300 OR NEW.realtime_token_ttl_seconds > 7200 THEN
    RAISE EXCEPTION 'realtime_token_ttl_seconds must be between 300 and 7200';
  END IF;
  IF NEW.realtime_idle_disposal_ms < 10000 OR NEW.realtime_idle_disposal_ms > 1800000 THEN
    RAISE EXCEPTION 'realtime_idle_disposal_ms must be between 10000 and 1800000';
  END IF;
  IF NEW.realtime_pending_max < 32 OR NEW.realtime_pending_max > 4096 THEN
    RAISE EXCEPTION 'realtime_pending_max must be between 32 and 4096';
  END IF;
  IF NEW.realtime_message_dedupe_window < 16 OR NEW.realtime_message_dedupe_window > 4096 THEN
    RAISE EXCEPTION 'realtime_message_dedupe_window must be between 16 and 4096';
  END IF;
  IF NEW.observability_log_level NOT IN ('debug','info','warn','error') THEN
    RAISE EXCEPTION 'observability_log_level must be one of debug|info|warn|error';
  END IF;
  IF NEW.alert_webhook_url IS NOT NULL AND NEW.alert_webhook_url <> '' THEN
    IF NEW.alert_webhook_url !~ '^https?://' THEN
      RAISE EXCEPTION 'alert_webhook_url must start with http:// or https://';
    END IF;
  END IF;
  IF NEW.perf_memory_budget_mb < 64 OR NEW.perf_memory_budget_mb > 32768 THEN
    RAISE EXCEPTION 'perf_memory_budget_mb must be between 64 and 32768';
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: widget_settings_validate_offline_mode()
CREATE OR REPLACE FUNCTION public.widget_settings_validate_offline_mode() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.offline_mode NOT IN ('accept_messages', 'contact_fallback') THEN
    RAISE EXCEPTION 'invalid offline_mode: %, expected accept_messages or contact_fallback', NEW.offline_mode;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: workspace_domains_normalize()
CREATE OR REPLACE FUNCTION public.workspace_domains_normalize() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.domain := public.normalize_domain(NEW.domain);
  IF NEW.domain IS NULL OR NEW.domain = '' THEN
    RAISE EXCEPTION 'Invalid domain';
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: workspace_health_snapshot_compute()
CREATE OR REPLACE FUNCTION public.workspace_health_snapshot_compute() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  inserted      integer := 0;
  pruned        integer := 0;
BEGIN
  WITH win AS (
    SELECT
      bm.workspace_id,
      AVG(COALESCE(bm.first_response_time_p95, 0))                AS frt_p95_avg,
      SUM(COALESCE(bm.unanswered_conversations, 0))               AS unanswered_sum,
      SUM(COALESCE(bm.stale_open_conversations, 0))               AS stale_sum,
      AVG(COALESCE(bm.support_load_score, 0))                     AS load_avg,
      COUNT(*)                                                     AS sample
    FROM public.business_metrics_hourly bm
    WHERE bm.bucket_hour >= now() - interval '24 hours'
    GROUP BY bm.workspace_id
  ),
  plat AS (
    SELECT
      AVG(COALESCE(uptime_pct, 100))            AS uptime_avg,
      SUM(COALESCE(degraded_minutes, 0))        AS degraded_total,
      SUM(COALESCE(failover_count, 0))          AS failovers_total,
      SUM(COALESCE(critical_alert_count, 0))    AS criticals_total
    FROM public.sla_reliability_hourly
    WHERE bucket_hour >= now() - interval '24 hours'
      AND scope_type = 'platform'
  ),
  scored AS (
    SELECT
      w.id AS workspace_id,
      -- Component sub-scores 0..100 (higher is better)
      GREATEST(0, LEAST(100, COALESCE((SELECT uptime_avg FROM plat), 100)))                     AS s_availability,
      GREATEST(0, 100 - LEAST(100, COALESCE((SELECT degraded_total FROM plat), 0) * 2))         AS s_degraded,
      GREATEST(0, 100 - LEAST(100, COALESCE((SELECT failovers_total FROM plat), 0) * 20))       AS s_failover,
      GREATEST(0, 100 - LEAST(100, COALESCE((SELECT criticals_total FROM plat), 0) * 25))       AS s_alerts,
      GREATEST(0, 100 - LEAST(100, COALESCE(win.frt_p95_avg, 0) / 60.0 * 5))                    AS s_frt,
      GREATEST(0, 100 - LEAST(100, COALESCE(win.unanswered_sum, 0) * 5))                        AS s_unanswered,
      GREATEST(0, 100 - LEAST(100, COALESCE(win.stale_sum, 0) * 5))                             AS s_stale
    FROM public.workspaces w
    LEFT JOIN win ON win.workspace_id = w.id
  )
  INSERT INTO public.workspace_health_snapshots (workspace_id, health_score, state, components, inputs)
  SELECT
    workspace_id,
    GREATEST(0, LEAST(100,
      ROUND(
        s_availability * 0.20 + s_degraded * 0.10 + s_failover * 0.10 + s_alerts * 0.15
        + s_frt * 0.20 + s_unanswered * 0.15 + s_stale * 0.10
      )::int
    )),
    CASE
      WHEN ROUND(
        s_availability * 0.20 + s_degraded * 0.10 + s_failover * 0.10 + s_alerts * 0.15
        + s_frt * 0.20 + s_unanswered * 0.15 + s_stale * 0.10
      )::int >= 80 THEN 'healthy'
      WHEN ROUND(
        s_availability * 0.20 + s_degraded * 0.10 + s_failover * 0.10 + s_alerts * 0.15
        + s_frt * 0.20 + s_unanswered * 0.15 + s_stale * 0.10
      )::int >= 60 THEN 'warning'
      ELSE 'at_risk'
    END,
    jsonb_build_object(
      'availability', s_availability,
      'degraded',     s_degraded,
      'failover',     s_failover,
      'alerts',       s_alerts,
      'frt',          s_frt,
      'unanswered',   s_unanswered,
      'stale',        s_stale
    ),
    '{}'::jsonb
  FROM scored;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  -- Prune > 90 days of snapshots
  DELETE FROM public.workspace_health_snapshots WHERE captured_at < now() - interval '90 days';
  GET DIAGNOSTICS pruned = ROW_COUNT;

  RETURN jsonb_build_object('inserted', inserted, 'pruned', pruned, 'ran_at', now());
END $$;

-- FUNCTION: workspaces_auto_register_owner_domain()
CREATE OR REPLACE FUNCTION public.workspaces_auto_register_owner_domain() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_owner_domain text;
  v_owner_id uuid;
BEGIN
  -- Find the account owner
  SELECT a.owner_id INTO v_owner_id
  FROM public.accounts a
  WHERE a.id = NEW.account_id;

  IF v_owner_id IS NULL THEN RETURN NEW; END IF;

  -- Pull the website domain from the owner's profile
  SELECT website_domain INTO v_owner_domain
  FROM public.profiles
  WHERE id = v_owner_id;

  IF v_owner_domain IS NULL OR trim(v_owner_domain) = '' THEN
    RETURN NEW;
  END IF;

  PERFORM public.register_workspace_domain(NEW.id, v_owner_domain, true);
  RETURN NEW;
END;
$$;

-- TABLE: admin_gate_bypass_log
CREATE TABLE IF NOT EXISTS public.admin_gate_bypass_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid,
    module_key text NOT NULL,
    route text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_agent_debug_events
CREATE TABLE IF NOT EXISTS public.ai_agent_debug_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    run_id uuid,
    event_type text NOT NULL,
    actor_user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_agent_guidance_rules
CREATE TABLE IF NOT EXISTS public.ai_agent_guidance_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    rule_type text NOT NULL,
    condition_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    instruction text DEFAULT ''::text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_guidance_rules_rule_type_check CHECK ((rule_type = ANY (ARRAY['tone'::text, 'answer_policy'::text, 'escalation_policy'::text, 'restricted_topic'::text, 'fallback_behavior'::text, 'sales_guidance'::text, 'support_guidance'::text, 'pricing_guidance'::text])))
);

-- TABLE: ai_agent_intro_log
CREATE TABLE IF NOT EXISTS public.ai_agent_intro_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid,
    visitor_session_id uuid,
    visitor_id text,
    message_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_agent_learning_candidates
CREATE TABLE IF NOT EXISTS public.ai_agent_learning_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid,
    visitor_message_id uuid,
    operator_message_id uuid,
    question_text text NOT NULL,
    answer_text text NOT NULL,
    normalized_question text NOT NULL,
    source_type text DEFAULT 'operator_reply'::text NOT NULL,
    locale text,
    confidence_score numeric,
    status text DEFAULT 'pending'::text NOT NULL,
    suggested_title text,
    suggested_answer text,
    suggested_tags text[] DEFAULT '{}'::text[] NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    CONSTRAINT ai_agent_learning_candidates_reason_check CHECK (((reason IS NULL) OR (reason = ANY (ARRAY['no_answer'::text, 'low_confidence'::text, 'handoff_after_ai'::text, 'repeated_clarification'::text, 'no_indexed_page'::text, 'no_url'::text, 'operator_answer_available'::text, 'other'::text])))),
    CONSTRAINT ai_agent_learning_candidates_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'converted_to_qna'::text, 'converted_to_kb'::text])))
);

-- TABLE: ai_agent_message_triggers
CREATE TABLE IF NOT EXISTS public.ai_agent_message_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    event_type text NOT NULL,
    conditions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_type text NOT NULL,
    action_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    delay_seconds integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_message_triggers_action_type_check CHECK ((action_type = ANY (ARRAY['send_message'::text, 'start_workflow'::text, 'handoff'::text, 'assign'::text, 'tag'::text, 'internal_note'::text]))),
    CONSTRAINT ai_agent_message_triggers_event_type_check CHECK ((event_type = ANY (ARRAY['visitor_first_message'::text, 'conversation_started'::text, 'after_prechat'::text, 'no_operator_online'::text, 'ai_no_answer'::text, 'topic_detected'::text, 'human_requested'::text, 'business_hours_closed'::text])))
);

-- TABLE: ai_agent_qna
CREATE TABLE IF NOT EXISTS public.ai_agent_qna (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_agent_regression_batches
CREATE TABLE IF NOT EXISTS public.ai_agent_regression_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    schedule_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    trigger_type text DEFAULT 'manual'::text NOT NULL,
    total_cases integer DEFAULT 0 NOT NULL,
    passed integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    errored integer DEFAULT 0 NOT NULL,
    pass_rate numeric,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_regression_batches_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT ai_agent_regression_batches_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['manual'::text, 'scheduled'::text])))
);

-- TABLE: ai_agent_regression_schedules
CREATE TABLE IF NOT EXISTS public.ai_agent_regression_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    name text DEFAULT 'Default regression schedule'::text NOT NULL,
    frequency text DEFAULT 'daily'::text NOT NULL,
    time_of_day text,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    include_enabled_cases_only boolean DEFAULT true NOT NULL,
    max_cases_per_run integer DEFAULT 50 NOT NULL,
    call_llm boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_by uuid,
    updated_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_regression_schedules_frequency_check CHECK ((frequency = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekly'::text, 'manual'::text])))
);

-- TABLE: ai_agent_routing_rules
CREATE TABLE IF NOT EXISTS public.ai_agent_routing_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    trigger_type text NOT NULL,
    conditions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_type text NOT NULL,
    action_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_routing_rules_action_type_check CHECK ((action_type = ANY (ARRAY['handoff'::text, 'assign_team'::text, 'assign_operator'::text, 'keep_ai'::text, 'create_ticket'::text, 'mark_priority'::text]))),
    CONSTRAINT ai_agent_routing_rules_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['human_request'::text, 'no_answer'::text, 'low_confidence'::text, 'topic_detected'::text, 'business_hours'::text, 'language'::text, 'vip_customer'::text, 'plan_limit'::text])))
);

-- TABLE: ai_agent_runs
CREATE TABLE IF NOT EXISTS public.ai_agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid,
    visitor_message_id uuid,
    run_type text NOT NULL,
    mode text,
    status text NOT NULL,
    input_text text,
    output_text text,
    skip_reason text,
    error_message text,
    provider text,
    model text,
    prompt_tokens integer,
    completion_tokens integer,
    credits_used integer DEFAULT 0 NOT NULL,
    kb_article_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    confidence numeric,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_runs_run_type_chk CHECK ((run_type = ANY (ARRAY['playground'::text, 'auto_reply'::text, 'suggestion'::text, 'handoff'::text, 'skip'::text]))),
    CONSTRAINT ai_agent_runs_status_chk CHECK ((status = ANY (ARRAY['skipped'::text, 'replied'::text, 'suggested'::text, 'handoff'::text, 'failed'::text, 'no_answer'::text])))
);

-- TABLE: ai_agent_sources
CREATE TABLE IF NOT EXISTS public.ai_agent_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_sources_type_chk CHECK ((source_type = ANY (ARRAY['knowledge_base'::text, 'web_pages'::text, 'files'::text, 'qna'::text, 'integrations'::text, 'mcp'::text])))
);

-- TABLE: ai_agent_suggested_test_cases
CREATE TABLE IF NOT EXISTS public.ai_agent_suggested_test_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    name text NOT NULL,
    input_message text NOT NULL,
    locale text,
    page_context jsonb,
    expected_behavior text NOT NULL,
    expected_source_type text,
    expected_source_url text,
    expected_source_id text,
    expected_contains text[] DEFAULT '{}'::text[] NOT NULL,
    expected_not_contains text[] DEFAULT '{}'::text[] NOT NULL,
    min_confidence numeric,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_suggested_test_cases_expected_behavior_check CHECK ((expected_behavior = ANY (ARRAY['answer'::text, 'no_answer'::text, 'handoff'::text, 'clarification'::text]))),
    CONSTRAINT ai_agent_suggested_test_cases_source_type_check CHECK ((source_type = ANY (ARRAY['operator_assist_feedback'::text, 'test_run'::text, 'manual'::text]))),
    CONSTRAINT ai_agent_suggested_test_cases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'converted'::text])))
);

-- TABLE: ai_agent_suggestions
CREATE TABLE IF NOT EXISTS public.ai_agent_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    visitor_message_id uuid,
    suggested_reply text NOT NULL,
    source_article_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    confidence numeric,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_suggestions_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'used'::text, 'dismissed'::text, 'expired'::text])))
);

-- TABLE: ai_agent_test_cases
CREATE TABLE IF NOT EXISTS public.ai_agent_test_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    input_message text NOT NULL,
    locale text,
    page_context jsonb,
    expected_behavior text NOT NULL,
    expected_source_type text,
    expected_source_url text,
    expected_source_id text,
    expected_contains text[] DEFAULT '{}'::text[] NOT NULL,
    expected_not_contains text[] DEFAULT '{}'::text[] NOT NULL,
    min_confidence numeric,
    enabled boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_test_cases_expected_behavior_check CHECK ((expected_behavior = ANY (ARRAY['answer'::text, 'no_answer'::text, 'handoff'::text, 'clarification'::text]))),
    CONSTRAINT ai_agent_test_cases_expected_source_type_check CHECK (((expected_source_type IS NULL) OR (expected_source_type = ANY (ARRAY['qna'::text, 'learned_qna'::text, 'kb_article'::text, 'web_page'::text, 'file'::text, 'business_profile'::text]))))
);

-- TABLE: ai_agent_test_runs
CREATE TABLE IF NOT EXISTS public.ai_agent_test_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    test_case_id uuid,
    ai_agent_run_id uuid,
    status text NOT NULL,
    input_message text NOT NULL,
    actual_output text,
    actual_status text,
    confidence numeric,
    selected_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    retrieval_debug jsonb,
    answer_strategy jsonb,
    failure_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    regression_batch_id uuid,
    CONSTRAINT ai_agent_test_runs_status_check CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text, 'errored'::text])))
);

-- TABLE: ai_agent_tool_servers
CREATE TABLE IF NOT EXISTS public.ai_agent_tool_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    server_type text DEFAULT 'mcp'::text NOT NULL,
    endpoint_url text,
    status text DEFAULT 'disabled'::text NOT NULL,
    auth_type text DEFAULT 'none'::text NOT NULL,
    encrypted_config jsonb,
    allowed_tools text[] DEFAULT '{}'::text[] NOT NULL,
    permissions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_checked_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_tool_servers_auth_type_check CHECK ((auth_type = ANY (ARRAY['none'::text, 'bearer'::text, 'basic'::text, 'api_key'::text, 'oauth'::text]))),
    CONSTRAINT ai_agent_tool_servers_server_type_check CHECK ((server_type = ANY (ARRAY['mcp'::text, 'internal'::text, 'webhook'::text]))),
    CONSTRAINT ai_agent_tool_servers_status_check CHECK ((status = ANY (ARRAY['disabled'::text, 'enabled'::text, 'error'::text])))
);

-- TABLE: ai_agent_tools
CREATE TABLE IF NOT EXISTS public.ai_agent_tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    tool_type text NOT NULL,
    provider text,
    server_id uuid,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    permissions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    risk_level text DEFAULT 'low'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_tools_risk_level_check CHECK ((risk_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT ai_agent_tools_tool_type_check CHECK ((tool_type = ANY (ARRAY['internal'::text, 'mcp'::text, 'webhook'::text, 'crm'::text, 'ticket'::text])))
);

-- TABLE: ai_agent_topics
CREATE TABLE IF NOT EXISTS public.ai_agent_topics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    slug text NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    examples text[] DEFAULT '{}'::text[] NOT NULL,
    language text,
    confidence_threshold numeric DEFAULT 0.65 NOT NULL,
    action text DEFAULT 'label_only'::text NOT NULL,
    action_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_topics_action_check CHECK ((action = ANY (ARRAY['label_only'::text, 'route'::text, 'trigger_workflow'::text, 'suggest_reply'::text, 'decline'::text])))
);

-- TABLE: ai_agent_workflows
CREATE TABLE IF NOT EXISTS public.ai_agent_workflows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    trigger_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    steps_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_agent_workflows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'archived'::text])))
);

-- TABLE: ai_data_sources
CREATE TABLE IF NOT EXISTS public.ai_data_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    name text NOT NULL,
    base_url text,
    status text DEFAULT 'active'::text NOT NULL,
    include_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    exclude_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    crawl_depth integer DEFAULT 2 NOT NULL,
    max_pages integer DEFAULT 50 NOT NULL,
    refresh_interval text DEFAULT 'manual'::text NOT NULL,
    last_synced_at timestamp with time zone,
    next_sync_at timestamp with time zone,
    last_error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pages_found integer DEFAULT 0 NOT NULL,
    chunks_created integer DEFAULT 0 NOT NULL,
    embedded_chunks integer DEFAULT 0 NOT NULL,
    last_warning text,
    CONSTRAINT ai_data_sources_refresh_interval_check CHECK ((refresh_interval = ANY (ARRAY['manual'::text, 'daily'::text, 'weekly'::text, 'monthly'::text]))),
    CONSTRAINT ai_data_sources_source_type_check CHECK ((source_type = ANY (ARRAY['website'::text, 'kb'::text, 'qna'::text, 'file'::text, 'business_profile'::text, 'snippet'::text]))),
    CONSTRAINT ai_data_sources_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'syncing'::text, 'failed'::text, 'deleted'::text])))
);

-- TABLE: ai_kb_generated_articles
CREATE TABLE IF NOT EXISTS public.ai_kb_generated_articles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    job_id uuid NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    excerpt text,
    content_md text DEFAULT ''::text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    suggested_category text,
    confidence numeric(4,3),
    source_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    status public.ai_kb_generated_status DEFAULT 'pending'::public.ai_kb_generated_status NOT NULL,
    kb_article_id uuid,
    model text,
    credits_used integer DEFAULT 0 NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_kb_job_events
CREATE TABLE IF NOT EXISTS public.ai_kb_job_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_kb_job_pages
CREATE TABLE IF NOT EXISTS public.ai_kb_job_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    url text NOT NULL,
    url_hash text NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    status public.ai_kb_page_status DEFAULT 'pending'::public.ai_kb_page_status NOT NULL,
    http_status integer,
    bytes integer,
    text_length integer,
    content_hash text,
    title text,
    error_message text,
    fetched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_kb_jobs
CREATE TABLE IF NOT EXISTS public.ai_kb_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    requested_by uuid,
    source_kind public.ai_kb_source_kind NOT NULL,
    source_domain text NOT NULL,
    source_workspace_domain_id uuid,
    source_verified boolean DEFAULT false NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    status public.ai_kb_job_status DEFAULT 'queued'::public.ai_kb_job_status NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    plan_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    pages_discovered integer DEFAULT 0 NOT NULL,
    pages_crawled integer DEFAULT 0 NOT NULL,
    pages_failed integer DEFAULT 0 NOT NULL,
    articles_generated integer DEFAULT 0 NOT NULL,
    credits_used integer DEFAULT 0 NOT NULL,
    error_message text,
    worker_id text,
    claimed_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    admin_override boolean DEFAULT false NOT NULL,
    created_by_global_admin uuid
);

-- TABLE: ai_kb_usage
CREATE TABLE IF NOT EXISTS public.ai_kb_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    job_id uuid,
    generated_article_id uuid,
    event_type text NOT NULL,
    credits integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_knowledge_chunks
CREATE TABLE IF NOT EXISTS public.ai_knowledge_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    source_url text,
    title text,
    content text NOT NULL,
    locale text,
    chunk_index integer DEFAULT 0 NOT NULL,
    content_hash text NOT NULL,
    embedding public.vector(1536),
    embedding_provider text,
    embedding_model text,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_knowledge_chunks_source_type_check CHECK ((source_type = ANY (ARRAY['kb_article'::text, 'qna'::text, 'learned_qna'::text, 'web_page'::text, 'file'::text, 'business_profile'::text]))),
    CONSTRAINT ai_knowledge_chunks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'stale'::text, 'deleted'::text])))
);

-- TABLE: ai_operator_assist_feedback
CREATE TABLE IF NOT EXISTS public.ai_operator_assist_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    assist_run_id uuid NOT NULL,
    conversation_id uuid,
    submitted_by uuid,
    rating text NOT NULL,
    reason text,
    comment text,
    operator_action text,
    final_composer_text text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_operator_assist_feedback_operator_action_check CHECK (((operator_action IS NULL) OR (operator_action = ANY (ARRAY['inserted'::text, 'replaced'::text, 'appended'::text, 'copied'::text, 'dismissed'::text, 'regenerated'::text, 'sent_after_edit'::text, 'sent_as_is'::text])))),
    CONSTRAINT ai_operator_assist_feedback_rating_check CHECK ((rating = ANY (ARRAY['positive'::text, 'negative'::text, 'neutral'::text]))),
    CONSTRAINT ai_operator_assist_feedback_reason_check CHECK (((reason IS NULL) OR (reason = ANY (ARRAY['helpful'::text, 'wrong_answer'::text, 'missing_context'::text, 'bad_tone'::text, 'too_long'::text, 'too_short'::text, 'unsafe'::text, 'not_grounded'::text, 'other'::text]))))
);

-- TABLE: ai_operator_assist_runs
CREATE TABLE IF NOT EXISTS public.ai_operator_assist_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    requested_by uuid,
    status text NOT NULL,
    input_message text,
    instruction text,
    tone text,
    suggestion text,
    confidence numeric,
    selected_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    retrieval_debug jsonb DEFAULT '{}'::jsonb NOT NULL,
    answer_strategy jsonb DEFAULT '{}'::jsonb NOT NULL,
    safety_notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    provider text,
    model text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_operator_assist_runs_status_check CHECK ((status = ANY (ARRAY['suggested'::text, 'failed'::text, 'skipped'::text])))
);

-- TABLE: ai_source_pages
CREATE TABLE IF NOT EXISTS public.ai_source_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    url text NOT NULL,
    url_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    http_status integer,
    title text,
    locale text,
    text_length integer DEFAULT 0,
    content_hash text,
    chunks_created integer DEFAULT 0,
    embedding_status text,
    warning text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_source_sync_jobs
CREATE TABLE IF NOT EXISTS public.ai_source_sync_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    job_type text DEFAULT 'website_sync'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    locked_by text,
    locked_at timestamp with time zone,
    lock_expires_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_source_sync_jobs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);

-- TABLE: ai_source_sync_logs
CREATE TABLE IF NOT EXISTS public.ai_source_sync_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    status text NOT NULL,
    message text,
    pages_found integer DEFAULT 0,
    chunks_created integer DEFAULT 0,
    embedded_chunks integer DEFAULT 0,
    errors integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: ai_usage_logs
CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_name text NOT NULL,
    model text,
    prompt_tokens integer DEFAULT 0,
    completion_tokens integer DEFAULT 0,
    total_tokens integer DEFAULT 0,
    success boolean DEFAULT true NOT NULL,
    error_message text,
    latency_ms integer,
    endpoint text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: alert_events
CREATE TABLE IF NOT EXISTS public.alert_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    rule_slug text NOT NULL,
    severity text NOT NULL,
    state text NOT NULL,
    metric_value numeric,
    threshold_value numeric,
    window_seconds integer NOT NULL,
    sample_size integer,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    webhook_status text,
    webhook_attempts integer DEFAULT 0 NOT NULL,
    webhook_last_error text,
    webhook_last_attempt_at timestamp with time zone,
    CONSTRAINT alert_events_severity_check CHECK ((severity = ANY (ARRAY['warn'::text, 'critical'::text, 'resolved'::text]))),
    CONSTRAINT alert_events_state_check CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text])))
);

-- TABLE: alert_rules
CREATE TABLE IF NOT EXISTS public.alert_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    kind text NOT NULL,
    metric text,
    numerator text,
    denominator text,
    window_seconds integer DEFAULT 300 NOT NULL,
    warn_threshold numeric NOT NULL,
    critical_threshold numeric NOT NULL,
    min_sample integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_builtin boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    route_group text,
    subrules jsonb DEFAULT '[]'::jsonb NOT NULL,
    aggregation text,
    CONSTRAINT alert_rules_kind_check CHECK ((kind = ANY (ARRAY['count'::text, 'ratio'::text, 'perf_p95'::text, 'perf_p99'::text, 'perf_error_rate'::text, 'process_avg'::text, 'process_ratio'::text, 'combined'::text]))),
    CONSTRAINT alert_rules_min_sample_check CHECK ((min_sample >= 0)),
    CONSTRAINT alert_rules_threshold_chk CHECK ((critical_threshold >= warn_threshold)),
    CONSTRAINT alert_rules_window_seconds_check CHECK (((window_seconds >= 60) AND (window_seconds <= 3600)))
);

-- TABLE: auto_action_definitions
CREATE TABLE IF NOT EXISTS public.auto_action_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    action_type text NOT NULL,
    trigger_rule_slug text,
    min_severity text DEFAULT 'critical'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    cooldown_seconds integer DEFAULT 600 NOT NULL,
    max_duration_seconds integer DEFAULT 900 NOT NULL,
    is_builtin boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auto_action_definitions_action_type_check CHECK ((action_type = ANY (ARRAY['disable_typing_temporarily'::text, 'force_polling_mode'::text, 'increase_reconnect_backoff'::text, 'mark_system_degraded'::text, 'throttle_new_conversations'::text, 'slow_mode_messages'::text, 'operator_load_shedding'::text, 'priority_only_mode'::text]))),
    CONSTRAINT auto_action_definitions_cooldown_seconds_check CHECK (((cooldown_seconds >= 60) AND (cooldown_seconds <= 86400))),
    CONSTRAINT auto_action_definitions_max_duration_seconds_check CHECK (((max_duration_seconds >= 60) AND (max_duration_seconds <= 86400))),
    CONSTRAINT auto_action_definitions_min_severity_check CHECK ((min_severity = ANY (ARRAY['warn'::text, 'critical'::text])))
);

-- TABLE: auto_action_events
CREATE TABLE IF NOT EXISTS public.auto_action_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    definition_id uuid NOT NULL,
    action_slug text NOT NULL,
    action_type text NOT NULL,
    trigger_rule_slug text,
    trigger_alert_event_id uuid,
    trigger_severity text,
    state text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    ended_reason text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT auto_action_events_state_check CHECK ((state = ANY (ARRAY['active'::text, 'expired'::text, 'resolved'::text, 'overridden'::text])))
);

-- TABLE: backup_restore_drills
CREATE TABLE IF NOT EXISTS public.backup_restore_drills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    drill_kind text NOT NULL,
    environment text NOT NULL,
    source_backup_id text,
    target_time timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    findings jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_restore_drills_drill_kind_check CHECK ((drill_kind = ANY (ARRAY['full_restore'::text, 'pitr'::text, 'object_storage'::text]))),
    CONSTRAINT backup_restore_drills_status_check CHECK ((status = ANY (ARRAY['running'::text, 'passed'::text, 'failed'::text])))
);

-- TABLE: backup_runs
CREATE TABLE IF NOT EXISTS public.backup_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    backup_id text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    bytes bigint,
    checksum text,
    destination text,
    lsn text,
    encrypted boolean DEFAULT false NOT NULL,
    verification_status text DEFAULT 'unverified'::text NOT NULL,
    verified_at timestamp with time zone,
    last_restore_tested_at timestamp with time zone,
    error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_runs_kind_check CHECK ((kind = ANY (ARRAY['base'::text, 'wal'::text, 'logical'::text, 'object'::text]))),
    CONSTRAINT backup_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT backup_runs_verification_status_check CHECK ((verification_status = ANY (ARRAY['unverified'::text, 'verified'::text, 'failed'::text])))
);

-- TABLE: billing_events
CREATE TABLE IF NOT EXISTS public.billing_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    event_type text NOT NULL,
    provider_name text NOT NULL,
    provider_event_id text,
    amount integer,
    currency text,
    status text DEFAULT 'received'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: business_metrics_hourly
CREATE TABLE IF NOT EXISTS public.business_metrics_hourly (
    bucket_hour timestamp with time zone NOT NULL,
    workspace_id uuid NOT NULL,
    new_conversations integer DEFAULT 0 NOT NULL,
    resolved_conversations integer DEFAULT 0 NOT NULL,
    reopened_conversations integer DEFAULT 0 NOT NULL,
    unanswered_conversations integer DEFAULT 0 NOT NULL,
    stale_open_conversations integer DEFAULT 0 NOT NULL,
    avg_conversation_duration_seconds numeric,
    avg_messages_per_conversation numeric,
    first_response_time_p50 numeric,
    first_response_time_p95 numeric,
    next_response_time_p50 numeric,
    next_response_time_p95 numeric,
    messages_sent integer DEFAULT 0 NOT NULL,
    active_operators integer DEFAULT 0 NOT NULL,
    active_conversations integer DEFAULT 0 NOT NULL,
    visitor_to_conversation_rate numeric,
    conversation_to_resolution_rate numeric,
    avg_resolution_time_seconds numeric,
    support_load_score numeric
);

-- TABLE: call_center_agent_presence
CREATE TABLE IF NOT EXISTS public.call_center_agent_presence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    status_message text,
    active_call_count integer DEFAULT 0 NOT NULL,
    last_seen_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_center_agent_presence_status_check CHECK ((status = ANY (ARRAY['available'::text, 'busy'::text, 'away'::text, 'offline'::text])))
);

-- TABLE: call_center_department_agents
CREATE TABLE IF NOT EXISTS public.call_center_department_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    department_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'agent'::text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    max_concurrent_calls integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_center_department_agents_role_check CHECK ((role = ANY (ARRAY['agent'::text, 'supervisor'::text])))
);

-- TABLE: call_center_departments
CREATE TABLE IF NOT EXISTS public.call_center_departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    color text,
    icon text,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    routing_mode text DEFAULT 'broadcast'::text NOT NULL,
    fallback_department_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_center_departments_routing_mode_check CHECK ((routing_mode = ANY (ARRAY['broadcast'::text, 'round_robin'::text, 'least_busy'::text])))
);

-- TABLE: call_events
CREATE TABLE IF NOT EXISTS public.call_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_session_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_type public.call_participant_type,
    actor_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: call_invitations
CREATE TABLE IF NOT EXISTS public.call_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    contact_id uuid,
    visitor_session_id uuid,
    created_by_user_id uuid NOT NULL,
    channel public.call_invitation_channel NOT NULL,
    status public.call_invitation_status DEFAULT 'pending'::public.call_invitation_status NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    joined_at timestamp with time zone,
    ended_at timestamp with time zone,
    cancel_reason text,
    call_session_id uuid,
    system_message_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: call_participants
CREATE TABLE IF NOT EXISTS public.call_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_session_id uuid NOT NULL,
    participant_type public.call_participant_type NOT NULL,
    participant_id uuid,
    provider_participant_id text,
    joined_at timestamp with time zone,
    left_at timestamp with time zone,
    media_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    device_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: call_ratings
CREATE TABLE IF NOT EXISTS public.call_ratings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    call_session_id uuid NOT NULL,
    visitor_id uuid,
    rating smallint NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_ratings_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

-- TABLE: call_recordings
CREATE TABLE IF NOT EXISTS public.call_recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_session_id uuid NOT NULL,
    provider text NOT NULL,
    recording_type text DEFAULT 'composite'::text NOT NULL,
    storage_provider text NOT NULL,
    storage_path text NOT NULL,
    duration_seconds integer,
    size_bytes bigint,
    retention_policy text DEFAULT 'default'::text NOT NULL,
    retention_expires_at timestamp with time zone,
    legal_hold boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_recording_id text,
    workspace_id uuid NOT NULL
);

-- TABLE: commerce_deleted_entities
CREATE TABLE IF NOT EXISTS public.commerce_deleted_entities (
    connection_id uuid NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    entity_version text NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commerce_deleted_entities_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'variant'::text])))
);

-- TABLE: contact_verifications
CREATE TABLE IF NOT EXISTS public.contact_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    visitor_id text,
    channel text NOT NULL,
    identifier text NOT NULL,
    token_hash text NOT NULL,
    nonce text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_verifications_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'phone'::text])))
);

-- TABLE: conversation_attachments
CREATE TABLE IF NOT EXISTS public.conversation_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid,
    message_id uuid,
    storage_provider text NOT NULL,
    storage_path text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    uploaded_by_type text NOT NULL,
    uploaded_by_id uuid,
    visitor_session_id uuid,
    status text DEFAULT 'uploading'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT conversation_attachments_path_scope_check CHECK ((storage_path ~~ (('workspace/'::text || (workspace_id)::text) || '/attachments/%'::text))),
    CONSTRAINT conversation_attachments_status_check CHECK ((status = ANY (ARRAY['uploading'::text, 'uploaded'::text, 'attached'::text, 'failed'::text]))),
    CONSTRAINT conversation_attachments_uploader_check CHECK ((uploaded_by_type = ANY (ARRAY['visitor'::text, 'contact'::text, 'agent'::text, 'system'::text])))
);

-- TABLE: conversation_events
CREATE TABLE IF NOT EXISTS public.conversation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: conversation_notes
CREATE TABLE IF NOT EXISTS public.conversation_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: email_logs
CREATE TABLE IF NOT EXISTS public.email_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    template_slug text,
    recipient_email text NOT NULL,
    subject text,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_name text,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone
);

-- TABLE: email_settings
CREATE TABLE IF NOT EXISTS public.email_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    sender_email text DEFAULT 'noreply@example.com'::text,
    reply_to_email text,
    email_logo_url text,
    email_footer_text text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- TABLE: email_settings_localized
CREATE TABLE IF NOT EXISTS public.email_settings_localized (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    locale text NOT NULL,
    sender_name text,
    footer_text text,
    support_contact_label text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- TABLE: enforcement_actions
CREATE TABLE IF NOT EXISTS public.enforcement_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    rule_slug text NOT NULL,
    trigger_type text NOT NULL,
    trigger_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    auto_action_event_id uuid,
    scope_type text NOT NULL,
    scope_key text NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: enforcement_normalizations
CREATE TABLE IF NOT EXISTS public.enforcement_normalizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cycle_ran_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    normalized_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: enforcement_rules
CREATE TABLE IF NOT EXISTS public.enforcement_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    trigger_type text NOT NULL,
    condition_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    cooldown_seconds integer DEFAULT 600 NOT NULL,
    ttl_seconds integer DEFAULT 900 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    CONSTRAINT enforcement_rules_cooldown_check CHECK (((cooldown_seconds >= 60) AND (cooldown_seconds <= 86400))),
    CONSTRAINT enforcement_rules_priority_range CHECK (((priority >= 0) AND (priority <= 1000))),
    CONSTRAINT enforcement_rules_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['slo_breach'::text, 'health_score'::text, 'alert_rate'::text]))),
    CONSTRAINT enforcement_rules_ttl_check CHECK (((ttl_seconds >= 60) AND (ttl_seconds <= 86400)))
);

-- TABLE: geo_ip_cache
CREATE TABLE IF NOT EXISTS public.geo_ip_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_hash text NOT NULL,
    source text DEFAULT 'maxmind_local'::text NOT NULL,
    country_code text,
    country_name text,
    region text,
    city text,
    latitude double precision,
    longitude double precision,
    timezone text,
    accuracy_level text,
    is_fallback boolean DEFAULT false NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL
);

-- TABLE: identity_merges
CREATE TABLE IF NOT EXISTS public.identity_merges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    visitor_id text NOT NULL,
    contact_id uuid NOT NULL,
    method text NOT NULL,
    conversations_merged integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    merged_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_merges_method_check CHECK ((method = ANY (ARRAY['cookie'::text, 'email'::text, 'phone'::text, 'token'::text, 'prechat'::text, 'manual'::text])))
);

-- TABLE: ip_blocklist
CREATE TABLE IF NOT EXISTS public.ip_blocklist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_address text NOT NULL,
    reason text NOT NULL,
    blocked_by uuid,
    blocked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: knowledge_base_change_events
CREATE TABLE IF NOT EXISTS public.knowledge_base_change_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    article_id uuid,
    event_type text NOT NULL,
    locale text,
    status text,
    processed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_token uuid,
    claimed_by text,
    claimed_at timestamp with time zone,
    claim_expires_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    last_error_code text,
    last_error_detail text
);

-- TABLE: livekit_webhook_events
CREATE TABLE IF NOT EXISTS public.livekit_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    room_name text,
    participant_identity text,
    egress_id text,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    signature_valid boolean DEFAULT false NOT NULL,
    processed_at timestamp with time zone,
    process_error text,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: login_attempts
CREATE TABLE IF NOT EXISTS public.login_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_address text NOT NULL,
    email text NOT NULL,
    success boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: operator_call_availability
CREATE TABLE IF NOT EXISTS public.operator_call_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'unavailable'::text NOT NULL,
    in_call boolean DEFAULT false NOT NULL,
    in_call_since timestamp with time zone,
    active_call_session_id uuid,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: phone_verification_challenges
CREATE TABLE IF NOT EXISTS public.phone_verification_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone_e164 text NOT NULL,
    purpose text NOT NULL,
    code_digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    sent_at timestamp with time zone,
    consumed_at timestamp with time zone,
    invalidated_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    delivery_status text DEFAULT 'pending'::text NOT NULL,
    provider_name text,
    provider_message_id text,
    created_by text DEFAULT 'user'::text NOT NULL,
    created_by_admin_id uuid,
    created_ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pvc_created_by_chk CHECK ((created_by = ANY (ARRAY['user'::text, 'admin'::text]))),
    CONSTRAINT pvc_delivery_chk CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);

-- TABLE: platform_branding_localized
CREATE TABLE IF NOT EXISTS public.platform_branding_localized (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    locale text NOT NULL,
    platform_name text DEFAULT 'My Platform'::text NOT NULL,
    public_site_title text,
    browser_title_format text DEFAULT '{{page}} — {{platform}}'::text,
    meta_title text,
    meta_description text,
    footer_company_text text,
    support_label text,
    legal_company_display_name text,
    social_share_title text,
    social_share_description text,
    knowledge_base_title text DEFAULT 'Help Center'::text,
    widget_display_name text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- TABLE: platform_call_center_settings
CREATE TABLE IF NOT EXISTS public.platform_call_center_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    call_center_enabled boolean DEFAULT false NOT NULL,
    voice_calls_enabled boolean DEFAULT true NOT NULL,
    video_calls_enabled boolean DEFAULT true NOT NULL,
    callback_requests_enabled boolean DEFAULT true NOT NULL,
    call_recording_enabled boolean DEFAULT false NOT NULL,
    screen_share_enabled boolean DEFAULT false NOT NULL,
    call_transfer_enabled boolean DEFAULT false NOT NULL,
    departments_enabled boolean DEFAULT false NOT NULL,
    advanced_routing_enabled boolean DEFAULT false NOT NULL,
    max_concurrent_calls_per_workspace integer DEFAULT 50 NOT NULL,
    max_queue_size_per_workspace integer DEFAULT 100 NOT NULL,
    max_monthly_call_minutes_per_workspace integer DEFAULT 100000 NOT NULL,
    max_callback_requests_per_month integer DEFAULT 10000 NOT NULL,
    max_recording_storage_mb integer DEFAULT 10000 NOT NULL,
    disabled_message jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    callback_show_when_online boolean DEFAULT true NOT NULL,
    callback_min_seconds_between_requests integer DEFAULT 600 NOT NULL,
    callback_max_per_ip_per_hour integer DEFAULT 5 NOT NULL,
    callback_require_contact boolean DEFAULT true NOT NULL,
    callback_min_message_length integer DEFAULT 0 NOT NULL,
    callback_honeypot_enabled boolean DEFAULT true NOT NULL,
    callback_min_form_seconds integer DEFAULT 3 NOT NULL,
    ringback_enabled boolean DEFAULT true NOT NULL,
    ringback_mode text DEFAULT 'tone'::text NOT NULL,
    ringback_music_url text,
    queue_show_position boolean DEFAULT true NOT NULL,
    queue_show_eta boolean DEFAULT true NOT NULL,
    queue_eta_seconds_per_position integer DEFAULT 45 NOT NULL,
    queue_offer_callback_after_seconds integer DEFAULT 60 NOT NULL,
    operator_new_call_sound_enabled boolean DEFAULT true NOT NULL,
    widget_default_locale text DEFAULT 'en'::text NOT NULL,
    widget_available_locales text[] DEFAULT ARRAY['en'::text, 'fa'::text, 'tr'::text] NOT NULL,
    ringback_music_path text,
    ringback_announcement_audio_path text,
    ringback_queue_audio_paths jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT platform_call_center_settings_ringback_mode_check CHECK ((ringback_mode = ANY (ARRAY['tone'::text, 'music'::text, 'off'::text]))),
    CONSTRAINT platform_call_center_settings_widget_default_locale_check CHECK ((widget_default_locale = ANY (ARRAY['en'::text, 'fa'::text, 'tr'::text])))
);

-- TABLE: platform_domains
CREATE TABLE IF NOT EXISTS public.platform_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    primary_domain text,
    canonical_base_url text,
    public_base_url text,
    app_base_url text,
    api_base_url text,
    widget_base_url text,
    asset_base_url text,
    help_center_base_url text,
    email_base_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- TABLE: platform_sms_provider_config
CREATE TABLE IF NOT EXISTS public.platform_sms_provider_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    provider_name text DEFAULT 'disabled'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_sms_provider_config_name_chk CHECK ((provider_name = ANY (ARRAY['kavenegar'::text, 'smsir'::text, 'disabled'::text]))),
    CONSTRAINT platform_sms_provider_config_singleton_chk CHECK ((singleton = true))
);

-- TABLE: privacy_jobs
CREATE TABLE IF NOT EXISTS public.privacy_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    actor_user_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    subject_email_hash text,
    resolved_identity jsonb DEFAULT '{}'::jsonb NOT NULL,
    action text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    artifact_path text,
    artifact_hash text,
    artifact_size_bytes bigint,
    download_count integer DEFAULT 0 NOT NULL,
    download_token_hash text,
    expires_at timestamp with time zone,
    error_message text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    artifact_storage_provider text,
    artifact_storage_key text,
    CONSTRAINT privacy_jobs_action_check CHECK ((action = ANY (ARRAY['export'::text, 'delete'::text]))),
    CONSTRAINT privacy_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT privacy_jobs_subject_type_check CHECK ((subject_type = ANY (ARRAY['contact'::text, 'visitor'::text, 'user'::text])))
);

-- TABLE: realtime_failover_state
CREATE TABLE IF NOT EXISTS public.realtime_failover_state (
    id text DEFAULT 'singleton'::text NOT NULL,
    effective_provider text DEFAULT 'centrifugo'::text NOT NULL,
    last_failover_at timestamp with time zone,
    last_failover_reason text,
    candidate_recovery_provider text,
    candidate_recovery_since timestamp with time zone,
    failback_eligible_at timestamp with time zone,
    cooldown_until timestamp with time zone,
    last_health jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_evaluated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT realtime_failover_state_singleton CHECK ((id = 'singleton'::text))
)
WITH (autovacuum_vacuum_threshold='1000', autovacuum_vacuum_scale_factor='0', autovacuum_analyze_threshold='1000', autovacuum_analyze_scale_factor='0', fillfactor='70');

-- TABLE: realtime_provider_audit
CREATE TABLE IF NOT EXISTS public.realtime_provider_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    changed_by uuid,
    action text NOT NULL,
    vendor text,
    prev_vendor text,
    config_diff jsonb DEFAULT '{}'::jsonb,
    result text,
    error_message text,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: role_permissions
CREATE TABLE IF NOT EXISTS public.role_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    role_slug text NOT NULL,
    permission_key text NOT NULL,
    granted boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: security_events
CREATE TABLE IF NOT EXISTS public.security_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    ip_address text,
    user_id uuid,
    user_email text,
    workspace_id uuid,
    endpoint text,
    metadata jsonb DEFAULT '{}'::jsonb,
    resolved boolean DEFAULT false,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: sla_reliability_hourly
CREATE TABLE IF NOT EXISTS public.sla_reliability_hourly (
    bucket_hour timestamp with time zone NOT NULL,
    scope_type text NOT NULL,
    scope_key text NOT NULL,
    uptime_pct numeric DEFAULT 100 NOT NULL,
    realtime_availability_pct numeric DEFAULT 100 NOT NULL,
    degraded_minutes numeric DEFAULT 0 NOT NULL,
    forced_polling_minutes numeric DEFAULT 0 NOT NULL,
    critical_alert_count integer DEFAULT 0 NOT NULL,
    warn_alert_count integer DEFAULT 0 NOT NULL,
    failover_count integer DEFAULT 0 NOT NULL,
    recovery_count integer DEFAULT 0 NOT NULL,
    mean_failover_recovery_seconds numeric,
    unhealthy_minutes numeric DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: slo_breach_events
CREATE TABLE IF NOT EXISTS public.slo_breach_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slo_id uuid NOT NULL,
    slo_slug text NOT NULL,
    scope_type text NOT NULL,
    scope_key text NOT NULL,
    state text NOT NULL,
    observed_value numeric,
    target_value numeric NOT NULL,
    target_type text NOT NULL,
    consecutive_breaches integer DEFAULT 1 NOT NULL,
    first_breach_at timestamp with time zone DEFAULT now() NOT NULL,
    last_breach_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT slo_breach_events_state_check CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text])))
);

-- TABLE: slo_definitions
CREATE TABLE IF NOT EXISTS public.slo_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    scope_type text NOT NULL,
    metric_key text NOT NULL,
    target_type text NOT NULL,
    target_value numeric NOT NULL,
    window_seconds integer DEFAULT 86400 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: storage_usage_logs
CREATE TABLE IF NOT EXISTS public.storage_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_name text NOT NULL,
    operation text NOT NULL,
    file_key text,
    file_size bigint,
    content_type text,
    success boolean DEFAULT true NOT NULL,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: team_messages
CREATE TABLE IF NOT EXISTS public.team_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachment_id uuid,
    reply_to_id uuid
);

-- TABLE: user_availability_prefs
CREATE TABLE IF NOT EXISTS public.user_availability_prefs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid,
    force_offline boolean DEFAULT false NOT NULL,
    available_when_using_app boolean DEFAULT true NOT NULL,
    schedule_enabled boolean DEFAULT false NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    weekly_schedule jsonb DEFAULT '{"fri": {"enabled": true, "intervals": [{"to": "18:00", "from": "09:00"}]}, "mon": {"enabled": true, "intervals": [{"to": "18:00", "from": "09:00"}]}, "sat": {"enabled": true, "intervals": []}, "sun": {"enabled": false, "intervals": []}, "thu": {"enabled": true, "intervals": [{"to": "18:00", "from": "09:00"}]}, "tue": {"enabled": true, "intervals": [{"to": "18:00", "from": "09:00"}]}, "wed": {"enabled": true, "intervals": [{"to": "18:00", "from": "09:00"}]}}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: user_continuity_tokens
CREATE TABLE IF NOT EXISTS public.user_continuity_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid,
    user_id uuid,
    token_hash text NOT NULL,
    device_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT continuity_target_required CHECK (((contact_id IS NOT NULL) OR (user_id IS NOT NULL)))
);

-- TABLE: user_phone_verifications
CREATE TABLE IF NOT EXISTS public.user_phone_verifications (
    user_id uuid NOT NULL,
    phone_e164 text NOT NULL,
    country_code text DEFAULT 'IR'::text NOT NULL,
    phone_verified_at timestamp with time zone,
    verification_method text,
    verified_by_admin_id uuid,
    manual_verification_reason text,
    last_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_phone_verifications_manual_chk CHECK (((verification_method = 'admin_manual'::text) OR ((verified_by_admin_id IS NULL) AND (manual_verification_reason IS NULL)))),
    CONSTRAINT user_phone_verifications_method_chk CHECK (((verification_method IS NULL) OR (verification_method = ANY (ARRAY['sms_otp'::text, 'admin_manual'::text]))))
);

-- TABLE: visitor_geo_cache
CREATE TABLE IF NOT EXISTS public.visitor_geo_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_hash text NOT NULL,
    country text,
    country_code text,
    region text,
    city text,
    latitude double precision,
    longitude double precision,
    source text DEFAULT 'centroid'::text NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL
);

-- TABLE: widget_templates
CREATE TABLE IF NOT EXISTS public.widget_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT widget_templates_status_check CHECK ((status = ANY (ARRAY['active'::text, 'beta'::text, 'deprecated'::text, 'hidden'::text])))
);

-- TABLE: workspace_alert_dismissals
CREATE TABLE IF NOT EXISTS public.workspace_alert_dismissals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    alert_key text NOT NULL,
    signature text DEFAULT ''::text NOT NULL,
    dismissed_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_until timestamp with time zone
);

-- TABLE: workspace_branding_localized
CREATE TABLE IF NOT EXISTS public.workspace_branding_localized (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    locale text NOT NULL,
    platform_name text,
    public_site_title text,
    browser_title_format text,
    meta_title text,
    meta_description text,
    footer_company_text text,
    support_label text,
    legal_company_display_name text,
    social_share_title text,
    social_share_description text,
    knowledge_base_title text,
    widget_display_name text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- TABLE: workspace_channel_overrides
CREATE TABLE IF NOT EXISTS public.workspace_channel_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    channel_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    admin_notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: workspace_domains_extended
CREATE TABLE IF NOT EXISTS public.workspace_domains_extended (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    primary_domain text,
    canonical_base_url text,
    public_base_url text,
    app_base_url text,
    api_base_url text,
    widget_base_url text,
    asset_base_url text,
    help_center_base_url text,
    email_base_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- TABLE: workspace_health_snapshots
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer NOT NULL,
    state text NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
)
PARTITION BY RANGE (captured_at);

-- TABLE: workspace_health_snapshots_2026_09
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots_2026_09 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer NOT NULL,
    state text NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: workspace_health_snapshots_2026_10
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots_2026_10 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer NOT NULL,
    state text NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: workspace_health_snapshots_2026_11
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots_2026_11 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer NOT NULL,
    state text NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: workspace_health_snapshots_default
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots_default (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer NOT NULL,
    state text NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: workspace_health_snapshots_legacy
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots_legacy (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer NOT NULL,
    state text NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- TABLE: workspace_limit_overrides
CREATE TABLE IF NOT EXISTS public.workspace_limit_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    limit_key text NOT NULL,
    limit_value integer NOT NULL,
    admin_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: workspace_module_overrides
CREATE TABLE IF NOT EXISTS public.workspace_module_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    module_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    admin_notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: workspace_provider_settings
CREATE TABLE IF NOT EXISTS public.workspace_provider_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_type text NOT NULL,
    provider_name text DEFAULT 'disabled'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secrets jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_provider_settings_provider_type_check CHECK ((provider_type = ANY (ARRAY['email'::text, 'ai'::text, 'webhook'::text, 'call'::text])))
);

-- TABLE: workspace_settings
CREATE TABLE IF NOT EXISTS public.workspace_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    site_mode text,
    default_locale text,
    panel_default_locale text,
    widget_default_locale text,
    fallback_locale text,
    active_locales text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT workspace_settings_site_mode_check CHECK (((site_mode IS NULL) OR (site_mode = ANY (ARRAY['single_language'::text, 'multi_language'::text]))))
);

-- TABLE ATTACH: workspace_health_snapshots_2026_09
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots ATTACH PARTITION public.workspace_health_snapshots_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00')$stmt$;
EXCEPTION WHEN duplicate_object OR invalid_object_definition OR wrong_object_type THEN NULL;
END $parity$;

-- TABLE ATTACH: workspace_health_snapshots_2026_10
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots ATTACH PARTITION public.workspace_health_snapshots_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')$stmt$;
EXCEPTION WHEN duplicate_object OR invalid_object_definition OR wrong_object_type THEN NULL;
END $parity$;

-- TABLE ATTACH: workspace_health_snapshots_2026_11
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots ATTACH PARTITION public.workspace_health_snapshots_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00')$stmt$;
EXCEPTION WHEN duplicate_object OR invalid_object_definition OR wrong_object_type THEN NULL;
END $parity$;

-- TABLE ATTACH: workspace_health_snapshots_default
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots ATTACH PARTITION public.workspace_health_snapshots_default DEFAULT$stmt$;
EXCEPTION WHEN duplicate_object OR invalid_object_definition OR wrong_object_type THEN NULL;
END $parity$;

-- ── columns on existing tables ──────────────────────────────
ALTER TABLE public.ai_agent_settings ADD COLUMN IF NOT EXISTS strict_topic_scope boolean DEFAULT false NOT NULL;
ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS departments_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS allow_visitor_department_choice boolean DEFAULT false NOT NULL;
ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS widget_default_locale text;
ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS widget_enabled_locales text[];
ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS widget_custom_texts jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS operator_video_visible_to_visitor boolean DEFAULT true NOT NULL;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS is_spam boolean DEFAULT false NOT NULL;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS spam_marked_at timestamp with time zone;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS spam_marked_by uuid;
ALTER TABLE public.conversation_messages ADD COLUMN IF NOT EXISTS seen_at timestamp with time zone;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS ai_state text GENERATED ALWAYS AS ((metadata ->> 'ai_state'::text)) STORED;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS is_spam boolean DEFAULT false NOT NULL;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS spam_marked_at timestamp with time zone;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS spam_marked_by uuid;
ALTER TABLE public.knowledge_base_articles ADD COLUMN IF NOT EXISTS visible_in_widget boolean DEFAULT true NOT NULL;
ALTER TABLE public.knowledge_base_articles ADD COLUMN IF NOT EXISTS used_by_ai boolean DEFAULT true NOT NULL;
ALTER TABLE public.platform_branding ADD COLUMN IF NOT EXISTS pwa_enabled boolean DEFAULT true NOT NULL;
ALTER TABLE public.platform_branding ADD COLUMN IF NOT EXISTS pwa_short_name text;
ALTER TABLE public.platform_branding ADD COLUMN IF NOT EXISTS pwa_background_color text DEFAULT '#ffffff'::text;
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS maintenance_mode boolean DEFAULT false NOT NULL;
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS maintenance_message text;
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS locale_billing_providers jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS region_mode text DEFAULT 'multi'::text NOT NULL;
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS region_currency text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS identity_state text DEFAULT 'anonymous'::text NOT NULL;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS contact_id uuid;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS ip_raw text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS allow_subdomains boolean DEFAULT true NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS debug_mode boolean DEFAULT false NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS live_chat_enabled boolean DEFAULT true NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS offline_mode text DEFAULT 'accept_messages'::text NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS business_hours jsonb DEFAULT '{"enabled": false, "schedule": [], "timezone": "UTC"}'::jsonb NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS availability_labels jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS attachments_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS attachments_max_size_mb integer DEFAULT 10 NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS attachments_allowed_mimes text[] DEFAULT ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'image/gif'::text, 'application/pdf'::text, 'text/plain'::text] NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS read_receipts_enabled boolean DEFAULT true NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS offline_message_localized jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS store_raw_ip boolean DEFAULT false NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS template_slug text DEFAULT 'default'::text NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS smart_engagement_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS voice_notes_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS emoji_enabled boolean DEFAULT true NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS assignment_mode text DEFAULT 'auto'::text NOT NULL;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS round_robin_cursor_user_id uuid;
ALTER TABLE public.workspace_branding ADD COLUMN IF NOT EXISTS widget_public_base_url text;
ALTER TABLE public.workspace_branding ADD COLUMN IF NOT EXISTS widget_loader_base_url text;
ALTER TABLE public.workspace_branding ADD COLUMN IF NOT EXISTS widget_api_base_url text;
ALTER TABLE public.workspace_branding ADD COLUMN IF NOT EXISTS contact_info jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.workspace_department_members ADD COLUMN IF NOT EXISTS call_center_role text DEFAULT 'agent'::text NOT NULL;
ALTER TABLE public.workspace_department_members ADD COLUMN IF NOT EXISTS call_center_priority integer DEFAULT 100 NOT NULL;
ALTER TABLE public.workspace_department_members ADD COLUMN IF NOT EXISTS call_center_enabled boolean DEFAULT true NOT NULL;
ALTER TABLE public.workspace_department_members ADD COLUMN IF NOT EXISTS call_center_max_concurrent_calls integer;
ALTER TABLE public.workspace_department_members ADD COLUMN IF NOT EXISTS call_center_metadata jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS tickets_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS cc_voice_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS cc_video_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS cc_callback_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS cc_routing_mode text;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS cc_fallback_department_id uuid;
ALTER TABLE public.workspace_departments ADD COLUMN IF NOT EXISTS cc_routing_state jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE public.workspace_domains ADD COLUMN IF NOT EXISTS normalized_domain text GENERATED ALWAYS AS (regexp_replace(regexp_replace(regexp_replace(lower(btrim(domain)), '^https?://'::text, ''::text), '[:/?#].*$'::text, ''::text), '^www\.'::text, ''::text)) STORED;
ALTER TABLE public.workspace_usage_counters ADD COLUMN IF NOT EXISTS call_minutes_used integer DEFAULT 0 NOT NULL;

-- ── views ───────────────────────────────────────────────────
-- VIEW: billing_plans_public
CREATE OR REPLACE VIEW public.billing_plans_public WITH (security_invoker='on') AS
 SELECT id,
    name,
    slug,
    description,
    prices,
    default_currency,
    is_free,
    trial_days,
    sort_order,
    limits,
    entitlements
   FROM public.billing_plans
  WHERE ((is_active = true) AND (is_hidden = false));

-- ── constraints, indexes, triggers, policies, comments ──────
-- COMMENT: FUNCTION apply_storage_usage_log()
COMMENT ON FUNCTION public.apply_storage_usage_log() IS 'Canonical producer for workspace_usage_counters.storage_bytes. SOLE writer. Increments on successful uploads with file_size, decrements on successful deletes with file_size. Seeds new monthly rows from the prior period to preserve cumulative occupancy across rollover.';

-- COMMENT: FUNCTION partition_ensure_all(_months integer)
COMMENT ON FUNCTION public.partition_ensure_all(_months integer) IS 'Canonical WEBYAR partition manager entry point: ensures current + N future monthly partitions for every managed table. Idempotent, never destructive.';

-- COMMENT: FUNCTION retention_partition_preview(_policy_key text)
COMMENT ON FUNCTION public.retention_partition_preview(_policy_key text) IS 'READ-ONLY partition retention preview. Never detaches, drops, truncates or deletes. Returns no rows for protected, permanent or disabled policies.';

-- COMMENT: FUNCTION tg_call_sessions_bill_minutes()
COMMENT ON FUNCTION public.tg_call_sessions_bill_minutes() IS 'Canonical, sole writer for workspace_usage_counters.call_minutes_used. Fires on call_sessions UPDATE when state transitions OLD<>''ended'' -> NEW=''ended''. Adds CEIL((ended_at-connected_at)/60) minutes to the UTC-month bucket. Skips non-connected outcomes. Idempotent: the OLD-state guard prevents double-counting on subsequent updates to an already-ended row. Do NOT add server-side increments for call_minutes_used elsewhere.';

-- COMMENT: FUNCTION tg_visitor_sessions_count_visitor()
COMMENT ON FUNCTION public.tg_visitor_sessions_count_visitor() IS 'Canonical, sole writer for workspace_usage_counters.visitors_count. Increments by 1 only on the first visitor_sessions insert per (workspace_id, visitor_id) within the current UTC calendar month. Do NOT add server-side increments for visitors_count elsewhere.';

-- COMMENT: COLUMN call_center_settings.departments_enabled
COMMENT ON COLUMN public.call_center_settings.departments_enabled IS 'Workspace-level toggle: whether the standalone Call Center surfaces department concepts at all.';

-- COMMENT: COLUMN call_center_settings.allow_visitor_department_choice
COMMENT ON COLUMN public.call_center_settings.allow_visitor_department_choice IS 'When true, the visitor call-widget shows a department dropdown using channel-enabled workspace_departments. Server-side default_department_id fallback still applies when false.';

-- COMMENT: COLUMN call_recordings.workspace_id
COMMENT ON COLUMN public.call_recordings.workspace_id IS 'Denormalized from call_sessions.workspace_id at write time — lets the database itself verify storage_path is scoped to the right workspace+session (call_recordings_path_scope_check), independent of the call_session_id join.';

-- COMMENT: COLUMN conversation_messages.seen_at
COMMENT ON COLUMN public.conversation_messages.seen_at IS 'Phase 7: Set when an operator opens/selects the conversation. Monotonic — never cleared.';

-- COMMENT: COLUMN platform_call_center_settings.ringback_music_path
COMMENT ON COLUMN public.platform_call_center_settings.ringback_music_path IS 'Provider storage key for platform call-center hold music. URL is resolved at widget bootstrap from active global storage provider.';

-- COMMENT: COLUMN platform_call_center_settings.ringback_announcement_audio_path
COMMENT ON COLUMN public.platform_call_center_settings.ringback_announcement_audio_path IS 'Provider storage key for uploaded queue announcement audio.';

-- COMMENT: COLUMN platform_call_center_settings.ringback_queue_audio_paths
COMMENT ON COLUMN public.platform_call_center_settings.ringback_queue_audio_paths IS 'Provider storage keys for queue-position waiting audio, keyed by position 1..6.';

-- COMMENT: COLUMN platform_domains.widget_base_url
COMMENT ON COLUMN public.platform_domains.widget_base_url IS 'DEPRECATED — moved to widget_platform_settings.widget_loader_base_url. Kept for rollback only.';

-- COMMENT: COLUMN platform_domains.asset_base_url
COMMENT ON COLUMN public.platform_domains.asset_base_url IS 'DEPRECATED for widget assets — see widget_platform_settings.widget_asset_base_url.';

-- COMMENT: COLUMN privacy_jobs.artifact_storage_provider
COMMENT ON COLUMN public.privacy_jobs.artifact_storage_provider IS 'Storage provider name that holds the export artifact (e.g. local, s3, bunny_storage). NULL = legacy local-disk artifact stored at artifact_path.';

-- COMMENT: COLUMN privacy_jobs.artifact_storage_key
COMMENT ON COLUMN public.privacy_jobs.artifact_storage_key IS 'Provider-relative object key for the artifact (e.g. privacy-exports/<workspace>/<job>.zip). Used together with artifact_storage_provider.';

-- COMMENT: COLUMN visitor_sessions.ip_raw
COMMENT ON COLUMN public.visitor_sessions.ip_raw IS 'Optional raw client IP. Populated only when widget_settings.store_raw_ip = true for the workspace. Never returned to non-admin roles.';

-- COMMENT: TABLE widget_ai_nudge_settings
COMMENT ON TABLE public.widget_ai_nudge_settings IS 'Per-workspace AI Proactive Nudge (AI Smart Nudge) configuration. Extends Smart Engagement; does not fork it.';

-- COMMENT: TABLE widget_ai_nudges
COMMENT ON TABLE public.widget_ai_nudges IS 'One row per AI-generated nudge actually shown to a visitor. Bounded by max_per_session/cooldown — never per evaluation.';

-- COMMENT: COLUMN widget_platform_settings.widget_loader_base_url
COMMENT ON COLUMN public.widget_platform_settings.widget_loader_base_url IS 'Origin used to serve /widget/loader.js. Single source of truth for widget loader URL.';

-- COMMENT: COLUMN widget_platform_settings.widget_asset_base_url
COMMENT ON COLUMN public.widget_platform_settings.widget_asset_base_url IS 'Origin used to serve runtime.js / runtime.css / runtime-rt-centrifugo.js / widget-manifest.json.';

-- COMMENT: COLUMN widget_platform_settings.widget_public_base_url
COMMENT ON COLUMN public.widget_platform_settings.widget_public_base_url IS 'Public website origin where the widget is embedded (used for default origin checks and embed previews).';

-- COMMENT: COLUMN widget_platform_settings.widget_api_base_url
COMMENT ON COLUMN public.widget_platform_settings.widget_api_base_url IS 'Backend API origin used by the widget for /api/widget/* calls.';

-- COMMENT: COLUMN widget_platform_settings.typing_rate_limit_enabled
COMMENT ON COLUMN public.widget_platform_settings.typing_rate_limit_enabled IS 'Phase 1.1 — when true, /api/widget/action typing events are rate-limited per conversation. Overflow events are silently dropped.';

-- COMMENT: COLUMN widget_platform_settings.typing_rate_limit_window_ms
COMMENT ON COLUMN public.widget_platform_settings.typing_rate_limit_window_ms IS 'Phase 1.1 — typing rate limit window in milliseconds. Default 2000ms.';

-- COMMENT: COLUMN widget_platform_settings.typing_rate_limit_max_events
COMMENT ON COLUMN public.widget_platform_settings.typing_rate_limit_max_events IS 'Phase 1.1 — max typing publishes allowed per window per conversation. Default 2.';

-- COMMENT: COLUMN widget_platform_settings.realtime_stale_resubscribe_guard_enabled
COMMENT ON COLUMN public.widget_platform_settings.realtime_stale_resubscribe_guard_enabled IS 'Phase 1.3 — when true, resubscribeAll loops abort immediately if the socket dies / generation rolls. Always-on diagnostic flag.';

-- COMMENT: COLUMN widget_settings.live_chat_enabled
COMMENT ON COLUMN public.widget_settings.live_chat_enabled IS 'Phase 5: master toggle for live human chat. When false, widget shows unavailable state.';

-- COMMENT: COLUMN widget_settings.offline_mode
COMMENT ON COLUMN public.widget_settings.offline_mode IS 'Phase 5: behavior when live operators are offline/unavailable. accept_messages = let user send anyway, contact_fallback = show contact form.';

-- COMMENT: COLUMN widget_settings.business_hours
COMMENT ON COLUMN public.widget_settings.business_hours IS 'Phase 5: { enabled, timezone, schedule:[{day:0..6, open:"HH:MM", close:"HH:MM"}] }. When enabled=false, widget never marks as closed by hours.';

-- COMMENT: COLUMN widget_settings.availability_labels
COMMENT ON COLUMN public.widget_settings.availability_labels IS 'Phase 5: optional overrides for { online, away, offline, unavailable, offline_intro, fallback_intro }. Empty {} means use widget defaults.';

-- COMMENT: COLUMN widget_settings.read_receipts_enabled
COMMENT ON COLUMN public.widget_settings.read_receipts_enabled IS 'Phase 7: When false, widget shows only sending/sent (no seen indicator).';

-- COMMENT: COLUMN widget_settings.offline_message_localized
COMMENT ON COLUMN public.widget_settings.offline_message_localized IS 'Per-locale offline message shown to visitors outside business hours. Shape: { "en": "...", "fa": "...", "tr": "..." }. Falls back to widget_settings.offline_message when a locale is missing.';

-- COMMENT: COLUMN widget_settings.store_raw_ip
COMMENT ON COLUMN public.widget_settings.store_raw_ip IS 'Privacy toggle. When TRUE, the server stores the raw visitor IP on visitor_sessions.ip_raw (still only exposed to owner/admin roles). Default FALSE — only the salted ip_hash is stored.';

-- COMMENT: COLUMN workspace_branding.widget_base_url
COMMENT ON COLUMN public.workspace_branding.widget_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';

-- COMMENT: COLUMN workspace_branding.widget_public_base_url
COMMENT ON COLUMN public.workspace_branding.widget_public_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';

-- COMMENT: COLUMN workspace_branding.widget_loader_base_url
COMMENT ON COLUMN public.workspace_branding.widget_loader_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';

-- COMMENT: COLUMN workspace_branding.widget_api_base_url
COMMENT ON COLUMN public.workspace_branding.widget_api_base_url IS 'DEPRECATED — managed centrally via widget_platform_settings.';

-- COMMENT: COLUMN workspace_branding.contact_info
COMMENT ON COLUMN public.workspace_branding.contact_info IS 'Public contact channels for the workspace: { phone, messenger, telegram, twitter, whatsapp, instagram }. Used by the Workspace Information settings screen.';

-- COMMENT: TABLE workspace_health_snapshots
COMMENT ON TABLE public.workspace_health_snapshots IS 'Monthly RANGE-partitioned on captured_at. Managed by public.partition_ensure_all(). Rollback copy: workspace_health_snapshots_legacy (retained deliberately).';

-- COMMENT: TABLE workspace_health_snapshots_legacy
COMMENT ON TABLE public.workspace_health_snapshots_legacy IS 'Pre-partitioning snapshot of workspace_health_snapshots, kept as a rollback fallback. Not written to. Do not drop without an explicit decision.';

-- COMMENT: COLUMN workspace_usage_counters.call_minutes_used
COMMENT ON COLUMN public.workspace_usage_counters.call_minutes_used IS 'Canonical monthly aggregate of billable call minutes per workspace per UTC month. Sole writer: trigger tg_call_sessions_bill_minutes. Billable policy: only when call_sessions.connected_at IS NOT NULL AND state transitions to ''ended''; minutes = CEIL((ended_at - connected_at) / 60). Period bucket: UTC YYYY-MM of ended_at.';


SET default_tablespace = '';

-- CONSTRAINT: admin_gate_bypass_log admin_gate_bypass_log_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.admin_gate_bypass_log
    ADD CONSTRAINT admin_gate_bypass_log_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_debug_events ai_agent_debug_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_debug_events
    ADD CONSTRAINT ai_agent_debug_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_guidance_rules ai_agent_guidance_rules_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_guidance_rules
    ADD CONSTRAINT ai_agent_guidance_rules_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_intro_log ai_agent_intro_log_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_intro_log
    ADD CONSTRAINT ai_agent_intro_log_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_learning_candidates ai_agent_learning_candidates_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_learning_candidates
    ADD CONSTRAINT ai_agent_learning_candidates_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_message_triggers ai_agent_message_triggers_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_message_triggers
    ADD CONSTRAINT ai_agent_message_triggers_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_qna ai_agent_qna_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_qna
    ADD CONSTRAINT ai_agent_qna_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_regression_batches ai_agent_regression_batches_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_regression_batches
    ADD CONSTRAINT ai_agent_regression_batches_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_regression_schedules ai_agent_regression_schedules_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_regression_schedules
    ADD CONSTRAINT ai_agent_regression_schedules_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_routing_rules ai_agent_routing_rules_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_routing_rules
    ADD CONSTRAINT ai_agent_routing_rules_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_runs ai_agent_runs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_runs
    ADD CONSTRAINT ai_agent_runs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_sources ai_agent_sources_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_sources
    ADD CONSTRAINT ai_agent_sources_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_suggested_test_cases ai_agent_suggested_test_cases_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_suggested_test_cases
    ADD CONSTRAINT ai_agent_suggested_test_cases_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_suggestions ai_agent_suggestions_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_suggestions
    ADD CONSTRAINT ai_agent_suggestions_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_test_cases ai_agent_test_cases_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_test_cases
    ADD CONSTRAINT ai_agent_test_cases_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_test_runs ai_agent_test_runs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_test_runs
    ADD CONSTRAINT ai_agent_test_runs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_tool_servers ai_agent_tool_servers_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_tool_servers
    ADD CONSTRAINT ai_agent_tool_servers_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_tools ai_agent_tools_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_topics ai_agent_topics_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_topics
    ADD CONSTRAINT ai_agent_topics_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_agent_workflows ai_agent_workflows_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_workflows
    ADD CONSTRAINT ai_agent_workflows_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_data_sources ai_data_sources_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_data_sources
    ADD CONSTRAINT ai_data_sources_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_kb_generated_articles ai_kb_generated_articles_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_generated_articles
    ADD CONSTRAINT ai_kb_generated_articles_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_kb_job_events ai_kb_job_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_events
    ADD CONSTRAINT ai_kb_job_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_kb_job_pages ai_kb_job_pages_job_id_url_hash_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_pages
    ADD CONSTRAINT ai_kb_job_pages_job_id_url_hash_key UNIQUE (job_id, url_hash)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_kb_job_pages ai_kb_job_pages_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_pages
    ADD CONSTRAINT ai_kb_job_pages_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_kb_jobs ai_kb_jobs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_jobs
    ADD CONSTRAINT ai_kb_jobs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_kb_usage ai_kb_usage_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_usage
    ADD CONSTRAINT ai_kb_usage_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_knowledge_chunks ai_knowledge_chunks_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_knowledge_chunks
    ADD CONSTRAINT ai_knowledge_chunks_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_operator_assist_feedback ai_operator_assist_feedback_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_operator_assist_feedback
    ADD CONSTRAINT ai_operator_assist_feedback_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_operator_assist_runs ai_operator_assist_runs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_operator_assist_runs
    ADD CONSTRAINT ai_operator_assist_runs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_source_pages ai_source_pages_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_source_pages
    ADD CONSTRAINT ai_source_pages_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_source_sync_jobs ai_source_sync_jobs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_source_sync_jobs
    ADD CONSTRAINT ai_source_sync_jobs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_source_sync_logs ai_source_sync_logs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_source_sync_logs
    ADD CONSTRAINT ai_source_sync_logs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ai_usage_logs ai_usage_logs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: alert_events alert_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.alert_events
    ADD CONSTRAINT alert_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: alert_rules alert_rules_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: alert_rules alert_rules_slug_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_slug_key UNIQUE (slug)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: auto_action_definitions auto_action_definitions_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.auto_action_definitions
    ADD CONSTRAINT auto_action_definitions_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: auto_action_definitions auto_action_definitions_slug_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.auto_action_definitions
    ADD CONSTRAINT auto_action_definitions_slug_key UNIQUE (slug)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: auto_action_events auto_action_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.auto_action_events
    ADD CONSTRAINT auto_action_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: backup_commands backup_commands_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.backup_commands
    ADD CONSTRAINT backup_commands_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: backup_restore_drills backup_restore_drills_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.backup_restore_drills
    ADD CONSTRAINT backup_restore_drills_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: backup_runs backup_runs_kind_backup_id_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT backup_runs_kind_backup_id_key UNIQUE (kind, backup_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: backup_runs backup_runs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT backup_runs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: billing_events billing_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.billing_events
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: business_metrics_hourly business_metrics_hourly_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.business_metrics_hourly
    ADD CONSTRAINT business_metrics_hourly_pkey PRIMARY KEY (bucket_hour, workspace_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_center_agent_presence call_center_agent_presence_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_agent_presence
    ADD CONSTRAINT call_center_agent_presence_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_center_agent_presence call_center_agent_presence_workspace_id_user_id_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_agent_presence
    ADD CONSTRAINT call_center_agent_presence_workspace_id_user_id_key UNIQUE (workspace_id, user_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_center_department_agents call_center_department_agents_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_department_agents
    ADD CONSTRAINT call_center_department_agents_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_center_department_agents call_center_department_agents_workspace_id_department_id_us_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_department_agents
    ADD CONSTRAINT call_center_department_agents_workspace_id_department_id_us_key UNIQUE (workspace_id, department_id, user_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_center_departments call_center_departments_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_departments
    ADD CONSTRAINT call_center_departments_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_center_departments call_center_departments_workspace_id_slug_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_departments
    ADD CONSTRAINT call_center_departments_workspace_id_slug_key UNIQUE (workspace_id, slug)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CHECK CONSTRAINT: call_center_settings call_center_settings_avatar_path_scope_check
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.call_center_settings
    ADD CONSTRAINT call_center_settings_avatar_path_scope_check CHECK (((avatar_storage_path IS NULL) OR (avatar_storage_path ~~ (('workspace/'::text || (workspace_id)::text) || '/avatars/call-center/%'::text)) OR (avatar_storage_path ~~ (('workspace/'::text || (workspace_id)::text) || '/call-center/avatar/%'::text)))) NOT VALID$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_events call_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_events
    ADD CONSTRAINT call_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_invitations call_invitations_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_invitations
    ADD CONSTRAINT call_invitations_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_participants call_participants_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_participants
    ADD CONSTRAINT call_participants_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_ratings call_ratings_call_session_id_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_ratings
    ADD CONSTRAINT call_ratings_call_session_id_key UNIQUE (call_session_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_ratings call_ratings_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_ratings
    ADD CONSTRAINT call_ratings_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CHECK CONSTRAINT: call_recordings call_recordings_path_scope_check
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.call_recordings
    ADD CONSTRAINT call_recordings_path_scope_check CHECK (((storage_path = ''::text) OR (storage_path ~~ (((('workspace/'::text || (workspace_id)::text) || '/calls/recordings/'::text) || (call_session_id)::text) || '/%'::text)))) NOT VALID$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: call_recordings call_recordings_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_recordings
    ADD CONSTRAINT call_recordings_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: commerce_deleted_entities commerce_deleted_entities_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.commerce_deleted_entities
    ADD CONSTRAINT commerce_deleted_entities_pkey PRIMARY KEY (connection_id, kind, external_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: contact_verifications contact_verifications_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.contact_verifications
    ADD CONSTRAINT contact_verifications_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: conversation_attachments conversation_attachments_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.conversation_attachments
    ADD CONSTRAINT conversation_attachments_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: conversation_events conversation_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.conversation_events
    ADD CONSTRAINT conversation_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: conversation_notes conversation_notes_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.conversation_notes
    ADD CONSTRAINT conversation_notes_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: email_logs email_logs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: email_settings_localized email_settings_localized_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_settings_localized
    ADD CONSTRAINT email_settings_localized_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: email_settings_localized email_settings_localized_workspace_id_locale_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_settings_localized
    ADD CONSTRAINT email_settings_localized_workspace_id_locale_key UNIQUE (workspace_id, locale)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: email_settings email_settings_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_settings
    ADD CONSTRAINT email_settings_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: enforcement_actions enforcement_actions_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.enforcement_actions
    ADD CONSTRAINT enforcement_actions_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: enforcement_normalizations enforcement_normalizations_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.enforcement_normalizations
    ADD CONSTRAINT enforcement_normalizations_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: enforcement_rules enforcement_rules_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.enforcement_rules
    ADD CONSTRAINT enforcement_rules_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: enforcement_rules enforcement_rules_slug_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.enforcement_rules
    ADD CONSTRAINT enforcement_rules_slug_key UNIQUE (slug)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: geo_ip_cache geo_ip_cache_ip_hash_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.geo_ip_cache
    ADD CONSTRAINT geo_ip_cache_ip_hash_key UNIQUE (ip_hash)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: geo_ip_cache geo_ip_cache_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.geo_ip_cache
    ADD CONSTRAINT geo_ip_cache_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: identity_merges identity_merges_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.identity_merges
    ADD CONSTRAINT identity_merges_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ip_blocklist ip_blocklist_ip_address_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ip_blocklist
    ADD CONSTRAINT ip_blocklist_ip_address_key UNIQUE (ip_address)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: ip_blocklist ip_blocklist_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ip_blocklist
    ADD CONSTRAINT ip_blocklist_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: knowledge_base_change_events knowledge_base_change_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.knowledge_base_change_events
    ADD CONSTRAINT knowledge_base_change_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: livekit_webhook_events livekit_webhook_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.livekit_webhook_events
    ADD CONSTRAINT livekit_webhook_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: login_attempts login_attempts_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: operator_call_availability operator_call_availability_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.operator_call_availability
    ADD CONSTRAINT operator_call_availability_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: operator_call_availability operator_call_availability_workspace_id_user_id_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.operator_call_availability
    ADD CONSTRAINT operator_call_availability_workspace_id_user_id_key UNIQUE (workspace_id, user_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: phone_verification_challenges phone_verification_challenges_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.phone_verification_challenges
    ADD CONSTRAINT phone_verification_challenges_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_branding_localized platform_branding_localized_locale_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_branding_localized
    ADD CONSTRAINT platform_branding_localized_locale_key UNIQUE (locale)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_branding_localized platform_branding_localized_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_branding_localized
    ADD CONSTRAINT platform_branding_localized_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_call_center_settings platform_call_center_settings_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_call_center_settings
    ADD CONSTRAINT platform_call_center_settings_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_call_center_settings platform_call_center_settings_singleton_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_call_center_settings
    ADD CONSTRAINT platform_call_center_settings_singleton_key UNIQUE (singleton)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_domains platform_domains_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_domains
    ADD CONSTRAINT platform_domains_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_sms_provider_config platform_sms_provider_config_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_sms_provider_config
    ADD CONSTRAINT platform_sms_provider_config_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: platform_sms_provider_config platform_sms_provider_config_singleton_uniq
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.platform_sms_provider_config
    ADD CONSTRAINT platform_sms_provider_config_singleton_uniq UNIQUE (singleton)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CHECK CONSTRAINT: privacy_jobs privacy_jobs_artifact_path_scope_check
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.privacy_jobs
    ADD CONSTRAINT privacy_jobs_artifact_path_scope_check CHECK (((artifact_storage_key IS NULL) OR ((workspace_id IS NOT NULL) AND ((artifact_storage_key ~~ (('workspace/'::text || (workspace_id)::text) || '/exports/privacy/%'::text)) OR (artifact_storage_key ~~ (('privacy-exports/'::text || (workspace_id)::text) || '/%'::text)))) OR ((workspace_id IS NULL) AND (artifact_storage_key ~~ (('users/'::text || subject_id) || '/exports/privacy/%'::text))))) NOT VALID$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: privacy_jobs privacy_jobs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.privacy_jobs
    ADD CONSTRAINT privacy_jobs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: realtime_failover_state realtime_failover_state_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.realtime_failover_state
    ADD CONSTRAINT realtime_failover_state_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: realtime_provider_audit realtime_provider_audit_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.realtime_provider_audit
    ADD CONSTRAINT realtime_provider_audit_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: role_permissions role_permissions_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: security_events security_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: sla_reliability_hourly sla_reliability_hourly_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.sla_reliability_hourly
    ADD CONSTRAINT sla_reliability_hourly_pkey PRIMARY KEY (bucket_hour, scope_type, scope_key)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: slo_breach_events slo_breach_events_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.slo_breach_events
    ADD CONSTRAINT slo_breach_events_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: slo_definitions slo_definitions_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.slo_definitions
    ADD CONSTRAINT slo_definitions_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: slo_definitions slo_definitions_slug_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.slo_definitions
    ADD CONSTRAINT slo_definitions_slug_key UNIQUE (slug)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: storage_usage_logs storage_usage_logs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.storage_usage_logs
    ADD CONSTRAINT storage_usage_logs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: team_messages team_messages_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: user_availability_prefs user_availability_prefs_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_availability_prefs
    ADD CONSTRAINT user_availability_prefs_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: user_continuity_tokens user_continuity_tokens_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_continuity_tokens
    ADD CONSTRAINT user_continuity_tokens_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: user_continuity_tokens user_continuity_tokens_token_hash_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_continuity_tokens
    ADD CONSTRAINT user_continuity_tokens_token_hash_key UNIQUE (token_hash)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: user_phone_verifications user_phone_verifications_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_phone_verifications
    ADD CONSTRAINT user_phone_verifications_pkey PRIMARY KEY (user_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: visitor_geo_cache visitor_geo_cache_ip_hash_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.visitor_geo_cache
    ADD CONSTRAINT visitor_geo_cache_ip_hash_key UNIQUE (ip_hash)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: visitor_geo_cache visitor_geo_cache_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.visitor_geo_cache
    ADD CONSTRAINT visitor_geo_cache_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: widget_templates widget_templates_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.widget_templates
    ADD CONSTRAINT widget_templates_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: widget_templates widget_templates_slug_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.widget_templates
    ADD CONSTRAINT widget_templates_slug_key UNIQUE (slug)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_alert_dismissals workspace_alert_dismissals_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_alert_dismissals
    ADD CONSTRAINT workspace_alert_dismissals_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_alert_dismissals workspace_alert_dismissals_workspace_id_user_id_alert_key_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_alert_dismissals
    ADD CONSTRAINT workspace_alert_dismissals_workspace_id_user_id_alert_key_key UNIQUE (workspace_id, user_id, alert_key)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_branding_localized workspace_branding_localized_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_branding_localized
    ADD CONSTRAINT workspace_branding_localized_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_branding_localized workspace_branding_localized_workspace_id_locale_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_branding_localized
    ADD CONSTRAINT workspace_branding_localized_workspace_id_locale_key UNIQUE (workspace_id, locale)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_channel_overrides workspace_channel_overrides_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_channel_overrides
    ADD CONSTRAINT workspace_channel_overrides_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_channel_overrides workspace_channel_overrides_workspace_id_channel_key_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_channel_overrides
    ADD CONSTRAINT workspace_channel_overrides_workspace_id_channel_key_key UNIQUE (workspace_id, channel_key)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_domains_extended workspace_domains_extended_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_domains_extended
    ADD CONSTRAINT workspace_domains_extended_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_domains_extended workspace_domains_extended_workspace_id_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_domains_extended
    ADD CONSTRAINT workspace_domains_extended_workspace_id_key UNIQUE (workspace_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_health_snapshots workspace_health_snapshots_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots
    ADD CONSTRAINT workspace_health_snapshots_pkey PRIMARY KEY (captured_at, id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_health_snapshots_2026_09 workspace_health_snapshots_2026_09_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots_2026_09
    ADD CONSTRAINT workspace_health_snapshots_2026_09_pkey PRIMARY KEY (captured_at, id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_health_snapshots_2026_10 workspace_health_snapshots_2026_10_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots_2026_10
    ADD CONSTRAINT workspace_health_snapshots_2026_10_pkey PRIMARY KEY (captured_at, id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_health_snapshots_2026_11 workspace_health_snapshots_2026_11_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots_2026_11
    ADD CONSTRAINT workspace_health_snapshots_2026_11_pkey PRIMARY KEY (captured_at, id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_health_snapshots_default workspace_health_snapshots_default_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots_default
    ADD CONSTRAINT workspace_health_snapshots_default_pkey PRIMARY KEY (captured_at, id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_health_snapshots_legacy workspace_health_snapshots_legacy_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_health_snapshots_legacy
    ADD CONSTRAINT workspace_health_snapshots_legacy_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_limit_overrides workspace_limit_overrides_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_limit_overrides
    ADD CONSTRAINT workspace_limit_overrides_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_limit_overrides workspace_limit_overrides_workspace_id_limit_key_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_limit_overrides
    ADD CONSTRAINT workspace_limit_overrides_workspace_id_limit_key_key UNIQUE (workspace_id, limit_key)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_module_overrides workspace_module_overrides_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_module_overrides
    ADD CONSTRAINT workspace_module_overrides_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_module_overrides workspace_module_overrides_workspace_id_module_key_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_module_overrides
    ADD CONSTRAINT workspace_module_overrides_workspace_id_module_key_key UNIQUE (workspace_id, module_key)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_provider_settings workspace_provider_settings_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_provider_settings
    ADD CONSTRAINT workspace_provider_settings_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_provider_settings workspace_provider_settings_workspace_id_provider_type_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_provider_settings
    ADD CONSTRAINT workspace_provider_settings_workspace_id_provider_type_key UNIQUE (workspace_id, provider_type)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_settings workspace_settings_pkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_pkey PRIMARY KEY (id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- CONSTRAINT: workspace_settings workspace_settings_workspace_id_key
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_workspace_id_key UNIQUE (workspace_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- INDEX: ai_agent_learning_candidates_pending_uniq
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_learning_candidates_pending_uniq ON public.ai_agent_learning_candidates USING btree (workspace_id, normalized_question) WHERE (status = 'pending'::text);

-- INDEX: ai_agent_learning_candidates_ws_status_reason_idx
CREATE INDEX IF NOT EXISTS ai_agent_learning_candidates_ws_status_reason_idx ON public.ai_agent_learning_candidates USING btree (workspace_id, status, reason);

-- INDEX: ai_knowledge_chunks_embedding_hnsw
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_hnsw ON public.ai_knowledge_chunks USING hnsw (embedding public.vector_cosine_ops);

-- INDEX: ai_knowledge_chunks_hash_idx
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_hash_idx ON public.ai_knowledge_chunks USING btree (content_hash);

-- INDEX: ai_knowledge_chunks_unique_source
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_chunks_unique_source ON public.ai_knowledge_chunks USING btree (workspace_id, source_type, source_id, chunk_index);

-- INDEX: ai_knowledge_chunks_ws_locale_idx
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_ws_locale_idx ON public.ai_knowledge_chunks USING btree (workspace_id, locale);

-- INDEX: ai_knowledge_chunks_ws_status_idx
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_ws_status_idx ON public.ai_knowledge_chunks USING btree (workspace_id, status);

-- INDEX: ai_source_pages_unique_idx
CREATE UNIQUE INDEX IF NOT EXISTS ai_source_pages_unique_idx ON public.ai_source_pages USING btree (source_id, url_hash);

-- INDEX: ai_source_pages_workspace_idx
CREATE INDEX IF NOT EXISTS ai_source_pages_workspace_idx ON public.ai_source_pages USING btree (workspace_id);

-- INDEX: ai_source_sync_jobs_claim_idx
CREATE INDEX IF NOT EXISTS ai_source_sync_jobs_claim_idx ON public.ai_source_sync_jobs USING btree (status, priority, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- INDEX: ai_source_sync_jobs_source_idx
CREATE INDEX IF NOT EXISTS ai_source_sync_jobs_source_idx ON public.ai_source_sync_jobs USING btree (source_id, created_at DESC);

-- INDEX: ai_source_sync_jobs_workspace_idx
CREATE INDEX IF NOT EXISTS ai_source_sync_jobs_workspace_idx ON public.ai_source_sync_jobs USING btree (workspace_id, created_at DESC);

-- INDEX: alert_events_fired_at_idx
CREATE INDEX IF NOT EXISTS alert_events_fired_at_idx ON public.alert_events USING btree (fired_at DESC);

-- INDEX: alert_events_rule_state_idx
CREATE INDEX IF NOT EXISTS alert_events_rule_state_idx ON public.alert_events USING btree (rule_id, state);

-- INDEX: alert_rules_enabled_idx
CREATE INDEX IF NOT EXISTS alert_rules_enabled_idx ON public.alert_rules USING btree (enabled);

-- INDEX: auto_action_events_active_idx
CREATE INDEX IF NOT EXISTS auto_action_events_active_idx ON public.auto_action_events USING btree (definition_id, state, started_at DESC) WHERE (state = 'active'::text);

-- INDEX: auto_action_events_recent_idx
CREATE INDEX IF NOT EXISTS auto_action_events_recent_idx ON public.auto_action_events USING btree (started_at DESC);

-- INDEX: backup_commands_pending_idx
CREATE INDEX IF NOT EXISTS backup_commands_pending_idx ON public.backup_commands USING btree (status, requested_at);

-- INDEX: backup_restore_drills_kind_idx
CREATE INDEX IF NOT EXISTS backup_restore_drills_kind_idx ON public.backup_restore_drills USING btree (drill_kind, started_at DESC);

-- INDEX: backup_runs_kind_started_idx
CREATE INDEX IF NOT EXISTS backup_runs_kind_started_idx ON public.backup_runs USING btree (kind, started_at DESC);

-- INDEX: backup_runs_status_idx
CREATE INDEX IF NOT EXISTS backup_runs_status_idx ON public.backup_runs USING btree (status, started_at DESC);

-- INDEX: business_metrics_hourly_workspace_idx
CREATE INDEX IF NOT EXISTS business_metrics_hourly_workspace_idx ON public.business_metrics_hourly USING btree (workspace_id, bucket_hour DESC);

-- INDEX: canned_responses_body_trgm_idx
CREATE INDEX IF NOT EXISTS canned_responses_body_trgm_idx ON public.canned_responses USING gin (body public.gin_trgm_ops);

-- INDEX: canned_responses_shortcut_trgm_idx
CREATE INDEX IF NOT EXISTS canned_responses_shortcut_trgm_idx ON public.canned_responses USING gin (shortcut public.gin_trgm_ops);

-- INDEX: canned_responses_title_trgm_idx
CREATE INDEX IF NOT EXISTS canned_responses_title_trgm_idx ON public.canned_responses USING gin (title public.gin_trgm_ops);

-- INDEX: commerce_deleted_entities_expiry_idx
CREATE INDEX IF NOT EXISTS commerce_deleted_entities_expiry_idx ON public.commerce_deleted_entities USING btree (deleted_at);

-- INDEX: contacts_workspace_email_unique_not_blank
CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_email_unique_not_blank ON public.contacts USING btree (workspace_id, lower(btrim(email))) WHERE ((email IS NOT NULL) AND (btrim(email) <> ''::text));

-- INDEX: contacts_workspace_phone_unique_not_blank
CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_phone_unique_not_blank ON public.contacts USING btree (workspace_id, regexp_replace(phone, '[^0-9+]'::text, ''::text, 'g'::text)) WHERE ((phone IS NOT NULL) AND (regexp_replace(phone, '[^0-9+]'::text, ''::text, 'g'::text) <> ''::text));

-- INDEX: conversation_messages_call_ended_uidx
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_call_ended_uidx ON public.conversation_messages USING btree (conversation_id, ((metadata ->> 'call_session_id'::text))) WHERE ((sender_type = 'system'::public.sender_type) AND ((metadata ->> 'kind'::text) = 'call_ended'::text) AND ((metadata ->> 'call_session_id'::text) IS NOT NULL));

-- INDEX: enforcement_actions_recent_idx
CREATE INDEX IF NOT EXISTS enforcement_actions_recent_idx ON public.enforcement_actions USING btree (created_at DESC);

-- INDEX: enforcement_actions_rule_idx
CREATE INDEX IF NOT EXISTS enforcement_actions_rule_idx ON public.enforcement_actions USING btree (rule_id, created_at DESC);

-- INDEX: enforcement_normalizations_created_idx
CREATE INDEX IF NOT EXISTS enforcement_normalizations_created_idx ON public.enforcement_normalizations USING btree (created_at DESC);

-- INDEX: enforcement_rules_enabled_idx
CREATE INDEX IF NOT EXISTS enforcement_rules_enabled_idx ON public.enforcement_rules USING btree (enabled) WHERE (enabled = true);

-- INDEX: enforcement_rules_priority_idx
CREATE INDEX IF NOT EXISTS enforcement_rules_priority_idx ON public.enforcement_rules USING btree (priority DESC);

-- INDEX: idx_admin_gate_bypass_log_user
CREATE INDEX IF NOT EXISTS idx_admin_gate_bypass_log_user ON public.admin_gate_bypass_log USING btree (user_id, created_at DESC);

-- INDEX: idx_admin_gate_bypass_log_ws
CREATE INDEX IF NOT EXISTS idx_admin_gate_bypass_log_ws ON public.admin_gate_bypass_log USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_agent_debug_events_run
CREATE INDEX IF NOT EXISTS idx_ai_agent_debug_events_run ON public.ai_agent_debug_events USING btree (run_id);

-- INDEX: idx_ai_agent_debug_events_ws_created
CREATE INDEX IF NOT EXISTS idx_ai_agent_debug_events_ws_created ON public.ai_agent_debug_events USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_agent_qna_workspace
CREATE INDEX IF NOT EXISTS idx_ai_agent_qna_workspace ON public.ai_agent_qna USING btree (workspace_id);

-- INDEX: idx_ai_agent_regression_batches_schedule_created
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_batches_schedule_created ON public.ai_agent_regression_batches USING btree (schedule_id, created_at DESC);

-- INDEX: idx_ai_agent_regression_batches_status_created
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_batches_status_created ON public.ai_agent_regression_batches USING btree (status, created_at);

-- INDEX: idx_ai_agent_regression_batches_ws_created
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_batches_ws_created ON public.ai_agent_regression_batches USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_agent_regression_schedules_enabled_next
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_schedules_enabled_next ON public.ai_agent_regression_schedules USING btree (enabled, next_run_at);

-- INDEX: idx_ai_agent_regression_schedules_ws
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_schedules_ws ON public.ai_agent_regression_schedules USING btree (workspace_id);

-- INDEX: idx_ai_agent_regression_schedules_ws_enabled
CREATE INDEX IF NOT EXISTS idx_ai_agent_regression_schedules_ws_enabled ON public.ai_agent_regression_schedules USING btree (workspace_id, enabled);

-- INDEX: idx_ai_agent_runs_conversation
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_conversation ON public.ai_agent_runs USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);

-- INDEX: idx_ai_agent_runs_workspace_created
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_workspace_created ON public.ai_agent_runs USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_agent_sources_workspace
CREATE INDEX IF NOT EXISTS idx_ai_agent_sources_workspace ON public.ai_agent_sources USING btree (workspace_id);

-- INDEX: idx_ai_agent_suggested_tc_expected_source_type
CREATE INDEX IF NOT EXISTS idx_ai_agent_suggested_tc_expected_source_type ON public.ai_agent_suggested_test_cases USING btree (expected_source_type);

-- INDEX: idx_ai_agent_suggested_tc_source
CREATE INDEX IF NOT EXISTS idx_ai_agent_suggested_tc_source ON public.ai_agent_suggested_test_cases USING btree (source_type, source_id);

-- INDEX: idx_ai_agent_suggested_tc_ws_status_created
CREATE INDEX IF NOT EXISTS idx_ai_agent_suggested_tc_ws_status_created ON public.ai_agent_suggested_test_cases USING btree (workspace_id, status, created_at DESC);

-- INDEX: idx_ai_agent_suggestions_conversation
CREATE INDEX IF NOT EXISTS idx_ai_agent_suggestions_conversation ON public.ai_agent_suggestions USING btree (conversation_id);

-- INDEX: idx_ai_agent_suggestions_workspace
CREATE INDEX IF NOT EXISTS idx_ai_agent_suggestions_workspace ON public.ai_agent_suggestions USING btree (workspace_id);

-- INDEX: idx_ai_agent_test_cases_behavior
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_cases_behavior ON public.ai_agent_test_cases USING btree (workspace_id, expected_behavior);

-- INDEX: idx_ai_agent_test_cases_ws
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_cases_ws ON public.ai_agent_test_cases USING btree (workspace_id, enabled);

-- INDEX: idx_ai_agent_test_runs_case
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_runs_case ON public.ai_agent_test_runs USING btree (test_case_id, created_at DESC);

-- INDEX: idx_ai_agent_test_runs_regression_batch
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_runs_regression_batch ON public.ai_agent_test_runs USING btree (regression_batch_id);

-- INDEX: idx_ai_agent_test_runs_ws
CREATE INDEX IF NOT EXISTS idx_ai_agent_test_runs_ws ON public.ai_agent_test_runs USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_data_sources_workspace
CREATE INDEX IF NOT EXISTS idx_ai_data_sources_workspace ON public.ai_data_sources USING btree (workspace_id, source_type);

-- INDEX: idx_ai_guidance_workspace
CREATE INDEX IF NOT EXISTS idx_ai_guidance_workspace ON public.ai_agent_guidance_rules USING btree (workspace_id, priority);

-- INDEX: idx_ai_kb_generated_job
CREATE INDEX IF NOT EXISTS idx_ai_kb_generated_job ON public.ai_kb_generated_articles USING btree (job_id);

-- INDEX: idx_ai_kb_generated_workspace
CREATE INDEX IF NOT EXISTS idx_ai_kb_generated_workspace ON public.ai_kb_generated_articles USING btree (workspace_id, status, created_at DESC);

-- INDEX: idx_ai_kb_job_events_job
CREATE INDEX IF NOT EXISTS idx_ai_kb_job_events_job ON public.ai_kb_job_events USING btree (job_id, created_at);

-- INDEX: idx_ai_kb_job_pages_job
CREATE INDEX IF NOT EXISTS idx_ai_kb_job_pages_job ON public.ai_kb_job_pages USING btree (job_id, status);

-- INDEX: idx_ai_kb_jobs_status
CREATE INDEX IF NOT EXISTS idx_ai_kb_jobs_status ON public.ai_kb_jobs USING btree (status, created_at);

-- INDEX: idx_ai_kb_jobs_workspace
CREATE INDEX IF NOT EXISTS idx_ai_kb_jobs_workspace ON public.ai_kb_jobs USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_kb_usage_workspace
CREATE INDEX IF NOT EXISTS idx_ai_kb_usage_workspace ON public.ai_kb_usage USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_learn_cand_conv
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_conv ON public.ai_agent_learning_candidates USING btree (conversation_id);

-- INDEX: idx_ai_learn_cand_created
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_created ON public.ai_agent_learning_candidates USING btree (created_at DESC);

-- INDEX: idx_ai_learn_cand_ws_norm
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_ws_norm ON public.ai_agent_learning_candidates USING btree (workspace_id, normalized_question);

-- INDEX: idx_ai_learn_cand_ws_status
CREATE INDEX IF NOT EXISTS idx_ai_learn_cand_ws_status ON public.ai_agent_learning_candidates USING btree (workspace_id, status);

-- INDEX: idx_ai_msg_triggers_workspace
CREATE INDEX IF NOT EXISTS idx_ai_msg_triggers_workspace ON public.ai_agent_message_triggers USING btree (workspace_id);

-- INDEX: idx_ai_msg_triggers_workspace_event
CREATE INDEX IF NOT EXISTS idx_ai_msg_triggers_workspace_event ON public.ai_agent_message_triggers USING btree (workspace_id, event_type);

-- INDEX: idx_ai_op_assist_fb_action
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_action ON public.ai_operator_assist_feedback USING btree (operator_action);

-- INDEX: idx_ai_op_assist_fb_rating
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_rating ON public.ai_operator_assist_feedback USING btree (rating);

-- INDEX: idx_ai_op_assist_fb_reason
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_reason ON public.ai_operator_assist_feedback USING btree (reason);

-- INDEX: idx_ai_op_assist_fb_run
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_run ON public.ai_operator_assist_feedback USING btree (assist_run_id);

-- INDEX: idx_ai_op_assist_fb_ws_created
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_fb_ws_created ON public.ai_operator_assist_feedback USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_op_assist_ws_conv_created
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_ws_conv_created ON public.ai_operator_assist_runs USING btree (workspace_id, conversation_id, created_at DESC);

-- INDEX: idx_ai_op_assist_ws_created
CREATE INDEX IF NOT EXISTS idx_ai_op_assist_ws_created ON public.ai_operator_assist_runs USING btree (workspace_id, created_at DESC);

-- INDEX: idx_ai_routing_workspace
CREATE INDEX IF NOT EXISTS idx_ai_routing_workspace ON public.ai_agent_routing_rules USING btree (workspace_id, priority);

-- INDEX: idx_ai_source_logs_source
CREATE INDEX IF NOT EXISTS idx_ai_source_logs_source ON public.ai_source_sync_logs USING btree (source_id, created_at DESC);

-- INDEX: idx_ai_tool_servers_workspace
CREATE INDEX IF NOT EXISTS idx_ai_tool_servers_workspace ON public.ai_agent_tool_servers USING btree (workspace_id);

-- INDEX: idx_ai_tool_servers_workspace_status
CREATE INDEX IF NOT EXISTS idx_ai_tool_servers_workspace_status ON public.ai_agent_tool_servers USING btree (workspace_id, status);

-- INDEX: idx_ai_tools_server
CREATE INDEX IF NOT EXISTS idx_ai_tools_server ON public.ai_agent_tools USING btree (server_id);

-- INDEX: idx_ai_tools_workspace
CREATE INDEX IF NOT EXISTS idx_ai_tools_workspace ON public.ai_agent_tools USING btree (workspace_id);

-- INDEX: idx_ai_tools_workspace_type
CREATE INDEX IF NOT EXISTS idx_ai_tools_workspace_type ON public.ai_agent_tools USING btree (workspace_id, tool_type);

-- INDEX: idx_ai_topics_workspace
CREATE INDEX IF NOT EXISTS idx_ai_topics_workspace ON public.ai_agent_topics USING btree (workspace_id);

-- INDEX: idx_ai_topics_workspace_enabled
CREATE INDEX IF NOT EXISTS idx_ai_topics_workspace_enabled ON public.ai_agent_topics USING btree (workspace_id, enabled);

-- INDEX: idx_ai_usage_created
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON public.ai_usage_logs USING btree (created_at DESC);

-- INDEX: idx_ai_usage_provider
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON public.ai_usage_logs USING btree (provider_name);

-- INDEX: idx_ai_usage_workspace
CREATE INDEX IF NOT EXISTS idx_ai_usage_workspace ON public.ai_usage_logs USING btree (workspace_id);

-- INDEX: idx_ai_workflows_workspace
CREATE INDEX IF NOT EXISTS idx_ai_workflows_workspace ON public.ai_agent_workflows USING btree (workspace_id);

-- INDEX: idx_ai_workflows_workspace_status
CREATE INDEX IF NOT EXISTS idx_ai_workflows_workspace_status ON public.ai_agent_workflows USING btree (workspace_id, status);

-- INDEX: idx_billing_events_idempotent
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_idempotent ON public.billing_events USING btree (provider_name, provider_event_id) WHERE (provider_event_id IS NOT NULL);

-- INDEX: idx_billing_events_workspace
CREATE INDEX IF NOT EXISTS idx_billing_events_workspace ON public.billing_events USING btree (workspace_id);

-- INDEX: idx_call_center_settings_publickey
CREATE INDEX IF NOT EXISTS idx_call_center_settings_publickey ON public.call_center_settings USING btree (public_key) WHERE (public_key IS NOT NULL);

-- INDEX: idx_call_center_settings_workspace
CREATE INDEX IF NOT EXISTS idx_call_center_settings_workspace ON public.call_center_settings USING btree (workspace_id);

-- INDEX: idx_call_events_session
CREATE INDEX IF NOT EXISTS idx_call_events_session ON public.call_events USING btree (call_session_id, created_at DESC);

-- INDEX: idx_call_invitations_conversation
CREATE INDEX IF NOT EXISTS idx_call_invitations_conversation ON public.call_invitations USING btree (conversation_id, created_at DESC);

-- INDEX: idx_call_invitations_pending_expiry
CREATE INDEX IF NOT EXISTS idx_call_invitations_pending_expiry ON public.call_invitations USING btree (expires_at) WHERE (status = 'pending'::public.call_invitation_status);

-- INDEX: idx_call_invitations_session
CREATE INDEX IF NOT EXISTS idx_call_invitations_session ON public.call_invitations USING btree (call_session_id) WHERE (call_session_id IS NOT NULL);

-- INDEX: idx_call_invitations_workspace_status
CREATE INDEX IF NOT EXISTS idx_call_invitations_workspace_status ON public.call_invitations USING btree (workspace_id, status, expires_at);

-- INDEX: idx_call_participants_session
CREATE INDEX IF NOT EXISTS idx_call_participants_session ON public.call_participants USING btree (call_session_id);

-- INDEX: idx_call_ratings_call
CREATE INDEX IF NOT EXISTS idx_call_ratings_call ON public.call_ratings USING btree (call_session_id);

-- INDEX: idx_call_ratings_workspace
CREATE INDEX IF NOT EXISTS idx_call_ratings_workspace ON public.call_ratings USING btree (workspace_id, created_at DESC);

-- INDEX: idx_call_recordings_provider_recording_id
CREATE INDEX IF NOT EXISTS idx_call_recordings_provider_recording_id ON public.call_recordings USING btree (provider_recording_id) WHERE (provider_recording_id IS NOT NULL);

-- INDEX: idx_call_recordings_retention
CREATE INDEX IF NOT EXISTS idx_call_recordings_retention ON public.call_recordings USING btree (retention_expires_at) WHERE ((legal_hold = false) AND (retention_expires_at IS NOT NULL));

-- INDEX: idx_call_recordings_session
CREATE INDEX IF NOT EXISTS idx_call_recordings_session ON public.call_recordings USING btree (call_session_id);

-- INDEX: idx_call_recordings_workspace
CREATE INDEX IF NOT EXISTS idx_call_recordings_workspace ON public.call_recordings USING btree (workspace_id);

-- INDEX: idx_ccap_user
CREATE INDEX IF NOT EXISTS idx_ccap_user ON public.call_center_agent_presence USING btree (user_id);

-- INDEX: idx_ccap_workspace
CREATE INDEX IF NOT EXISTS idx_ccap_workspace ON public.call_center_agent_presence USING btree (workspace_id);

-- INDEX: idx_ccap_workspace_status
CREATE INDEX IF NOT EXISTS idx_ccap_workspace_status ON public.call_center_agent_presence USING btree (workspace_id, status);

-- INDEX: idx_ccd_workspace
CREATE INDEX IF NOT EXISTS idx_ccd_workspace ON public.call_center_departments USING btree (workspace_id);

-- INDEX: idx_ccd_workspace_enabled
CREATE INDEX IF NOT EXISTS idx_ccd_workspace_enabled ON public.call_center_departments USING btree (workspace_id, enabled);

-- INDEX: idx_ccd_workspace_slug
CREATE INDEX IF NOT EXISTS idx_ccd_workspace_slug ON public.call_center_departments USING btree (workspace_id, slug);

-- INDEX: idx_ccda_department
CREATE INDEX IF NOT EXISTS idx_ccda_department ON public.call_center_department_agents USING btree (department_id);

-- INDEX: idx_ccda_user
CREATE INDEX IF NOT EXISTS idx_ccda_user ON public.call_center_department_agents USING btree (user_id);

-- INDEX: idx_ccda_workspace
CREATE INDEX IF NOT EXISTS idx_ccda_workspace ON public.call_center_department_agents USING btree (workspace_id);

-- INDEX: idx_ccda_workspace_enabled
CREATE INDEX IF NOT EXISTS idx_ccda_workspace_enabled ON public.call_center_department_agents USING btree (workspace_id, enabled);

-- INDEX: idx_contact_verifications_expires
CREATE INDEX IF NOT EXISTS idx_contact_verifications_expires ON public.contact_verifications USING btree (expires_at) WHERE (used_at IS NULL);

-- INDEX: idx_contact_verifications_token_hash
CREATE INDEX IF NOT EXISTS idx_contact_verifications_token_hash ON public.contact_verifications USING btree (token_hash) WHERE (used_at IS NULL);

-- INDEX: idx_contact_verifications_workspace_identifier
CREATE INDEX IF NOT EXISTS idx_contact_verifications_workspace_identifier ON public.contact_verifications USING btree (workspace_id, channel, identifier);

-- INDEX: idx_contacts_workspace_spam
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_spam ON public.contacts USING btree (workspace_id, is_spam);

-- INDEX: idx_continuity_tokens_expires
CREATE INDEX IF NOT EXISTS idx_continuity_tokens_expires ON public.user_continuity_tokens USING btree (expires_at) WHERE (revoked_at IS NULL);

-- INDEX: idx_continuity_tokens_workspace_contact
CREATE INDEX IF NOT EXISTS idx_continuity_tokens_workspace_contact ON public.user_continuity_tokens USING btree (workspace_id, contact_id);

-- INDEX: idx_conv_messages_unseen_visitor
CREATE INDEX IF NOT EXISTS idx_conv_messages_unseen_visitor ON public.conversation_messages USING btree (conversation_id, created_at) WHERE ((seen_at IS NULL) AND (sender_type = 'contact'::public.sender_type));

-- INDEX: idx_conversation_attachments_conversation
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_conversation ON public.conversation_attachments USING btree (conversation_id);

-- INDEX: idx_conversation_attachments_message
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_message ON public.conversation_attachments USING btree (message_id);

-- INDEX: idx_conversation_attachments_status
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_status ON public.conversation_attachments USING btree (status);

-- INDEX: idx_conversation_attachments_workspace
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_workspace ON public.conversation_attachments USING btree (workspace_id);

-- INDEX: idx_conversation_events_conv
CREATE INDEX IF NOT EXISTS idx_conversation_events_conv ON public.conversation_events USING btree (conversation_id, created_at DESC);

-- INDEX: idx_conversation_events_type
CREATE INDEX IF NOT EXISTS idx_conversation_events_type ON public.conversation_events USING btree (event_type);

-- INDEX: idx_conversation_events_workspace
CREATE INDEX IF NOT EXISTS idx_conversation_events_workspace ON public.conversation_events USING btree (workspace_id);

-- INDEX: idx_conversation_messages_conv_sender_created
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv_sender_created ON public.conversation_messages USING btree (conversation_id, sender_type, created_at DESC);

-- INDEX: idx_conversation_messages_metadata_source
CREATE INDEX IF NOT EXISTS idx_conversation_messages_metadata_source ON public.conversation_messages USING btree (((metadata ->> 'source'::text)));

-- INDEX: idx_conversation_notes_conv
CREATE INDEX IF NOT EXISTS idx_conversation_notes_conv ON public.conversation_notes USING btree (conversation_id, created_at DESC);

-- INDEX: idx_conversation_notes_workspace
CREATE INDEX IF NOT EXISTS idx_conversation_notes_workspace ON public.conversation_notes USING btree (workspace_id);

-- INDEX: idx_conversations_ai_state
CREATE INDEX IF NOT EXISTS idx_conversations_ai_state ON public.conversations USING btree (workspace_id, ai_state) WHERE (ai_state IS NOT NULL);

-- INDEX: idx_conversations_workspace_spam
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_spam ON public.conversations USING btree (workspace_id, is_spam);

-- INDEX: idx_email_logs_created_at
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON public.email_logs USING btree (created_at DESC);

-- INDEX: idx_email_logs_status
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON public.email_logs USING btree (status);

-- INDEX: idx_email_logs_workspace_id
CREATE INDEX IF NOT EXISTS idx_email_logs_workspace_id ON public.email_logs USING btree (workspace_id);

-- INDEX: idx_geo_ip_cache_expires_at
CREATE INDEX IF NOT EXISTS idx_geo_ip_cache_expires_at ON public.geo_ip_cache USING btree (expires_at);

-- INDEX: idx_geo_ip_cache_ip_hash
CREATE INDEX IF NOT EXISTS idx_geo_ip_cache_ip_hash ON public.geo_ip_cache USING btree (ip_hash);

-- INDEX: idx_identity_merges_visitor
CREATE INDEX IF NOT EXISTS idx_identity_merges_visitor ON public.identity_merges USING btree (workspace_id, visitor_id);

-- INDEX: idx_identity_merges_workspace_contact
CREATE INDEX IF NOT EXISTS idx_identity_merges_workspace_contact ON public.identity_merges USING btree (workspace_id, contact_id);

-- INDEX: idx_ip_blocklist_ip
CREATE INDEX IF NOT EXISTS idx_ip_blocklist_ip ON public.ip_blocklist USING btree (ip_address);

-- INDEX: idx_kb_articles_content_trgm
CREATE INDEX IF NOT EXISTS idx_kb_articles_content_trgm ON public.knowledge_base_articles USING gin (content public.gin_trgm_ops);

-- INDEX: idx_kb_articles_excerpt_trgm
CREATE INDEX IF NOT EXISTS idx_kb_articles_excerpt_trgm ON public.knowledge_base_articles USING gin (excerpt public.gin_trgm_ops);

-- INDEX: idx_kb_articles_title_trgm
CREATE INDEX IF NOT EXISTS idx_kb_articles_title_trgm ON public.knowledge_base_articles USING gin (title public.gin_trgm_ops);

-- INDEX: idx_kb_articles_ws_locale_status
CREATE INDEX IF NOT EXISTS idx_kb_articles_ws_locale_status ON public.knowledge_base_articles USING btree (workspace_id, locale, status);

-- INDEX: idx_kb_categories_ws_locale
CREATE INDEX IF NOT EXISTS idx_kb_categories_ws_locale ON public.knowledge_base_categories USING btree (workspace_id, locale);

-- INDEX: idx_kb_change_events_pending
CREATE INDEX IF NOT EXISTS idx_kb_change_events_pending ON public.knowledge_base_change_events USING btree (created_at) WHERE (processed_at IS NULL);

-- INDEX: idx_livekit_webhook_events_received_at
CREATE INDEX IF NOT EXISTS idx_livekit_webhook_events_received_at ON public.livekit_webhook_events USING btree (received_at DESC);

-- INDEX: idx_livekit_webhook_events_room
CREATE INDEX IF NOT EXISTS idx_livekit_webhook_events_room ON public.livekit_webhook_events USING btree (room_name) WHERE (room_name IS NOT NULL);

-- INDEX: idx_login_attempts_created
CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON public.login_attempts USING btree (created_at DESC);

-- INDEX: idx_login_attempts_ip_email
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_email ON public.login_attempts USING btree (ip_address, email);

-- INDEX: idx_operator_call_avail_lookup
CREATE INDEX IF NOT EXISTS idx_operator_call_avail_lookup ON public.operator_call_availability USING btree (workspace_id, status) WHERE (status <> 'unavailable'::text);

-- INDEX: idx_privacy_jobs_actor_requested
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_actor_requested ON public.privacy_jobs USING btree (actor_user_id, requested_at DESC);

-- INDEX: idx_privacy_jobs_expires_at
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_expires_at ON public.privacy_jobs USING btree (expires_at) WHERE (artifact_storage_key IS NOT NULL);

-- INDEX: idx_privacy_jobs_status_requested
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_status_requested ON public.privacy_jobs USING btree (status, requested_at);

-- INDEX: idx_privacy_jobs_subject
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_subject ON public.privacy_jobs USING btree (workspace_id, subject_type, subject_id);

-- INDEX: idx_privacy_jobs_workspace_status
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_workspace_status ON public.privacy_jobs USING btree (workspace_id, status);

-- INDEX: idx_realtime_provider_audit_created
CREATE INDEX IF NOT EXISTS idx_realtime_provider_audit_created ON public.realtime_provider_audit USING btree (created_at DESC);

-- INDEX: idx_security_events_created
CREATE INDEX IF NOT EXISTS idx_security_events_created ON public.security_events USING btree (created_at DESC);

-- INDEX: idx_security_events_ip
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON public.security_events USING btree (ip_address);

-- INDEX: idx_security_events_severity
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON public.security_events USING btree (severity);

-- INDEX: idx_security_events_type
CREATE INDEX IF NOT EXISTS idx_security_events_type ON public.security_events USING btree (event_type);

-- INDEX: idx_security_events_user
CREATE INDEX IF NOT EXISTS idx_security_events_user ON public.security_events USING btree (user_id);

-- INDEX: idx_storage_usage_created
CREATE INDEX IF NOT EXISTS idx_storage_usage_created ON public.storage_usage_logs USING btree (created_at DESC);

-- INDEX: idx_storage_usage_workspace
CREATE INDEX IF NOT EXISTS idx_storage_usage_workspace ON public.storage_usage_logs USING btree (workspace_id);

-- INDEX: idx_visitor_geo_cache_expires
CREATE INDEX IF NOT EXISTS idx_visitor_geo_cache_expires ON public.visitor_geo_cache USING btree (expires_at);

-- INDEX: idx_visitor_geo_cache_ip_hash
CREATE INDEX IF NOT EXISTS idx_visitor_geo_cache_ip_hash ON public.visitor_geo_cache USING btree (ip_hash);

-- INDEX: idx_visitor_page_views_session_time
CREATE INDEX IF NOT EXISTS idx_visitor_page_views_session_time ON public.visitor_page_views USING btree (visitor_session_id, viewed_at DESC);

-- INDEX: idx_visitor_sessions_contact
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_contact ON public.visitor_sessions USING btree (contact_id) WHERE (contact_id IS NOT NULL);

-- INDEX: idx_visitor_sessions_workspace_visitor
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_workspace_visitor ON public.visitor_sessions USING btree (workspace_id, visitor_id);

-- INDEX: idx_wad_lookup
CREATE INDEX IF NOT EXISTS idx_wad_lookup ON public.workspace_alert_dismissals USING btree (workspace_id, user_id);

-- INDEX: idx_wdm_workspace_cc_enabled
CREATE INDEX IF NOT EXISTS idx_wdm_workspace_cc_enabled ON public.workspace_department_members USING btree (workspace_id, call_center_enabled);

-- INDEX: idx_wdm_workspace_department
CREATE INDEX IF NOT EXISTS idx_wdm_workspace_department ON public.workspace_department_members USING btree (workspace_id, department_id);

-- INDEX: idx_wdm_workspace_user
CREATE INDEX IF NOT EXISTS idx_wdm_workspace_user ON public.workspace_department_members USING btree (workspace_id, user_id);

-- INDEX: idx_widget_templates_enabled
CREATE INDEX IF NOT EXISTS idx_widget_templates_enabled ON public.widget_templates USING btree (enabled);

-- INDEX: idx_widget_templates_sort
CREATE INDEX IF NOT EXISTS idx_widget_templates_sort ON public.widget_templates USING btree (sort_order, slug);

-- INDEX: idx_workspace_departments_cc_video
CREATE INDEX IF NOT EXISTS idx_workspace_departments_cc_video ON public.workspace_departments USING btree (workspace_id, enabled, cc_video_enabled);

-- INDEX: idx_workspace_departments_cc_voice
CREATE INDEX IF NOT EXISTS idx_workspace_departments_cc_voice ON public.workspace_departments USING btree (workspace_id, enabled, cc_voice_enabled);

-- INDEX: idx_workspace_limit_overrides_workspace
CREATE INDEX IF NOT EXISTS idx_workspace_limit_overrides_workspace ON public.workspace_limit_overrides USING btree (workspace_id);

-- INDEX: knowledge_base_articles_ai_idx
CREATE INDEX IF NOT EXISTS knowledge_base_articles_ai_idx ON public.knowledge_base_articles USING btree (workspace_id, used_by_ai) WHERE (used_by_ai = true);

-- INDEX: knowledge_base_articles_category_published_idx
CREATE INDEX IF NOT EXISTS knowledge_base_articles_category_published_idx ON public.knowledge_base_articles USING btree (category_id, workspace_id) WHERE (status = 'published'::public.article_status);

-- INDEX: knowledge_base_articles_widget_idx
CREATE INDEX IF NOT EXISTS knowledge_base_articles_widget_idx ON public.knowledge_base_articles USING btree (workspace_id, visible_in_widget) WHERE (visible_in_widget = true);

-- INDEX: knowledge_base_categories_id_workspace_key
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_categories_id_workspace_key ON public.knowledge_base_categories USING btree (id, workspace_id);

-- INDEX: knowledge_base_change_events_claim_idx
CREATE INDEX IF NOT EXISTS knowledge_base_change_events_claim_idx ON public.knowledge_base_change_events USING btree (claim_token) WHERE (claim_token IS NOT NULL);

-- INDEX: knowledge_base_change_events_pending_idx
CREATE INDEX IF NOT EXISTS knowledge_base_change_events_pending_idx ON public.knowledge_base_change_events USING btree (next_attempt_at, created_at) WHERE ((processed_at IS NULL) AND (dead_lettered_at IS NULL));

-- INDEX: pvc_created_idx
CREATE INDEX IF NOT EXISTS pvc_created_idx ON public.phone_verification_challenges USING btree (created_at);

-- INDEX: pvc_expires_idx
CREATE INDEX IF NOT EXISTS pvc_expires_idx ON public.phone_verification_challenges USING btree (expires_at);

-- INDEX: pvc_ip_idx
CREATE INDEX IF NOT EXISTS pvc_ip_idx ON public.phone_verification_challenges USING btree (created_ip_hash);

-- INDEX: pvc_one_active_per_user
CREATE UNIQUE INDEX IF NOT EXISTS pvc_one_active_per_user ON public.phone_verification_challenges USING btree (user_id) WHERE is_active;

-- INDEX: pvc_phone_idx
CREATE INDEX IF NOT EXISTS pvc_phone_idx ON public.phone_verification_challenges USING btree (phone_e164);

-- INDEX: pvc_purpose_idx
CREATE INDEX IF NOT EXISTS pvc_purpose_idx ON public.phone_verification_challenges USING btree (purpose);

-- INDEX: pvc_user_idx
CREATE INDEX IF NOT EXISTS pvc_user_idx ON public.phone_verification_challenges USING btree (user_id);

-- INDEX: sla_reliability_hourly_recent_idx
CREATE INDEX IF NOT EXISTS sla_reliability_hourly_recent_idx ON public.sla_reliability_hourly USING btree (bucket_hour DESC, scope_type);

-- INDEX: slo_breach_events_one_open_per_scope
CREATE UNIQUE INDEX IF NOT EXISTS slo_breach_events_one_open_per_scope ON public.slo_breach_events USING btree (slo_id, scope_type, scope_key) WHERE (state = 'open'::text);

-- INDEX: team_messages_attachment_id_idx
CREATE INDEX IF NOT EXISTS team_messages_attachment_id_idx ON public.team_messages USING btree (attachment_id) WHERE (attachment_id IS NOT NULL);

-- INDEX: team_messages_reply_to_idx
CREATE INDEX IF NOT EXISTS team_messages_reply_to_idx ON public.team_messages USING btree (reply_to_id) WHERE (reply_to_id IS NOT NULL);

-- INDEX: team_messages_ws_pair_idx
CREATE INDEX IF NOT EXISTS team_messages_ws_pair_idx ON public.team_messages USING btree (workspace_id, sender_id, recipient_id, created_at DESC);

-- INDEX: team_messages_ws_recipient_unread_idx
CREATE INDEX IF NOT EXISTS team_messages_ws_recipient_unread_idx ON public.team_messages USING btree (workspace_id, recipient_id) WHERE (read_at IS NULL);

-- INDEX: uniq_role_perm_scope
CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm_scope ON public.role_permissions USING btree (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), role_slug, permission_key);

-- INDEX: uq_ai_agent_intro_log_conv
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_intro_log_conv ON public.ai_agent_intro_log USING btree (workspace_id, conversation_id) WHERE (conversation_id IS NOT NULL);

-- INDEX: uq_ai_agent_intro_log_session
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_intro_log_session ON public.ai_agent_intro_log USING btree (workspace_id, visitor_session_id) WHERE ((visitor_session_id IS NOT NULL) AND (conversation_id IS NULL));

-- INDEX: uq_ai_topics_workspace_slug
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_topics_workspace_slug ON public.ai_agent_topics USING btree (workspace_id, slug);

-- INDEX: uq_livekit_webhook_events_event_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_webhook_events_event_id ON public.livekit_webhook_events USING btree (event_id);

-- INDEX: user_availability_prefs_user_idx
CREATE INDEX IF NOT EXISTS user_availability_prefs_user_idx ON public.user_availability_prefs USING btree (user_id);

-- INDEX: user_availability_prefs_user_ws_unique
CREATE UNIQUE INDEX IF NOT EXISTS user_availability_prefs_user_ws_unique ON public.user_availability_prefs USING btree (user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- INDEX: workspace_domains_normalized_idx
CREATE INDEX IF NOT EXISTS workspace_domains_normalized_idx ON public.workspace_domains USING btree (normalized_domain);

-- INDEX: workspace_domains_normalized_verified_idx
CREATE INDEX IF NOT EXISTS workspace_domains_normalized_verified_idx ON public.workspace_domains USING btree (normalized_domain) WHERE verified;

-- INDEX: workspace_domains_verified_domain_uniq
CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_verified_domain_uniq ON public.workspace_domains USING btree (normalized_domain) WHERE verified;

-- INDEX: workspace_domains_workspace_id_idx
CREATE INDEX IF NOT EXISTS workspace_domains_workspace_id_idx ON public.workspace_domains USING btree (workspace_id);

-- INDEX: workspace_health_snapshots_recent_idx
CREATE INDEX IF NOT EXISTS workspace_health_snapshots_recent_idx ON ONLY public.workspace_health_snapshots USING btree (workspace_id, captured_at DESC);

-- INDEX: workspace_health_snapshots_2026_09_workspace_id_captured_at_idx
CREATE INDEX IF NOT EXISTS workspace_health_snapshots_2026_09_workspace_id_captured_at_idx ON public.workspace_health_snapshots_2026_09 USING btree (workspace_id, captured_at DESC);

-- INDEX: workspace_health_snapshots_2026_10_workspace_id_captured_at_idx
CREATE INDEX IF NOT EXISTS workspace_health_snapshots_2026_10_workspace_id_captured_at_idx ON public.workspace_health_snapshots_2026_10 USING btree (workspace_id, captured_at DESC);

-- INDEX: workspace_health_snapshots_2026_11_workspace_id_captured_at_idx
CREATE INDEX IF NOT EXISTS workspace_health_snapshots_2026_11_workspace_id_captured_at_idx ON public.workspace_health_snapshots_2026_11 USING btree (workspace_id, captured_at DESC);

-- INDEX: workspace_health_snapshots_default_workspace_id_captured_at_idx
CREATE INDEX IF NOT EXISTS workspace_health_snapshots_default_workspace_id_captured_at_idx ON public.workspace_health_snapshots_default USING btree (workspace_id, captured_at DESC);

-- INDEX: workspace_health_snapshots_legacy_recent_idx
CREATE INDEX IF NOT EXISTS workspace_health_snapshots_legacy_recent_idx ON public.workspace_health_snapshots_legacy USING btree (workspace_id, captured_at DESC);

-- INDEX ATTACH: workspace_health_snapshots_2026_09_pkey
ALTER INDEX public.workspace_health_snapshots_pkey ATTACH PARTITION public.workspace_health_snapshots_2026_09_pkey;

-- INDEX ATTACH: workspace_health_snapshots_2026_09_workspace_id_captured_at_idx
ALTER INDEX public.workspace_health_snapshots_recent_idx ATTACH PARTITION public.workspace_health_snapshots_2026_09_workspace_id_captured_at_idx;

-- INDEX ATTACH: workspace_health_snapshots_2026_10_pkey
ALTER INDEX public.workspace_health_snapshots_pkey ATTACH PARTITION public.workspace_health_snapshots_2026_10_pkey;

-- INDEX ATTACH: workspace_health_snapshots_2026_10_workspace_id_captured_at_idx
ALTER INDEX public.workspace_health_snapshots_recent_idx ATTACH PARTITION public.workspace_health_snapshots_2026_10_workspace_id_captured_at_idx;

-- INDEX ATTACH: workspace_health_snapshots_2026_11_pkey
ALTER INDEX public.workspace_health_snapshots_pkey ATTACH PARTITION public.workspace_health_snapshots_2026_11_pkey;

-- INDEX ATTACH: workspace_health_snapshots_2026_11_workspace_id_captured_at_idx
ALTER INDEX public.workspace_health_snapshots_recent_idx ATTACH PARTITION public.workspace_health_snapshots_2026_11_workspace_id_captured_at_idx;

-- INDEX ATTACH: workspace_health_snapshots_default_pkey
ALTER INDEX public.workspace_health_snapshots_pkey ATTACH PARTITION public.workspace_health_snapshots_default_pkey;

-- INDEX ATTACH: workspace_health_snapshots_default_workspace_id_captured_at_idx
ALTER INDEX public.workspace_health_snapshots_recent_idx ATTACH PARTITION public.workspace_health_snapshots_default_workspace_id_captured_at_idx;

-- TRIGGER: alert_rules alert_rules_touch_t
CREATE OR REPLACE TRIGGER alert_rules_touch_t BEFORE UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.alert_rules_touch();

-- TRIGGER: alert_rules alert_rules_validate_fields_t
CREATE OR REPLACE TRIGGER alert_rules_validate_fields_t BEFORE INSERT OR UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.alert_rules_validate_fields();

-- TRIGGER: auto_action_definitions auto_action_definitions_touch
CREATE OR REPLACE TRIGGER auto_action_definitions_touch BEFORE UPDATE ON public.auto_action_definitions FOR EACH ROW EXECUTE FUNCTION public.touch_auto_action_definitions();

-- TRIGGER: backup_restore_drills backup_drills_no_credentials
CREATE OR REPLACE TRIGGER backup_drills_no_credentials BEFORE INSERT OR UPDATE ON public.backup_restore_drills FOR EACH ROW EXECUTE FUNCTION public.backup_reject_credentials();

-- TRIGGER: backup_runs backup_runs_no_credentials
CREATE OR REPLACE TRIGGER backup_runs_no_credentials BEFORE INSERT OR UPDATE ON public.backup_runs FOR EACH ROW EXECUTE FUNCTION public.backup_reject_credentials();

-- TRIGGER: backup_runs backup_runs_touch
CREATE OR REPLACE TRIGGER backup_runs_touch BEFORE UPDATE ON public.backup_runs FOR EACH ROW EXECUTE FUNCTION public.backup_touch_updated_at();

-- TRIGGER: email_logs check_email_log_status
CREATE OR REPLACE TRIGGER check_email_log_status BEFORE INSERT OR UPDATE ON public.email_logs FOR EACH ROW EXECUTE FUNCTION public.validate_email_log_status();

-- TRIGGER: enforcement_rules enforcement_rules_protect_builtin_t
CREATE OR REPLACE TRIGGER enforcement_rules_protect_builtin_t BEFORE UPDATE ON public.enforcement_rules FOR EACH ROW EXECUTE FUNCTION public.enforcement_rules_protect_builtin();

-- TRIGGER: enforcement_rules enforcement_rules_touch_t
CREATE OR REPLACE TRIGGER enforcement_rules_touch_t BEFORE UPDATE ON public.enforcement_rules FOR EACH ROW EXECUTE FUNCTION public.touch_enforcement_rules();

-- TRIGGER: knowledge_base_categories kb_categories_detach_articles
CREATE OR REPLACE TRIGGER kb_categories_detach_articles BEFORE DELETE ON public.knowledge_base_categories FOR EACH ROW EXECUTE FUNCTION public.kb_detach_articles_before_category_delete();

-- TRIGGER: platform_sms_provider_config platform_sms_provider_config_updated_at
CREATE OR REPLACE TRIGGER platform_sms_provider_config_updated_at BEFORE UPDATE ON public.platform_sms_provider_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: role_permissions role_permissions_set_updated_at
CREATE OR REPLACE TRIGGER role_permissions_set_updated_at BEFORE UPDATE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION public.set_role_permissions_updated_at();

-- TRIGGER: slo_definitions slo_definitions_protect_builtin_t
CREATE OR REPLACE TRIGGER slo_definitions_protect_builtin_t BEFORE UPDATE ON public.slo_definitions FOR EACH ROW EXECUTE FUNCTION public.slo_definitions_protect_builtin();

-- TRIGGER: slo_definitions slo_definitions_touch_t
CREATE OR REPLACE TRIGGER slo_definitions_touch_t BEFORE UPDATE ON public.slo_definitions FOR EACH ROW EXECUTE FUNCTION public.slo_definitions_touch();

-- TRIGGER: ai_agent_qna trg_ai_agent_qna_updated
CREATE OR REPLACE TRIGGER trg_ai_agent_qna_updated BEFORE UPDATE ON public.ai_agent_qna FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_sources trg_ai_agent_sources_updated
CREATE OR REPLACE TRIGGER trg_ai_agent_sources_updated BEFORE UPDATE ON public.ai_agent_sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_suggested_test_cases trg_ai_agent_suggested_tc_updated_at
CREATE OR REPLACE TRIGGER trg_ai_agent_suggested_tc_updated_at BEFORE UPDATE ON public.ai_agent_suggested_test_cases FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_suggestions trg_ai_agent_suggestions_updated
CREATE OR REPLACE TRIGGER trg_ai_agent_suggestions_updated BEFORE UPDATE ON public.ai_agent_suggestions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_test_cases trg_ai_agent_test_cases_updated_at
CREATE OR REPLACE TRIGGER trg_ai_agent_test_cases_updated_at BEFORE UPDATE ON public.ai_agent_test_cases FOR EACH ROW EXECUTE FUNCTION public.touch_ai_agent_test_cases_updated_at();

-- TRIGGER: ai_data_sources trg_ai_data_sources_updated_at
CREATE OR REPLACE TRIGGER trg_ai_data_sources_updated_at BEFORE UPDATE ON public.ai_data_sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_guidance_rules trg_ai_guidance_updated_at
CREATE OR REPLACE TRIGGER trg_ai_guidance_updated_at BEFORE UPDATE ON public.ai_agent_guidance_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_kb_generated_articles trg_ai_kb_generated_updated_at
CREATE OR REPLACE TRIGGER trg_ai_kb_generated_updated_at BEFORE UPDATE ON public.ai_kb_generated_articles FOR EACH ROW EXECUTE FUNCTION public.ai_kb_set_updated_at();

-- TRIGGER: ai_kb_jobs trg_ai_kb_jobs_updated_at
CREATE OR REPLACE TRIGGER trg_ai_kb_jobs_updated_at BEFORE UPDATE ON public.ai_kb_jobs FOR EACH ROW EXECUTE FUNCTION public.ai_kb_set_updated_at();

-- TRIGGER: ai_agent_learning_candidates trg_ai_learn_cand_updated
CREATE OR REPLACE TRIGGER trg_ai_learn_cand_updated BEFORE UPDATE ON public.ai_agent_learning_candidates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_message_triggers trg_ai_msg_triggers_updated_at
CREATE OR REPLACE TRIGGER trg_ai_msg_triggers_updated_at BEFORE UPDATE ON public.ai_agent_message_triggers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_regression_batches trg_ai_regression_batches_updated
CREATE OR REPLACE TRIGGER trg_ai_regression_batches_updated BEFORE UPDATE ON public.ai_agent_regression_batches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_e10();

-- TRIGGER: ai_agent_regression_schedules trg_ai_regression_schedules_updated
CREATE OR REPLACE TRIGGER trg_ai_regression_schedules_updated BEFORE UPDATE ON public.ai_agent_regression_schedules FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_e10();

-- TRIGGER: ai_agent_routing_rules trg_ai_routing_updated_at
CREATE OR REPLACE TRIGGER trg_ai_routing_updated_at BEFORE UPDATE ON public.ai_agent_routing_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_tool_servers trg_ai_tool_servers_updated_at
CREATE OR REPLACE TRIGGER trg_ai_tool_servers_updated_at BEFORE UPDATE ON public.ai_agent_tool_servers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_tools trg_ai_tools_updated_at
CREATE OR REPLACE TRIGGER trg_ai_tools_updated_at BEFORE UPDATE ON public.ai_agent_tools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_agent_topics trg_ai_topics_updated_at
CREATE OR REPLACE TRIGGER trg_ai_topics_updated_at BEFORE UPDATE ON public.ai_agent_topics FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: ai_usage_logs trg_ai_usage_logs_count_request
CREATE OR REPLACE TRIGGER trg_ai_usage_logs_count_request AFTER INSERT ON public.ai_usage_logs FOR EACH ROW EXECUTE FUNCTION public.tg_ai_usage_logs_count_request();

-- TRIGGER: ai_agent_workflows trg_ai_workflows_updated_at
CREATE OR REPLACE TRIGGER trg_ai_workflows_updated_at BEFORE UPDATE ON public.ai_agent_workflows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: call_invitations trg_call_invitations_updated_at
CREATE OR REPLACE TRIGGER trg_call_invitations_updated_at BEFORE UPDATE ON public.call_invitations FOR EACH ROW EXECUTE FUNCTION public.set_call_invitations_updated_at();

-- TRIGGER: call_center_settings trg_cc_settings_touch
CREATE OR REPLACE TRIGGER trg_cc_settings_touch BEFORE UPDATE ON public.call_center_settings FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- TRIGGER: call_center_agent_presence trg_ccap_touch
CREATE OR REPLACE TRIGGER trg_ccap_touch BEFORE UPDATE ON public.call_center_agent_presence FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- TRIGGER: call_center_departments trg_ccd_touch
CREATE OR REPLACE TRIGGER trg_ccd_touch BEFORE UPDATE ON public.call_center_departments FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- TRIGGER: call_center_department_agents trg_ccda_touch
CREATE OR REPLACE TRIGGER trg_ccda_touch BEFORE UPDATE ON public.call_center_department_agents FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- TRIGGER: conversation_attachments trg_conversation_attachments_touch_message
CREATE OR REPLACE TRIGGER trg_conversation_attachments_touch_message AFTER UPDATE OF message_id, status ON public.conversation_attachments FOR EACH ROW EXECUTE FUNCTION public.tg_conversation_attachments_touch_message();

-- TRIGGER: conversation_messages trg_conversation_messages_count_message
CREATE OR REPLACE TRIGGER trg_conversation_messages_count_message AFTER INSERT ON public.conversation_messages FOR EACH ROW EXECUTE FUNCTION public.tg_conversation_messages_count_message();

-- TRIGGER: conversation_notes trg_conversation_notes_updated_at
CREATE OR REPLACE TRIGGER trg_conversation_notes_updated_at BEFORE UPDATE ON public.conversation_notes FOR EACH ROW EXECUTE FUNCTION public.set_conversation_notes_updated_at();

-- TRIGGER: conversations trg_conversations_count_conversation
CREATE OR REPLACE TRIGGER trg_conversations_count_conversation AFTER INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.tg_conversations_count_conversation();

-- TRIGGER: kb_article_feedback trg_kb_article_feedback_touch
CREATE OR REPLACE TRIGGER trg_kb_article_feedback_touch BEFORE UPDATE ON public.kb_article_feedback FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_generic();

-- TRIGGER: knowledge_base_articles trg_kb_articles_change_event
CREATE OR REPLACE TRIGGER trg_kb_articles_change_event AFTER INSERT OR DELETE OR UPDATE ON public.knowledge_base_articles FOR EACH ROW EXECUTE FUNCTION public.knowledge_base_emit_change_event();

-- TRIGGER: operator_call_availability trg_operator_call_avail_updated_at
CREATE OR REPLACE TRIGGER trg_operator_call_avail_updated_at BEFORE UPDATE ON public.operator_call_availability FOR EACH ROW EXECUTE FUNCTION public.set_operator_call_avail_updated_at();

-- TRIGGER: platform_call_center_settings trg_pcc_touch
CREATE OR REPLACE TRIGGER trg_pcc_touch BEFORE UPDATE ON public.platform_call_center_settings FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- TRIGGER: storage_usage_logs trg_storage_usage_logs_apply
CREATE OR REPLACE TRIGGER trg_storage_usage_logs_apply AFTER INSERT ON public.storage_usage_logs FOR EACH ROW EXECUTE FUNCTION public.apply_storage_usage_log();

-- TRIGGER: ai_source_pages trg_touch_ai_source_pages
CREATE OR REPLACE TRIGGER trg_touch_ai_source_pages BEFORE UPDATE ON public.ai_source_pages FOR EACH ROW EXECUTE FUNCTION public.touch_ai_source_sync_jobs();

-- TRIGGER: ai_source_sync_jobs trg_touch_ai_source_sync_jobs
CREATE OR REPLACE TRIGGER trg_touch_ai_source_sync_jobs BEFORE UPDATE ON public.ai_source_sync_jobs FOR EACH ROW EXECUTE FUNCTION public.touch_ai_source_sync_jobs();

-- TRIGGER: user_notification_prefs trg_touch_user_notification_prefs
CREATE OR REPLACE TRIGGER trg_touch_user_notification_prefs BEFORE UPDATE ON public.user_notification_prefs FOR EACH ROW EXECUTE FUNCTION public.touch_user_notification_prefs();

-- TRIGGER: visitor_sessions trg_visitor_sessions_count_visitor
CREATE OR REPLACE TRIGGER trg_visitor_sessions_count_visitor AFTER INSERT ON public.visitor_sessions FOR EACH ROW EXECUTE FUNCTION public.tg_visitor_sessions_count_visitor();

-- TRIGGER: widget_platform_settings trg_widget_platform_settings_validate_phase1
CREATE OR REPLACE TRIGGER trg_widget_platform_settings_validate_phase1 BEFORE INSERT OR UPDATE ON public.widget_platform_settings FOR EACH ROW EXECUTE FUNCTION public.widget_platform_settings_validate_phase1();

-- TRIGGER: widget_templates trg_widget_templates_updated_at
CREATE OR REPLACE TRIGGER trg_widget_templates_updated_at BEFORE UPDATE ON public.widget_templates FOR EACH ROW EXECUTE FUNCTION public.set_widget_templates_updated_at();

-- TRIGGER: workspace_domains trg_workspace_domains_normalize
CREATE OR REPLACE TRIGGER trg_workspace_domains_normalize BEFORE INSERT OR UPDATE OF domain ON public.workspace_domains FOR EACH ROW EXECUTE FUNCTION public.workspace_domains_normalize();

-- TRIGGER: workspace_provider_settings trg_workspace_provider_settings_updated_at
CREATE OR REPLACE TRIGGER trg_workspace_provider_settings_updated_at BEFORE UPDATE ON public.workspace_provider_settings FOR EACH ROW EXECUTE FUNCTION public.update_workspace_provider_settings_updated_at();

-- TRIGGER: workspaces trg_workspaces_auto_register_owner_domain
CREATE OR REPLACE TRIGGER trg_workspaces_auto_register_owner_domain AFTER INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.workspaces_auto_register_owner_domain();

-- TRIGGER: ai_knowledge_chunks update_ai_knowledge_chunks_updated_at
CREATE OR REPLACE TRIGGER update_ai_knowledge_chunks_updated_at BEFORE UPDATE ON public.ai_knowledge_chunks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: billing_payment_intents update_billing_payment_intents_updated_at
CREATE OR REPLACE TRIGGER update_billing_payment_intents_updated_at BEFORE UPDATE ON public.billing_payment_intents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- TRIGGER: user_availability_prefs user_availability_prefs_updated_at
CREATE OR REPLACE TRIGGER user_availability_prefs_updated_at BEFORE UPDATE ON public.user_availability_prefs FOR EACH ROW EXECUTE FUNCTION public.user_availability_prefs_set_updated_at();

-- TRIGGER: widget_settings validate_widget_template_slug_trg
CREATE OR REPLACE TRIGGER validate_widget_template_slug_trg BEFORE INSERT OR UPDATE OF template_slug ON public.widget_settings FOR EACH ROW EXECUTE FUNCTION public.validate_widget_template_slug();

-- TRIGGER: widget_settings widget_settings_validate_offline_mode
CREATE OR REPLACE TRIGGER widget_settings_validate_offline_mode BEFORE INSERT OR UPDATE OF offline_mode ON public.widget_settings FOR EACH ROW EXECUTE FUNCTION public.widget_settings_validate_offline_mode();

-- FK CONSTRAINT: ai_agent_debug_events ai_agent_debug_events_run_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_debug_events
    ADD CONSTRAINT ai_agent_debug_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.ai_agent_runs(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_debug_events ai_agent_debug_events_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_debug_events
    ADD CONSTRAINT ai_agent_debug_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_guidance_rules ai_agent_guidance_rules_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_guidance_rules
    ADD CONSTRAINT ai_agent_guidance_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_intro_log ai_agent_intro_log_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_intro_log
    ADD CONSTRAINT ai_agent_intro_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_message_triggers ai_agent_message_triggers_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_message_triggers
    ADD CONSTRAINT ai_agent_message_triggers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_qna ai_agent_qna_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_qna
    ADD CONSTRAINT ai_agent_qna_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_regression_batches ai_agent_regression_batches_schedule_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_regression_batches
    ADD CONSTRAINT ai_agent_regression_batches_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.ai_agent_regression_schedules(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_regression_batches ai_agent_regression_batches_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_regression_batches
    ADD CONSTRAINT ai_agent_regression_batches_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_regression_schedules ai_agent_regression_schedules_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_regression_schedules
    ADD CONSTRAINT ai_agent_regression_schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_routing_rules ai_agent_routing_rules_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_routing_rules
    ADD CONSTRAINT ai_agent_routing_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_runs ai_agent_runs_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_runs
    ADD CONSTRAINT ai_agent_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_sources ai_agent_sources_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_sources
    ADD CONSTRAINT ai_agent_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_suggestions ai_agent_suggestions_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_suggestions
    ADD CONSTRAINT ai_agent_suggestions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_test_cases ai_agent_test_cases_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_test_cases
    ADD CONSTRAINT ai_agent_test_cases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_test_runs ai_agent_test_runs_regression_batch_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_test_runs
    ADD CONSTRAINT ai_agent_test_runs_regression_batch_id_fkey FOREIGN KEY (regression_batch_id) REFERENCES public.ai_agent_regression_batches(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_test_runs ai_agent_test_runs_test_case_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_test_runs
    ADD CONSTRAINT ai_agent_test_runs_test_case_id_fkey FOREIGN KEY (test_case_id) REFERENCES public.ai_agent_test_cases(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_test_runs ai_agent_test_runs_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_test_runs
    ADD CONSTRAINT ai_agent_test_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_tool_servers ai_agent_tool_servers_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_tool_servers
    ADD CONSTRAINT ai_agent_tool_servers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_tools ai_agent_tools_server_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.ai_agent_tool_servers(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_tools ai_agent_tools_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_topics ai_agent_topics_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_topics
    ADD CONSTRAINT ai_agent_topics_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_agent_workflows ai_agent_workflows_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_agent_workflows
    ADD CONSTRAINT ai_agent_workflows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_data_sources ai_data_sources_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_data_sources
    ADD CONSTRAINT ai_data_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_generated_articles ai_kb_generated_articles_job_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_generated_articles
    ADD CONSTRAINT ai_kb_generated_articles_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_kb_jobs(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_generated_articles ai_kb_generated_articles_kb_article_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_generated_articles
    ADD CONSTRAINT ai_kb_generated_articles_kb_article_id_fkey FOREIGN KEY (kb_article_id) REFERENCES public.knowledge_base_articles(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_generated_articles ai_kb_generated_articles_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_generated_articles
    ADD CONSTRAINT ai_kb_generated_articles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_job_events ai_kb_job_events_job_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_events
    ADD CONSTRAINT ai_kb_job_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_kb_jobs(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_job_events ai_kb_job_events_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_events
    ADD CONSTRAINT ai_kb_job_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_job_pages ai_kb_job_pages_job_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_pages
    ADD CONSTRAINT ai_kb_job_pages_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_kb_jobs(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_job_pages ai_kb_job_pages_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_job_pages
    ADD CONSTRAINT ai_kb_job_pages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_jobs ai_kb_jobs_source_workspace_domain_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_jobs
    ADD CONSTRAINT ai_kb_jobs_source_workspace_domain_id_fkey FOREIGN KEY (source_workspace_domain_id) REFERENCES public.workspace_domains(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_jobs ai_kb_jobs_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_jobs
    ADD CONSTRAINT ai_kb_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_usage ai_kb_usage_generated_article_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_usage
    ADD CONSTRAINT ai_kb_usage_generated_article_id_fkey FOREIGN KEY (generated_article_id) REFERENCES public.ai_kb_generated_articles(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_usage ai_kb_usage_job_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_usage
    ADD CONSTRAINT ai_kb_usage_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_kb_jobs(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_kb_usage ai_kb_usage_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_kb_usage
    ADD CONSTRAINT ai_kb_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_operator_assist_feedback ai_operator_assist_feedback_assist_run_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_operator_assist_feedback
    ADD CONSTRAINT ai_operator_assist_feedback_assist_run_id_fkey FOREIGN KEY (assist_run_id) REFERENCES public.ai_operator_assist_runs(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_source_sync_logs ai_source_sync_logs_source_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_source_sync_logs
    ADD CONSTRAINT ai_source_sync_logs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.ai_data_sources(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: ai_source_sync_logs ai_source_sync_logs_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.ai_source_sync_logs
    ADD CONSTRAINT ai_source_sync_logs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: alert_events alert_events_rule_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.alert_events
    ADD CONSTRAINT alert_events_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.alert_rules(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: auto_action_events auto_action_events_definition_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.auto_action_events
    ADD CONSTRAINT auto_action_events_definition_id_fkey FOREIGN KEY (definition_id) REFERENCES public.auto_action_definitions(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_center_agent_presence call_center_agent_presence_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_agent_presence
    ADD CONSTRAINT call_center_agent_presence_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_center_department_agents call_center_department_agents_department_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_department_agents
    ADD CONSTRAINT call_center_department_agents_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.call_center_departments(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_center_department_agents call_center_department_agents_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_department_agents
    ADD CONSTRAINT call_center_department_agents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_center_departments call_center_departments_fallback_fk
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_departments
    ADD CONSTRAINT call_center_departments_fallback_fk FOREIGN KEY (fallback_department_id) REFERENCES public.call_center_departments(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_center_departments call_center_departments_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_center_departments
    ADD CONSTRAINT call_center_departments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_events call_events_call_session_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_events
    ADD CONSTRAINT call_events_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_invitations call_invitations_call_session_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_invitations
    ADD CONSTRAINT call_invitations_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_invitations call_invitations_contact_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_invitations
    ADD CONSTRAINT call_invitations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_invitations call_invitations_conversation_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_invitations
    ADD CONSTRAINT call_invitations_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_invitations call_invitations_system_message_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_invitations
    ADD CONSTRAINT call_invitations_system_message_id_fkey FOREIGN KEY (system_message_id) REFERENCES public.conversation_messages(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_invitations call_invitations_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_invitations
    ADD CONSTRAINT call_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_participants call_participants_call_session_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_participants
    ADD CONSTRAINT call_participants_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_recordings call_recordings_call_session_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_recordings
    ADD CONSTRAINT call_recordings_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: call_recordings call_recordings_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.call_recordings
    ADD CONSTRAINT call_recordings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: canned_responses canned_responses_created_by_profiles_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.canned_responses
    ADD CONSTRAINT canned_responses_created_by_profiles_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: commerce_deleted_entities commerce_deleted_entities_connection_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.commerce_deleted_entities
    ADD CONSTRAINT commerce_deleted_entities_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.commerce_connections(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: contact_verifications contact_verifications_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.contact_verifications
    ADD CONSTRAINT contact_verifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: conversation_attachments conversation_attachments_conversation_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.conversation_attachments
    ADD CONSTRAINT conversation_attachments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: conversation_attachments conversation_attachments_message_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.conversation_attachments
    ADD CONSTRAINT conversation_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.conversation_messages(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: conversation_attachments conversation_attachments_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.conversation_attachments
    ADD CONSTRAINT conversation_attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: email_logs email_logs_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: email_settings_localized email_settings_localized_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_settings_localized
    ADD CONSTRAINT email_settings_localized_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: email_settings email_settings_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.email_settings
    ADD CONSTRAINT email_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: enforcement_actions enforcement_actions_auto_action_event_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.enforcement_actions
    ADD CONSTRAINT enforcement_actions_auto_action_event_id_fkey FOREIGN KEY (auto_action_event_id) REFERENCES public.auto_action_events(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: enforcement_actions enforcement_actions_rule_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.enforcement_actions
    ADD CONSTRAINT enforcement_actions_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.enforcement_rules(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: identity_merges identity_merges_contact_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.identity_merges
    ADD CONSTRAINT identity_merges_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: identity_merges identity_merges_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.identity_merges
    ADD CONSTRAINT identity_merges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: knowledge_base_articles knowledge_base_articles_category_workspace_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.knowledge_base_articles
    ADD CONSTRAINT knowledge_base_articles_category_workspace_fkey FOREIGN KEY (category_id, workspace_id) REFERENCES public.knowledge_base_categories(id, workspace_id)$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: operator_call_availability operator_call_availability_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.operator_call_availability
    ADD CONSTRAINT operator_call_availability_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: phone_verification_challenges phone_verification_challenges_user_id_profiles_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.phone_verification_challenges
    ADD CONSTRAINT phone_verification_challenges_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: role_permissions role_permissions_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: slo_breach_events slo_breach_events_slo_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.slo_breach_events
    ADD CONSTRAINT slo_breach_events_slo_id_fkey FOREIGN KEY (slo_id) REFERENCES public.slo_definitions(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: team_messages team_messages_attachment_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.conversation_attachments(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: team_messages team_messages_reply_to_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.team_messages(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: user_availability_prefs user_availability_prefs_user_id_profiles_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_availability_prefs
    ADD CONSTRAINT user_availability_prefs_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: user_availability_prefs user_availability_prefs_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_availability_prefs
    ADD CONSTRAINT user_availability_prefs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: user_continuity_tokens user_continuity_tokens_contact_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_continuity_tokens
    ADD CONSTRAINT user_continuity_tokens_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: user_continuity_tokens user_continuity_tokens_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_continuity_tokens
    ADD CONSTRAINT user_continuity_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: user_notification_prefs user_notification_prefs_user_id_profiles_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_notification_prefs
    ADD CONSTRAINT user_notification_prefs_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: user_phone_verifications user_phone_verifications_user_id_profiles_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.user_phone_verifications
    ADD CONSTRAINT user_phone_verifications_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: visitor_sessions visitor_sessions_contact_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.visitor_sessions
    ADD CONSTRAINT visitor_sessions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_branding_localized workspace_branding_localized_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_branding_localized
    ADD CONSTRAINT workspace_branding_localized_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_channel_overrides workspace_channel_overrides_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_channel_overrides
    ADD CONSTRAINT workspace_channel_overrides_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_departments workspace_departments_cc_fallback_department_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_departments
    ADD CONSTRAINT workspace_departments_cc_fallback_department_id_fkey FOREIGN KEY (cc_fallback_department_id) REFERENCES public.workspace_departments(id) ON DELETE SET NULL$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_domains_extended workspace_domains_extended_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_domains_extended
    ADD CONSTRAINT workspace_domains_extended_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_limit_overrides workspace_limit_overrides_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_limit_overrides
    ADD CONSTRAINT workspace_limit_overrides_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_module_overrides workspace_module_overrides_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_module_overrides
    ADD CONSTRAINT workspace_module_overrides_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_provider_settings workspace_provider_settings_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_provider_settings
    ADD CONSTRAINT workspace_provider_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- FK CONSTRAINT: workspace_settings workspace_settings_workspace_id_fkey
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $parity$;

-- POLICY: ip_blocklist Admins can manage IP blocklist
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage IP blocklist" ON public.ip_blocklist TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: account_members Admins can manage account members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage account members" ON public.account_members TO authenticated USING ((public.get_account_role(account_id, auth.uid()) = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK ((public.get_account_role(account_id, auth.uid()) = ANY (ARRAY['owner'::text, 'admin'::text])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_roles Admins can manage all roles
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage all roles" ON public.user_roles TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_settings_localized Admins can manage email settings localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage email settings localized" ON public.email_settings_localized TO authenticated USING ((((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)) OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))) WITH CHECK ((((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)) OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_templates Admins can manage email templates
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage email templates" ON public.email_templates TO authenticated USING ((((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)) OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))) WITH CHECK ((((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)) OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_branding Admins can manage platform branding
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage platform branding" ON public.platform_branding TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_branding_localized Admins can manage platform branding localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage platform branding localized" ON public.platform_branding_localized TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_domains Admins can manage platform domains
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage platform domains" ON public.platform_domains TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_settings Admins can manage platform email settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage platform email settings" ON public.email_settings TO authenticated USING ((((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)) OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))) WITH CHECK ((((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)) OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_settings Admins can manage platform settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage platform settings" ON public.platform_settings TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_platform_settings Admins can manage widget platform settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage widget platform settings" ON public.widget_platform_settings TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_templates Admins can manage widget templates
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage widget templates" ON public.widget_templates TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_settings Admins can manage workspace settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can manage workspace settings" ON public.workspace_settings TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: alert_events Admins can read alert events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can read alert events" ON public.alert_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: alert_rules Admins can read alert rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can read alert rules" ON public.alert_rules FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: realtime_failover_state Admins can read failover state
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can read failover state" ON public.realtime_failover_state FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: geo_ip_cache Admins can read geo_ip_cache
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can read geo_ip_cache" ON public.geo_ip_cache FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: provider_configs Admins can read provider configs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can read provider configs" ON public.provider_configs FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: app_runtime_config Admins can read runtime config
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can read runtime config" ON public.app_runtime_config FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: alert_rules Admins can update alert rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can update alert rules" ON public.alert_rules FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: security_events Admins can update security events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can update security events" ON public.security_events FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: billing_events Admins can view billing events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can view billing events" ON public.billing_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: feature_flags Admins can view platform feature flags
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can view platform feature flags" ON public.feature_flags FOR SELECT TO authenticated USING (((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: security_events Admins can view security events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins can view security events" ON public.security_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: business_metrics_hourly Admins read business_metrics_hourly
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read business_metrics_hourly" ON public.business_metrics_hourly FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: enforcement_actions Admins read enforcement_actions
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read enforcement_actions" ON public.enforcement_actions FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: enforcement_normalizations Admins read enforcement_normalizations
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read enforcement_normalizations" ON public.enforcement_normalizations FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: enforcement_rules Admins read enforcement_rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read enforcement_rules" ON public.enforcement_rules FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: sla_reliability_hourly Admins read sla_reliability_hourly
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read sla_reliability_hourly" ON public.sla_reliability_hourly FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: slo_breach_events Admins read slo_breach_events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read slo_breach_events" ON public.slo_breach_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: slo_definitions Admins read slo_definitions
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read slo_definitions" ON public.slo_definitions FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_health_snapshots Admins read workspace_health_snapshots
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read workspace_health_snapshots" ON public.workspace_health_snapshots FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_health_snapshots_legacy Admins read workspace_health_snapshots
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins read workspace_health_snapshots" ON public.workspace_health_snapshots_legacy FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: business_metrics_hourly Admins write business_metrics_hourly
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write business_metrics_hourly" ON public.business_metrics_hourly TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: enforcement_actions Admins write enforcement_actions
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write enforcement_actions" ON public.enforcement_actions TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: enforcement_rules Admins write enforcement_rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write enforcement_rules" ON public.enforcement_rules TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: sla_reliability_hourly Admins write sla_reliability_hourly
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write sla_reliability_hourly" ON public.sla_reliability_hourly TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: slo_breach_events Admins write slo_breach_events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write slo_breach_events" ON public.slo_breach_events TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: slo_definitions Admins write slo_definitions
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write slo_definitions" ON public.slo_definitions TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_health_snapshots Admins write workspace_health_snapshots
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write workspace_health_snapshots" ON public.workspace_health_snapshots TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_health_snapshots_legacy Admins write workspace_health_snapshots
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins write workspace_health_snapshots" ON public.workspace_health_snapshots_legacy TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversations Admins+ can delete conversations
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can delete conversations" ON public.conversations FOR DELETE TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_messages Admins+ can delete messages
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can delete messages" ON public.conversation_messages FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.conversations c
  WHERE ((c.id = conversation_messages.conversation_id) AND (public.get_workspace_role(c.workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_source_sync_logs Admins+ can insert sync logs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can insert sync logs" ON public.ai_source_sync_logs FOR INSERT TO authenticated WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_data_sources Admins+ can manage data sources
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage data sources" ON public.ai_data_sources TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_guidance_rules Admins+ can manage guidance rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage guidance rules" ON public.ai_agent_guidance_rules TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_message_triggers Admins+ can manage message triggers
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage message triggers" ON public.ai_agent_message_triggers TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_routing_rules Admins+ can manage routing rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage routing rules" ON public.ai_agent_routing_rules TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_tool_servers Admins+ can manage tool servers
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage tool servers" ON public.ai_agent_tool_servers TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_tools Admins+ can manage tools
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage tools" ON public.ai_agent_tools TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_topics Admins+ can manage topics
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage topics" ON public.ai_agent_topics TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_workflows Admins+ can manage workflows
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage workflows" ON public.ai_agent_workflows TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_settings Admins+ can manage workspace settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage workspace settings" ON public.workspace_settings TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_branding_localized Admins+ can manage ws branding localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can manage ws branding localized" ON public.workspace_branding_localized TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_members Admins+ can update members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can update members" ON public.workspace_members FOR UPDATE TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_usage_logs Admins+ can view AI usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can view AI usage" ON public.ai_usage_logs FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_kb_usage Admins+ can view ai_kb_usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can view ai_kb_usage" ON public.ai_kb_usage FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_logs Admins+ can view email logs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can view email logs" ON public.email_logs FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: storage_usage_logs Admins+ can view storage usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ can view storage usage" ON public.storage_usage_logs FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains Admins+ manage ws domains (phone gated)
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ manage ws domains (phone gated)" ON public.workspace_domains TO authenticated USING (((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])) AND public.workspace_owner_phone_verified(workspace_id))) WITH CHECK (((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])) AND public.workspace_owner_phone_verified(workspace_id)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains_extended Admins+ manage ws domains extended (phone gated)
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Admins+ manage ws domains extended (phone gated)" ON public.workspace_domains_extended TO authenticated USING (((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])) AND public.workspace_owner_phone_verified(workspace_id))) WITH CHECK (((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])) AND public.workspace_owner_phone_verified(workspace_id)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_presence Anon can insert own presence
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can insert own presence" ON public.visitor_presence FOR INSERT TO anon WITH CHECK (((visitor_session_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.visitor_sessions vs
  WHERE ((vs.id = visitor_presence.visitor_session_id) AND (vs.workspace_id = visitor_presence.workspace_id) AND (vs.visitor_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-id'::text)))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_presence Anon can read own presence
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can read own presence" ON public.visitor_presence FOR SELECT TO anon USING ((EXISTS ( SELECT 1
   FROM public.visitor_sessions vs
  WHERE ((vs.id = visitor_presence.visitor_session_id) AND (vs.visitor_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-id'::text))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_branding Anon can read platform branding
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can read platform branding" ON public.platform_branding FOR SELECT TO anon USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_branding_localized Anon can read platform branding localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can read platform branding localized" ON public.platform_branding_localized FOR SELECT TO anon USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_domains Anon can read platform domains
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can read platform domains" ON public.platform_domains FOR SELECT TO anon USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_settings Anon can read platform settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can read platform settings" ON public.platform_settings FOR SELECT TO anon USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_presence Anon can update own presence
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can update own presence" ON public.visitor_presence FOR UPDATE TO anon USING ((EXISTS ( SELECT 1
   FROM public.visitor_sessions vs
  WHERE ((vs.id = visitor_presence.visitor_session_id) AND (vs.visitor_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-id'::text))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_sessions Anon can update own visitor sessions
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Anon can update own visitor sessions" ON public.visitor_sessions FOR UPDATE TO anon USING ((visitor_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-id'::text))) WITH CHECK ((visitor_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-id'::text)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_settings Authenticated can read email settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read email settings" ON public.email_settings FOR SELECT TO authenticated USING ((((workspace_id IS NOT NULL) AND public.is_workspace_member(workspace_id, auth.uid())) OR ((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_settings_localized Authenticated can read email settings localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read email settings localized" ON public.email_settings_localized FOR SELECT TO authenticated USING ((((workspace_id IS NOT NULL) AND public.is_workspace_member(workspace_id, auth.uid())) OR ((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_branding Authenticated can read platform branding
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read platform branding" ON public.platform_branding FOR SELECT TO authenticated USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_branding_localized Authenticated can read platform branding localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read platform branding localized" ON public.platform_branding_localized FOR SELECT TO authenticated USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_domains Authenticated can read platform domains
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read platform domains" ON public.platform_domains FOR SELECT TO authenticated USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_settings Authenticated can read platform settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read platform settings" ON public.platform_settings FOR SELECT TO authenticated USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_templates Authenticated can read platform templates
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read platform templates" ON public.email_templates FOR SELECT TO authenticated USING ((workspace_id IS NULL))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_templates Authenticated can read widget templates
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authenticated can read widget templates" ON public.widget_templates FOR SELECT TO authenticated USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_notes Authors can update own notes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authors can update own notes" ON public.conversation_notes FOR UPDATE TO authenticated USING (((author_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid())))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_notes Authors or admins can delete notes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Authors or admins can delete notes" ON public.conversation_notes FOR DELETE TO authenticated USING ((((author_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid())) OR (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_usage_counters Global admins can manage all usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can manage all usage" ON public.workspace_usage_counters TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_channel_overrides Global admins can manage channel overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can manage channel overrides" ON public.workspace_channel_overrides TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_limit_overrides Global admins can manage limit overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can manage limit overrides" ON public.workspace_limit_overrides TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_module_overrides Global admins can manage module overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can manage module overrides" ON public.workspace_module_overrides TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: plan_change_log Global admins can manage plan changes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can manage plan changes" ON public.plan_change_log TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_usage_logs Global admins can view all AI usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all AI usage" ON public.ai_usage_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: account_members Global admins can view all account members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all account members" ON public.account_members FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: accounts Global admins can view all accounts
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all accounts" ON public.accounts FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: audit_logs Global admins can view all audit logs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all audit logs" ON public.audit_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: email_logs Global admins can view all email logs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all email logs" ON public.email_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: billing_payments Global admins can view all payments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all payments" ON public.billing_payments FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: storage_usage_logs Global admins can view all storage usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all storage usage" ON public.storage_usage_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains_extended Global admins can view all workspace domains extended
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all workspace domains extended" ON public.workspace_domains_extended FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_settings Global admins can view all workspace settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins can view all workspace settings" ON public.workspace_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: privacy_jobs Global admins view all privacy jobs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Global admins view all privacy jobs" ON public.privacy_jobs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_notes Members can insert notes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can insert notes" ON public.conversation_notes FOR INSERT TO authenticated WITH CHECK ((public.is_workspace_member(workspace_id, auth.uid()) AND (author_id = auth.uid())))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: knowledge_base_articles Members can read KB articles
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can read KB articles" ON public.knowledge_base_articles FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: knowledge_base_categories Members can read KB categories
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can read KB categories" ON public.knowledge_base_categories FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_settings Members can read workspace settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can read workspace settings" ON public.workspace_settings FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_branding_localized Members can read ws branding localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can read ws branding localized" ON public.workspace_branding_localized FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: account_members Members can view account members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view account members" ON public.account_members FOR SELECT TO authenticated USING (public.is_account_member(account_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_kb_generated_articles Members can view ai_kb_generated
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view ai_kb_generated" ON public.ai_kb_generated_articles FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_kb_job_events Members can view ai_kb_job_events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view ai_kb_job_events" ON public.ai_kb_job_events FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_kb_job_pages Members can view ai_kb_job_pages
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view ai_kb_job_pages" ON public.ai_kb_job_pages FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_kb_jobs Members can view ai_kb_jobs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view ai_kb_jobs" ON public.ai_kb_jobs FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_events Members can view conv events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view conv events" ON public.conversation_events FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_data_sources Members can view data sources
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view data sources" ON public.ai_data_sources FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_guidance_rules Members can view guidance rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view guidance rules" ON public.ai_agent_guidance_rules FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_message_triggers Members can view message triggers
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view message triggers" ON public.ai_agent_message_triggers FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_notes Members can view notes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view notes" ON public.conversation_notes FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_page_views Members can view page views
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view page views" ON public.visitor_page_views FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_routing_rules Members can view routing rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view routing rules" ON public.ai_agent_routing_rules FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_source_sync_logs Members can view sync logs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view sync logs" ON public.ai_source_sync_logs FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: accounts Members can view their accounts
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view their accounts" ON public.accounts FOR SELECT TO authenticated USING (public.is_account_member(id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_tool_servers Members can view tool servers
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view tool servers" ON public.ai_agent_tool_servers FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_tools Members can view tools
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view tools" ON public.ai_agent_tools FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_topics Members can view topics
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view topics" ON public.ai_agent_topics FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_workflows Members can view workflows
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view workflows" ON public.ai_agent_workflows FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains_extended Members can view workspace domains extended
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view workspace domains extended" ON public.workspace_domains_extended FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: feature_flags Members can view workspace feature flags
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view workspace feature flags" ON public.feature_flags FOR SELECT TO authenticated USING (((workspace_id IS NOT NULL) AND public.is_workspace_member(workspace_id, auth.uid())))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_settings Members can view workspace settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Members can view workspace settings" ON public.workspace_settings FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: livekit_webhook_events No PostgREST access
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "No PostgREST access" ON public.livekit_webhook_events TO authenticated USING (false) WITH CHECK (false)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_geo_cache No direct access to geo cache
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "No direct access to geo cache" ON public.visitor_geo_cache TO anon, authenticated USING (false) WITH CHECK (false)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: login_attempts No direct access to login attempts
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "No direct access to login attempts" ON public.login_attempts TO anon, authenticated USING (false) WITH CHECK (false)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_roles Non-admins cannot insert roles
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Non-admins cannot insert roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains Only admins can delete domains
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Only admins can delete domains" ON public.workspace_domains FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains Only admins can insert domains
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Only admins can insert domains" ON public.workspace_domains FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_domains Only admins can update domains
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Only admins can update domains" ON public.workspace_domains FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: accounts Owner can update account
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Owner can update account" ON public.accounts FOR UPDATE TO authenticated USING ((public.get_account_role(id, auth.uid()) = ANY (ARRAY['owner'::text, 'admin'::text])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_provider_settings Platform admins can view all provider settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Platform admins can view all provider settings" ON public.workspace_provider_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: role_permissions Platform admins manage defaults
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Platform admins manage defaults" ON public.role_permissions TO authenticated USING (((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))) WITH CHECK (((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_branding Public can read active workspace branding
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Public can read active workspace branding" ON public.workspace_branding FOR SELECT TO anon USING ((EXISTS ( SELECT 1
   FROM public.widget_settings ws
  WHERE ((ws.workspace_id = workspace_branding.workspace_id) AND (ws.enabled = true)))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_branding_localized Public can read active workspace branding localized
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Public can read active workspace branding localized" ON public.workspace_branding_localized FOR SELECT TO anon USING ((EXISTS ( SELECT 1
   FROM public.widget_settings ws
  WHERE ((ws.workspace_id = workspace_branding_localized.workspace_id) AND (ws.enabled = true)))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: knowledge_base_categories Public can read non-empty KB categories
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Public can read non-empty KB categories" ON public.knowledge_base_categories FOR SELECT TO anon USING ((EXISTS ( SELECT 1
   FROM public.knowledge_base_articles a
  WHERE ((a.category_id = knowledge_base_categories.id) AND (a.workspace_id = knowledge_base_categories.workspace_id) AND (a.status = 'published'::public.article_status)))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: translations Public can read platform translations
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Public can read platform translations" ON public.translations FOR SELECT TO anon USING ((workspace_id IS NULL))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: knowledge_base_articles Public can read published KB articles
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Public can read published KB articles" ON public.knowledge_base_articles FOR SELECT TO anon USING ((status = 'published'::public.article_status))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: role_permissions Read role permissions
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Read role permissions" ON public.role_permissions FOR SELECT TO authenticated USING (((workspace_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = role_permissions.workspace_id) AND (wm.user_id = auth.uid()))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: alert_events Service role full access alert_events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access alert_events" ON public.alert_events TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: alert_rules Service role full access alert_rules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access alert_rules" ON public.alert_rules TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_attachments Service role full access attachments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access attachments" ON public.conversation_attachments TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_continuity_tokens Service role full access continuity
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access continuity" ON public.user_continuity_tokens TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_events Service role full access conv events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access conv events" ON public.conversation_events TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: visitor_geo_cache Service role full access geo cache
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access geo cache" ON public.visitor_geo_cache TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: geo_ip_cache Service role full access geo_ip_cache
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access geo_ip_cache" ON public.geo_ip_cache TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: identity_merges Service role full access merges
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access merges" ON public.identity_merges TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_notes Service role full access notes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access notes" ON public.conversation_notes TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: privacy_jobs Service role full access privacy jobs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access privacy jobs" ON public.privacy_jobs TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: contact_verifications Service role full access verifications
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role full access verifications" ON public.contact_verifications TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: knowledge_base_change_events Service role manages KB change events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Service role manages KB change events" ON public.knowledge_base_change_events TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_roles Users can view own roles
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT TO authenticated USING ((user_id = auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: privacy_jobs Users view own privacy jobs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Users view own privacy jobs" ON public.privacy_jobs FOR SELECT TO authenticated USING (((actor_user_id = auth.uid()) AND (subject_type = 'user'::text) AND (subject_id = (auth.uid())::text)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_attachments Workspace admins can delete attachments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can delete attachments" ON public.conversation_attachments FOR DELETE TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_provider_settings Workspace admins can manage provider settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can manage provider settings" ON public.workspace_provider_settings TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_channel_overrides Workspace admins can view own channel overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can view own channel overrides" ON public.workspace_channel_overrides FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_limit_overrides Workspace admins can view own limit overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can view own limit overrides" ON public.workspace_limit_overrides FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_module_overrides Workspace admins can view own module overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can view own module overrides" ON public.workspace_module_overrides FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: plan_change_log Workspace admins can view own plan changes
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can view own plan changes" ON public.plan_change_log FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_usage_counters Workspace admins can view own usage
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins can view own usage" ON public.workspace_usage_counters FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: privacy_jobs Workspace admins create privacy jobs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins create privacy jobs" ON public.privacy_jobs FOR INSERT TO authenticated WITH CHECK (((actor_user_id = auth.uid()) AND (((subject_type = ANY (ARRAY['contact'::text, 'visitor'::text])) AND (workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) OR ((subject_type = 'user'::text) AND (subject_id = (auth.uid())::text)))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: role_permissions Workspace admins manage overrides
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins manage overrides" ON public.role_permissions TO authenticated USING (((workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = role_permissions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))) WITH CHECK (((workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = role_permissions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: privacy_jobs Workspace admins view privacy jobs
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace admins view privacy jobs" ON public.privacy_jobs FOR SELECT TO authenticated USING (((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: billing_events Workspace billing access can view billing events
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace billing access can view billing events" ON public.billing_events FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role, 'billing'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: billing_payments Workspace billing access can view payments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace billing access can view payments" ON public.billing_payments FOR SELECT TO authenticated USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role, 'billing'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: conversation_attachments Workspace members can read attachments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can read attachments" ON public.conversation_attachments FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_invitations Workspace members can read call invitations
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can read call invitations" ON public.call_invitations FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_ratings Workspace members can read ratings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can read ratings" ON public.call_ratings FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = call_ratings.workspace_id) AND (wm.user_id = auth.uid())))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_ai_nudge_settings Workspace members can update ai nudge settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can update ai nudge settings" ON public.widget_ai_nudge_settings FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid())) WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_ai_nudge_settings Workspace members can upsert ai nudge settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can upsert ai nudge settings" ON public.widget_ai_nudge_settings FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_ai_nudge_settings Workspace members can view ai nudge settings
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can view ai nudge settings" ON public.widget_ai_nudge_settings FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: widget_ai_nudges Workspace members can view ai nudges
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members can view ai nudges" ON public.widget_ai_nudges FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_continuity_tokens Workspace members read continuity
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members read continuity" ON public.user_continuity_tokens FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: identity_merges Workspace members read merges
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members read merges" ON public.identity_merges FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: business_metrics_hourly Workspace members read own business_metrics
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members read own business_metrics" ON public.business_metrics_hourly FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_health_snapshots Workspace members read own health
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members read own health" ON public.workspace_health_snapshots FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_health_snapshots_legacy Workspace members read own health
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members read own health" ON public.workspace_health_snapshots_legacy FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: contact_verifications Workspace members read verifications
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "Workspace members read verifications" ON public.contact_verifications FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: admin_gate_bypass_log
ALTER TABLE public.admin_gate_bypass_log ENABLE ROW LEVEL SECURITY;

-- POLICY: admin_gate_bypass_log admins_read_gate_bypass
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY admins_read_gate_bypass ON public.admin_gate_bypass_log FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: realtime_provider_audit admins_read_realtime_audit
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY admins_read_realtime_audit ON public.realtime_provider_audit FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_debug_events
ALTER TABLE public.ai_agent_debug_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_guidance_rules
ALTER TABLE public.ai_agent_guidance_rules ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_intro_log
ALTER TABLE public.ai_agent_intro_log ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_intro_log ai_agent_intro_log_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_intro_log_member_read ON public.ai_agent_intro_log FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_learning_candidates
ALTER TABLE public.ai_agent_learning_candidates ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_message_triggers
ALTER TABLE public.ai_agent_message_triggers ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_qna
ALTER TABLE public.ai_agent_qna ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_qna ai_agent_qna_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_qna_member_read ON public.ai_agent_qna FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_regression_batches
ALTER TABLE public.ai_agent_regression_batches ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_regression_schedules
ALTER TABLE public.ai_agent_regression_schedules ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_routing_rules
ALTER TABLE public.ai_agent_routing_rules ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_runs
ALTER TABLE public.ai_agent_runs ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_runs ai_agent_runs_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_runs_member_read ON public.ai_agent_runs FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_sources
ALTER TABLE public.ai_agent_sources ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_sources ai_agent_sources_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_sources_member_read ON public.ai_agent_sources FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_suggested_test_cases ai_agent_suggested_tc_delete_admins
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_suggested_tc_delete_admins ON public.ai_agent_suggested_test_cases FOR DELETE TO authenticated USING (((public.get_workspace_role(workspace_id, auth.uid()))::text = ANY (ARRAY['owner'::text, 'admin'::text])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_suggested_test_cases ai_agent_suggested_tc_insert_operators
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_suggested_tc_insert_operators ON public.ai_agent_suggested_test_cases FOR INSERT TO authenticated WITH CHECK (((public.get_workspace_role(workspace_id, auth.uid()))::text = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text, 'support_agent'::text, 'team_lead'::text])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_suggested_test_cases ai_agent_suggested_tc_read_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_suggested_tc_read_members ON public.ai_agent_suggested_test_cases FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_suggested_test_cases ai_agent_suggested_tc_update_admins
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_suggested_tc_update_admins ON public.ai_agent_suggested_test_cases FOR UPDATE TO authenticated USING (((public.get_workspace_role(workspace_id, auth.uid()))::text = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK (((public.get_workspace_role(workspace_id, auth.uid()))::text = ANY (ARRAY['owner'::text, 'admin'::text])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_suggested_test_cases
ALTER TABLE public.ai_agent_suggested_test_cases ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_suggestions
ALTER TABLE public.ai_agent_suggestions ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_suggestions ai_agent_suggestions_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_suggestions_member_read ON public.ai_agent_suggestions FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_test_cases
ALTER TABLE public.ai_agent_test_cases ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_test_cases ai_agent_test_cases_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_test_cases_select_members ON public.ai_agent_test_cases FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_test_cases ai_agent_test_cases_write_admins
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_test_cases_write_admins ON public.ai_agent_test_cases USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_agent_test_cases.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_agent_test_cases.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_test_runs
ALTER TABLE public.ai_agent_test_runs ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_test_runs ai_agent_test_runs_insert_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_test_runs_insert_members ON public.ai_agent_test_runs FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_test_runs ai_agent_test_runs_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_agent_test_runs_select_members ON public.ai_agent_test_runs FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_agent_tool_servers
ALTER TABLE public.ai_agent_tool_servers ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_tools
ALTER TABLE public.ai_agent_tools ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_topics
ALTER TABLE public.ai_agent_topics ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_agent_workflows
ALTER TABLE public.ai_agent_workflows ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_data_sources
ALTER TABLE public.ai_data_sources ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_debug_events ai_debug_events_admin_insert
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_debug_events_admin_insert ON public.ai_agent_debug_events FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_agent_debug_events.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_debug_events ai_debug_events_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_debug_events_member_read ON public.ai_agent_debug_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_agent_debug_events.workspace_id) AND (wm.user_id = auth.uid())))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_kb_generated_articles
ALTER TABLE public.ai_kb_generated_articles ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_kb_job_events
ALTER TABLE public.ai_kb_job_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_kb_job_pages
ALTER TABLE public.ai_kb_job_pages ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_kb_jobs
ALTER TABLE public.ai_kb_jobs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_kb_usage
ALTER TABLE public.ai_kb_usage ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_knowledge_chunks
ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_knowledge_chunks ai_knowledge_chunks_no_client_access
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_knowledge_chunks_no_client_access ON public.ai_knowledge_chunks TO authenticated USING (false) WITH CHECK (false)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_learning_candidates ai_learn_cand_admin_write
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_learn_cand_admin_write ON public.ai_agent_learning_candidates TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_agent_learning_candidates.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_agent_learning_candidates.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_learning_candidates ai_learn_cand_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_learn_cand_member_read ON public.ai_agent_learning_candidates FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_operator_assist_feedback ai_op_assist_fb_delete_admins
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_op_assist_fb_delete_admins ON public.ai_operator_assist_feedback FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_operator_assist_feedback.workspace_id) AND (wm.user_id = auth.uid()) AND ((wm.role)::text = ANY (ARRAY['owner'::text, 'admin'::text]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_operator_assist_feedback ai_op_assist_fb_insert_operators
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_op_assist_fb_insert_operators ON public.ai_operator_assist_feedback FOR INSERT TO authenticated WITH CHECK ((public.is_workspace_member(workspace_id, auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = ai_operator_assist_feedback.workspace_id) AND (wm.user_id = auth.uid()) AND ((wm.role)::text = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text, 'support_agent'::text, 'team_lead'::text])))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_operator_assist_feedback ai_op_assist_fb_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_op_assist_fb_select_members ON public.ai_operator_assist_feedback FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_operator_assist_feedback
ALTER TABLE public.ai_operator_assist_feedback ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_operator_assist_runs
ALTER TABLE public.ai_operator_assist_runs ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_operator_assist_runs ai_operator_assist_runs_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ai_operator_assist_runs_select_members ON public.ai_operator_assist_runs FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: ai_source_pages
ALTER TABLE public.ai_source_pages ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_source_sync_jobs
ALTER TABLE public.ai_source_sync_jobs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_source_sync_logs
ALTER TABLE public.ai_source_sync_logs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ai_usage_logs
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: alert_events
ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: alert_rules
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: auto_action_definitions
ALTER TABLE public.auto_action_definitions ENABLE ROW LEVEL SECURITY;

-- POLICY: auto_action_definitions auto_action_definitions_no_public_access
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY auto_action_definitions_no_public_access ON public.auto_action_definitions TO anon, authenticated USING (false) WITH CHECK (false)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: auto_action_events
ALTER TABLE public.auto_action_events ENABLE ROW LEVEL SECURITY;

-- POLICY: auto_action_events auto_action_events_no_public_access
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY auto_action_events_no_public_access ON public.auto_action_events TO anon, authenticated USING (false) WITH CHECK (false)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: backup_commands
ALTER TABLE public.backup_commands ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: backup_restore_drills
ALTER TABLE public.backup_restore_drills ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: backup_runs
ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: billing_events
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: business_metrics_hourly
ALTER TABLE public.business_metrics_hourly ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: call_center_agent_presence
ALTER TABLE public.call_center_agent_presence ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: call_center_department_agents
ALTER TABLE public.call_center_department_agents ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: call_center_departments
ALTER TABLE public.call_center_departments ENABLE ROW LEVEL SECURITY;

-- POLICY: call_center_settings call_center_settings_admin_write
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY call_center_settings_admin_write ON public.call_center_settings USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_settings call_center_settings_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY call_center_settings_member_read ON public.call_center_settings FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: call_events
ALTER TABLE public.call_events ENABLE ROW LEVEL SECURITY;

-- POLICY: call_events call_events_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY call_events_select_members ON public.call_events FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.call_sessions cs
  WHERE ((cs.id = call_events.call_session_id) AND (public.is_workspace_member(cs.workspace_id, auth.uid()) OR public.has_role(auth.uid(), 'admin'::public.app_role))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: call_invitations
ALTER TABLE public.call_invitations ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: call_participants
ALTER TABLE public.call_participants ENABLE ROW LEVEL SECURITY;

-- POLICY: call_participants call_participants_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY call_participants_select_members ON public.call_participants FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.call_sessions cs
  WHERE ((cs.id = call_participants.call_session_id) AND (public.is_workspace_member(cs.workspace_id, auth.uid()) OR public.has_role(auth.uid(), 'admin'::public.app_role))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: call_ratings
ALTER TABLE public.call_ratings ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: call_recordings
ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;

-- POLICY: call_recordings call_recordings_select_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY call_recordings_select_members ON public.call_recordings FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.call_sessions cs
  WHERE ((cs.id = call_recordings.call_session_id) AND (public.is_workspace_member(cs.workspace_id, auth.uid()) OR public.has_role(auth.uid(), 'admin'::public.app_role))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_agent_presence ccap_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ccap_member_read ON public.call_center_agent_presence FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_agent_presence ccap_self_write
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ccap_self_write ON public.call_center_agent_presence USING (((user_id = auth.uid()) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role, 'agent'::public.workspace_role, 'support_agent'::public.workspace_role, 'team_lead'::public.workspace_role])))) WITH CHECK (((user_id = auth.uid()) AND (public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role, 'agent'::public.workspace_role, 'support_agent'::public.workspace_role, 'team_lead'::public.workspace_role]))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_departments ccd_admin_write
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ccd_admin_write ON public.call_center_departments USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_departments ccd_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ccd_member_read ON public.call_center_departments FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_department_agents ccda_admin_write
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ccda_admin_write ON public.call_center_department_agents USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))) WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: call_center_department_agents ccda_member_read
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY ccda_member_read ON public.call_center_department_agents FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: commerce_deleted_entities
ALTER TABLE public.commerce_deleted_entities ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: contact_verifications
ALTER TABLE public.contact_verifications ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: conversation_attachments
ALTER TABLE public.conversation_attachments ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: conversation_events
ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: conversation_notes
ALTER TABLE public.conversation_notes ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: email_logs
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: email_settings
ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: email_settings_localized
ALTER TABLE public.email_settings_localized ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: enforcement_actions
ALTER TABLE public.enforcement_actions ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: enforcement_normalizations
ALTER TABLE public.enforcement_normalizations ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: enforcement_rules
ALTER TABLE public.enforcement_rules ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: geo_ip_cache
ALTER TABLE public.geo_ip_cache ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: identity_merges
ALTER TABLE public.identity_merges ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: ip_blocklist
ALTER TABLE public.ip_blocklist ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: knowledge_base_change_events
ALTER TABLE public.knowledge_base_change_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: livekit_webhook_events
ALTER TABLE public.livekit_webhook_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: login_attempts
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- POLICY: operator_call_availability members read call availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "members read call availability" ON public.operator_call_availability FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_regression_batches members read regression batches
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "members read regression batches" ON public.ai_agent_regression_batches FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_regression_schedules members read regression schedules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "members read regression schedules" ON public.ai_agent_regression_schedules FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_department_members members_can_view_department_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY members_can_view_department_members ON public.workspace_department_members FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspace_department_members.workspace_id) AND (wm.user_id = auth.uid())))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_departments members_can_view_departments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY members_can_view_departments ON public.workspace_departments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspace_departments.workspace_id) AND (wm.user_id = auth.uid())))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: operator_call_availability operator updates own availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "operator updates own availability" ON public.operator_call_availability FOR UPDATE USING (((user_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid()))) WITH CHECK (((user_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid())))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: operator_call_availability operator writes own availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "operator writes own availability" ON public.operator_call_availability FOR INSERT WITH CHECK (((user_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid())))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: operator_call_availability
ALTER TABLE public.operator_call_availability ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_agent_regression_schedules owner_admin delete regression schedules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "owner_admin delete regression schedules" ON public.ai_agent_regression_schedules FOR DELETE USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_regression_batches owner_admin insert regression batches
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "owner_admin insert regression batches" ON public.ai_agent_regression_batches FOR INSERT WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_regression_schedules owner_admin insert regression schedules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "owner_admin insert regression schedules" ON public.ai_agent_regression_schedules FOR INSERT WITH CHECK ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_regression_batches owner_admin update regression batches
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "owner_admin update regression batches" ON public.ai_agent_regression_batches FOR UPDATE USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_agent_regression_schedules owner_admin update regression schedules
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "owner_admin update regression schedules" ON public.ai_agent_regression_schedules FOR UPDATE USING ((public.get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_department_members owners_admins_can_manage_department_members
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY owners_admins_can_manage_department_members ON public.workspace_department_members USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspace_department_members.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspace_department_members.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: workspace_departments owners_admins_can_manage_departments
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY owners_admins_can_manage_departments ON public.workspace_departments USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspace_departments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspace_departments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_call_center_settings pcc_read_authenticated
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY pcc_read_authenticated ON public.platform_call_center_settings FOR SELECT TO authenticated USING (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_call_center_settings pcc_write_admin
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY pcc_write_admin ON public.platform_call_center_settings USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: phone_verification_challenges
ALTER TABLE public.phone_verification_challenges ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: platform_branding_localized
ALTER TABLE public.platform_branding_localized ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: platform_call_center_settings
ALTER TABLE public.platform_call_center_settings ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: platform_domains
ALTER TABLE public.platform_domains ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: platform_sms_provider_config
ALTER TABLE public.platform_sms_provider_config ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: privacy_jobs
ALTER TABLE public.privacy_jobs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: realtime_failover_state
ALTER TABLE public.realtime_failover_state ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: realtime_provider_audit
ALTER TABLE public.realtime_provider_audit ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: role_permissions
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: security_events
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

-- POLICY: ai_source_pages service role full access
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "service role full access" ON public.ai_source_pages TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: ai_source_sync_jobs service role full access
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "service role full access" ON public.ai_source_sync_jobs TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: commerce_deleted_entities service role only
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "service role only" ON public.commerce_deleted_entities TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: platform_sms_provider_config service role only
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "service role only" ON public.platform_sms_provider_config TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: phone_verification_challenges service role only pvc
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "service role only pvc" ON public.phone_verification_challenges TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_phone_verifications service role only upv
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "service role only upv" ON public.user_phone_verifications TO service_role USING (true) WITH CHECK (true)$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: sla_reliability_hourly
ALTER TABLE public.sla_reliability_hourly ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: slo_breach_events
ALTER TABLE public.slo_breach_events ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: slo_definitions
ALTER TABLE public.slo_definitions ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: storage_usage_logs
ALTER TABLE public.storage_usage_logs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: team_messages
ALTER TABLE public.team_messages ENABLE ROW LEVEL SECURITY;

-- POLICY: team_messages team_messages_insert_sender
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY team_messages_insert_sender ON public.team_messages FOR INSERT TO authenticated WITH CHECK (((sender_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid()) AND public.is_workspace_member(workspace_id, recipient_id)))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: team_messages team_messages_select_participants
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY team_messages_select_participants ON public.team_messages FOR SELECT TO authenticated USING ((public.is_workspace_member(workspace_id, auth.uid()) AND ((sender_id = auth.uid()) OR (recipient_id = auth.uid()))))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: team_messages team_messages_update_recipient
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY team_messages_update_recipient ON public.team_messages FOR UPDATE TO authenticated USING (((recipient_id = auth.uid()) AND public.is_workspace_member(workspace_id, auth.uid()))) WITH CHECK ((recipient_id = auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: user_availability_prefs
ALTER TABLE public.user_availability_prefs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: user_continuity_tokens
ALTER TABLE public.user_continuity_tokens ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: user_deletion_jobs
ALTER TABLE public.user_deletion_jobs ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: user_phone_verifications
ALTER TABLE public.user_phone_verifications ENABLE ROW LEVEL SECURITY;

-- POLICY: user_availability_prefs users delete own availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "users delete own availability" ON public.user_availability_prefs FOR DELETE TO authenticated USING ((auth.uid() = user_id))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_availability_prefs users insert own availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "users insert own availability" ON public.user_availability_prefs FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_availability_prefs users select own availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "users select own availability" ON public.user_availability_prefs FOR SELECT TO authenticated USING ((auth.uid() = user_id))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- POLICY: user_availability_prefs users update own availability
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY "users update own availability" ON public.user_availability_prefs FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: visitor_geo_cache
ALTER TABLE public.visitor_geo_cache ENABLE ROW LEVEL SECURITY;

-- POLICY: workspace_alert_dismissals wad_own_rows
DO $parity$ BEGIN
  EXECUTE $stmt$CREATE POLICY wad_own_rows ON public.workspace_alert_dismissals TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()))$stmt$;
EXCEPTION WHEN duplicate_object THEN NULL;
END $parity$;

-- ROW SECURITY: widget_templates
ALTER TABLE public.widget_templates ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_alert_dismissals
ALTER TABLE public.workspace_alert_dismissals ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_branding_localized
ALTER TABLE public.workspace_branding_localized ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_channel_overrides
ALTER TABLE public.workspace_channel_overrides ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_domains_extended
ALTER TABLE public.workspace_domains_extended ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_health_snapshots
ALTER TABLE public.workspace_health_snapshots ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_health_snapshots_2026_09
ALTER TABLE public.workspace_health_snapshots_2026_09 ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_health_snapshots_2026_10
ALTER TABLE public.workspace_health_snapshots_2026_10 ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_health_snapshots_2026_11
ALTER TABLE public.workspace_health_snapshots_2026_11 ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_health_snapshots_default
ALTER TABLE public.workspace_health_snapshots_default ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_health_snapshots_legacy
ALTER TABLE public.workspace_health_snapshots_legacy ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_limit_overrides
ALTER TABLE public.workspace_limit_overrides ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_module_overrides
ALTER TABLE public.workspace_module_overrides ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_provider_settings
ALTER TABLE public.workspace_provider_settings ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: workspace_settings
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;

-- ── check constraints on existing tables ────────────────────
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'refunded'::text, 'partially_refunded'::text])))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.workspace_departments ADD CONSTRAINT workspace_departments_cc_routing_mode_check CHECK (((cc_routing_mode IS NULL) OR (cc_routing_mode = ANY (ARRAY['broadcast'::text, 'round_robin'::text, 'least_busy'::text]))))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.workspace_department_members ADD CONSTRAINT workspace_department_members_call_center_role_check CHECK ((call_center_role = ANY (ARRAY['agent'::text, 'supervisor'::text])))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.call_center_settings ADD CONSTRAINT call_center_settings_widget_default_locale_check CHECK (((widget_default_locale IS NULL) OR (widget_default_locale = ANY (ARRAY['en'::text, 'fa'::text, 'tr'::text]))))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.platform_settings ADD CONSTRAINT platform_settings_region_mode_check CHECK ((region_mode = ANY (ARRAY['multi'::text, 'iran'::text, 'turkey'::text, 'global'::text])))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.widget_settings ADD CONSTRAINT widget_settings_assignment_mode_check CHECK ((assignment_mode = ANY (ARRAY['auto'::text, 'round_robin'::text, 'manual'::text])))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.widget_ai_nudge_settings ADD CONSTRAINT widget_ai_nudge_settings_include_paths_len CHECK (((array_length(include_paths, 1) IS NULL) OR (array_length(include_paths, 1) <= 50)))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.widget_ai_nudge_settings ADD CONSTRAINT widget_ai_nudge_settings_exclude_paths_len CHECK (((array_length(exclude_paths, 1) IS NULL) OR (array_length(exclude_paths, 1) <= 50)))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_cta_label_len CHECK (((cta_label IS NULL) OR (length(cta_label) <= 60)))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))))$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;
DO $parity$ BEGIN
  EXECUTE $stmt$ALTER TABLE public.call_center_settings ADD CONSTRAINT call_center_settings_avatar_path_scope_check CHECK (((avatar_storage_path IS NULL) OR (avatar_storage_path ~~ (('workspace/'::text || (workspace_id)::text) || '/avatars/call-center/%'::text)) OR (avatar_storage_path ~~ (('workspace/'::text || (workspace_id)::text) || '/call-center/avatar/%'::text)))) NOT VALID$stmt$;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $parity$;

-- ── row level security and policy hardening ─────────────────
ALTER TABLE public.user_deletion_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can read runtime config" ON public.app_runtime_config;
DROP POLICY IF EXISTS "Admins+ can manage email templates" ON public.email_templates;
DROP POLICY IF EXISTS "Members can view feature flags" ON public.feature_flags;
DROP POLICY IF EXISTS "Members can manage KB articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Public can read published articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Members can manage KB categories" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Public can read KB categories" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Public can read translations" ON public.translations;
DROP POLICY IF EXISTS "Anon can manage presence" ON public.visitor_presence;
DROP POLICY IF EXISTS "Anon can update visitor sessions" ON public.visitor_sessions;
DROP POLICY IF EXISTS "Public can read branding" ON public.workspace_branding;
DROP POLICY IF EXISTS "Admins+ can manage domains" ON public.workspace_domains;
DROP POLICY IF EXISTS "Anon can insert visitor sessions" ON public.visitor_sessions;
CREATE POLICY "Anon can insert visitor sessions" ON public.visitor_sessions AS PERMISSIVE FOR INSERT TO anon WITH CHECK (((visitor_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM widget_settings ws
  WHERE ((ws.workspace_id = visitor_sessions.workspace_id) AND (ws.visitor_tracking_enabled = true) AND (ws.enabled = true))))));
DROP POLICY IF EXISTS "Admins+ can insert widget settings" ON public.widget_settings;
CREATE POLICY "Admins+ can insert widget settings" ON public.widget_settings AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])) AND workspace_owner_phone_verified(workspace_id)));
DROP POLICY IF EXISTS "Admins+ can update widget settings" ON public.widget_settings;
CREATE POLICY "Admins+ can update widget settings" ON public.widget_settings AS PERMISSIVE FOR UPDATE TO authenticated USING (((get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])) AND workspace_owner_phone_verified(workspace_id)));

-- ── privileges ──────────────────────────────────────────────
REVOKE ALL ON TABLE public.app_runtime_config FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.app_runtime_config TO anon;
GRANT ALL ON TABLE public.app_runtime_config TO authenticated;
GRANT ALL ON TABLE public.app_runtime_config TO service_role;
REVOKE ALL ON TABLE public.email_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_logs TO anon;
GRANT ALL ON TABLE public.email_logs TO authenticated;
GRANT ALL ON TABLE public.email_logs TO service_role;
REVOKE ALL ON TABLE public.security_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.security_events TO anon;
GRANT ALL ON TABLE public.security_events TO authenticated;
GRANT ALL ON TABLE public.security_events TO service_role;
REVOKE ALL ON TABLE public.email_templates FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_templates TO anon;
GRANT ALL ON TABLE public.email_templates TO authenticated;
GRANT ALL ON TABLE public.email_templates TO service_role;
REVOKE ALL ON TABLE public.user_roles FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_roles TO anon;
GRANT ALL ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;
REVOKE ALL ON TABLE public.workspaces FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspaces TO anon;
GRANT ALL ON TABLE public.workspaces TO authenticated;
GRANT ALL ON TABLE public.workspaces TO service_role;
REVOKE ALL ON TABLE public.workspace_domains FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_domains TO anon;
GRANT ALL ON TABLE public.workspace_domains TO authenticated;
GRANT ALL ON TABLE public.workspace_domains TO service_role;
REVOKE ALL ON TABLE public.contacts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.contacts TO anon;
GRANT ALL ON TABLE public.contacts TO authenticated;
REVOKE INSERT ON TABLE public.contacts FROM authenticated;
GRANT ALL ON TABLE public.contacts TO service_role;
REVOKE ALL ON TABLE public.conversation_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_messages TO anon;
GRANT ALL ON TABLE public.conversation_messages TO authenticated;
GRANT ALL ON TABLE public.conversation_messages TO service_role;
REVOKE ALL ON TABLE public.knowledge_base_categories FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.knowledge_base_categories TO anon;
REVOKE INSERT, DELETE, UPDATE ON TABLE public.knowledge_base_categories FROM anon;
GRANT ALL ON TABLE public.knowledge_base_categories TO authenticated;
REVOKE INSERT, DELETE, UPDATE ON TABLE public.knowledge_base_categories FROM authenticated;
GRANT ALL ON TABLE public.knowledge_base_categories TO service_role;
REVOKE ALL ON TABLE public.visitor_presence FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.visitor_presence TO anon;
GRANT ALL ON TABLE public.visitor_presence TO authenticated;
GRANT ALL ON TABLE public.visitor_presence TO service_role;
REVOKE ALL ON TABLE public.knowledge_base_articles FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.knowledge_base_articles TO anon;
REVOKE INSERT, DELETE, UPDATE ON TABLE public.knowledge_base_articles FROM anon;
GRANT ALL ON TABLE public.knowledge_base_articles TO authenticated;
REVOKE INSERT, DELETE, UPDATE ON TABLE public.knowledge_base_articles FROM authenticated;
GRANT ALL ON TABLE public.knowledge_base_articles TO service_role;
REVOKE ALL ON TABLE public.provider_configs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.provider_configs TO anon;
GRANT ALL ON TABLE public.provider_configs TO authenticated;
GRANT ALL ON TABLE public.provider_configs TO service_role;
REVOKE ALL ON TABLE public.translations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.translations TO anon;
GRANT ALL ON TABLE public.translations TO authenticated;
GRANT ALL ON TABLE public.translations TO service_role;
REVOKE ALL ON TABLE public.feature_flags FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.feature_flags TO anon;
GRANT ALL ON TABLE public.feature_flags TO authenticated;
GRANT ALL ON TABLE public.feature_flags TO service_role;
REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.audit_logs TO anon;
GRANT ALL ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO service_role;
REVOKE ALL ON TABLE public.login_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.login_attempts TO anon;
GRANT ALL ON TABLE public.login_attempts TO authenticated;
GRANT ALL ON TABLE public.login_attempts TO service_role;
REVOKE ALL ON TABLE public.ip_blocklist FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ip_blocklist TO anon;
GRANT ALL ON TABLE public.ip_blocklist TO authenticated;
GRANT ALL ON TABLE public.ip_blocklist TO service_role;
REVOKE ALL ON TABLE public.ai_usage_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_usage_logs TO anon;
GRANT ALL ON TABLE public.ai_usage_logs TO authenticated;
GRANT ALL ON TABLE public.ai_usage_logs TO service_role;
REVOKE ALL ON TABLE public.workspace_subscriptions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_subscriptions TO anon;
GRANT ALL ON TABLE public.workspace_subscriptions TO authenticated;
GRANT ALL ON TABLE public.workspace_subscriptions TO service_role;
REVOKE ALL ON TABLE public.billing_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_events TO anon;
GRANT ALL ON TABLE public.billing_events TO authenticated;
GRANT ALL ON TABLE public.billing_events TO service_role;
REVOKE ALL ON TABLE public.storage_usage_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.storage_usage_logs TO anon;
GRANT ALL ON TABLE public.storage_usage_logs TO authenticated;
GRANT ALL ON TABLE public.storage_usage_logs TO service_role;
REVOKE ALL ON TABLE public.workspace_domains_extended FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_domains_extended TO anon;
GRANT ALL ON TABLE public.workspace_domains_extended TO authenticated;
GRANT ALL ON TABLE public.workspace_domains_extended TO service_role;
REVOKE ALL ON TABLE public.billing_plans FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_plans TO anon;
GRANT ALL ON TABLE public.billing_plans TO authenticated;
GRANT ALL ON TABLE public.billing_plans TO service_role;
REVOKE ALL ON TABLE public.workspace_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_settings TO anon;
GRANT ALL ON TABLE public.workspace_settings TO authenticated;
GRANT ALL ON TABLE public.workspace_settings TO service_role;
REVOKE ALL ON TABLE public.workspace_branding_localized FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_branding_localized TO anon;
GRANT ALL ON TABLE public.workspace_branding_localized TO authenticated;
GRANT ALL ON TABLE public.workspace_branding_localized TO service_role;
REVOKE ALL ON TABLE public.platform_branding_localized FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_branding_localized TO anon;
GRANT ALL ON TABLE public.platform_branding_localized TO authenticated;
GRANT ALL ON TABLE public.platform_branding_localized TO service_role;
REVOKE ALL ON TABLE public.email_settings_localized FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_settings_localized TO anon;
GRANT ALL ON TABLE public.email_settings_localized TO authenticated;
GRANT ALL ON TABLE public.email_settings_localized TO service_role;
REVOKE ALL ON TABLE public.platform_domains FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_domains TO anon;
GRANT ALL ON TABLE public.platform_domains TO authenticated;
GRANT ALL ON TABLE public.platform_domains TO service_role;
REVOKE ALL ON TABLE public.email_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_settings TO anon;
GRANT ALL ON TABLE public.email_settings TO authenticated;
GRANT ALL ON TABLE public.email_settings TO service_role;
REVOKE ALL ON TABLE public.platform_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_settings TO anon;
GRANT ALL ON TABLE public.platform_settings TO authenticated;
GRANT ALL ON TABLE public.platform_settings TO service_role;
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;
REVOKE ALL ON TABLE public.accounts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.accounts TO anon;
GRANT ALL ON TABLE public.accounts TO authenticated;
GRANT ALL ON TABLE public.accounts TO service_role;
REVOKE ALL ON TABLE public.account_members FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.account_members TO anon;
GRANT ALL ON TABLE public.account_members TO authenticated;
GRANT ALL ON TABLE public.account_members TO service_role;
REVOKE ALL ON TABLE public.workspace_usage_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_usage_counters TO anon;
GRANT ALL ON TABLE public.workspace_usage_counters TO authenticated;
GRANT ALL ON TABLE public.workspace_usage_counters TO service_role;
REVOKE ALL ON TABLE public.workspace_branding FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_branding TO anon;
GRANT ALL ON TABLE public.workspace_branding TO authenticated;
GRANT ALL ON TABLE public.workspace_branding TO service_role;
REVOKE ALL ON TABLE public.workspace_provider_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_provider_settings TO anon;
GRANT ALL ON TABLE public.workspace_provider_settings TO authenticated;
GRANT ALL ON TABLE public.workspace_provider_settings TO service_role;
REVOKE ALL ON TABLE public.workspace_module_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_module_overrides TO anon;
GRANT ALL ON TABLE public.workspace_module_overrides TO authenticated;
GRANT ALL ON TABLE public.workspace_module_overrides TO service_role;
REVOKE ALL ON TABLE public.billing_plans_public FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_plans_public TO anon;
GRANT ALL ON TABLE public.billing_plans_public TO authenticated;
GRANT ALL ON TABLE public.billing_plans_public TO service_role;
REVOKE ALL ON TABLE public.workspace_channel_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_channel_overrides TO anon;
GRANT ALL ON TABLE public.workspace_channel_overrides TO authenticated;
GRANT ALL ON TABLE public.workspace_channel_overrides TO service_role;
REVOKE ALL ON TABLE public.plan_change_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.plan_change_log TO anon;
GRANT ALL ON TABLE public.plan_change_log TO authenticated;
GRANT ALL ON TABLE public.plan_change_log TO service_role;
REVOKE ALL ON TABLE public.contact_verifications FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.contact_verifications TO anon;
GRANT ALL ON TABLE public.contact_verifications TO authenticated;
GRANT ALL ON TABLE public.contact_verifications TO service_role;
REVOKE ALL ON TABLE public.user_continuity_tokens FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_continuity_tokens TO anon;
GRANT ALL ON TABLE public.user_continuity_tokens TO authenticated;
GRANT ALL ON TABLE public.user_continuity_tokens TO service_role;
REVOKE ALL ON TABLE public.identity_merges FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.identity_merges TO anon;
GRANT ALL ON TABLE public.identity_merges TO authenticated;
GRANT ALL ON TABLE public.identity_merges TO service_role;
REVOKE ALL ON TABLE public.realtime_provider_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.realtime_provider_audit TO anon;
GRANT ALL ON TABLE public.realtime_provider_audit TO authenticated;
GRANT ALL ON TABLE public.realtime_provider_audit TO service_role;
REVOKE ALL ON TABLE public.conversation_attachments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_attachments TO anon;
GRANT ALL ON TABLE public.conversation_attachments TO authenticated;
GRANT ALL ON TABLE public.conversation_attachments TO service_role;
REVOKE ALL ON TABLE public.conversation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_events TO anon;
GRANT ALL ON TABLE public.conversation_events TO authenticated;
GRANT ALL ON TABLE public.conversation_events TO service_role;
REVOKE ALL ON TABLE public.widget_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_settings TO anon;
GRANT ALL ON TABLE public.widget_settings TO authenticated;
GRANT ALL ON TABLE public.widget_settings TO service_role;
REVOKE ALL ON TABLE public.conversation_notes FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_notes TO anon;
GRANT ALL ON TABLE public.conversation_notes TO authenticated;
GRANT ALL ON TABLE public.conversation_notes TO service_role;
REVOKE ALL ON TABLE public.canned_responses FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.canned_responses TO anon;
GRANT ALL ON TABLE public.canned_responses TO authenticated;
GRANT ALL ON TABLE public.canned_responses TO service_role;
REVOKE ALL ON TABLE public.visitor_page_views FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.visitor_page_views TO anon;
GRANT ALL ON TABLE public.visitor_page_views TO authenticated;
GRANT ALL ON TABLE public.visitor_page_views TO service_role;
REVOKE ALL ON TABLE public.visitor_geo_cache FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.visitor_geo_cache TO anon;
GRANT ALL ON TABLE public.visitor_geo_cache TO authenticated;
GRANT ALL ON TABLE public.visitor_geo_cache TO service_role;
REVOKE ALL ON TABLE public.widget_templates FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_templates TO anon;
GRANT ALL ON TABLE public.widget_templates TO authenticated;
GRANT ALL ON TABLE public.widget_templates TO service_role;
REVOKE ALL ON TABLE public.geo_ip_cache FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.geo_ip_cache TO anon;
GRANT ALL ON TABLE public.geo_ip_cache TO authenticated;
GRANT ALL ON TABLE public.geo_ip_cache TO service_role;
REVOKE ALL ON SEQUENCE public.visitor_page_views_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.visitor_page_views_id_seq TO anon;
GRANT ALL ON SEQUENCE public.visitor_page_views_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.visitor_page_views_id_seq TO service_role;
REVOKE ALL ON TABLE public.privacy_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.privacy_jobs TO anon;
GRANT ALL ON TABLE public.privacy_jobs TO authenticated;
GRANT ALL ON TABLE public.privacy_jobs TO service_role;
REVOKE ALL ON TABLE public.user_availability_prefs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_availability_prefs TO anon;
GRANT ALL ON TABLE public.user_availability_prefs TO authenticated;
GRANT ALL ON TABLE public.user_availability_prefs TO service_role;
REVOKE ALL ON TABLE public.alert_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.alert_events TO anon;
GRANT ALL ON TABLE public.alert_events TO authenticated;
GRANT ALL ON TABLE public.alert_events TO service_role;
REVOKE ALL ON TABLE public.workspace_health_snapshots_legacy FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_health_snapshots_legacy TO anon;
GRANT ALL ON TABLE public.workspace_health_snapshots_legacy TO authenticated;
GRANT ALL ON TABLE public.workspace_health_snapshots_legacy TO service_role;
REVOKE ALL ON TABLE public.alert_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.alert_rules TO anon;
GRANT ALL ON TABLE public.alert_rules TO authenticated;
GRANT ALL ON TABLE public.alert_rules TO service_role;
REVOKE ALL ON TABLE public.auto_action_definitions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.auto_action_definitions TO anon;
GRANT ALL ON TABLE public.auto_action_definitions TO authenticated;
GRANT ALL ON TABLE public.auto_action_definitions TO service_role;
REVOKE ALL ON TABLE public.auto_action_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.auto_action_events TO anon;
GRANT ALL ON TABLE public.auto_action_events TO authenticated;
GRANT ALL ON TABLE public.auto_action_events TO service_role;
REVOKE ALL ON TABLE public.business_metrics_hourly FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.business_metrics_hourly TO anon;
GRANT ALL ON TABLE public.business_metrics_hourly TO authenticated;
GRANT ALL ON TABLE public.business_metrics_hourly TO service_role;
REVOKE ALL ON TABLE public.sla_reliability_hourly FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.sla_reliability_hourly TO anon;
GRANT ALL ON TABLE public.sla_reliability_hourly TO authenticated;
GRANT ALL ON TABLE public.sla_reliability_hourly TO service_role;
REVOKE ALL ON TABLE public.realtime_failover_state FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.realtime_failover_state TO anon;
GRANT ALL ON TABLE public.realtime_failover_state TO authenticated;
GRANT ALL ON TABLE public.realtime_failover_state TO service_role;
REVOKE ALL ON TABLE public.slo_definitions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.slo_definitions TO anon;
GRANT ALL ON TABLE public.slo_definitions TO authenticated;
GRANT ALL ON TABLE public.slo_definitions TO service_role;
REVOKE ALL ON TABLE public.slo_breach_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.slo_breach_events TO anon;
GRANT ALL ON TABLE public.slo_breach_events TO authenticated;
GRANT ALL ON TABLE public.slo_breach_events TO service_role;
REVOKE ALL ON TABLE public.enforcement_normalizations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.enforcement_normalizations TO anon;
GRANT ALL ON TABLE public.enforcement_normalizations TO authenticated;
GRANT ALL ON TABLE public.enforcement_normalizations TO service_role;
REVOKE ALL ON TABLE public.enforcement_actions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.enforcement_actions TO anon;
GRANT ALL ON TABLE public.enforcement_actions TO authenticated;
GRANT ALL ON TABLE public.enforcement_actions TO service_role;
REVOKE ALL ON TABLE public.enforcement_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.enforcement_rules TO anon;
GRANT ALL ON TABLE public.enforcement_rules TO authenticated;
GRANT ALL ON TABLE public.enforcement_rules TO service_role;
REVOKE ALL ON TABLE public.call_participants FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_participants TO anon;
GRANT ALL ON TABLE public.call_participants TO authenticated;
GRANT ALL ON TABLE public.call_participants TO service_role;
REVOKE ALL ON TABLE public.call_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_events TO anon;
GRANT ALL ON TABLE public.call_events TO authenticated;
GRANT ALL ON TABLE public.call_events TO service_role;
REVOKE ALL ON TABLE public.call_recordings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_recordings TO anon;
GRANT ALL ON TABLE public.call_recordings TO authenticated;
GRANT ALL ON TABLE public.call_recordings TO service_role;
REVOKE ALL ON TABLE public.livekit_webhook_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.livekit_webhook_events TO anon;
GRANT ALL ON TABLE public.livekit_webhook_events TO authenticated;
GRANT ALL ON TABLE public.livekit_webhook_events TO service_role;
REVOKE ALL ON TABLE public.role_permissions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.role_permissions TO anon;
GRANT ALL ON TABLE public.role_permissions TO authenticated;
GRANT ALL ON TABLE public.role_permissions TO service_role;
REVOKE ALL ON TABLE public.operator_call_availability FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.operator_call_availability TO anon;
GRANT ALL ON TABLE public.operator_call_availability TO authenticated;
GRANT ALL ON TABLE public.operator_call_availability TO service_role;
REVOKE ALL ON TABLE public.callback_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.callback_requests TO anon;
GRANT ALL ON TABLE public.callback_requests TO authenticated;
GRANT ALL ON TABLE public.callback_requests TO service_role;
REVOKE ALL ON TABLE public.call_invitations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_invitations TO anon;
GRANT ALL ON TABLE public.call_invitations TO authenticated;
GRANT ALL ON TABLE public.call_invitations TO service_role;
REVOKE ALL ON TABLE public.ai_kb_job_pages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_kb_job_pages TO anon;
GRANT ALL ON TABLE public.ai_kb_job_pages TO authenticated;
GRANT ALL ON TABLE public.ai_kb_job_pages TO service_role;
REVOKE ALL ON TABLE public.ai_kb_generated_articles FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_kb_generated_articles TO anon;
GRANT ALL ON TABLE public.ai_kb_generated_articles TO authenticated;
GRANT ALL ON TABLE public.ai_kb_generated_articles TO service_role;
REVOKE ALL ON TABLE public.ai_kb_usage FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_kb_usage TO anon;
GRANT ALL ON TABLE public.ai_kb_usage TO authenticated;
GRANT ALL ON TABLE public.ai_kb_usage TO service_role;
REVOKE ALL ON TABLE public.ai_kb_job_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_kb_job_events TO anon;
GRANT ALL ON TABLE public.ai_kb_job_events TO authenticated;
GRANT ALL ON TABLE public.ai_kb_job_events TO service_role;
REVOKE ALL ON TABLE public.ai_kb_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_kb_jobs TO anon;
GRANT ALL ON TABLE public.ai_kb_jobs TO authenticated;
GRANT ALL ON TABLE public.ai_kb_jobs TO service_role;
REVOKE ALL ON TABLE public.ai_agent_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_runs TO anon;
GRANT ALL ON TABLE public.ai_agent_runs TO authenticated;
GRANT ALL ON TABLE public.ai_agent_runs TO service_role;
REVOKE ALL ON TABLE public.admin_gate_bypass_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.admin_gate_bypass_log TO anon;
GRANT ALL ON TABLE public.admin_gate_bypass_log TO authenticated;
GRANT ALL ON TABLE public.admin_gate_bypass_log TO service_role;
REVOKE ALL ON TABLE public.conversations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversations TO anon;
GRANT ALL ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;
REVOKE ALL ON TABLE public.ai_agent_suggestions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_suggestions TO anon;
GRANT ALL ON TABLE public.ai_agent_suggestions TO authenticated;
GRANT ALL ON TABLE public.ai_agent_suggestions TO service_role;
REVOKE ALL ON TABLE public.ai_agent_sources FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_sources TO anon;
GRANT ALL ON TABLE public.ai_agent_sources TO authenticated;
GRANT ALL ON TABLE public.ai_agent_sources TO service_role;
REVOKE ALL ON TABLE public.ai_agent_qna FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_qna TO anon;
GRANT ALL ON TABLE public.ai_agent_qna TO authenticated;
GRANT ALL ON TABLE public.ai_agent_qna TO service_role;
REVOKE ALL ON TABLE public.ai_agent_intro_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_intro_log TO anon;
GRANT ALL ON TABLE public.ai_agent_intro_log TO authenticated;
GRANT ALL ON TABLE public.ai_agent_intro_log TO service_role;
REVOKE ALL ON TABLE public.ai_agent_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_settings TO anon;
GRANT ALL ON TABLE public.ai_agent_settings TO authenticated;
GRANT ALL ON TABLE public.ai_agent_settings TO service_role;
REVOKE ALL ON TABLE public.ai_knowledge_chunks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_knowledge_chunks TO anon;
GRANT ALL ON TABLE public.ai_knowledge_chunks TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_chunks TO service_role;
REVOKE ALL ON TABLE public.ai_agent_guidance_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_guidance_rules TO anon;
GRANT ALL ON TABLE public.ai_agent_guidance_rules TO authenticated;
GRANT ALL ON TABLE public.ai_agent_guidance_rules TO service_role;
REVOKE ALL ON TABLE public.ai_agent_routing_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_routing_rules TO anon;
GRANT ALL ON TABLE public.ai_agent_routing_rules TO authenticated;
GRANT ALL ON TABLE public.ai_agent_routing_rules TO service_role;
REVOKE ALL ON TABLE public.ai_source_sync_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_source_sync_logs TO anon;
GRANT ALL ON TABLE public.ai_source_sync_logs TO authenticated;
GRANT ALL ON TABLE public.ai_source_sync_logs TO service_role;
REVOKE ALL ON TABLE public.ai_agent_topics FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_topics TO anon;
GRANT ALL ON TABLE public.ai_agent_topics TO authenticated;
GRANT ALL ON TABLE public.ai_agent_topics TO service_role;
REVOKE ALL ON TABLE public.ai_agent_workflows FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_workflows TO anon;
GRANT ALL ON TABLE public.ai_agent_workflows TO authenticated;
GRANT ALL ON TABLE public.ai_agent_workflows TO service_role;
REVOKE ALL ON TABLE public.ai_agent_message_triggers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_message_triggers TO anon;
GRANT ALL ON TABLE public.ai_agent_message_triggers TO authenticated;
GRANT ALL ON TABLE public.ai_agent_message_triggers TO service_role;
REVOKE ALL ON TABLE public.ai_agent_tool_servers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_tool_servers TO anon;
GRANT ALL ON TABLE public.ai_agent_tool_servers TO authenticated;
GRANT ALL ON TABLE public.ai_agent_tool_servers TO service_role;
REVOKE ALL ON TABLE public.ai_agent_tools FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_tools TO anon;
GRANT ALL ON TABLE public.ai_agent_tools TO authenticated;
GRANT ALL ON TABLE public.ai_agent_tools TO service_role;
REVOKE ALL ON TABLE public.ai_data_sources FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_data_sources TO anon;
GRANT ALL ON TABLE public.ai_data_sources TO authenticated;
GRANT ALL ON TABLE public.ai_data_sources TO service_role;
REVOKE ALL ON TABLE public.ai_source_sync_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_source_sync_jobs TO anon;
GRANT ALL ON TABLE public.ai_source_sync_jobs TO authenticated;
GRANT ALL ON TABLE public.ai_source_sync_jobs TO service_role;
REVOKE ALL ON TABLE public.ai_source_pages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_source_pages TO anon;
GRANT ALL ON TABLE public.ai_source_pages TO authenticated;
GRANT ALL ON TABLE public.ai_source_pages TO service_role;
REVOKE ALL ON TABLE public.ai_agent_learning_candidates FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_learning_candidates TO anon;
GRANT ALL ON TABLE public.ai_agent_learning_candidates TO authenticated;
GRANT ALL ON TABLE public.ai_agent_learning_candidates TO service_role;
REVOKE ALL ON TABLE public.ai_agent_debug_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_debug_events TO anon;
GRANT ALL ON TABLE public.ai_agent_debug_events TO authenticated;
GRANT ALL ON TABLE public.ai_agent_debug_events TO service_role;
REVOKE ALL ON TABLE public.ai_agent_test_cases FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_test_cases TO anon;
GRANT ALL ON TABLE public.ai_agent_test_cases TO authenticated;
GRANT ALL ON TABLE public.ai_agent_test_cases TO service_role;
REVOKE ALL ON TABLE public.ai_operator_assist_feedback FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_operator_assist_feedback TO anon;
GRANT ALL ON TABLE public.ai_operator_assist_feedback TO authenticated;
GRANT ALL ON TABLE public.ai_operator_assist_feedback TO service_role;
REVOKE ALL ON TABLE public.ai_operator_assist_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_operator_assist_runs TO anon;
GRANT ALL ON TABLE public.ai_operator_assist_runs TO authenticated;
GRANT ALL ON TABLE public.ai_operator_assist_runs TO service_role;
REVOKE ALL ON TABLE public.ai_agent_suggested_test_cases FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_suggested_test_cases TO anon;
GRANT ALL ON TABLE public.ai_agent_suggested_test_cases TO authenticated;
GRANT ALL ON TABLE public.ai_agent_suggested_test_cases TO service_role;
REVOKE ALL ON TABLE public.ai_agent_regression_schedules FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_regression_schedules TO anon;
GRANT ALL ON TABLE public.ai_agent_regression_schedules TO authenticated;
GRANT ALL ON TABLE public.ai_agent_regression_schedules TO service_role;
REVOKE ALL ON TABLE public.ai_agent_test_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_test_runs TO anon;
GRANT ALL ON TABLE public.ai_agent_test_runs TO authenticated;
GRANT ALL ON TABLE public.ai_agent_test_runs TO service_role;
REVOKE ALL ON TABLE public.ai_agent_regression_batches FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_regression_batches TO anon;
GRANT ALL ON TABLE public.ai_agent_regression_batches TO authenticated;
GRANT ALL ON TABLE public.ai_agent_regression_batches TO service_role;
REVOKE ALL ON TABLE public.call_center_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_center_settings TO anon;
GRANT ALL ON TABLE public.call_center_settings TO authenticated;
GRANT ALL ON TABLE public.call_center_settings TO service_role;
REVOKE ALL ON TABLE public.call_center_departments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_center_departments TO anon;
GRANT ALL ON TABLE public.call_center_departments TO authenticated;
GRANT ALL ON TABLE public.call_center_departments TO service_role;
REVOKE ALL ON TABLE public.call_center_department_agents FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_center_department_agents TO anon;
GRANT ALL ON TABLE public.call_center_department_agents TO authenticated;
GRANT ALL ON TABLE public.call_center_department_agents TO service_role;
REVOKE ALL ON TABLE public.workspace_departments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_departments TO anon;
GRANT ALL ON TABLE public.workspace_departments TO authenticated;
GRANT ALL ON TABLE public.workspace_departments TO service_role;
REVOKE ALL ON TABLE public.call_center_agent_presence FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_center_agent_presence TO anon;
GRANT ALL ON TABLE public.call_center_agent_presence TO authenticated;
GRANT ALL ON TABLE public.call_center_agent_presence TO service_role;
REVOKE ALL ON TABLE public.call_queue_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_queue_entries TO anon;
GRANT ALL ON TABLE public.call_queue_entries TO authenticated;
GRANT ALL ON TABLE public.call_queue_entries TO service_role;
REVOKE ALL ON TABLE public.workspace_department_members FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_department_members TO anon;
GRANT ALL ON TABLE public.workspace_department_members TO authenticated;
GRANT ALL ON TABLE public.workspace_department_members TO service_role;
REVOKE ALL ON TABLE public.call_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_sessions TO anon;
GRANT ALL ON TABLE public.call_sessions TO authenticated;
GRANT ALL ON TABLE public.call_sessions TO service_role;
REVOKE ALL ON TABLE public.platform_sms_provider_config FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_sms_provider_config TO anon;
GRANT ALL ON TABLE public.platform_sms_provider_config TO authenticated;
GRANT ALL ON TABLE public.platform_sms_provider_config TO service_role;
REVOKE ALL ON TABLE public.workspace_limit_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_limit_overrides TO anon;
GRANT ALL ON TABLE public.workspace_limit_overrides TO authenticated;
GRANT ALL ON TABLE public.workspace_limit_overrides TO service_role;
REVOKE ALL ON TABLE public.platform_call_center_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_call_center_settings TO anon;
REVOKE SELECT ON TABLE public.platform_call_center_settings FROM anon;
GRANT ALL ON TABLE public.platform_call_center_settings TO authenticated;
GRANT ALL ON TABLE public.platform_call_center_settings TO service_role;
REVOKE ALL ON TABLE public.call_ratings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.call_ratings TO anon;
GRANT ALL ON TABLE public.call_ratings TO authenticated;
GRANT ALL ON TABLE public.call_ratings TO service_role;
REVOKE ALL ON TABLE public.user_phone_verifications FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_phone_verifications TO service_role;
REVOKE ALL ON TABLE public.phone_verification_challenges FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.phone_verification_challenges TO service_role;
REVOKE ALL ON TABLE public.knowledge_base_change_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.knowledge_base_change_events TO anon;
GRANT ALL ON TABLE public.knowledge_base_change_events TO authenticated;
GRANT ALL ON TABLE public.knowledge_base_change_events TO service_role;
REVOKE ALL ON TABLE public.workspace_alert_dismissals FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_alert_dismissals TO anon;
GRANT ALL ON TABLE public.workspace_alert_dismissals TO authenticated;
GRANT ALL ON TABLE public.workspace_alert_dismissals TO service_role;
REVOKE ALL ON TABLE public.widget_smart_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_smart_events TO anon;
GRANT ALL ON TABLE public.widget_smart_events TO authenticated;
GRANT ALL ON TABLE public.widget_smart_events TO service_role;
REVOKE ALL ON TABLE public.team_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.team_messages TO anon;
GRANT ALL ON TABLE public.team_messages TO authenticated;
GRANT ALL ON TABLE public.team_messages TO service_role;
REVOKE ALL ON TABLE public.widget_smart_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_smart_rules TO anon;
GRANT ALL ON TABLE public.widget_smart_rules TO authenticated;
GRANT ALL ON TABLE public.widget_smart_rules TO service_role;
REVOKE ALL ON TABLE public.ai_agent_action_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_action_claims TO anon;
GRANT ALL ON TABLE public.ai_agent_action_claims TO authenticated;
GRANT ALL ON TABLE public.ai_agent_action_claims TO service_role;
REVOKE ALL ON TABLE public.admin_impersonation_tokens FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.admin_impersonation_tokens TO anon;
GRANT ALL ON TABLE public.admin_impersonation_tokens TO authenticated;
GRANT ALL ON TABLE public.admin_impersonation_tokens TO service_role;
REVOKE ALL ON TABLE public.ai_agent_guidance_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_guidance_requests TO anon;
GRANT ALL ON TABLE public.ai_agent_guidance_requests TO authenticated;
GRANT ALL ON TABLE public.ai_agent_guidance_requests TO service_role;
REVOKE ALL ON TABLE public.ai_agent_guidance FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_agent_guidance TO anon;
GRANT ALL ON TABLE public.ai_agent_guidance TO authenticated;
GRANT ALL ON TABLE public.ai_agent_guidance TO service_role;
REVOKE ALL ON TABLE public.channel_provider_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.channel_provider_operations TO anon;
GRANT ALL ON TABLE public.channel_provider_operations TO authenticated;
GRANT ALL ON TABLE public.channel_provider_operations TO service_role;
REVOKE ALL ON TABLE public.kb_article_feedback FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.kb_article_feedback TO anon;
GRANT ALL ON TABLE public.kb_article_feedback TO authenticated;
GRANT ALL ON TABLE public.kb_article_feedback TO service_role;
REVOKE ALL ON TABLE public.widget_prechat_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_prechat_settings TO anon;
GRANT ALL ON TABLE public.widget_prechat_settings TO authenticated;
GRANT ALL ON TABLE public.widget_prechat_settings TO service_role;
REVOKE ALL ON TABLE public.ai_billing_recovery_lease FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ai_billing_recovery_lease TO anon;
GRANT ALL ON TABLE public.ai_billing_recovery_lease TO authenticated;
GRANT ALL ON TABLE public.ai_billing_recovery_lease TO service_role;
REVOKE ALL ON TABLE public.workspace_invitations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitations TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_tokens FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_tokens TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_otps FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_otps TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_proofs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_proofs TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_contexts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_contexts TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_jobs TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_departments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_departments TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_deliveries TO service_role;
REVOKE DELETE ON TABLE public.workspace_invitation_deliveries FROM service_role;
REVOKE ALL ON TABLE public.workspace_member_details FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_member_details TO service_role;
REVOKE ALL ON TABLE public.workspace_member_details_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_member_details_history TO service_role;
REVOKE ALL ON TABLE public.legal_policy_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.legal_policy_versions TO service_role;
REVOKE ALL ON TABLE public.workspace_members FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_members TO anon;
GRANT ALL ON TABLE public.workspace_members TO authenticated;
GRANT ALL ON TABLE public.workspace_members TO service_role;
REVOKE ALL ON TABLE public.workspace_seat_entitlement_mode FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_seat_entitlement_mode TO service_role;
REVOKE ALL ON TABLE public.verification_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_attempts TO service_role;
REVOKE DELETE, UPDATE ON TABLE public.verification_attempts FROM service_role;
REVOKE ALL ON TABLE public.workspace_invitation_idempotency FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_idempotency TO service_role;
REVOKE ALL ON TABLE public.workspace_invitation_consents FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_invitation_consents TO service_role;
REVOKE DELETE ON TABLE public.workspace_invitation_consents FROM service_role;
REVOKE ALL ON TABLE public.verification_challenges FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_challenges TO service_role;
REVOKE ALL ON TABLE public.platform_branding FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_branding TO anon;
GRANT ALL ON TABLE public.platform_branding TO authenticated;
GRANT ALL ON TABLE public.platform_branding TO service_role;
REVOKE ALL ON TABLE public.verification_purpose_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_purpose_settings TO service_role;
REVOKE INSERT, DELETE, UPDATE ON TABLE public.verification_purpose_settings FROM service_role;
REVOKE ALL ON TABLE public.verification_proofs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_proofs TO service_role;
REVOKE ALL ON TABLE public.verification_idempotency FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_idempotency TO service_role;
REVOKE ALL ON TABLE public.verification_delivery_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_delivery_attempts TO service_role;
REVOKE DELETE, UPDATE ON TABLE public.verification_delivery_attempts FROM service_role;
REVOKE ALL ON TABLE public.verification_purpose_settings_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.verification_purpose_settings_audit TO service_role;
REVOKE INSERT, DELETE, UPDATE ON TABLE public.verification_purpose_settings_audit FROM service_role;
REVOKE ALL ON TABLE public.billing_invoices FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_invoices TO anon;
GRANT ALL ON TABLE public.billing_invoices TO authenticated;
GRANT ALL ON TABLE public.billing_invoices TO service_role;
REVOKE ALL ON TABLE public.billing_subscription_applications FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_subscription_applications TO anon;
GRANT ALL ON TABLE public.billing_subscription_applications TO authenticated;
GRANT ALL ON TABLE public.billing_subscription_applications TO service_role;
REVOKE ALL ON TABLE public.billing_invoice_collections FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_invoice_collections TO anon;
GRANT ALL ON TABLE public.billing_invoice_collections TO authenticated;
GRANT ALL ON TABLE public.billing_invoice_collections TO service_role;
REVOKE ALL ON TABLE public.billing_payment_intents FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_payment_intents TO anon;
GRANT ALL ON TABLE public.billing_payment_intents TO authenticated;
GRANT ALL ON TABLE public.billing_payment_intents TO service_role;
REVOKE ALL ON TABLE public.billing_payments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_payments TO anon;
GRANT ALL ON TABLE public.billing_payments TO authenticated;
GRANT ALL ON TABLE public.billing_payments TO service_role;
REVOKE ALL ON TABLE public.billing_notification_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_notification_jobs TO anon;
GRANT ALL ON TABLE public.billing_notification_jobs TO authenticated;
GRANT ALL ON TABLE public.billing_notification_jobs TO service_role;
REVOKE ALL ON TABLE public.billing_entitlement_cycles FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_entitlement_cycles TO anon;
GRANT ALL ON TABLE public.billing_entitlement_cycles TO authenticated;
GRANT ALL ON TABLE public.billing_entitlement_cycles TO service_role;
REVOKE ALL ON TABLE public.billing_wallet_deposits FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_wallet_deposits TO anon;
GRANT ALL ON TABLE public.billing_wallet_deposits TO authenticated;
GRANT ALL ON TABLE public.billing_wallet_deposits TO service_role;
REVOKE ALL ON TABLE public.billing_retention_signals FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_retention_signals TO anon;
GRANT ALL ON TABLE public.billing_retention_signals TO authenticated;
GRANT ALL ON TABLE public.billing_retention_signals TO service_role;
REVOKE ALL ON TABLE public.billing_v2_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_v2_policy TO anon;
GRANT ALL ON TABLE public.billing_v2_policy TO authenticated;
GRANT ALL ON TABLE public.billing_v2_policy TO service_role;
REVOKE ALL ON TABLE public.billing_v2_workspace_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_v2_workspace_policy TO anon;
GRANT ALL ON TABLE public.billing_v2_workspace_policy TO authenticated;
GRANT ALL ON TABLE public.billing_v2_workspace_policy TO service_role;
REVOKE ALL ON TABLE public.billing_wallet_accounts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_wallet_accounts TO anon;
GRANT ALL ON TABLE public.billing_wallet_accounts TO authenticated;
GRANT ALL ON TABLE public.billing_wallet_accounts TO service_role;
REVOKE ALL ON TABLE public.billing_v2_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_v2_audit TO anon;
GRANT ALL ON TABLE public.billing_v2_audit TO authenticated;
GRANT ALL ON TABLE public.billing_v2_audit TO service_role;
REVOKE ALL ON TABLE public.billing_v2_rollout FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_v2_rollout TO anon;
GRANT ALL ON TABLE public.billing_v2_rollout TO authenticated;
GRANT ALL ON TABLE public.billing_v2_rollout TO service_role;
REVOKE ALL ON TABLE public.billing_v2_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_v2_jobs TO anon;
GRANT ALL ON TABLE public.billing_v2_jobs TO authenticated;
GRANT ALL ON TABLE public.billing_v2_jobs TO service_role;
REVOKE ALL ON TABLE public.billing_payment_allocations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_payment_allocations TO anon;
GRANT ALL ON TABLE public.billing_payment_allocations TO authenticated;
GRANT ALL ON TABLE public.billing_payment_allocations TO service_role;
REVOKE ALL ON TABLE public.billing_currencies FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_currencies TO anon;
GRANT ALL ON TABLE public.billing_currencies TO authenticated;
GRANT ALL ON TABLE public.billing_currencies TO service_role;
REVOKE ALL ON TABLE public.billing_exchange_rates FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_exchange_rates TO anon;
GRANT ALL ON TABLE public.billing_exchange_rates TO authenticated;
GRANT ALL ON TABLE public.billing_exchange_rates TO service_role;
REVOKE ALL ON TABLE public.billing_gateways FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_gateways TO anon;
GRANT ALL ON TABLE public.billing_gateways TO authenticated;
GRANT ALL ON TABLE public.billing_gateways TO service_role;
REVOKE ALL ON TABLE public.widget_ai_nudge_session_state FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_ai_nudge_session_state TO anon;
GRANT ALL ON TABLE public.widget_ai_nudge_session_state TO authenticated;
GRANT ALL ON TABLE public.widget_ai_nudge_session_state TO service_role;
REVOKE ALL ON TABLE public.billing_subscription_periods FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_subscription_periods TO anon;
GRANT ALL ON TABLE public.billing_subscription_periods TO authenticated;
GRANT ALL ON TABLE public.billing_subscription_periods TO service_role;
REVOKE ALL ON TABLE public.billing_period_allowance_grants FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_period_allowance_grants TO anon;
GRANT ALL ON TABLE public.billing_period_allowance_grants TO authenticated;
GRANT ALL ON TABLE public.billing_period_allowance_grants TO service_role;
REVOKE ALL ON TABLE public.billing_invoice_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_invoice_lines TO anon;
GRANT ALL ON TABLE public.billing_invoice_lines TO authenticated;
GRANT ALL ON TABLE public.billing_invoice_lines TO service_role;
REVOKE ALL ON TABLE public.billing_wallet_ledger FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_wallet_ledger TO anon;
GRANT ALL ON TABLE public.billing_wallet_ledger TO authenticated;
GRANT ALL ON TABLE public.billing_wallet_ledger TO service_role;
REVOKE ALL ON TABLE public.billing_invoice_applications FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_invoice_applications TO anon;
GRANT ALL ON TABLE public.billing_invoice_applications TO authenticated;
GRANT ALL ON TABLE public.billing_invoice_applications TO service_role;
REVOKE ALL ON TABLE public.billing_tax_rates FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_tax_rates TO anon;
GRANT ALL ON TABLE public.billing_tax_rates TO authenticated;
GRANT ALL ON TABLE public.billing_tax_rates TO service_role;
REVOKE ALL ON TABLE public.billing_coupons FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_coupons TO anon;
GRANT ALL ON TABLE public.billing_coupons TO authenticated;
GRANT ALL ON TABLE public.billing_coupons TO service_role;
REVOKE ALL ON TABLE public.mobile_push_devices FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.mobile_push_devices TO anon;
GRANT ALL ON TABLE public.mobile_push_devices TO authenticated;
GRANT ALL ON TABLE public.mobile_push_devices TO service_role;
REVOKE ALL ON TABLE public.billing_coupon_redemptions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_coupon_redemptions TO anon;
GRANT ALL ON TABLE public.billing_coupon_redemptions TO authenticated;
GRANT ALL ON TABLE public.billing_coupon_redemptions TO service_role;
REVOKE ALL ON TABLE public.billing_usage_items FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_usage_items TO anon;
GRANT ALL ON TABLE public.billing_usage_items TO authenticated;
GRANT ALL ON TABLE public.billing_usage_items TO service_role;
REVOKE ALL ON TABLE public.operator_presence_fallback_state FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.operator_presence_fallback_state TO anon;
GRANT ALL ON TABLE public.operator_presence_fallback_state TO authenticated;
GRANT ALL ON TABLE public.operator_presence_fallback_state TO service_role;
REVOKE ALL ON TABLE public.push_dispatch_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.push_dispatch_log TO anon;
GRANT ALL ON TABLE public.push_dispatch_log TO authenticated;
GRANT ALL ON TABLE public.push_dispatch_log TO service_role;
REVOKE ALL ON TABLE public.user_notification_prefs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_notification_prefs TO anon;
GRANT ALL ON TABLE public.user_notification_prefs TO authenticated;
GRANT ALL ON TABLE public.user_notification_prefs TO service_role;
REVOKE ALL ON TABLE public.background_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.background_jobs TO service_role;
REVOKE ALL ON TABLE public.seo_pages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_pages TO service_role;
REVOKE ALL ON TABLE public.seo_crawls FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_crawls TO service_role;
REVOKE ALL ON TABLE public.seo_links FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_links TO service_role;
REVOKE ALL ON TABLE public.seo_issues FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_issues TO service_role;
REVOKE ALL ON TABLE public.seo_performance_results FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_performance_results TO service_role;
REVOKE ALL ON TABLE public.seo_sitemaps FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_sitemaps TO service_role;
REVOKE ALL ON TABLE public.seo_issue_pages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_issue_pages TO service_role;
REVOKE ALL ON TABLE public.observability_ticker_lease FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.observability_ticker_lease TO anon;
GRANT ALL ON TABLE public.observability_ticker_lease TO authenticated;
GRANT ALL ON TABLE public.observability_ticker_lease TO service_role;
REVOKE ALL ON TABLE public.widget_ai_nudges FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_ai_nudges TO anon;
GRANT ALL ON TABLE public.widget_ai_nudges TO authenticated;
GRANT ALL ON TABLE public.widget_ai_nudges TO service_role;
REVOKE ALL ON TABLE public.widget_ai_nudge_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.widget_ai_nudge_settings TO anon;
GRANT ALL ON TABLE public.widget_ai_nudge_settings TO authenticated;
GRANT ALL ON TABLE public.widget_ai_nudge_settings TO service_role;
REVOKE ALL ON TABLE public.seo_backlink_scans FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_backlink_scans TO service_role;
REVOKE ALL ON TABLE public.platform_ai_agent_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_ai_agent_settings TO anon;
GRANT ALL ON TABLE public.platform_ai_agent_settings TO authenticated;
GRANT ALL ON TABLE public.platform_ai_agent_settings TO service_role;
REVOKE ALL ON TABLE public.billing_provider_credentials FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_provider_credentials TO anon;
GRANT ALL ON TABLE public.billing_provider_credentials TO authenticated;
GRANT ALL ON TABLE public.billing_provider_credentials TO service_role;
REVOKE ALL ON TABLE public.platform_backlinks_provider_config FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_backlinks_provider_config TO anon;
GRANT ALL ON TABLE public.platform_backlinks_provider_config TO authenticated;
GRANT ALL ON TABLE public.platform_backlinks_provider_config TO service_role;
REVOKE ALL ON TABLE public.platform_keywords_provider_config FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_keywords_provider_config TO anon;
GRANT ALL ON TABLE public.platform_keywords_provider_config TO authenticated;
GRANT ALL ON TABLE public.platform_keywords_provider_config TO service_role;
REVOKE ALL ON TABLE public.seo_backlinks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_backlinks TO service_role;
REVOKE ALL ON TABLE public.seo_keyword_research_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_keyword_research_runs TO service_role;
REVOKE ALL ON TABLE public.seo_keyword_results FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_keyword_results TO service_role;
REVOKE ALL ON TABLE public.platform_rank_tracking_provider_config FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_rank_tracking_provider_config TO anon;
GRANT ALL ON TABLE public.platform_rank_tracking_provider_config TO authenticated;
GRANT ALL ON TABLE public.platform_rank_tracking_provider_config TO service_role;
REVOKE ALL ON TABLE public.platform_performance_provider_config FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.platform_performance_provider_config TO anon;
GRANT ALL ON TABLE public.platform_performance_provider_config TO authenticated;
GRANT ALL ON TABLE public.platform_performance_provider_config TO service_role;
REVOKE ALL ON TABLE public.seo_rank_checks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_rank_checks TO service_role;
REVOKE ALL ON TABLE public.seo_tracked_keywords FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_tracked_keywords TO service_role;
REVOKE ALL ON TABLE public.seo_performance_audits FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_performance_audits TO service_role;
REVOKE ALL ON TABLE public.seo_gsc_oauth_states FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_gsc_oauth_states TO service_role;
REVOKE ALL ON TABLE public.seo_explorer_backlinks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_explorer_backlinks TO service_role;
REVOKE ALL ON TABLE public.seo_gsc_query_cache FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_gsc_query_cache TO service_role;
REVOKE ALL ON TABLE public.seo_gsc_connections FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_gsc_connections TO service_role;
REVOKE ALL ON TABLE public.seo_explorer_backlink_scans FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_explorer_backlink_scans TO service_role;
REVOKE ALL ON TABLE public.seo_gsc_properties FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_gsc_properties TO service_role;
REVOKE ALL ON TABLE public.web_analytics_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.web_analytics_events TO service_role;
REVOKE ALL ON TABLE public.seo_explorer_keyword_scans FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_explorer_keyword_scans TO service_role;
REVOKE ALL ON TABLE public.seo_explorer_keywords FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_explorer_keywords TO service_role;
REVOKE ALL ON TABLE public.visitor_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.visitor_sessions TO anon;
GRANT ALL ON TABLE public.visitor_sessions TO authenticated;
GRANT ALL ON TABLE public.visitor_sessions TO service_role;
REVOKE ALL ON TABLE public.bot_log_imports FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.bot_log_imports TO service_role;
REVOKE ALL ON TABLE public.web_analytics_funnels FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.web_analytics_funnels TO service_role;
REVOKE ALL ON SEQUENCE public.bot_visits_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.bot_visits_id_seq TO anon;
GRANT ALL ON SEQUENCE public.bot_visits_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.bot_visits_id_seq TO service_role;
REVOKE ALL ON TABLE public.bot_visits FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.bot_visits TO service_role;
REVOKE ALL ON TABLE public.brand_radar_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.brand_radar_settings TO service_role;
REVOKE ALL ON TABLE public.commerce_pairing_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_pairing_requests TO service_role;
REVOKE ALL ON TABLE public.brand_radar_web_checks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.brand_radar_web_checks TO service_role;
REVOKE ALL ON TABLE public.brand_radar_topics FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.brand_radar_topics TO service_role;
REVOKE ALL ON TABLE public.brand_radar_ai_checks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.brand_radar_ai_checks TO service_role;
REVOKE ALL ON TABLE public.commerce_connections FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_connections TO service_role;
REVOKE ALL ON TABLE public.commerce_sync_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_sync_jobs TO service_role;
REVOKE ALL ON TABLE public.commerce_product_variants FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_product_variants TO service_role;
REVOKE ALL ON TABLE public.commerce_nonce_cache FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_nonce_cache TO service_role;
REVOKE ALL ON TABLE public.commerce_sync_cursors FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_sync_cursors TO service_role;
REVOKE ALL ON TABLE public.commerce_event_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_event_receipts TO service_role;
REVOKE ALL ON TABLE public.commerce_products FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_products TO service_role;
REVOKE ALL ON TABLE public.commerce_tool_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_tool_audit TO service_role;
REVOKE ALL ON TABLE public.seo_rank_check_competitors FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_rank_check_competitors TO service_role;
REVOKE ALL ON TABLE public.seo_explorer_competitor_scans FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_explorer_competitor_scans TO service_role;
REVOKE ALL ON TABLE public.seo_explorer_competitors FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_explorer_competitors TO service_role;
REVOKE ALL ON TABLE public.email_threads FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_threads TO service_role;
REVOKE ALL ON TABLE public.channel_oauth_states FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.channel_oauth_states TO service_role;
REVOKE ALL ON TABLE public.email_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_messages TO service_role;
REVOKE ALL ON TABLE public.seo_crawl_summaries FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_crawl_summaries TO anon;
GRANT ALL ON TABLE public.seo_crawl_summaries TO authenticated;
GRANT ALL ON TABLE public.seo_crawl_summaries TO service_role;
REVOKE ALL ON TABLE public.seo_link_edges FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_link_edges TO anon;
GRANT ALL ON TABLE public.seo_link_edges TO authenticated;
GRANT ALL ON TABLE public.seo_link_edges TO service_role;
REVOKE ALL ON TABLE public.seo_backfill_state FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.seo_backfill_state TO anon;
GRANT ALL ON TABLE public.seo_backfill_state TO authenticated;
GRANT ALL ON TABLE public.seo_backfill_state TO service_role;
REVOKE ALL ON TABLE public.workspace_health_snapshots_2026_09 FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_health_snapshots_2026_09 TO service_role;
REVOKE ALL ON TABLE public.workspace_health_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_health_snapshots TO anon;
GRANT ALL ON TABLE public.workspace_health_snapshots TO authenticated;
GRANT ALL ON TABLE public.workspace_health_snapshots TO service_role;
REVOKE ALL ON TABLE public.workspace_health_snapshots_2026_10 FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_health_snapshots_2026_10 TO service_role;
REVOKE ALL ON TABLE public.workspace_health_snapshots_2026_11 FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_health_snapshots_2026_11 TO service_role;
REVOKE ALL ON TABLE public.workspace_health_snapshots_default FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_health_snapshots_default TO service_role;
REVOKE ALL ON TABLE public.workspace_deletion_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.workspace_deletion_jobs TO service_role;
REVOKE ALL ON TABLE public.user_deletion_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_deletion_jobs TO service_role;
REVOKE ALL ON TABLE public.email_attachments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.email_attachments TO service_role;
REVOKE ALL ON TABLE public.backup_restore_drills FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.backup_restore_drills TO service_role;
REVOKE ALL ON TABLE public.backup_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.backup_runs TO service_role;
REVOKE ALL ON TABLE public.backup_commands FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.backup_commands TO service_role;
REVOKE ALL ON TABLE public.owner_write_leases FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.owner_write_leases TO service_role;
REVOKE ALL ON TABLE public.billing_v2_worker_health FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.billing_v2_worker_health TO anon;
GRANT ALL ON TABLE public.billing_v2_worker_health TO authenticated;
GRANT ALL ON TABLE public.billing_v2_worker_health TO service_role;
REVOKE ALL ON TABLE public.operator_presence_live FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.operator_presence_live TO anon;
GRANT ALL ON TABLE public.operator_presence_live TO authenticated;
GRANT ALL ON TABLE public.operator_presence_live TO service_role;
REVOKE ALL ON TABLE public.notification_email_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.notification_email_jobs TO anon;
GRANT ALL ON TABLE public.notification_email_jobs TO authenticated;
GRANT ALL ON TABLE public.notification_email_jobs TO service_role;
REVOKE ALL ON TABLE public.notification_email_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.notification_email_settings TO anon;
GRANT ALL ON TABLE public.notification_email_settings TO authenticated;
GRANT ALL ON TABLE public.notification_email_settings TO service_role;
REVOKE ALL ON TABLE public.commerce_deleted_entities FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_deleted_entities TO service_role;
REVOKE ALL ON TABLE public.user_email_notification_prefs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_email_notification_prefs TO anon;
GRANT ALL ON TABLE public.user_email_notification_prefs TO authenticated;
GRANT ALL ON TABLE public.user_email_notification_prefs TO service_role;
REVOKE ALL ON TABLE public.commerce_customer_links FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.commerce_customer_links TO service_role;
REVOKE ALL ON TABLE public.push_platform_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.push_platform_settings TO anon;
GRANT ALL ON TABLE public.push_platform_settings TO authenticated;
GRANT ALL ON TABLE public.push_platform_settings TO service_role;
REVOKE ALL ON TABLE public.mobile_app_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.mobile_app_settings TO anon;
GRANT ALL ON TABLE public.mobile_app_settings TO authenticated;
GRANT ALL ON TABLE public.mobile_app_settings TO service_role;
REVOKE ALL ON FUNCTION public.validate_email_log_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.validate_email_log_status() TO PUBLIC;
GRANT ALL ON FUNCTION public.validate_email_log_status() TO anon;
GRANT ALL ON FUNCTION public.validate_email_log_status() TO authenticated;
GRANT ALL ON FUNCTION public.validate_email_log_status() TO service_role;
REVOKE ALL ON FUNCTION public.generate_short_id(prefix text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.generate_short_id(prefix text) TO PUBLIC;
GRANT ALL ON FUNCTION public.generate_short_id(prefix text) TO anon;
GRANT ALL ON FUNCTION public.generate_short_id(prefix text) TO authenticated;
GRANT ALL ON FUNCTION public.generate_short_id(prefix text) TO service_role;
REVOKE ALL ON FUNCTION public.update_workspace_provider_settings_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.update_workspace_provider_settings_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.update_workspace_provider_settings_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_workspace_provider_settings_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_workspace_provider_settings_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.normalize_domain(_input text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.normalize_domain(_input text) TO PUBLIC;
GRANT ALL ON FUNCTION public.normalize_domain(_input text) TO anon;
GRANT ALL ON FUNCTION public.normalize_domain(_input text) TO authenticated;
GRANT ALL ON FUNCTION public.normalize_domain(_input text) TO service_role;
REVOKE ALL ON FUNCTION public.workspace_domains_normalize() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.workspace_domains_normalize() TO PUBLIC;
GRANT ALL ON FUNCTION public.workspace_domains_normalize() TO anon;
GRANT ALL ON FUNCTION public.workspace_domains_normalize() TO authenticated;
GRANT ALL ON FUNCTION public.workspace_domains_normalize() TO service_role;
REVOKE ALL ON FUNCTION public.widget_settings_validate_offline_mode() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.widget_settings_validate_offline_mode() TO PUBLIC;
GRANT ALL ON FUNCTION public.widget_settings_validate_offline_mode() TO anon;
GRANT ALL ON FUNCTION public.widget_settings_validate_offline_mode() TO authenticated;
GRANT ALL ON FUNCTION public.widget_settings_validate_offline_mode() TO service_role;
REVOKE ALL ON FUNCTION public.admin_count_profiles() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_count_profiles() TO service_role;
REVOKE ALL ON FUNCTION public.admin_count_workspaces() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_count_workspaces() TO service_role;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;
REVOKE ALL ON FUNCTION public.widget_platform_settings_touch() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.widget_platform_settings_touch() TO PUBLIC;
GRANT ALL ON FUNCTION public.widget_platform_settings_touch() TO anon;
GRANT ALL ON FUNCTION public.widget_platform_settings_touch() TO authenticated;
GRANT ALL ON FUNCTION public.widget_platform_settings_touch() TO service_role;
REVOKE ALL ON FUNCTION public.set_conversation_notes_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_conversation_notes_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.widget_prechat_settings_touch() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.widget_prechat_settings_touch() TO PUBLIC;
GRANT ALL ON FUNCTION public.widget_prechat_settings_touch() TO anon;
GRANT ALL ON FUNCTION public.widget_prechat_settings_touch() TO authenticated;
GRANT ALL ON FUNCTION public.widget_prechat_settings_touch() TO service_role;
REVOKE ALL ON FUNCTION public.check_module_access(_workspace_id uuid, _module_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.check_module_access(_workspace_id uuid, _module_key text) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_expired_widget_identity() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.cleanup_expired_widget_identity() TO service_role;
REVOKE ALL ON FUNCTION public.set_canned_responses_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_canned_responses_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_canned_responses_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_canned_responses_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_canned_responses_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.ai_kb_set_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.ai_kb_set_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.ai_kb_set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.ai_kb_set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.ai_kb_set_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.set_widget_templates_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_widget_templates_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_widget_templates_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_widget_templates_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_widget_templates_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.touch_user_notification_prefs() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_user_notification_prefs() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_user_notification_prefs() TO anon;
GRANT ALL ON FUNCTION public.touch_user_notification_prefs() TO authenticated;
GRANT ALL ON FUNCTION public.touch_user_notification_prefs() TO service_role;
REVOKE ALL ON FUNCTION public.user_availability_prefs_set_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.user_availability_prefs_set_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.user_availability_prefs_set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.user_availability_prefs_set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.user_availability_prefs_set_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.set_call_queue_entries_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_call_queue_entries_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_call_queue_entries_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_call_queue_entries_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_call_queue_entries_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.set_role_permissions_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_role_permissions_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_role_permissions_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_role_permissions_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_role_permissions_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO PUBLIC;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;
REVOKE ALL ON FUNCTION public.touch_updated_at_e10() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_updated_at_e10() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_updated_at_e10() TO anon;
GRANT ALL ON FUNCTION public.touch_updated_at_e10() TO authenticated;
GRANT ALL ON FUNCTION public.touch_updated_at_e10() TO service_role;
REVOKE ALL ON FUNCTION public.enforcement_rules_protect_builtin() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.enforcement_rules_protect_builtin() TO service_role;
REVOKE ALL ON FUNCTION public.set_operator_call_avail_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_operator_call_avail_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_operator_call_avail_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_operator_call_avail_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_operator_call_avail_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.set_callback_requests_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_callback_requests_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_callback_requests_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_callback_requests_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_callback_requests_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.alert_rules_touch() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.alert_rules_touch() TO PUBLIC;
GRANT ALL ON FUNCTION public.alert_rules_touch() TO anon;
GRANT ALL ON FUNCTION public.alert_rules_touch() TO authenticated;
GRANT ALL ON FUNCTION public.alert_rules_touch() TO service_role;
REVOKE ALL ON FUNCTION public.widget_platform_settings_validate_phase1() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.widget_platform_settings_validate_phase1() TO PUBLIC;
GRANT ALL ON FUNCTION public.widget_platform_settings_validate_phase1() TO anon;
GRANT ALL ON FUNCTION public.widget_platform_settings_validate_phase1() TO authenticated;
GRANT ALL ON FUNCTION public.widget_platform_settings_validate_phase1() TO service_role;
REVOKE ALL ON FUNCTION public.set_workspace_departments_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_workspace_departments_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_workspace_departments_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_workspace_departments_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_workspace_departments_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.set_call_invitations_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.set_call_invitations_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.set_call_invitations_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_call_invitations_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_call_invitations_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.alert_rules_validate_fields() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.alert_rules_validate_fields() TO PUBLIC;
GRANT ALL ON FUNCTION public.alert_rules_validate_fields() TO anon;
GRANT ALL ON FUNCTION public.alert_rules_validate_fields() TO authenticated;
GRANT ALL ON FUNCTION public.alert_rules_validate_fields() TO service_role;
REVOKE ALL ON FUNCTION public.touch_ai_source_sync_jobs() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_ai_source_sync_jobs() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_ai_source_sync_jobs() TO anon;
GRANT ALL ON FUNCTION public.touch_ai_source_sync_jobs() TO authenticated;
GRANT ALL ON FUNCTION public.touch_ai_source_sync_jobs() TO service_role;
REVOKE ALL ON FUNCTION public.touch_auto_action_definitions() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_auto_action_definitions() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_auto_action_definitions() TO anon;
GRANT ALL ON FUNCTION public.touch_auto_action_definitions() TO authenticated;
GRANT ALL ON FUNCTION public.touch_auto_action_definitions() TO service_role;
REVOKE ALL ON FUNCTION public.slo_definitions_touch() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.slo_definitions_touch() TO PUBLIC;
GRANT ALL ON FUNCTION public.slo_definitions_touch() TO anon;
GRANT ALL ON FUNCTION public.slo_definitions_touch() TO authenticated;
GRANT ALL ON FUNCTION public.slo_definitions_touch() TO service_role;
REVOKE ALL ON FUNCTION public.touch_enforcement_rules() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_enforcement_rules() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_enforcement_rules() TO anon;
GRANT ALL ON FUNCTION public.touch_enforcement_rules() TO authenticated;
GRANT ALL ON FUNCTION public.touch_enforcement_rules() TO service_role;
REVOKE ALL ON FUNCTION public.touch_call_sessions_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_call_sessions_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_call_sessions_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_call_sessions_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_call_sessions_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.cc_touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.cc_touch_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.cc_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.cc_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.cc_touch_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.tg_visitor_sessions_count_visitor() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_visitor_sessions_count_visitor() TO service_role;
REVOKE ALL ON FUNCTION public.touch_ai_agent_test_cases_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_ai_agent_test_cases_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_ai_agent_test_cases_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_ai_agent_test_cases_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_ai_agent_test_cases_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.count_recent_login_failures(_ip text, _email text, _window_minutes integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.count_recent_login_failures(_ip text, _email text, _window_minutes integer) TO service_role;
REVOKE ALL ON FUNCTION public.increment_usage_counter(_workspace_id uuid, _counter_name text, _amount integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.increment_usage_counter(_workspace_id uuid, _counter_name text, _amount integer) TO service_role;
REVOKE ALL ON FUNCTION public.admin_list_login_attempts(_email text, _limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_list_login_attempts(_email text, _limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.mask_phone_e164(_phone text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.mask_phone_e164(_phone text) TO PUBLIC;
GRANT ALL ON FUNCTION public.mask_phone_e164(_phone text) TO anon;
GRANT ALL ON FUNCTION public.mask_phone_e164(_phone text) TO authenticated;
GRANT ALL ON FUNCTION public.mask_phone_e164(_phone text) TO service_role;
REVOKE ALL ON FUNCTION public.get_account_role(_account_id uuid, _user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.get_account_role(_account_id uuid, _user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_account_role(_account_id uuid, _user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.user_phone_verified(_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.user_phone_verified(_user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.defer_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _retry_seconds integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.defer_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _retry_seconds integer) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_claim_attempt(_challenge_id uuid, _user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phone_verification_invalidate(_challenge_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_invalidate(_challenge_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.phone_status_matches(_phone text, _verified_at timestamp with time zone, _filter text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_status_matches(_phone text, _verified_at timestamp with time zone, _filter text) TO authenticated;
GRANT ALL ON FUNCTION public.phone_status_matches(_phone text, _verified_at timestamp with time zone, _filter text) TO service_role;
REVOKE ALL ON FUNCTION public.fail_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _error_detail text, _retry_seconds integer, _permanent boolean, _max_attempts integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.fail_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[], _error_code text, _error_detail text, _retry_seconds integer, _permanent boolean, _max_attempts integer) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_consume(_challenge_id uuid, _user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phone_verification_admin_resend_requested(_challenge_id uuid, _user_id uuid, _admin_id uuid, _phone_masked text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_admin_resend_requested(_challenge_id uuid, _user_id uuid, _admin_id uuid, _phone_masked text) TO service_role;
REVOKE ALL ON FUNCTION public.default_workspace_permission(_role text, _permission_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.default_workspace_permission(_role text, _permission_key text) TO authenticated;
GRANT ALL ON FUNCTION public.default_workspace_permission(_role text, _permission_key text) TO service_role;
REVOKE ALL ON FUNCTION public.has_workspace_permission(_workspace_id uuid, _user_id uuid, _permission_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.has_workspace_permission(_workspace_id uuid, _user_id uuid, _permission_key text) TO service_role;
REVOKE ALL ON FUNCTION public.entitlement_fanout_touch() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.entitlement_fanout_touch() TO PUBLIC;
GRANT ALL ON FUNCTION public.entitlement_fanout_touch() TO anon;
GRANT ALL ON FUNCTION public.entitlement_fanout_touch() TO authenticated;
GRANT ALL ON FUNCTION public.entitlement_fanout_touch() TO service_role;
REVOKE ALL ON FUNCTION public.admin_list_profiles(_actor_user_id uuid, _limit integer, _offset integer, _search text, _sort text, _phone_status text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_list_profiles(_actor_user_id uuid, _limit integer, _offset integer, _search text, _sort text, _phone_status text) TO service_role;
REVOKE ALL ON FUNCTION public.touch_updated_at_generic() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.touch_updated_at_generic() TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_updated_at_generic() TO anon;
GRANT ALL ON FUNCTION public.touch_updated_at_generic() TO authenticated;
GRANT ALL ON FUNCTION public.touch_updated_at_generic() TO service_role;
REVOKE ALL ON FUNCTION public.bump_usage_counter_for(_workspace_id uuid, _counter_name text, _amount integer, _at timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.bump_usage_counter_for(_workspace_id uuid, _counter_name text, _amount integer, _at timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.tg_ai_usage_logs_count_request() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_ai_usage_logs_count_request() TO service_role;
REVOKE ALL ON FUNCTION public.legal_policy_versions_immutable() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.legal_policy_versions_immutable() TO PUBLIC;
GRANT ALL ON FUNCTION public.legal_policy_versions_immutable() TO anon;
GRANT ALL ON FUNCTION public.legal_policy_versions_immutable() TO authenticated;
GRANT ALL ON FUNCTION public.legal_policy_versions_immutable() TO service_role;
REVOKE ALL ON FUNCTION public.workspace_invitations_version_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.workspace_invitations_version_guard() TO PUBLIC;
GRANT ALL ON FUNCTION public.workspace_invitations_version_guard() TO anon;
GRANT ALL ON FUNCTION public.workspace_invitations_version_guard() TO authenticated;
GRANT ALL ON FUNCTION public.workspace_invitations_version_guard() TO service_role;
REVOKE ALL ON FUNCTION public.workspace_invitations_legacy_status_sync() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.workspace_invitations_legacy_status_sync() TO PUBLIC;
GRANT ALL ON FUNCTION public.workspace_invitations_legacy_status_sync() TO anon;
GRANT ALL ON FUNCTION public.workspace_invitations_legacy_status_sync() TO authenticated;
GRANT ALL ON FUNCTION public.workspace_invitations_legacy_status_sync() TO service_role;
REVOKE ALL ON FUNCTION public.ai_billing_block_pricing_mutation() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.ai_billing_block_pricing_mutation() TO service_role;
REVOKE ALL ON FUNCTION public.apply_storage_usage_log() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.apply_storage_usage_log() TO service_role;
REVOKE ALL ON FUNCTION public.backup_claim_command() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.backup_claim_command() TO service_role;
REVOKE ALL ON FUNCTION public.backup_health() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.backup_health() TO service_role;
REVOKE ALL ON FUNCTION public.billing_notify_payment_recorded() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_notify_payment_recorded() TO service_role;
REVOKE ALL ON FUNCTION public.gv_admin_consumer_implemented(_purpose text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.gv_admin_consumer_implemented(_purpose text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_reset_preserved_tables(_scope text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_reset_preserved_tables(_scope text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_reset_identity_tables() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_reset_identity_tables() TO service_role;
REVOKE ALL ON FUNCTION public.billing_touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_touch_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.billing_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.billing_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.billing_touch_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.commerce_products_search_text_trigger() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.commerce_products_search_text_trigger() TO PUBLIC;
GRANT ALL ON FUNCTION public.commerce_products_search_text_trigger() TO anon;
GRANT ALL ON FUNCTION public.commerce_products_search_text_trigger() TO authenticated;
GRANT ALL ON FUNCTION public.commerce_products_search_text_trigger() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_block_legacy_allowance_grant() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_block_legacy_allowance_grant() TO PUBLIC;
GRANT ALL ON FUNCTION public.billing_v2_block_legacy_allowance_grant() TO anon;
GRANT ALL ON FUNCTION public.billing_v2_block_legacy_allowance_grant() TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_block_legacy_allowance_grant() TO service_role;
REVOKE ALL ON FUNCTION public.admin_reset_settings_tables() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_reset_settings_tables() TO service_role;
REVOKE ALL ON FUNCTION public.billing_purge_active() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_purge_active() TO anon;
GRANT ALL ON FUNCTION public.billing_purge_active() TO authenticated;
GRANT ALL ON FUNCTION public.billing_purge_active() TO service_role;
REVOKE ALL ON FUNCTION public.partition_managed_tables() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_managed_tables() TO service_role;
REVOKE ALL ON FUNCTION public.billing_invoice_application_block_mutation() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_invoice_application_block_mutation() TO anon;
GRANT ALL ON FUNCTION public.billing_invoice_application_block_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.billing_invoice_application_block_mutation() TO service_role;
REVOKE ALL ON FUNCTION public.billing_invoice_freeze() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_invoice_freeze() TO anon;
GRANT ALL ON FUNCTION public.billing_invoice_freeze() TO authenticated;
GRANT ALL ON FUNCTION public.billing_invoice_freeze() TO service_role;
REVOKE ALL ON FUNCTION public.billing_invoice_line_freeze() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_invoice_line_freeze() TO anon;
GRANT ALL ON FUNCTION public.billing_invoice_line_freeze() TO authenticated;
GRANT ALL ON FUNCTION public.billing_invoice_line_freeze() TO service_role;
REVOKE ALL ON FUNCTION public.partition_inventory() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_inventory() TO service_role;
REVOKE ALL ON FUNCTION public.partition_health() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_health() TO service_role;
REVOKE ALL ON FUNCTION public.backup_touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.backup_touch_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.backup_reject_credentials() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.backup_reject_credentials() TO service_role;
REVOKE ALL ON FUNCTION public.billing_period_freeze() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_period_freeze() TO anon;
GRANT ALL ON FUNCTION public.billing_period_freeze() TO authenticated;
GRANT ALL ON FUNCTION public.billing_period_freeze() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_assert_single_scheduled_period() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_assert_single_scheduled_period() TO anon;
GRANT ALL ON FUNCTION public.billing_v2_assert_single_scheduled_period() TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_assert_single_scheduled_period() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_add_interval(p_ts timestamp with time zone, p_interval text, p_count integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_add_interval(p_ts timestamp with time zone, p_interval text, p_count integer) TO anon;
GRANT ALL ON FUNCTION public.billing_v2_add_interval(p_ts timestamp with time zone, p_interval text, p_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_add_interval(p_ts timestamp with time zone, p_interval text, p_count integer) TO service_role;
REVOKE ALL ON FUNCTION public.billing_allocation_block_mutation() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_allocation_block_mutation() TO anon;
GRANT ALL ON FUNCTION public.billing_allocation_block_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.billing_allocation_block_mutation() TO service_role;
REVOKE ALL ON FUNCTION public.billing_engine_version_freeze() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_engine_version_freeze() TO anon;
GRANT ALL ON FUNCTION public.billing_engine_version_freeze() TO authenticated;
GRANT ALL ON FUNCTION public.billing_engine_version_freeze() TO service_role;
REVOKE ALL ON FUNCTION public.billing_entitlement_cycle_freeze() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_entitlement_cycle_freeze() TO anon;
GRANT ALL ON FUNCTION public.billing_entitlement_cycle_freeze() TO authenticated;
GRANT ALL ON FUNCTION public.billing_entitlement_cycle_freeze() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_block_direct_subscription_mutation() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_block_direct_subscription_mutation() TO anon;
GRANT ALL ON FUNCTION public.billing_v2_block_direct_subscription_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_block_direct_subscription_mutation() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_block_period_keyed_grant() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_block_period_keyed_grant() TO anon;
GRANT ALL ON FUNCTION public.billing_v2_block_period_keyed_grant() TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_block_period_keyed_grant() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_document_number() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_document_number() TO anon;
GRANT ALL ON FUNCTION public.billing_v2_document_number() TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_document_number() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_period_cycles_grant(p_period_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_period_cycles_grant(p_period_id uuid) TO anon;
GRANT ALL ON FUNCTION public.billing_v2_period_cycles_grant(p_period_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_period_cycles_grant(p_period_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_period_monthly_allowance(p_period billing_subscription_periods) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_period_monthly_allowance(p_period billing_subscription_periods) TO anon;
GRANT ALL ON FUNCTION public.billing_v2_period_monthly_allowance(p_period billing_subscription_periods) TO authenticated;
GRANT ALL ON FUNCTION public.billing_v2_period_monthly_allowance(p_period billing_subscription_periods) TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_notification_sync() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_invoice_notification_sync() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_paid_recovery() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_invoice_paid_recovery() TO service_role;
REVOKE ALL ON FUNCTION public.billing_wallet_ledger_block_mutation() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_wallet_ledger_block_mutation() TO anon;
GRANT ALL ON FUNCTION public.billing_wallet_ledger_block_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.billing_wallet_ledger_block_mutation() TO service_role;
REVOKE ALL ON FUNCTION public.admin_count_profiles(_actor_user_id uuid, _search text, _phone_status text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_count_profiles(_actor_user_id uuid, _search text, _phone_status text) TO service_role;
REVOKE ALL ON FUNCTION public.accept_workspace_invitation(_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.accept_workspace_invitation(_token text) TO service_role;
REVOKE ALL ON FUNCTION public.tg_conversation_attachments_touch_message() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_conversation_attachments_touch_message() TO PUBLIC;
GRANT ALL ON FUNCTION public.tg_conversation_attachments_touch_message() TO anon;
GRANT ALL ON FUNCTION public.tg_conversation_attachments_touch_message() TO authenticated;
GRANT ALL ON FUNCTION public.tg_conversation_attachments_touch_message() TO service_role;
REVOKE ALL ON FUNCTION public.tg_conversation_messages_touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_conversation_messages_touch_updated_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.tg_conversation_messages_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.tg_conversation_messages_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.tg_conversation_messages_touch_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.activate_auto_actions() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.activate_auto_actions() TO service_role;
REVOKE ALL ON FUNCTION public.admin_count_workspaces(_actor_user_id uuid, _search text, _phone_status text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_count_workspaces(_actor_user_id uuid, _search text, _phone_status text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_get_user_detail(_actor_user_id uuid, _user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_get_user_detail(_actor_user_id uuid, _user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_reset_billing_data(p_confirm text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_reset_billing_data(p_confirm text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_get_workspace_detail(_actor_user_id uuid, _workspace_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_get_workspace_detail(_actor_user_id uuid, _workspace_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_list_profiles(_limit integer, _offset integer, _search text, _sort text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_list_profiles(_limit integer, _offset integer, _search text, _sort text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_list_realtime_audit(_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_list_realtime_audit(_limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.admin_list_workspaces(_limit integer, _offset integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_list_workspaces(_limit integer, _offset integer) TO service_role;
REVOKE ALL ON FUNCTION public.admin_list_workspaces(_actor_user_id uuid, _limit integer, _offset integer, _search text, _sort text, _phone_status text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_list_workspaces(_actor_user_id uuid, _limit integer, _offset integer, _search text, _sort text, _phone_status text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_security_stats() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_security_stats() TO service_role;
REVOKE ALL ON FUNCTION public.backup_wal_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.backup_wal_status() TO service_role;
REVOKE ALL ON FUNCTION public.billing_enroll_workspace() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_enroll_workspace() TO service_role;
REVOKE ALL ON FUNCTION public.billing_notify_subscription_lifecycle() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_notify_subscription_lifecycle() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_arm_dunning() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_invoice_arm_dunning() TO service_role;
REVOKE ALL ON FUNCTION public.billing_v2_payment_after_fallback() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.billing_v2_payment_after_fallback() TO service_role;
REVOKE ALL ON FUNCTION public.is_ip_blocked(_ip text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.is_ip_blocked(_ip text) TO service_role;
REVOKE ALL ON FUNCTION public.kb_detach_articles_before_category_delete() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.kb_detach_articles_before_category_delete() TO service_role;
REVOKE ALL ON FUNCTION public.bootstrap_admin(_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.bootstrap_admin(_user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.bulk_create_contacts(_workspace_id uuid, _contacts jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.bulk_create_contacts(_workspace_id uuid, _contacts jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.business_metrics_rollup_and_prune() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.business_metrics_rollup_and_prune() TO service_role;
REVOKE ALL ON FUNCTION public.complete_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.complete_kb_change_events(_claim_token uuid, _worker_id text, _ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.check_channel_access(_workspace_id uuid, _channel_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.check_channel_access(_workspace_id uuid, _channel_key text) TO service_role;
REVOKE ALL ON FUNCTION public.check_workspace_entitlement(_workspace_id uuid, _feature text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.check_workspace_entitlement(_workspace_id uuid, _feature text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_conversation(p_conversation_id uuid, p_workspace_id uuid, p_user_id uuid, p_force boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.claim_conversation(p_conversation_id uuid, p_workspace_id uuid, p_user_id uuid, p_force boolean) TO service_role;
REVOKE ALL ON FUNCTION public.claim_kb_change_events(_worker_id text, _limit integer, _lease_seconds integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.claim_kb_change_events(_worker_id text, _limit integer, _lease_seconds integer) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_expired_auth_tokens() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.cleanup_expired_auth_tokens() TO service_role;
REVOKE ALL ON FUNCTION public.commerce_purge_expired_deletions() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.commerce_purge_expired_deletions() TO service_role;
REVOKE ALL ON FUNCTION public.commerce_sweep_absent_products(p_connection_id uuid, p_sweep_epoch timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.commerce_sweep_absent_products(p_connection_id uuid, p_sweep_epoch timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.create_contact(_workspace_id uuid, _email text, _name text, _phone text, _avatar_url text, _tags text[], _notes text, _metadata jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.create_contact(_workspace_id uuid, _email text, _name text, _phone text, _avatar_url text, _tags text[], _notes text, _metadata jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.enqueue_kb_catchup(_workspace_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.enqueue_kb_catchup(_workspace_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.expire_stale_trials() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.expire_stale_trials() TO service_role;
REVOKE ALL ON FUNCTION public.gv_admin_sanitize_settings(_s verification_purpose_settings) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.gv_admin_sanitize_settings(_s verification_purpose_settings) TO service_role;
REVOKE ALL ON FUNCTION public.gv_admin_default_settings(_purpose text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.gv_admin_default_settings(_purpose text) TO service_role;
REVOKE ALL ON FUNCTION public.gv_admin_deployment_allowlisted(_purpose text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.gv_admin_deployment_allowlisted(_purpose text) TO service_role;
REVOKE ALL ON FUNCTION public.kb_search_articles(p_workspace_id uuid, p_locale text, p_query text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.kb_search_articles(p_workspace_id uuid, p_locale text, p_query text, p_limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.knowledge_base_emit_change_event() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.knowledge_base_emit_change_event() TO service_role;
REVOKE ALL ON FUNCTION public.mark_conversation_seen(_conversation_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.mark_conversation_seen(_conversation_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.merge_visitor_into_contact(_workspace_id uuid, _visitor_id text, _contact_id uuid, _method text, _metadata jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.merge_visitor_into_contact(_workspace_id uuid, _visitor_id text, _contact_id uuid, _method text, _metadata jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.partition_ensure_all(_months integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_ensure_all(_months integer) TO service_role;
REVOKE ALL ON FUNCTION public.partition_ensure_future(_parent text, _months integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_ensure_future(_parent text, _months integer) TO service_role;
REVOKE ALL ON FUNCTION public.partition_ensure_month(_parent text, _month date) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_ensure_month(_parent text, _month date) TO service_role;
REVOKE ALL ON FUNCTION public.partition_exact_count(_partition text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_exact_count(_partition text) TO service_role;
REVOKE ALL ON FUNCTION public.partition_retention_candidates(_parent text, _cutoff timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.partition_retention_candidates(_parent text, _cutoff timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_cancel(_user_id uuid, _challenge_id uuid, _actor_user_id uuid, _workspace_id uuid, _purpose text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_cancel(_user_id uuid, _challenge_id uuid, _actor_user_id uuid, _workspace_id uuid, _purpose text) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_finalize_admin_resend(_challenge_id uuid, _admin_id uuid, _sent boolean, _provider_name text, _provider_message_id text, _error_code text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_finalize_admin_resend(_challenge_id uuid, _admin_id uuid, _sent boolean, _provider_name text, _provider_message_id text, _error_code text) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_manual_verify(_user_id uuid, _admin_id uuid, _reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_manual_verify(_user_id uuid, _admin_id uuid, _reason text) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_mark_delivery(_challenge_id uuid, _sent boolean, _provider_name text, _provider_message_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_mark_delivery(_challenge_id uuid, _sent boolean, _provider_name text, _provider_message_id text) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_start(_challenge_id uuid, _user_id uuid, _phone text, _purpose text, _code_digest text, _ttl_seconds integer, _created_by text, _created_by_admin_id uuid, _created_ip_hash text, _max_attempts integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_start(_challenge_id uuid, _user_id uuid, _phone text, _purpose text, _code_digest text, _ttl_seconds integer, _created_by text, _created_by_admin_id uuid, _created_ip_hash text, _max_attempts integer) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_state(_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_state(_user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.phone_verification_verify(_challenge_id uuid, _user_id uuid, _candidate_digest text, _actor_user_id uuid, _workspace_id uuid, _purpose text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.phone_verification_verify(_challenge_id uuid, _user_id uuid, _candidate_digest text, _actor_user_id uuid, _workspace_id uuid, _purpose text) TO service_role;
REVOKE ALL ON FUNCTION public.protect_workspace_domain_fields() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.protect_workspace_domain_fields() TO service_role;
REVOKE ALL ON FUNCTION public.register_workspace_domain(_workspace_id uuid, _raw_domain text, _make_primary boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.register_workspace_domain(_workspace_id uuid, _raw_domain text, _make_primary boolean) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_privacy_subject(_workspace_id uuid, _subject_type text, _subject_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.resolve_privacy_subject(_workspace_id uuid, _subject_type text, _subject_id text) TO service_role;
REVOKE ALL ON FUNCTION public.retention_partition_preview(_policy_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.retention_partition_preview(_policy_key text) TO service_role;
REVOKE ALL ON FUNCTION public.sla_reliability_rollup_and_prune() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.sla_reliability_rollup_and_prune() TO service_role;
REVOKE ALL ON FUNCTION public.slo_definitions_protect_builtin() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.slo_definitions_protect_builtin() TO service_role;
REVOKE ALL ON FUNCTION public.tg_call_sessions_bill_minutes() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_call_sessions_bill_minutes() TO service_role;
REVOKE ALL ON FUNCTION public.tg_conversation_messages_count_message() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_conversation_messages_count_message() TO service_role;
REVOKE ALL ON FUNCTION public.tg_conversations_count_conversation() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.tg_conversations_count_conversation() TO service_role;
REVOKE ALL ON FUNCTION public.validate_widget_template_slug() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.validate_widget_template_slug() TO service_role;
REVOKE ALL ON FUNCTION public.workspaces_auto_register_owner_domain() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.workspaces_auto_register_owner_domain() TO service_role;
REVOKE ALL ON FUNCTION public.workspace_health_snapshot_compute() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.workspace_health_snapshot_compute() TO service_role;
REVOKE ALL ON FUNCTION public.workspace_usage_counters_seed_storage() FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.workspace_usage_counters_seed_storage() TO service_role;
REVOKE ALL ON FUNCTION public.deduct_ai_credits(_workspace_id uuid, _credits integer, _period text) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.deduct_ai_credits(_workspace_id uuid, _credits integer, _period text) TO service_role;

-- ── realtime publication ────────────────────────────────────
DO $parity$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'team_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.team_messages;
  END IF;
END $parity$;

-- ── seed rows ───────────────────────────────────────────────
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('8c1da852-0925-4ba6-99dc-86fd4b7af319', 'subscribe_failed_spike', 'Subscribe failures spiking', 'Absolute count of realtime.subscribe_failed events in the window.', 'count', 'realtime.subscribe_failed', NULL, NULL, 300, 20, 100, 0, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('a4cb89c9-c755-4c87-8bc3-da75594cd659', 'token_refresh_failed_sustained', 'Token refresh failing repeatedly', 'Absolute count of realtime.token_refresh_failed in the window.', 'count', 'realtime.token_refresh_failed', NULL, NULL, 300, 5, 25, 0, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('111fb1b7-7cf4-41bc-9f3f-c810cdeab198', 'ws_error_spike', 'WebSocket errors spiking', 'Absolute count of realtime.ws_error in the window.', 'count', 'realtime.ws_error', NULL, NULL, 300, 25, 150, 0, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('2d7ac89a-99fc-4d7f-996b-d5ba287b8fc2', 'channel_ownership_reject_burst', 'Channel ownership rejects (possible abuse)', 'Bursts of realtime.channel_ownership_reject indicate misuse or bug.', 'count', 'realtime.channel_ownership_reject', NULL, NULL, 300, 10, 50, 0, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('36cfa841-dfba-4849-b10b-78527e6dfd57', 'subscribe_failed_ratio', 'High subscribe failure ratio', 'subscribe_failed / token_minted exceeds threshold.', 'ratio', NULL, 'realtime.subscribe_failed', 'realtime.token_minted', 300, 0.05, 0.20, 20, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('698e36f1-934c-43f6-807b-405851ba2670', 'fallback_engaged_ratio', 'High realtime → polling fallback ratio', 'fallback_engaged / reconnect_attempt exceeds threshold.', 'ratio', NULL, 'realtime.fallback_engaged', 'realtime.reconnect_attempt', 600, 0.10, 0.30, 20, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('d2ea3993-9e55-4a89-ab14-1ceeb3faaba0', 'ws_error_ratio', 'High WebSocket error ratio per reconnect', 'ws_error / reconnect_attempt exceeds threshold.', 'ratio', NULL, 'realtime.ws_error', 'realtime.reconnect_attempt', 600, 0.20, 0.50, 20, true, true, '2026-09-30 04:33:58.765779+00', '2026-09-30 04:33:58.765779+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('574c6c39-ce93-4479-a4f5-1ada01b4f5ec', 'operator_connect_p95_latency', 'Operator connect p95 latency high', 'p95 latency of /api/realtime/operator-connect over the window.', 'perf_p95', NULL, NULL, NULL, 300, 800, 2000, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'realtime.operator_connect', '[]', 'p95_ms') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('f1d3c734-e547-451f-b440-2549087112b1', 'subscribe_p95_latency', 'Realtime subscribe p95 latency high', 'p95 latency of /api/realtime/subscribe over the window.', 'perf_p95', NULL, NULL, NULL, 300, 700, 1500, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'realtime.subscribe', '[]', 'p95_ms') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('dd3edca8-4ea1-4e97-b4a7-56b2903a42a8', 'widget_bootstrap_p95_latency', 'Widget bootstrap p95 latency high', 'p95 latency of /api/widget/bootstrap over the window.', 'perf_p95', NULL, NULL, NULL, 300, 1000, 2500, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'widget.bootstrap', '[]', 'p95_ms') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('fed99b65-2090-47b1-8018-2500bcba9026', 'session_refresh_p95_latency', 'Widget session refresh p95 latency high', 'p95 latency of /api/widget/session/refresh over the window.', 'perf_p95', NULL, NULL, NULL, 300, 600, 1500, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'widget.session_refresh', '[]', 'p95_ms') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('d9ca266e-0b06-40bf-a621-edf448d57400', 'widget_action_p95_latency', 'Widget action p95 latency high', 'p95 latency of /api/widget/action over the window.', 'perf_p95', NULL, NULL, NULL, 300, 500, 1200, 30, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'widget.action', '[]', 'p95_ms') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('81002a08-1f4e-4f9d-8cfa-348880f83d28', 'operator_connect_error_rate', 'Operator connect error rate elevated', '5xx rate on /api/realtime/operator-connect.', 'perf_error_rate', NULL, NULL, NULL, 300, 0.02, 0.05, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'realtime.operator_connect', '[]', 'error_rate') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('60bc9099-3a66-4d6f-94dd-05058b058405', 'subscribe_error_rate', 'Realtime subscribe error rate elevated', '5xx rate on /api/realtime/subscribe.', 'perf_error_rate', NULL, NULL, NULL, 300, 0.02, 0.05, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'realtime.subscribe', '[]', 'error_rate') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('ccd8398f-c13f-4909-831f-cfebb40ff752', 'widget_bootstrap_error_rate', 'Widget bootstrap error rate elevated', '5xx rate on /api/widget/bootstrap.', 'perf_error_rate', NULL, NULL, NULL, 300, 0.03, 0.08, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'widget.bootstrap', '[]', 'error_rate') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('77902f44-9450-45d5-b97e-ff9dff06229b', 'session_refresh_error_rate', 'Widget session refresh error rate elevated', '5xx rate on /api/widget/session/refresh.', 'perf_error_rate', NULL, NULL, NULL, 300, 0.03, 0.08, 20, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', 'widget.session_refresh', '[]', 'error_rate') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('a97a5d4e-445b-4a56-8d32-a59b82eb0354', 'event_loop_lag_sustained', 'Event loop lag sustained high', 'Average node event-loop lag (ms) over the window.', 'process_avg', 'event_loop_lag_ms', NULL, NULL, 300, 80, 150, 3, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', NULL, '[]', 'avg_ms') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('3453c116-e51e-48b0-97a8-f17423332451', 'rss_memory_high', 'RSS memory sustained high', 'avg(RSS) / perf_memory_budget_mb. Threshold is a fraction (0..1).', 'process_avg', 'rss_pct_of_budget', NULL, NULL, 600, 0.70, 0.85, 5, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', NULL, '[]', 'fraction') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('8b7af00c-229b-477a-9a3a-8517098a2d8f', 'heap_usage_high', 'Heap usage sustained high', 'avg(heap_used) / avg(heap_total). Threshold is a fraction (0..1).', 'process_ratio', 'heap_used_over_total', NULL, NULL, 600, 0.75, 0.90, 5, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', NULL, '[]', 'fraction') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('b9b40dc6-3877-40cb-bb11-891dac420ba2', 'realtime_degradation_combined', 'Realtime degradation (combined)', 'Open if any realtime degradation signal is currently firing.', 'combined', NULL, NULL, NULL, 300, 1, 2, 0, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', NULL, '["operator_connect_p95_latency", "subscribe_p95_latency", "operator_connect_error_rate", "subscribe_error_rate", "fallback_engaged_ratio", "ws_error_ratio"]', 'or_open') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('47c2fbc8-4642-46a3-94cf-ea11b47457be', 'overload_suspected', 'Server overload suspected', 'Open if event-loop lag and any p95 latency rule are firing together.', 'combined', NULL, NULL, NULL, 300, 2, 3, 0, true, true, '2026-09-30 04:33:58.867909+00', '2026-09-30 04:33:58.867909+00', NULL, '["event_loop_lag_sustained", "widget_bootstrap_p95_latency", "operator_connect_p95_latency", "heap_usage_high"]', 'or_open') ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('3903913b-5298-4346-b640-570581f5a949', 'platform_uptime_breach', 'Platform uptime breach', 'Triggered when platform uptime falls below SLO in the last hour.', 'count', 'platform.uptime_breach', NULL, NULL, 3600, 1, 3, 1, true, true, '2026-09-30 04:33:59.07956+00', '2026-09-30 04:33:59.07956+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('25221ae7-b669-4735-b79c-b17ef6033de8', 'degraded_minutes_high', 'High degraded minutes', 'Auto-actions kept platform in degraded mode for too long.', 'count', 'platform.degraded_minute', NULL, NULL, 3600, 10, 30, 1, true, true, '2026-09-30 04:33:59.07956+00', '2026-09-30 04:33:59.07956+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('dee1661a-174a-481f-ae7a-945348441529', 'failover_frequency_high', 'Failover frequency high', 'Realtime failover engine switched providers too often.', 'count', 'realtime.failover_switch', NULL, NULL, 3600, 3, 6, 1, true, true, '2026-09-30 04:33:59.07956+00', '2026-09-30 04:33:59.07956+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('2da123a2-22cb-41fa-91ac-98408e52ffdf', 'first_response_time_breach', 'First response time breach', 'p95 first-response time crossed SLO target.', 'count', 'workspace.frt_breach', NULL, NULL, 3600, 1, 3, 1, true, true, '2026-09-30 04:33:59.07956+00', '2026-09-30 04:33:59.07956+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('3a5f0941-79b8-493c-8e74-ba59406e00b9', 'unanswered_conversation_spike', 'Unanswered conversations spike', 'Workspace has too many unanswered open conversations.', 'count', 'workspace.unanswered_high', NULL, NULL, 3600, 1, 3, 1, true, true, '2026-09-30 04:33:59.07956+00', '2026-09-30 04:33:59.07956+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.alert_rules (id, slug, title, description, kind, metric, numerator, denominator, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin, created_at, updated_at, route_group, subrules, aggregation) VALUES ('5e38c8e8-5e02-4d4c-af9c-d3c480c4feaa', 'workspace_health_score_low', 'Workspace health score low', 'A workspace fell into the at_risk band.', 'count', 'workspace.health_at_risk', NULL, NULL, 3600, 1, 3, 1, true, true, '2026-09-30 04:33:59.07956+00', '2026-09-30 04:33:59.07956+00', NULL, '[]', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('map_geo_settings', '{"geo": {"enabled": true, "store_raw_ip": false, "default_provider": "maxmind_local", "cache_ttl_seconds": 2592000, "preferred_precision": "city", "min_accuracy_for_map": "city", "raw_ip_retention_days": 7, "allow_centroid_fallback": true, "auto_enrich_on_session_create": true}, "tiles": {"max_zoom": 19, "min_zoom": 0, "provider": "self_hosted_raster", "subdomains": "", "attribution": "", "url_template": ""}, "behavior": {"default_zoom": 2, "debug_metadata": false, "default_center_lat": 0, "default_center_lng": 0, "include_geo_labels": true, "default_center_mode": "auto", "ignore_fallback_only": false, "show_only_valid_coords": true}, "maxmind_local": {"db_path": "/app/data/GeoLite2-City.mmdb", "enabled": true, "auto_reload": true, "cache_ttl_seconds": 2592000}, "maxmind_update": {"mode": "manual", "account_id": "", "edition_id": "GeoLite2-City", "last_error": null, "last_run_at": null, "last_status": null, "license_key": "", "interval_hours": 168}}', '2026-09-30 04:33:58.227647+00') ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('enforcement_kill_switch', '{"enabled": false}', '2026-09-30 04:33:59.153823+00') ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('enforcement_dry_run', '{"enabled": false}', '2026-09-30 04:33:59.153823+00') ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('enforcement_max_concurrent', '{"value": 5}', '2026-09-30 04:33:59.153823+00') ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('call_control_plane', '{"enabled": false, "fallback_policy": "lenient", "max_participants": 8, "primary_provider": "livekit", "secondary_provider": "jitsi", "default_video_profile": "h264_baseline_720p", "recording_default_type": "composite", "retention_default_days": 30, "recording_default_enabled": false, "default_audio_bitrate_kbps": 32, "default_video_bitrate_kbps": 1200, "verification_required_for_visitor_calls": true}', '2026-09-30 04:33:59.337522+00') ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('call_rtc_endpoints', '{"turn": {"urls": [], "username": null, "credential": null, "credential_type": "password", "static_secret_present": false}, "region": null, "ws_url": null, "rtc_url": null, "ice_policy": "all", "recording_url": null}', '2026-09-30 04:33:59.337522+00') ON CONFLICT DO NOTHING;
INSERT INTO public.app_runtime_config (key, value, updated_at) VALUES ('call_livekit_config', '{"region": null, "ws_url": null, "api_key": null, "enabled": false, "rtc_url": null, "api_secret": null, "egress_url": null, "egress_enabled": false, "recording_storage": {"bucket": null, "region": null, "vendor": null, "endpoint": null, "force_path_style": false, "access_key_present": false, "secret_key_present": false}, "webhook_secret_present": false}', '2026-09-30 04:33:59.372005+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('a7cb9503-e63c-4b0d-862e-36a8e8f64df8', 'overload_disable_typing', 'Pause typing indicators under overload', 'Temporarily stops broadcasting typing indicators to reduce realtime pressure when overload is suspected.', 'disable_typing_temporarily', 'overload_suspected', 'warn', false, 600, 600, true, '2026-09-30 04:33:58.922176+00', '2026-09-30 04:33:58.922176+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('747ec160-1ee0-4409-b418-217eaa84bc7f', 'realtime_force_polling', 'Force polling fallback during realtime degradation', 'Signals widget clients to use polling instead of websockets when combined realtime degradation is detected.', 'force_polling_mode', 'realtime_degradation_combined', 'critical', false, 900, 900, true, '2026-09-30 04:33:58.922176+00', '2026-09-30 04:33:58.922176+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('cc30feca-92b7-4ac8-9136-f2d8493d7137', 'eventloop_backoff', 'Increase reconnect backoff on event-loop pressure', 'Raises the reconnect backoff floor when the event loop is sustained under heavy lag, reducing reconnect storms.', 'increase_reconnect_backoff', 'event_loop_lag_sustained', 'critical', false, 600, 600, true, '2026-09-30 04:33:58.922176+00', '2026-09-30 04:33:58.922176+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('8dd670e2-b342-4259-989e-8601a543cf3b', 'system_degraded_banner', 'Mark system as degraded', 'Surfaces a degraded-system banner in admin UI when any critical alert fires. Purely informational; never blocks chat send flow.', 'mark_system_degraded', NULL, 'critical', true, 300, 900, true, '2026-09-30 04:33:58.922176+00', '2026-09-30 04:33:58.922176+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('65cc5300-5f8f-4940-b2ac-e61d40c73a46', 'throttle_new_conversations_builtin', 'Throttle new conversations', 'Asks widget clients to slow new conversation creation under load. Reversible.', 'throttle_new_conversations', NULL, 'critical', false, 600, 900, true, '2026-09-30 04:33:59.151774+00', '2026-09-30 04:33:59.151774+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('3bfa4093-5419-42c0-a982-bac680f3c3f6', 'slow_mode_messages_builtin', 'Slow-mode messages', 'Adds a small client-side delay between messages to reduce burst load.', 'slow_mode_messages', NULL, 'critical', false, 600, 900, true, '2026-09-30 04:33:59.151774+00', '2026-09-30 04:33:59.151774+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('10669821-7c8a-4e0c-a7eb-7c1e4a48e548', 'operator_load_shedding_builtin', 'Operator load shedding', 'Reduces non-critical operator UI polling/subscriptions when overloaded.', 'operator_load_shedding', NULL, 'critical', false, 600, 900, true, '2026-09-30 04:33:59.151774+00', '2026-09-30 04:33:59.151774+00') ON CONFLICT DO NOTHING;
INSERT INTO public.auto_action_definitions (id, slug, title, description, action_type, trigger_rule_slug, min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin, created_at, updated_at) VALUES ('60c474a6-80d8-401b-a6ec-ac47abbbf254', 'priority_only_mode_builtin', 'Priority-only mode', 'Routes only high-priority conversations through realtime; others poll.', 'priority_only_mode', NULL, 'critical', false, 900, 1800, true, '2026-09-30 04:33:59.151774+00', '2026-09-30 04:33:59.151774+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('48b20db7-53f7-4f26-a728-cd10f9df2a73', 'manual', '{"en": "Manual / bank transfer", "fa": "پرداخت دستی / کارت به کارت", "tr": "Manuel ödeme"}', false, false, '{IRR,USD,EUR,TRY}', '{}', 0, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('4ac2a14c-5507-4f67-b4c9-3631301769db', 'zarinpal', '{"en": "ZarinPal", "fa": "زرین‌پال", "tr": "ZarinPal"}', false, false, '{IRR}', '{}', 1, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('4b0f176d-e009-47ce-be24-c5de96dc4e8b', 'zarinpal_test', '{"en": "ZarinPal (test)", "fa": "زرین‌پال (تست)", "tr": "ZarinPal (test)"}', false, true, '{IRR}', '{}', 2, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('7b48b89a-eaf7-434c-8137-78c0a2992e7c', 'zibal', '{"en": "Zibal", "fa": "زیبال", "tr": "Zibal"}', false, false, '{IRR}', '{}', 3, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('f3dcf64f-cfff-4121-8511-3bc4d8eeeea7', 'idpay', '{"en": "IDPay", "fa": "آیدی‌پی", "tr": "IDPay"}', false, false, '{IRR}', '{}', 4, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('30462f98-e134-4761-b86b-abcc09a5d261', 'payping', '{"en": "PayPing", "fa": "پی‌پینگ", "tr": "PayPing"}', false, false, '{IRR}', '{}', 5, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('911462b5-c5e0-423f-b338-08385b311e65', 'nextpay', '{"en": "NextPay", "fa": "نکست‌پی", "tr": "NextPay"}', false, false, '{IRR}', '{}', 6, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('f18a4f2a-401a-4410-a1e6-f17bf4c7d8f4', 'sep_shaparak', '{"en": "SEP Shaparak", "fa": "سامان (سپ)", "tr": "SEP"}', false, false, '{IRR}', '{}', 7, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('295d1bfb-28ae-4bfd-abe2-8cc3c43e6be7', 'stripe', '{"en": "Stripe", "fa": "استرایپ", "tr": "Stripe"}', false, false, '{USD,EUR,TRY}', '{}', 8, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('fcc50968-c474-4e75-801a-f6fb8bb39893', 'paddle', '{"en": "Paddle", "fa": "پدل", "tr": "Paddle"}', false, false, '{USD,EUR}', '{}', 9, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('b3527571-ca21-4b1a-bb63-d82655768086', 'paypal', '{"en": "PayPal", "fa": "پی‌پال", "tr": "PayPal"}', false, false, '{USD,EUR}', '{}', 10, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('12c1937a-3983-41a1-8b3c-df368b510ffa', 'lemon_squeezy', '{"en": "Lemon Squeezy", "fa": "لمون اسکوییزی", "tr": "Lemon Squeezy"}', false, false, '{USD,EUR}', '{}', 11, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('2bb9a944-5c1d-40d6-8c62-b5cc6ea46f52', 'iyzico', '{"en": "iyzico", "fa": "آیزیکو", "tr": "iyzico"}', false, false, '{TRY}', '{}', 12, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('e34e660d-1589-4180-a188-935b9a28d1a0', 'paytr', '{"en": "PayTR", "fa": "پی‌تی‌آر", "tr": "PayTR"}', false, false, '{TRY}', '{}', 13, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('417928ad-0d3d-42ab-9b71-58c0e55d2260', 'sipay', '{"en": "Sipay", "fa": "سای‌پی", "tr": "Sipay"}', false, false, '{TRY}', '{}', 14, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('dddb05d1-7479-4a74-9227-66d59161a6f2', 'paratika', '{"en": "Paratika", "fa": "پاراتیکا", "tr": "Paratika"}', false, false, '{TRY}', '{}', 15, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('bd14fb31-8e81-4d0c-a7f2-207d0a25c184', 'craftgate', '{"en": "Craftgate", "fa": "کرفت‌گیت", "tr": "Craftgate"}', false, false, '{TRY}', '{}', 16, '{}', '2026-09-30 04:34:09.2415+00', '2026-09-30 04:34:09.2415+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_gateways (id, provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config, created_at, updated_at) VALUES ('31a99b21-8ea9-4c7a-9e03-349609f2887a', 'internal_test', '{"en": "Internal test gateway (simulator)", "fa": "درگاه تست داخلی (شبیه‌ساز)", "tr": "Dahili test sağlayıcısı"}', false, true, '{IRR}', '{IR}', 17, '{}', '2026-09-30 04:34:10.211301+00', '2026-09-30 04:34:10.211301+00') ON CONFLICT DO NOTHING;
INSERT INTO public.billing_plans (id, name, slug, description, sort_order, prices, default_currency, entitlements, limits, provider_price_ids, is_active, is_free, trial_days, created_at, updated_at, localized, is_hidden) VALUES ('8356c240-83f4-4673-853a-7998880f145f', 'Free', 'free', 'Get started with basic features', 0, '{"EUR": {"yearly": 0, "monthly": 0}, "IRR": {"yearly": 0, "monthly": 0}, "TRY": {"yearly": 0, "monthly": 0}, "USD": {"yearly": 0, "monthly": 0}}', 'USD', '{"ai_kb_builder": false, "knowledge_base": true, "custom_branding": false, "priority_support": false, "widget_powered_by": true}', '{"max_agents": 2, "storage_gb": 1, "max_contacts": 100, "max_visitors": 1000, "ai_kb_max_depth": 1, "ai_kb_max_pages": 3, "max_conversations": 50, "ai_credits_per_month": 0, "ai_kb_jobs_per_month": 1, "max_concurrent_calls": -1}', '{}', true, true, 0, '2026-09-30 04:33:55.443055+00', '2026-09-30 04:34:05.643934+00', '{}', false) ON CONFLICT DO NOTHING;
INSERT INTO public.billing_plans (id, name, slug, description, sort_order, prices, default_currency, entitlements, limits, provider_price_ids, is_active, is_free, trial_days, created_at, updated_at, localized, is_hidden) VALUES ('792f14fe-e2a2-429a-93be-3e5ebee1cacc', 'Pro', 'pro', 'For growing teams', 1, '{"EUR": {"yearly": 27000, "monthly": 2700}, "IRR": {"yearly": 150000000, "monthly": 15000000}, "TRY": {"yearly": 999000, "monthly": 99900}, "USD": {"yearly": 29000, "monthly": 2900}}', 'USD', '{"ai_kb_builder": true, "knowledge_base": true, "custom_branding": true, "priority_support": false, "widget_powered_by": true}', '{"max_agents": 10, "storage_gb": 5, "max_contacts": 5000, "max_visitors": 50000, "ai_kb_max_depth": 2, "ai_kb_max_pages": 25, "max_conversations": 1000, "ai_credits_per_month": 5000, "ai_kb_jobs_per_month": 5, "max_concurrent_calls": -1}', '{}', true, false, 0, '2026-09-30 04:33:55.443055+00', '2026-09-30 04:34:05.643934+00', '{}', false) ON CONFLICT DO NOTHING;
INSERT INTO public.billing_plans (id, name, slug, description, sort_order, prices, default_currency, entitlements, limits, provider_price_ids, is_active, is_free, trial_days, created_at, updated_at, localized, is_hidden) VALUES ('ebb18964-c5c8-44a2-ab70-afb548f2de0f', 'Enterprise', 'enterprise', 'For large organizations', 2, '{"EUR": {"yearly": 92000, "monthly": 9200}, "IRR": {"yearly": 500000000, "monthly": 50000000}, "TRY": {"yearly": 3499000, "monthly": 349900}, "USD": {"yearly": 99000, "monthly": 9900}}', 'USD', '{"sso": true, "api_access": true, "audit_logs": true, "ai_kb_builder": true, "knowledge_base": true, "custom_branding": true, "priority_support": true, "widget_powered_by": true}', '{"max_agents": -1, "storage_gb": 50, "max_contacts": -1, "max_visitors": -1, "ai_kb_max_depth": 3, "ai_kb_max_pages": 200, "max_conversations": -1, "ai_credits_per_month": -1, "ai_kb_jobs_per_month": 50, "max_concurrent_calls": -1}', '{}', true, false, 0, '2026-09-30 04:33:55.443055+00', '2026-09-30 04:34:05.643934+00', '{}', false) ON CONFLICT DO NOTHING;
INSERT INTO public.billing_plans (id, name, slug, description, sort_order, prices, default_currency, entitlements, limits, provider_price_ids, is_active, is_free, trial_days, created_at, updated_at, localized, is_hidden) VALUES ('eabf137e-79d3-41bb-8dd1-9ee2689fb9bf', 'Trial', 'trial', 'Auto-assigned trial plan with full access for new workspaces. Hidden from end-users.', -1, '{"EUR": {"yearly": 0, "monthly": 0}, "IRR": {"yearly": 0, "monthly": 0}, "TRY": {"yearly": 0, "monthly": 0}, "USD": {"yearly": 0, "monthly": 0}}', 'USD', '{"sms": true, "sso": true, "chat": true, "email": true, "video": true, "voice": true, "telegram": true, "whatsapp": true, "analytics": true, "instagram": true, "api_access": true, "audit_logs": true, "automation": true, "call_center": true, "chat_widget": true, "help_center": true, "omnichannel": true, "voice_video": true, "ai_assistant": true, "knowledge_base": true, "custom_branding": true, "email_campaigns": true, "priority_support": true, "visitor_tracking": true, "widget_powered_by": true}', '{"max_contacts": -1}', '{}', true, false, 14, '2026-09-30 04:34:02.493562+00', '2026-09-30 04:34:05.643934+00', '{"en": {"name": "Trial", "description": "Full-access trial plan auto-assigned to new workspaces."}, "fa": {"name": "دوره آزمایشی", "description": "پلن آزمایشی با دسترسی کامل برای کاربران جدید."}, "tr": {"name": "Deneme", "description": "Yeni çalışma alanları için tam erişimli deneme planı."}}', true) ON CONFLICT DO NOTHING;
INSERT INTO public.enforcement_rules (id, slug, title, description, trigger_type, condition_json, actions_json, cooldown_seconds, ttl_seconds, enabled, is_builtin, created_at, updated_at, priority) VALUES ('3e7091ff-698f-439c-b265-912b07d48cc1', 'health_score_critical', 'Health < 40 → force polling', 'When health drops below 40, force polling transport across clients.', 'health_score', '{"scope": "any", "max_score": 40}', '["mark_system_degraded", "force_polling_mode", "disable_typing_temporarily"]', 600, 900, true, true, '2026-09-30 04:33:59.152745+00', '2026-09-30 04:33:59.207407+00', 900) ON CONFLICT DO NOTHING;
INSERT INTO public.enforcement_rules (id, slug, title, description, trigger_type, condition_json, actions_json, cooldown_seconds, ttl_seconds, enabled, is_builtin, created_at, updated_at, priority) VALUES ('bdbf5139-5f7a-46f3-8df2-1747112ae5fd', 'platform_uptime_breach_degraded', 'Platform uptime breach → degraded mode', 'When the platform uptime SLO is breached, mark system degraded.', 'slo_breach', '{"slo_slug": "platform_uptime", "min_consecutive_breaches": 1}', '["mark_system_degraded"]', 600, 1800, true, true, '2026-09-30 04:33:59.152745+00', '2026-09-30 04:33:59.21069+00', 800) ON CONFLICT DO NOTHING;
INSERT INTO public.enforcement_rules (id, slug, title, description, trigger_type, condition_json, actions_json, cooldown_seconds, ttl_seconds, enabled, is_builtin, created_at, updated_at, priority) VALUES ('a00fb530-db75-477d-a904-9c6075cd088c', 'health_score_warning', 'Health < 60 → degraded + typing off', 'When workspace or platform health drops below 60, mark degraded and suppress typing.', 'health_score', '{"scope": "any", "max_score": 60, "min_score": 40}', '["mark_system_degraded", "disable_typing_temporarily"]', 600, 900, true, true, '2026-09-30 04:33:59.152745+00', '2026-09-30 04:33:59.211272+00', 700) ON CONFLICT DO NOTHING;
INSERT INTO public.enforcement_rules (id, slug, title, description, trigger_type, condition_json, actions_json, cooldown_seconds, ttl_seconds, enabled, is_builtin, created_at, updated_at, priority) VALUES ('bf421a63-5964-4bbe-a2e3-ef252d678638', 'frt_p95_breach_throttle', 'FRT p95 breach → throttle conversations', 'When first-response-time p95 SLO is breached, throttle new conversations.', 'slo_breach', '{"slo_slug": "first_response_time_p95", "min_consecutive_breaches": 2}', '["throttle_new_conversations", "slow_mode_messages"]', 900, 1200, true, true, '2026-09-30 04:33:59.152745+00', '2026-09-30 04:33:59.211921+00', 500) ON CONFLICT DO NOTHING;
INSERT INTO public.enforcement_rules (id, slug, title, description, trigger_type, condition_json, actions_json, cooldown_seconds, ttl_seconds, enabled, is_builtin, created_at, updated_at, priority) VALUES ('1da0b657-c0dc-4d7e-b5a2-88ae673a5f06', 'alert_rate_high_priority_only', 'High alert rate → priority-only mode', 'When critical alerts spike, switch to priority-only routing.', 'alert_rate', '{"window_seconds": 600, "min_critical_in_window": 5}', '["priority_only_mode", "operator_load_shedding"]', 900, 1800, true, true, '2026-09-30 04:33:59.152745+00', '2026-09-30 04:33:59.212417+00', 400) ON CONFLICT DO NOTHING;
INSERT INTO public.platform_call_center_settings (id, singleton, call_center_enabled, voice_calls_enabled, video_calls_enabled, callback_requests_enabled, call_recording_enabled, screen_share_enabled, call_transfer_enabled, departments_enabled, advanced_routing_enabled, max_concurrent_calls_per_workspace, max_queue_size_per_workspace, max_monthly_call_minutes_per_workspace, max_callback_requests_per_month, max_recording_storage_mb, disabled_message, created_at, updated_at, callback_show_when_online, callback_min_seconds_between_requests, callback_max_per_ip_per_hour, callback_require_contact, callback_min_message_length, callback_honeypot_enabled, callback_min_form_seconds, ringback_enabled, ringback_mode, ringback_music_url, queue_show_position, queue_show_eta, queue_eta_seconds_per_position, queue_offer_callback_after_seconds, operator_new_call_sound_enabled, widget_default_locale, widget_available_locales, ringback_music_path, ringback_announcement_audio_path, ringback_queue_audio_paths) VALUES ('4a0c553a-0e0a-4563-9737-58825fdfceef', true, false, true, true, true, false, false, false, false, false, 50, 100, 100000, 10000, 10000, '{}', '2026-09-30 04:34:01.28986+00', '2026-09-30 04:34:01.28986+00', true, 600, 5, true, 0, true, 3, true, 'tone', NULL, true, true, 45, 60, true, 'en', '{en,fa,tr}', NULL, NULL, '{}') ON CONFLICT DO NOTHING;
INSERT INTO public.platform_settings (id, site_mode, default_locale, panel_default_locale, widget_default_locale, fallback_locale, active_locales, timezone, created_at, updated_at, maintenance_mode, maintenance_message, locale_billing_providers, region_mode, region_currency, signup_verification_method, signup_verification_gate, signup_default_plan_mode, signup_trial_plan_id, signup_trial_days) VALUES ('a5140009-9356-4935-9eb8-0c5e80e69578', 'multi_language', 'en', 'en', 'en', 'en', '{en}', 'UTC', '2026-09-30 04:33:55.539154+00', '2026-09-30 04:33:55.539154+00', false, NULL, '{}', 'multi', NULL, 'link', 'before', 'free', NULL, 14) ON CONFLICT DO NOTHING;
INSERT INTO public.realtime_failover_state (id, effective_provider, last_failover_at, last_failover_reason, candidate_recovery_provider, candidate_recovery_since, failback_eligible_at, cooldown_until, last_health, last_evaluated_at, updated_at) VALUES ('singleton', 'centrifugo', NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-09-30 04:33:59.001831+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('fd1235a4-f0b6-442d-bea7-fc985ae8cab2', NULL, 'owner', 'can_start_audio_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('7c1bd71d-0531-47a0-9c72-ab2dc01545fb', NULL, 'owner', 'can_start_video_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('187191ae-4079-4fdf-9604-78e2b57c4ae2', NULL, 'owner', 'can_receive_audio_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('6bc77d18-adb2-451a-92b6-e3885932f40f', NULL, 'owner', 'can_receive_video_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('025fcd53-2383-42d1-bc19-57c1047c1add', NULL, 'owner', 'can_record_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('90a85598-d466-432b-a101-1ce3d6efe471', NULL, 'owner', 'can_transfer_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('73e85a5d-cc44-42d0-891a-b1b7e09f8984', NULL, 'owner', 'can_join_queue_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('ce67dcc2-6d0f-4909-974e-754222b4644d', NULL, 'owner', 'can_manage_call_queue', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('e3d1aa5f-fbef-41b2-b016-751ec5022556', NULL, 'admin', 'can_start_audio_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('7433c660-b735-4e8a-8580-298c89d2357f', NULL, 'admin', 'can_start_video_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('e8f098c9-25f2-45e8-a39e-aafd3a42ac72', NULL, 'admin', 'can_receive_audio_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('c4f4ab2f-7296-4628-94cc-c163e475b0c6', NULL, 'admin', 'can_receive_video_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('696f4e53-3b7c-4aa3-8ea4-7813688c42bd', NULL, 'admin', 'can_record_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('d0b940b2-d545-4cfd-a299-0bb060add542', NULL, 'admin', 'can_transfer_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('3c24239a-f0ce-44bc-9dda-450705e3fb53', NULL, 'admin', 'can_join_queue_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('84741481-0228-4d89-b409-b6d1b3dfe1e3', NULL, 'admin', 'can_manage_call_queue', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('7ba2e1f0-b422-4aa9-abbe-9a27ede4317e', NULL, 'agent', 'can_start_audio_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('abb0f96a-75e1-4244-8a29-f963234fb07d', NULL, 'agent', 'can_start_video_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('e36e7c22-3d74-4326-a52f-05524cada371', NULL, 'agent', 'can_receive_audio_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('2ba15870-4646-4884-a7ef-06aae8bcb6cd', NULL, 'agent', 'can_receive_video_call', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('5ba7d679-c779-4b06-adf6-258a33f73c62', NULL, 'agent', 'can_record_calls', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('efcc074f-33f1-47a4-92b8-a45104e20d37', NULL, 'agent', 'can_transfer_calls', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('0133e7ec-8195-4fcd-91b5-780fa4d4051d', NULL, 'agent', 'can_join_queue_calls', true, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('7e483bfe-ff68-4442-8ccd-12e644531313', NULL, 'agent', 'can_manage_call_queue', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('dc1287a6-58c5-4ab1-9af9-93f58cfd29f2', NULL, 'viewer', 'can_start_audio_call', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('e38060a2-ae73-43e7-893d-c3e659a86a98', NULL, 'viewer', 'can_start_video_call', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('0b46203c-455e-43ee-a822-a2539f3521d4', NULL, 'viewer', 'can_receive_audio_call', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('e8dfe730-4c36-45ea-ae77-318a1c3e3a62', NULL, 'viewer', 'can_receive_video_call', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('e87209a2-82d3-40a0-a4b8-362ced54e51e', NULL, 'viewer', 'can_record_calls', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('996e3bad-a5dd-4219-a681-a0d598559079', NULL, 'viewer', 'can_transfer_calls', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('d88c48a1-4c72-4d10-826d-ed892117a489', NULL, 'viewer', 'can_join_queue_calls', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (id, workspace_id, role_slug, permission_key, granted, created_at, updated_at) VALUES ('d22f0337-9692-4d13-9159-24dce6d43005', NULL, 'viewer', 'can_manage_call_queue', false, '2026-09-30 04:33:59.458531+00', '2026-09-30 04:33:59.458531+00') ON CONFLICT DO NOTHING;
INSERT INTO public.slo_definitions (id, slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin, created_at, updated_at) VALUES ('0cb372b7-6c80-40cb-acb3-73535bec4dbc', 'platform_uptime_24h', 'Platform uptime (24h)', 'Percent of time platform was not in degraded mode in the last 24h.', 'platform', 'uptime_pct', 'min', 99.0, 86400, true, true, '2026-09-30 04:33:59.077299+00', '2026-09-30 04:33:59.077299+00') ON CONFLICT DO NOTHING;
INSERT INTO public.slo_definitions (id, slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin, created_at, updated_at) VALUES ('541db7fd-557b-4d70-b20c-a1ce97e63869', 'realtime_availability_24h', 'Realtime availability (24h)', 'Percent of time realtime was not forced to polling in the last 24h.', 'platform', 'realtime_availability_pct', 'min', 99.0, 86400, true, true, '2026-09-30 04:33:59.077299+00', '2026-09-30 04:33:59.077299+00') ON CONFLICT DO NOTHING;
INSERT INTO public.slo_definitions (id, slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin, created_at, updated_at) VALUES ('fb76d53c-c9f0-4efa-828b-76e5255fb03e', 'failover_recovery_seconds', 'Failover recovery time', 'Mean seconds between alert fire and resolve.', 'platform', 'mean_failover_recovery_seconds', 'max', 300, 86400, true, true, '2026-09-30 04:33:59.077299+00', '2026-09-30 04:33:59.077299+00') ON CONFLICT DO NOTHING;
INSERT INTO public.slo_definitions (id, slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin, created_at, updated_at) VALUES ('cb92dfbc-e843-4bbb-b356-b467e26c07a0', 'first_response_time_p95', 'First response time p95', 'Per-workspace 95th percentile first-response time, in seconds.', 'workspace', 'first_response_time_p95', 'max', 600, 86400, true, true, '2026-09-30 04:33:59.077299+00', '2026-09-30 04:33:59.077299+00') ON CONFLICT DO NOTHING;
INSERT INTO public.slo_definitions (id, slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin, created_at, updated_at) VALUES ('f0e36659-d0c3-45e4-adc6-e1933a2a3f0c', 'unanswered_conversation_ratio', 'Unanswered open conversations', 'Per-workspace unanswered open conversations.', 'workspace', 'unanswered_conversations', 'max', 20, 86400, true, true, '2026-09-30 04:33:59.077299+00', '2026-09-30 04:33:59.077299+00') ON CONFLICT DO NOTHING;
INSERT INTO public.slo_definitions (id, slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin, created_at, updated_at) VALUES ('e4367cdb-bf23-4ba9-bbac-770d7e9225c6', 'workspace_health_score', 'Workspace health score', 'Per-workspace overall health score.', 'workspace', 'health_score', 'min', 60, 86400, true, true, '2026-09-30 04:33:59.077299+00', '2026-09-30 04:33:59.077299+00') ON CONFLICT DO NOTHING;
INSERT INTO public.widget_templates (id, slug, name, description, status, enabled, is_builtin, sort_order, metadata, created_at, updated_at) VALUES ('a25826ee-431c-443b-8a23-d4c938f8742b', 'template2', 'Widget Template 2', 'Premium chat skin with vivid blue accent, curved header, Vazirmatn typography. RTL-friendly.', 'hidden', false, false, 10, '{"font": "Vazirmatn", "preview": {"kind": "default"}, "primary": "#0066ff"}', '2026-09-30 04:34:02.002398+00', '2026-09-30 04:34:03.946197+00') ON CONFLICT DO NOTHING;
INSERT INTO public.widget_templates (id, slug, name, description, status, enabled, is_builtin, sort_order, metadata, created_at, updated_at) VALUES ('d33d4466-9056-4550-814c-4e3c2544cbf7', 'default', 'Default Widget', 'The current production widget template. Built-in and always available as a fallback.', 'active', true, true, 0, '{}', '2026-09-30 04:33:58.307363+00', '2026-09-30 04:34:03.948071+00') ON CONFLICT DO NOTHING;
INSERT INTO public.workspace_seat_entitlement_mode (id, mode, source, config_version, updated_by, updated_at, seat_limit) VALUES (true, 'plan_authoritative', 'hosted_bootstrap', 1, NULL, '2026-09-30 04:34:07.11891+00', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'account_expiry', 'en', 'Your account expires in {days_left} days — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Account Expiry</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Account expiring soon ⏰</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your <strong>{plan}</strong> plan on <strong>{brand}</strong> expires in <strong>{days_left} days</strong>. Renew now to keep your data and access.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Renew Now</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Your {plan} plan expires in {days_left} days. Renew: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'account_expiry' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'account_expiry', 'fa', 'حساب شما تا {days_left} روز دیگر منقضی می‌شود — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>انقضای حساب</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">حساب در حال انقضا ⏰</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن <strong>{plan}</strong> شما در <strong>{brand}</strong> تا <strong>{days_left} روز</strong> دیگر منقضی می‌شود.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">تمدید</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، پلن {plan} شما تا {days_left} روز دیگر منقضی می‌شود. تمدید: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'account_expiry' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'account_expiry', 'tr', 'Hesabınız {days_left} gün içinde sona eriyor — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Hesap Süresi</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Hesap süresi doluyor ⏰</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{brand}</strong> uzerindeki <strong>{plan}</strong> planınız <strong>{days_left} gün</strong> icinde sona eriyor.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Şimdi Yenile</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {plan} planınız {days_left} gün icinde sona eriyor. Yenile: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'account_expiry' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'ai_credit_purchased', 'en', 'AI credit added — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AI credit added</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">AI credit added</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your AI credit purchase was completed and the new balance is available right away.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View balance</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Your AI credit purchase of {amount} was completed.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'ai_credit_purchased' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'ai_credit_purchased', 'fa', 'اعتبار هوش مصنوعی شما افزایش یافت — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>اعتبار هوش مصنوعی شارژ شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">اعتبار هوش مصنوعی شارژ شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">خرید اعتبار هوش مصنوعی شما با موفقیت ثبت شد و اعتبار جدید بلافاصله قابل استفاده است.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده اعتبار</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'خرید اعتبار هوش مصنوعی به مبلغ {amount} ثبت شد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'ai_credit_purchased' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'ai_credit_purchased', 'tr', 'AI kredisi eklendi — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AI kredisi eklendi</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">AI kredisi eklendi</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">AI kredi satın alımınız tamamlandı ve yeni bakiye hemen kullanılabilir.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Bakiyeyi görüntüle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{amount} tutarındaki AI kredi satın alımınız tamamlandı.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'ai_credit_purchased' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'email_verify', 'en', 'Verify your email address — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verify Email</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Verify your email address</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Thank you for signing up for <strong>{brand}</strong>! Please verify your email address to activate your account and get started.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">This link will expire in <strong>{expiry_time}</strong>.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Verify Email Address</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Thank you for signing up for {brand}! Verify your email: {action_url} This link expires in {expiry_time}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'email_verify' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'email_verify', 'fa', 'تایید آدرس ایمیل — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>تایید ایمیل</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">تایید آدرس ایمیل شما</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">از ثبت‌نام شما در <strong>{brand}</strong> سپاسگزاریم! لطفاً آدرس ایمیل خود را تایید کنید تا حساب‌تان فعال شود.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">این لینک تا <strong>{expiry_time}</strong> معتبر است.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">تایید ایمیل</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، برای تایید ایمیل روی لینک زیر کلیک کنید: {action_url} این لینک تا {expiry_time} معتبر است.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'email_verify' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'email_verify', 'tr', 'E-posta adresinizi doğrulayın — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>E-posta Doğrulama</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">E-posta adresinizi doğrulayın</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{brand}</strong> kaydolduğunuz için teşekkürler! Hesabınızı aktifleştirmek için e-posta adresinizi doğrulayın.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Bu bağlantının süresi <strong>{expiry_time}</strong> içinde dolacaktır.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">E-postayı Doğrula</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {brand} e-postanızı doğrulayın: {action_url} Süresi: {expiry_time}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'email_verify' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invite_member', 'en', 'You have been invited to {workspace} — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Team Invite</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">You are invited!</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{inviter}</strong> has invited you to join <strong>{workspace}</strong> on {brand} as a <strong>{role}</strong>.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Accept Invitation</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, {inviter} invited you to {workspace} on {brand} as {role}. Accept: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invite_member' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invite_member', 'fa', 'دعوت به {workspace} — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>دعوت به تیم</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">شما دعوت شده‌اید!</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{inviter}</strong> شما را به <strong>{workspace}</strong> در {brand} با نقش <strong>{role}</strong> دعوت کرده است.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">پذیرش دعوت</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، {inviter} شما را به {workspace} دعوت کرده. پذیرش: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invite_member' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invite_member', 'tr', '{workspace} davet edildiniz — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Takım Daveti</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Davet edildiniz!</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{inviter}</strong> sizi {brand} uzerinde <strong>{workspace}</strong> olarak <strong>{role}</strong> davet etti.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Daveti Kabul Et</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {inviter} sizi {workspace} davet etti. Kabul: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invite_member' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invite_otp', 'en', 'Your verification code — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verification code</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px 40px 8px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your verification code</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Use the code below to verify your invitation.</p></td></tr><tr><td align="center" style="padding:16px 40px 8px;"><div style="display:inline-block;background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:16px 28px;color:#1e293b;font-size:30px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;">{code}</div></td></tr><tr><td style="padding:8px 40px 32px;text-align:center;"><p style="margin:0;color:#64748b;font-size:14px;line-height:22px;">This code expires in {expiry_minutes} minutes. If you did not request it, you can safely ignore this email.</p></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Your verification code: {code}. It expires in {expiry_minutes} minutes. — {brand}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invite_otp' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invite_otp', 'fa', 'کد تأیید شما — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>کد تأیید</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Tahoma,Segoe UI,Arial,sans-serif;direction:rtl;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px 40px 8px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">کد تأیید شما</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:26px;">برای تأیید دعوت‌نامه، از کد زیر استفاده کنید.</p></td></tr><tr><td align="center" style="padding:16px 40px 8px;"><div style="display:inline-block;background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:16px 28px;color:#1e293b;font-size:30px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;direction:ltr;">{code}</div></td></tr><tr><td style="padding:8px 40px 32px;text-align:center;"><p style="margin:0;color:#64748b;font-size:14px;line-height:24px;">این کد تا {expiry_minutes} دقیقه دیگر معتبر است. اگر شما درخواست نکرده‌اید، این ایمیل را نادیده بگیرید.</p></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'کد تأیید شما: {code} — این کد تا {expiry_minutes} دقیقه دیگر معتبر است. ({brand})', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invite_otp' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invite_otp', 'tr', 'Doğrulama kodunuz — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Doğrulama kodu</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px 40px 8px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Doğrulama kodunuz</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Davetinizi doğrulamak için aşağıdaki kodu kullanın.</p></td></tr><tr><td align="center" style="padding:16px 40px 8px;"><div style="display:inline-block;background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:16px 28px;color:#1e293b;font-size:30px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;">{code}</div></td></tr><tr><td style="padding:8px 40px 32px;text-align:center;"><p style="margin:0;color:#64748b;font-size:14px;line-height:22px;">Bu kodun geçerlilik süresi {expiry_minutes} dakikadır. Bu isteği siz yapmadıysanız e-postayı yok sayabilirsiniz.</p></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Doğrulama kodunuz: {code}. Süresi {expiry_minutes} dakika. — {brand}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invite_otp' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_due', 'en', 'Invoice {invoice_number} is due today — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your invoice is due today</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your invoice is due today</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Today is the last day to pay this invoice.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">If automatic payment is on and your wallet has enough balance, the amount is charged automatically.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Due date</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Pay invoice</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Invoice {invoice_number} for {amount} is due today. Pay: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_due' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_due', 'fa', 'امروز سررسید صورتحساب {invoice_number} — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>امروز سررسید صورتحساب است</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">امروز سررسید صورتحساب است</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">امروز آخرین روز پرداخت صورتحساب شماست.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">اگر پرداخت خودکار فعال باشد و موجودی کیف پول کافی باشد، مبلغ به‌صورت خودکار کسر می‌شود.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مهلت پرداخت</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">پرداخت صورتحساب</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'امروز سررسید صورتحساب {invoice_number} به مبلغ {amount} است. پرداخت: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_due' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_due', 'tr', '{invoice_number} numaralı faturanın vadesi bugün — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Faturanızın vadesi bugün</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Faturanızın vadesi bugün</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Bu faturayı ödemek için son gün bugün.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Otomatik ödeme açıksa ve cüzdan bakiyeniz yeterliyse tutar otomatik tahsil edilir.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Son ödeme tarihi</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Faturayı öde</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{invoice_number} numaralı {amount} tutarındaki faturanın vadesi bugün. Ödeme: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_due' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_issued', 'en', 'Invoice {invoice_number} issued — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>A new invoice is ready</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">A new invoice is ready</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">A new invoice has been issued for your workspace. The details are below.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Issuing an invoice does not debit your wallet; payment is taken on the due date.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Due date</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View and pay invoice</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Invoice {invoice_number} for {amount} was issued and is due on {due_at}. Pay: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_issued' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_issued', 'fa', 'صورتحساب {invoice_number} صادر شد — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>صورتحساب جدید صادر شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">صورتحساب جدید صادر شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">صورتحساب تازه‌ای برای فضای کاری شما صادر شد. جزئیات آن را در ادامه می‌بینید.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">صدور صورتحساب باعث کسر خودکار از کیف پول نمی‌شود؛ مبلغ در تاریخ سررسید دریافت می‌شود.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مهلت پرداخت</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده و پرداخت صورتحساب</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'صورتحساب {invoice_number} به مبلغ {amount} صادر شد. مهلت پرداخت: {due_at}. پرداخت: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_issued' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_issued', 'tr', '{invoice_number} numaralı fatura oluşturuldu — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Yeni faturanız hazır</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Yeni faturanız hazır</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınız için yeni bir fatura oluşturuldu. Ayrıntılar aşağıdadır.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Fatura oluşturulması cüzdanınızdan otomatik tahsilat yapmaz; ödeme vade tarihinde alınır.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Son ödeme tarihi</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Faturayı görüntüle ve öde</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{invoice_number} numaralı {amount} tutarındaki fatura oluşturuldu. Vade: {due_at}. Ödeme: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_issued' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_past_due', 'en', 'Invoice {invoice_number} is past due — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invoice past due</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Invoice past due</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">This invoice was not paid on its due date.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">You can still pay until the end of the grace period; after that the workspace moves to the free plan. No data is deleted.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Grace period ends</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{grace_ends_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Pay now</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Invoice {invoice_number} for {amount} is past due. Grace period ends {grace_ends_at}. Pay: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_past_due' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_past_due', 'fa', 'صورتحساب {invoice_number} پرداخت نشده است — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>صورتحساب معوق</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">صورتحساب معوق</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">صورتحساب شما در تاریخ سررسید پرداخت نشد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">تا پایان مهلت نهایی فرصت دارید پرداخت کنید؛ پس از آن فضای کاری به پلن رایگان منتقل می‌شود. هیچ داده‌ای حذف نمی‌شود.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مهلت نهایی</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{grace_ends_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">پرداخت فوری</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'صورتحساب {invoice_number} به مبلغ {amount} پرداخت نشد. مهلت نهایی: {grace_ends_at}. پرداخت: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_past_due' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_past_due', 'tr', '{invoice_number} numaralı fatura gecikmiş durumda — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Gecikmiş fatura</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Gecikmiş fatura</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Bu fatura vadesinde ödenmedi.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Ek süre sonuna kadar ödeyebilirsiniz; sonrasında çalışma alanı ücretsiz plana geçer. Hiçbir veri silinmez.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Ek süre bitişi</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{grace_ends_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Hemen öde</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{invoice_number} numaralı {amount} tutarındaki fatura gecikti. Ek süre bitişi: {grace_ends_at}. Ödeme: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_past_due' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_reminder', 'en', 'Reminder: invoice {invoice_number} is due soon — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment reminder</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Payment reminder</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your invoice is due soon.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Pay it or top up your wallet before the due date to avoid a service interruption.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Due date</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Pay invoice</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Invoice {invoice_number} for {amount} is due on {due_at}. Pay: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_reminder' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_reminder', 'fa', 'یادآوری پرداخت صورتحساب {invoice_number} — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>یادآوری پرداخت</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">یادآوری پرداخت</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سررسید صورتحساب شما نزدیک است.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">برای جلوگیری از وقفه در سرویس، پیش از تاریخ سررسید پرداخت کنید یا موجودی کیف پول را افزایش دهید.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مهلت پرداخت</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">پرداخت صورتحساب</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'مهلت پرداخت صورتحساب {invoice_number} به مبلغ {amount} تا {due_at} است. پرداخت: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_reminder' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'invoice_reminder', 'tr', 'Hatırlatma: {invoice_number} numaralı faturanın vadesi yaklaşıyor — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ödeme hatırlatması</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Ödeme hatırlatması</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Faturanızın vadesi yaklaşıyor.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hizmet kesintisini önlemek için vadeden önce ödeyin veya cüzdanınıza bakiye yükleyin.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Son ödeme tarihi</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Faturayı öde</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{invoice_number} numaralı {amount} tutarındaki faturanın vadesi {due_at}. Ödeme: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'invoice_reminder' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'magic_link', 'en', 'Your login link — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Magic Link</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your login link</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Click the button below to securely log in to your <strong>{brand}</strong> account. No password needed.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">This link will expire in <strong>{expiry_time}</strong> and can only be used once.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Log In</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Log in to {brand}: {action_url} Expires in {expiry_time}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'magic_link' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'magic_link', 'fa', 'لینک ورود شما — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>لینک ورود</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">لینک ورود شما</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">روی دکمه زیر کلیک کنید تا وارد حساب <strong>{brand}</strong> خود شوید.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">این لینک تا <strong>{expiry_time}</strong> معتبر است و فقط یکبار قابل استفاده است.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">ورود به حساب</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، ورود به {brand}: {action_url} تا {expiry_time} معتبر است.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'magic_link' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'magic_link', 'tr', 'Giriş bağlantınız — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Giriş Bağlantısı</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Giriş bağlantınız</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{brand}</strong> hesabınıza güvenli giriş için aşağıdaki düğmeye tıklayın.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Bu bağlantının süresi <strong>{expiry_time}</strong> içinde dolacaktır.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Giriş Yap</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {brand} girişi: {action_url} Süresi: {expiry_time}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'magic_link' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'new_conversation', 'en', 'New conversation from {visitor} — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>New Conversation</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">New conversation 💬</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">A new conversation has been started by <strong>{visitor}</strong>:</p><div style="background:#f8fafc;border-left:4px solid #3B82F6;padding:16px;border-radius:0 8px 8px 0;margin:16px 0;"><p style="margin:0;color:#334155;font-size:14px;line-height:22px;font-style:italic;">{message}</p></div></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Reply Now</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, New message from {visitor}: "{message}" Reply: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'new_conversation' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'new_conversation', 'fa', 'گفتگوی جدید از {visitor} — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>گفتگوی جدید</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">گفتگوی جدید 💬</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">یک گفتگوی جدید توسط <strong>{visitor}</strong> شروع شده:</p><div style="background:#f8fafc;border-right:4px solid #3B82F6;padding:16px;border-radius:8px 0 0 8px;margin:16px 0;"><p style="margin:0;color:#334155;font-size:14px;line-height:22px;font-style:italic;">{message}</p></div></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">پاسخ دهید</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، پیام جدید از {visitor}: "{message}" پاسخ: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'new_conversation' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'new_conversation', 'tr', '{visitor} yeni görüşme — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Yeni Görüşme</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Yeni görüşme 💬</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{visitor}</strong> yeni bir görüşme başlattı:</p><div style="background:#f8fafc;border-left:4px solid #3B82F6;padding:16px;border-radius:0 8px 8px 0;margin:16px 0;"><p style="margin:0;color:#334155;font-size:14px;line-height:22px;font-style:italic;">{message}</p></div></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Yanıtla</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {visitor} yeni mesaj: "{message}" Yanıtla: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'new_conversation' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'offline_message_received', 'en', 'New offline message from {contact_name}', '<!DOCTYPE html><html lang="en" dir="ltr"><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:24px 32px;color:#fff;"><h1 style="margin:0;font-size:18px;font-weight:600;">New offline message</h1></td></tr><tr><td style="padding:28px 32px;color:#334155;font-size:15px;line-height:24px;"><p style="margin:0 0 16px;">A visitor left a message while your workspace was offline.</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;font-size:14px;"><tr><td style="padding:6px 0;color:#64748b;">From</td><td style="padding:6px 0;"><strong>{contact_name}</strong></td></tr><tr><td style="padding:6px 0;color:#64748b;">Email</td><td style="padding:6px 0;">{contact_email}</td></tr></table><div style="background:#f8fafc;border-left:3px solid #3B82F6;padding:14px 16px;border-radius:6px;color:#1e293b;font-size:14px;line-height:22px;white-space:pre-wrap;">{message_body}</div><p style="margin:24px 0 0;font-size:13px;color:#64748b;">Open this conversation in your inbox to reply.</p></td></tr></table></td></tr></table></body></html>', 'New offline message from {contact_name} ({contact_email}):

{message_body}

Open this conversation in your inbox to reply.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'offline_message_received' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'offline_message_received', 'fa', 'پیام آفلاین جدید از {contact_name}', '<!DOCTYPE html><html lang="fa" dir="rtl"><body style="margin:0;padding:0;background:#f4f5f7;font-family:Tahoma,Segoe UI,Arial,sans-serif;direction:rtl;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:24px 32px;color:#fff;"><h1 style="margin:0;font-size:18px;font-weight:600;">پیام آفلاین جدید</h1></td></tr><tr><td style="padding:28px 32px;color:#334155;font-size:15px;line-height:26px;"><p style="margin:0 0 16px;">یک بازدیدکننده در زمان آفلاین بودن کارگاه شما پیامی ارسال کرده است.</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;font-size:14px;"><tr><td style="padding:6px 0;color:#64748b;">از طرف</td><td style="padding:6px 0;"><strong>{contact_name}</strong></td></tr><tr><td style="padding:6px 0;color:#64748b;">ایمیل</td><td style="padding:6px 0;">{contact_email}</td></tr></table><div style="background:#f8fafc;border-right:3px solid #3B82F6;padding:14px 16px;border-radius:6px;color:#1e293b;font-size:14px;line-height:24px;white-space:pre-wrap;">{message_body}</div><p style="margin:24px 0 0;font-size:13px;color:#64748b;">برای پاسخ، این مکالمه را در صندوق ورودی باز کنید.</p></td></tr></table></td></tr></table></body></html>', 'پیام آفلاین جدید از {contact_name} ({contact_email}):

{message_body}

برای پاسخ، این مکالمه را در صندوق ورودی باز کنید.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'offline_message_received' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'offline_message_received', 'tr', '{contact_name} kişisinden yeni çevrimdışı mesaj', '<!DOCTYPE html><html lang="tr" dir="ltr"><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:24px 32px;color:#fff;"><h1 style="margin:0;font-size:18px;font-weight:600;">Yeni çevrimdışı mesaj</h1></td></tr><tr><td style="padding:28px 32px;color:#334155;font-size:15px;line-height:24px;"><p style="margin:0 0 16px;">Bir ziyaretçi, çalışma alanınız çevrimdışıyken bir mesaj bıraktı.</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;font-size:14px;"><tr><td style="padding:6px 0;color:#64748b;">Gönderen</td><td style="padding:6px 0;"><strong>{contact_name}</strong></td></tr><tr><td style="padding:6px 0;color:#64748b;">E-posta</td><td style="padding:6px 0;">{contact_email}</td></tr></table><div style="background:#f8fafc;border-left:3px solid #3B82F6;padding:14px 16px;border-radius:6px;color:#1e293b;font-size:14px;line-height:22px;white-space:pre-wrap;">{message_body}</div><p style="margin:24px 0 0;font-size:13px;color:#64748b;">Yanıtlamak için bu konuşmayı gelen kutusunda açın.</p></td></tr></table></td></tr></table></body></html>', '{contact_name} kişisinden yeni çevrimdışı mesaj ({contact_email}):

{message_body}

Yanıtlamak için bu konuşmayı gelen kutusunda açın.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'offline_message_received' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_conversation_transcript', 'en', 'Transcript — {{subject}}', '<p>Hello {{name}},</p><p>Here is the transcript of the conversation with {{contact}} in {{workspace}}, resolved on {{resolved_at}}.</p><div>{{transcript}}</div><p><a href="{{action_url}}">Open the conversation</a></p><p>— {{brand}}</p>', 'Transcript of the conversation with {{contact}} in {{workspace}}, resolved {{resolved_at}}. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_conversation_transcript' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_conversation_transcript', 'fa', 'متن گفتگو — {{subject}}', '<p>سلام {{name}}،</p><p>این متن گفتگو با {{contact}} در {{workspace}} است که در {{resolved_at}} بسته شد.</p><div>{{transcript}}</div><p><a href="{{action_url}}">باز کردن گفتگو</a></p><p>— {{brand}}</p>', 'متن گفتگو با {{contact}} در {{workspace}}، بسته‌شده در {{resolved_at}}. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_conversation_transcript' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_conversation_transcript', 'tr', 'Konuşma dökümü — {{subject}}', '<p>Merhaba {{name}},</p><p>{{workspace}} alanında {{contact}} ile yapılan ve {{resolved_at}} tarihinde kapatılan konuşmanın dökümü.</p><div>{{transcript}}</div><p><a href="{{action_url}}">Konuşmayı aç</a></p><p>— {{brand}}</p>', '{{workspace}} alanında {{contact}} ile konuşmanın dökümü, {{resolved_at}} tarihinde kapatıldı. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_conversation_transcript' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_invoice_paid', 'en', 'Payment received — {{amount}}', '<p>Hello {{name}},</p><p>{{amount}} has been received for {{workspace}}{{invoice_label}}.</p><p><a href="{{action_url}}">Open billing</a></p><p>— {{brand}}</p>', '{{amount}} received for {{workspace}}{{invoice_label}}. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_invoice_paid' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_invoice_paid', 'fa', 'پرداخت دریافت شد — {{amount}}', '<p>سلام {{name}}،</p><p>مبلغ {{amount}} برای {{workspace}}{{invoice_label}} دریافت شد.</p><p><a href="{{action_url}}">باز کردن صورتحساب‌ها</a></p><p>— {{brand}}</p>', 'مبلغ {{amount}} برای {{workspace}}{{invoice_label}} دریافت شد. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_invoice_paid' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_invoice_paid', 'tr', 'Ödeme alındı — {{amount}}', '<p>Merhaba {{name}},</p><p>{{workspace}} için {{amount}} tutarında ödeme alındı{{invoice_label}}.</p><p><a href="{{action_url}}">Faturaları aç</a></p><p>— {{brand}}</p>', '{{workspace}} için {{amount}} ödeme alındı{{invoice_label}}. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_invoice_paid' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_product_update', 'en', '{{title}}', '<p>Hello {{name}},</p><div>{{body}}</div><p>— {{brand}}</p>', '{{title}} — {{body}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_product_update' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_product_update', 'fa', '{{title}}', '<p>سلام {{name}}،</p><div>{{body}}</div><p>— {{brand}}</p>', '{{title}} — {{body}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_product_update' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_product_update', 'tr', '{{title}}', '<p>Merhaba {{name}},</p><div>{{body}}</div><p>— {{brand}}</p>', '{{title}} — {{body}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_product_update' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_unread_digest', 'en', '{{count}} conversations are still waiting', '<p>Hello {{name}},</p><p>{{count}} conversation(s) in {{workspace}} have been waiting for an answer for more than {{minutes}} minutes.</p><p>{{list}}</p><p><a href="{{action_url}}">Open the inbox</a></p><p>— {{brand}}</p>', 'Hello {{name}}, {{count}} conversation(s) in {{workspace}} have been waiting more than {{minutes}} minutes. Open the inbox: {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_unread_digest' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_unread_digest', 'fa', '{{count}} گفتگو هنوز منتظر پاسخ است', '<p>سلام {{name}}،</p><p>{{count}} گفتگو در {{workspace}} بیش از {{minutes}} دقیقه است که منتظر پاسخ مانده‌اند.</p><p>{{list}}</p><p><a href="{{action_url}}">باز کردن صندوق ورودی</a></p><p>— {{brand}}</p>', 'سلام {{name}}، {{count}} گفتگو در {{workspace}} بیش از {{minutes}} دقیقه منتظر مانده است. صندوق ورودی: {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_unread_digest' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_unread_digest', 'tr', '{{count}} konuşma hâlâ yanıt bekliyor', '<p>Merhaba {{name}},</p><p>{{workspace}} alanındaki {{count}} konuşma {{minutes}} dakikadan uzun süredir yanıt bekliyor.</p><p>{{list}}</p><p><a href="{{action_url}}">Gelen kutusunu aç</a></p><p>— {{brand}}</p>', 'Merhaba {{name}}, {{workspace}} alanında {{count}} konuşma {{minutes}} dakikadan uzun süredir bekliyor. Gelen kutusu: {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_unread_digest' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_weekly_summary', 'en', 'Your week in {{workspace}}', '<p>Hello {{name}},</p><p>Last week in {{workspace}}: {{conversations}} conversations, {{resolved}} resolved, {{messages}} messages answered.</p><p><a href="{{action_url}}">Open the inbox</a></p><p>— {{brand}}</p>', 'Last week in {{workspace}}: {{conversations}} conversations, {{resolved}} resolved, {{messages}} messages. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_weekly_summary' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_weekly_summary', 'fa', 'هفته‌ی شما در {{workspace}}', '<p>سلام {{name}}،</p><p>هفته‌ی گذشته در {{workspace}}: {{conversations}} گفتگو، {{resolved}} بسته‌شده، {{messages}} پیام پاسخ داده شد.</p><p><a href="{{action_url}}">باز کردن صندوق ورودی</a></p><p>— {{brand}}</p>', 'هفته‌ی گذشته در {{workspace}}: {{conversations}} گفتگو، {{resolved}} بسته‌شده، {{messages}} پیام. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_weekly_summary' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'operator_weekly_summary', 'tr', '{{workspace}} alanındaki haftanız', '<p>Merhaba {{name}},</p><p>Geçen hafta {{workspace}} alanında: {{conversations}} konuşma, {{resolved}} çözüldü, {{messages}} mesaj yanıtlandı.</p><p><a href="{{action_url}}">Gelen kutusunu aç</a></p><p>— {{brand}}</p>', 'Geçen hafta {{workspace}}: {{conversations}} konuşma, {{resolved}} çözüldü, {{messages}} mesaj. {{action_url}} — {{brand}}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'operator_weekly_summary' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'password_reset', 'en', 'Reset your password — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Password Reset</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Reset your password</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">We received a request to reset the password for your <strong>{brand}</strong> account. Click the button below to choose a new password.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">This link will expire in <strong>{expiry_time}</strong>. If you did not request this, you can safely ignore this email.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Reset Password</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Reset your {brand} password: {action_url} Expires in {expiry_time}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'password_reset' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'password_reset', 'fa', 'بازنشانی رمز عبور — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>بازنشانی رمز عبور</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">بازنشانی رمز عبور</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">درخواست بازنشانی رمز عبور حساب <strong>{brand}</strong> شما دریافت شد. برای انتخاب رمز عبور جدید روی دکمه زیر کلیک کنید.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">این لینک تا <strong>{expiry_time}</strong> معتبر است.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">بازنشانی رمز عبور</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، برای بازنشانی رمز عبور: {action_url} تا {expiry_time} معتبر است.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'password_reset' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'password_reset', 'tr', 'Şifrenizi sıfırlayın — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Şifre Sıfırlama</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Şifrenizi sıfırlayın</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{brand}</strong> hesabınızın şifresini sıfırlamak için bir istek aldık.</p><p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Bu bağlantının süresi <strong>{expiry_time}</strong> içinde dolacaktır.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Şifreyi Sıfırla</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {brand} şifrenizi sıfırlayın: {action_url} Süresi: {expiry_time}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'password_reset' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_failed', 'en', 'Payment failed — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Failed</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Payment failed ⚠️</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">We were unable to process your payment of <strong>{amount} {currency}</strong>.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>Reason:</strong> {reason}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Please update your payment method to avoid service interruption.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Update Payment Method</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Payment of {amount} {currency} failed. Reason: {reason} Update: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_failed' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_failed', 'fa', 'پرداخت ناموفق — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>پرداخت ناموفق</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">پرداخت ناموفق ⚠️</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پرداخت شما به مبلغ <strong>{amount} {currency}</strong> انجام نشد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>دلیل:</strong> {reason}</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">بروزرسانی روش پرداخت</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، پرداخت {amount} {currency} ناموفق بود. دلیل: {reason}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_failed' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_failed', 'tr', 'Ödeme başarısız — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ödeme Başarısız</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Ödeme başarısız ⚠️</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{amount} {currency}</strong> ödemeniz işlenemedi.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>Sebep:</strong> {reason}</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Ödeme Yöntemini Güncelle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {amount} {currency} ödeme başarısız. Sebep: {reason}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_failed' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_received', 'en', 'Payment received for invoice {invoice_number} — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment received</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Payment received</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">We have received your payment. Thank you.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View receipt</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'We received your payment of {amount} for invoice {invoice_number}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_received' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_received', 'fa', 'پرداخت صورتحساب {invoice_number} تأیید شد — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>پرداخت شما دریافت شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">پرداخت شما دریافت شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پرداخت شما با موفقیت ثبت شد. از همراهی شما سپاسگزاریم.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده رسید</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'پرداخت صورتحساب {invoice_number} به مبلغ {amount} با موفقیت ثبت شد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_received' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_received', 'tr', '{invoice_number} numaralı fatura için ödeme alındı — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ödemeniz alındı</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Ödemeniz alındı</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Ödemeniz başarıyla alındı. Teşekkür ederiz.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Makbuzu görüntüle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{invoice_number} numaralı fatura için {amount} tutarındaki ödemeniz alındı.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_received' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_success', 'en', 'Payment received — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Received</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Payment confirmed ✅</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your payment of <strong>{amount} {currency}</strong> for the <strong>{plan}</strong> plan has been successfully processed.</p><table role="presentation" style="width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0;"><tr><td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;color:#94a3b8;font-size:13px;">Amount</td><td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount} {currency}</td></tr><tr><td style="padding:12px 16px;color:#94a3b8;font-size:13px;">Plan</td><td style="padding:12px 16px;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{invoice_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View Invoice</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Payment of {amount} {currency} for {plan} confirmed. Invoice: {invoice_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_success' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_success', 'fa', 'پرداخت موفق — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>پرداخت موفق</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">پرداخت تایید شد ✅</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پرداخت شما به مبلغ <strong>{amount} {currency}</strong> برای پلن <strong>{plan}</strong> با موفقیت انجام شد.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{invoice_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده فاکتور</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، پرداخت {amount} {currency} برای پلن {plan} تایید شد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_success' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'payment_success', 'tr', 'Ödeme alındı — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ödeme Alındı</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Ödeme onaylandı ✅</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{plan}</strong> planı için <strong>{amount} {currency}</strong> ödeme işlendi.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{invoice_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Faturayı Görüntüle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {plan} planı için {amount} {currency} ödeme onaylandı.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'payment_success' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_activated', 'en', 'Your {plan_name} plan is active — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your plan is active</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your plan is active</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">The {plan_name} plan is now active for your workspace and every feature is available.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Paid through</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{period_end}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View subscription</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'The {plan_name} plan is active through {period_end}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_activated' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_activated', 'fa', 'پلن «{plan_name}» فعال شد — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>پلن شما فعال شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">پلن شما فعال شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن «{plan_name}» برای فضای کاری شما فعال شد و همه امکانات آن هم‌اکنون در دسترس است.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">پلن</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">اعتبار تا</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{period_end}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده اشتراک</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'پلن «{plan_name}» فعال شد و تا {period_end} اعتبار دارد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_activated' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_activated', 'tr', '{plan_name} planınız etkin — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Planınız etkinleştirildi</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Planınız etkinleştirildi</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{plan_name} planı çalışma alanınız için etkinleştirildi ve tüm özellikler kullanıma hazır.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Geçerlilik</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{period_end}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Aboneliği görüntüle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{plan_name} planı {period_end} tarihine kadar etkin.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_activated' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_cancelled', 'en', 'Subscription cancelled — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Subscription Cancelled</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Subscription cancelled</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your <strong>{plan}</strong> subscription has been cancelled. You will continue to have access until <strong>{end_date}</strong>.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">We would love to have you back! You can resubscribe at any time.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Resubscribe</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Your {plan} subscription cancelled. Access until {end_date}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_cancelled' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_cancelled', 'fa', 'لغو اشتراک — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>لغو اشتراک</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">اشتراک لغو شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">اشتراک <strong>{plan}</strong> شما لغو شد. دسترسی شما تا <strong>{end_date}</strong> ادامه دارد.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">اشتراک مجدد</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، اشتراک {plan} لغو شد. دسترسی تا {end_date}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_cancelled' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_cancelled', 'tr', 'Abonelik iptal edildi — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Abonelik İptal</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Abonelik iptal edildi</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{plan}</strong> aboneliğiniz iptal edildi. <strong>{end_date}</strong> tarihine kadar erişiminiz devam edecek.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Tekrar Abone Ol</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {plan} aboneliği iptal edildi. Erişim: {end_date}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_cancelled' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_free_fallback', 'en', 'Your workspace moved to the free plan — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Moved to the free plan</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Moved to the free plan</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Because the invoice was not paid within the grace period, your workspace moved to the free plan.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">No data has been deleted, and upgrading restores full service.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Upgrade plan</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Your workspace moved to the {plan_name} plan. Upgrade: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_free_fallback' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_free_fallback', 'fa', 'انتقال فضای کاری به پلن رایگان — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>انتقال به پلن رایگان</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">انتقال به پلن رایگان</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">به دلیل پرداخت نشدن صورتحساب در مهلت تعیین‌شده، فضای کاری شما به پلن رایگان منتقل شد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">هیچ داده‌ای حذف نشده است و با ارتقای پلن، تمام امکانات دوباره در دسترس قرار می‌گیرد.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">پلن</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">ارتقای پلن</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'فضای کاری شما به پلن {plan_name} منتقل شد. ارتقا: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_free_fallback' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_free_fallback', 'tr', 'Çalışma alanınız ücretsiz plana geçti — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ücretsiz plana geçiş</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Ücretsiz plana geçiş</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Fatura ek süre içinde ödenmediği için çalışma alanınız ücretsiz plana geçti.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hiçbir veri silinmedi; planı yükselttiğinizde hizmet geri gelir.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Planı yükselt</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Çalışma alanınız {plan_name} planına geçti. Yükseltme: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_free_fallback' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_renewed', 'en', 'Subscription renewed — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Subscription Renewed</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Subscription renewed 🔄</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your <strong>{plan}</strong> subscription has been renewed for <strong>{amount}</strong>. Next renewal: <strong>{next_date}</strong>.</p></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Your {plan} subscription renewed for {amount}. Next: {next_date}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_renewed' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_renewed', 'fa', 'تمدید اشتراک — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>تمدید اشتراک</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">اشتراک تمدید شد 🔄</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">اشتراک <strong>{plan}</strong> شما به مبلغ <strong>{amount}</strong> تمدید شد. تمدید بعدی: <strong>{next_date}</strong>.</p></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، اشتراک {plan} تمدید شد. مبلغ: {amount}. بعدی: {next_date}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_renewed' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_renewed', 'tr', 'Abonelik yenilendi — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Abonelik Yenilendi</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Abonelik yenilendi 🔄</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{plan}</strong> aboneliğiniz <strong>{amount}</strong> karşılığında yenilendi. Sonraki: <strong>{next_date}</strong>.</p></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {plan} aboneliği {amount} yenilendi. Sonraki: {next_date}.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_renewed' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_restored', 'en', 'Your subscription is active again — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Subscription restored</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Subscription restored</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your payment was received and the subscription is no longer past due.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">All features of your plan are available again.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Open workspace</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Your payment was received and the subscription is active again.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_restored' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_restored', 'fa', 'اشتراک شما دوباره فعال شد — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>اشتراک دوباره فعال شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">اشتراک دوباره فعال شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پرداخت شما دریافت شد و اشتراک از حالت بدهی خارج و فعال شد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">تمام امکانات پلن شما هم‌اکنون در دسترس است.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">پلن</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{plan_name}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">ورود به فضای کاری</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'پرداخت شما دریافت شد و اشتراک دوباره فعال شد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_restored' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'subscription_restored', 'tr', 'Aboneliğiniz yeniden etkin — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Abonelik yeniden etkin</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Abonelik yeniden etkin</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Ödemeniz alındı ve aboneliğiniz gecikmiş durumdan çıkarıldı.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Planınızın tüm özellikleri yeniden kullanılabilir.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Çalışma alanını aç</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Ödemeniz alındı ve aboneliğiniz yeniden etkin.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'subscription_restored' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'system_alert', 'en', '[{severity}] {title} — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>System Alert</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">System Alert 🔔</h2><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:0 0 16px;"><p style="margin:0 0 4px;color:#991b1b;font-size:13px;font-weight:600;text-transform:uppercase;">{severity}</p><p style="margin:0 0 8px;color:#1e293b;font-size:16px;font-weight:600;">{title}</p><p style="margin:0;color:#475569;font-size:14px;line-height:22px;">{message}</p></div></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', '[{severity}] {title} — {message}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'system_alert' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'system_alert', 'fa', '[{severity}] {title} — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>هشدار سیستم</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">هشدار سیستم 🔔</h2><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:0 0 16px;"><p style="margin:0 0 4px;color:#991b1b;font-size:13px;font-weight:600;">{severity}</p><p style="margin:0 0 8px;color:#1e293b;font-size:16px;font-weight:600;">{title}</p><p style="margin:0;color:#475569;font-size:14px;line-height:22px;">{message}</p></div></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '[{severity}] {title} — {message}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'system_alert' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'system_alert', 'tr', '[{severity}] {title} — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sistem Uyarısı</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Sistem Uyarısı 🔔</h2><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:0 0 16px;"><p style="margin:0 0 4px;color:#991b1b;font-size:13px;font-weight:600;text-transform:uppercase;">{severity}</p><p style="margin:0 0 8px;color:#1e293b;font-size:16px;font-weight:600;">{title}</p><p style="margin:0;color:#475569;font-size:14px;line-height:22px;">{message}</p></div></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '[{severity}] {title} — {message}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'system_alert' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'task_assigned', 'en', 'Task assigned: {task} — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Task Assigned</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">New task assigned 📋</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{assigner}</strong> assigned you a new task:</p><div style="background:#f8fafc;border-left:4px solid #3B82F6;padding:16px;border-radius:0 8px 8px 0;margin:16px 0;"><p style="margin:0;color:#1e293b;font-size:15px;font-weight:600;">{task}</p></div></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View Task</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, {assigner} assigned you: {task} View: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'task_assigned' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'task_assigned', 'fa', 'وظیفه جدید: {task} — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>وظیفه جدید</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">وظیفه جدید 📋</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{assigner}</strong> یک وظیفه جدید به شما اختصاص داده:</p><div style="background:#f8fafc;border-right:4px solid #3B82F6;padding:16px;border-radius:8px 0 0 8px;margin:16px 0;"><p style="margin:0;color:#1e293b;font-size:15px;font-weight:600;">{task}</p></div></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده وظیفه</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، {assigner} وظیفه‌ای به شما داد: {task} مشاهده: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'task_assigned' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'task_assigned', 'tr', 'Görev atandı: {task} — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Görev Atandı</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Yeni görev 📋</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{assigner}</strong> size yeni bir görev atadı:</p><div style="background:#f8fafc;border-left:4px solid #3B82F6;padding:16px;border-radius:0 8px 8px 0;margin:16px 0;"><p style="margin:0;color:#1e293b;font-size:15px;font-weight:600;">{task}</p></div></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Görevi Görüntüle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {assigner} size görev atadı: {task} Görüntüle: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'task_assigned' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'trial_ending_soon', 'en', 'Your trial ends in {days_left} day(s) — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your trial is ending soon</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your trial is ending soon</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace trial is about to end. Upgrade to keep every feature available.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Current plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Trial ends</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{trial_end}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Days left</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{days_left}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Upgrade plan</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Your trial ends on {trial_end} ({days_left} day(s) left).', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'trial_ending_soon' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'trial_ending_soon', 'fa', '{days_left} روز تا پایان دوره آزمایشی — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>دوره آزمایشی رو به پایان است</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">دوره آزمایشی رو به پایان است</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دوره آزمایشی فضای کاری شما به‌زودی تمام می‌شود. برای ادامه استفاده از همه امکانات، پلن خود را ارتقا دهید.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">پلن فعلی</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">پایان دوره</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{trial_end}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">روز باقی‌مانده</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{days_left}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">ارتقای پلن</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'دوره آزمایشی شما در {trial_end} به پایان می‌رسد ({days_left} روز دیگر).', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'trial_ending_soon' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'trial_ending_soon', 'tr', 'Deneme süreniz {days_left} gün içinde bitiyor — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Deneme süreniz bitmek üzere</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Deneme süreniz bitmek üzere</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın deneme süresi bitmek üzere. Tüm özellikleri korumak için planınızı yükseltin.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Mevcut plan</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{plan_name}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Bitiş</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{trial_end}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Kalan gün</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{days_left}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Planı yükselt</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Deneme süreniz {trial_end} tarihinde sona eriyor ({days_left} gün kaldı).', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'trial_ending_soon' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'trial_expired', 'en', 'Your trial has ended — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your trial has ended</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your trial has ended</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your trial has ended and the workspace moved to the free plan. No data was deleted — upgrading restores full access.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">See plans</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Your trial has ended and the workspace moved to the free plan.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'trial_expired' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'trial_expired', 'fa', 'دوره آزمایشی شما به پایان رسید — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>دوره آزمایشی تمام شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">دوره آزمایشی تمام شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دوره آزمایشی شما تمام شد و فضای کاری به نسخه رایگان منتقل شد. هیچ داده‌ای حذف نشده است و با ارتقای پلن همه امکانات دوباره فعال می‌شود.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده پلن‌ها</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'دوره آزمایشی شما تمام شد و فضای کاری به نسخه رایگان منتقل شد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'trial_expired' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'trial_expired', 'tr', 'Deneme süreniz sona erdi — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Deneme süreniz sona erdi</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Deneme süreniz sona erdi</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Deneme süreniz sona erdi ve çalışma alanı ücretsiz plana geçti. Hiçbir veri silinmedi; planı yükselttiğinizde tüm erişim geri gelir.</p></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Planları gör</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Deneme süreniz sona erdi ve çalışma alanı ücretsiz plana geçti.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'trial_expired' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'wallet_autopay_insufficient', 'en', 'Wallet balance was not enough — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Wallet balance insufficient</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Wallet balance insufficient</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Automatic payment failed because your wallet balance was not enough.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Top up your wallet or pay the invoice directly.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Invoice number</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Due date</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Top up wallet</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Wallet balance was insufficient for invoice {invoice_number} ({amount}). Top up: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'wallet_autopay_insufficient' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'wallet_autopay_insufficient', 'fa', 'موجودی کیف پول کافی نبود — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>کسری موجودی کیف پول</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">کسری موجودی کیف پول</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پرداخت خودکار صورتحساب انجام نشد، چون موجودی کیف پول کافی نبود.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">لطفاً کیف پول را شارژ کنید یا صورتحساب را مستقیماً پرداخت کنید.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">شماره صورتحساب</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مهلت پرداخت</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">افزایش موجودی کیف پول</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'موجودی کیف پول برای پرداخت صورتحساب {invoice_number} به مبلغ {amount} کافی نبود. شارژ: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'wallet_autopay_insufficient' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'wallet_autopay_insufficient', 'tr', 'Cüzdan bakiyesi yetersiz — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Cüzdan bakiyesi yetersiz</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Cüzdan bakiyesi yetersiz</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Cüzdan bakiyeniz yeterli olmadığı için otomatik ödeme yapılamadı.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Lütfen bakiye yükleyin veya faturayı doğrudan ödeyin.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Fatura numarası</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{invoice_number}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Son ödeme tarihi</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{due_at}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Cüzdana bakiye yükle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{invoice_number} numaralı fatura ({amount}) için cüzdan bakiyesi yetersizdi. Yükleme: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'wallet_autopay_insufficient' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'wallet_deposit_received', 'en', 'Wallet topped up — {brand}', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Wallet topped up</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Wallet topped up</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your payment was added to the workspace wallet balance.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Amount</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">View wallet</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', '{amount} was added to your workspace wallet.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'wallet_deposit_received' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'wallet_deposit_received', 'fa', 'کیف پول شما شارژ شد — {brand}', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>کیف پول شارژ شد</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">کیف پول شارژ شد</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ پرداختی شما با موفقیت به کیف پول فضای کاری اضافه شد.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:right;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">مبلغ</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:left;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">مشاهده کیف پول</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'مبلغ {amount} به کیف پول شما اضافه شد.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'wallet_deposit_received' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'wallet_deposit_received', 'tr', 'Cüzdanınıza bakiye yüklendi — {brand}', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Cüzdan yüklendi</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Cüzdan yüklendi</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Ödemeniz çalışma alanı cüzdan bakiyenize eklendi.</p></td></tr><tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:left;"><tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Tutar</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">{amount}</td></tr></table></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Cüzdanı görüntüle</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Cüzdanınıza {amount} eklendi.', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'wallet_deposit_received' AND e.locale = 'tr');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'welcome', 'en', 'Welcome to {brand}! 🎉', '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Welcome</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Welcome aboard! 🎉</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Hi {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your <strong>{brand}</strong> account is ready! We are excited to have you on board.</p><ul style="margin:0 0 16px;padding-left:20px;color:#475569;font-size:15px;line-height:28px;"><li>Set up your workspace</li><li>Invite your team members</li><li>Explore features and integrations</li></ul></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Get Started</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}. All rights reserved.</p></td></tr></table></td></tr></table></body></html>', 'Hi {name}, Welcome to {brand}! Your account is ready. Get started: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'welcome' AND e.locale = 'en');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'welcome', 'fa', 'به {brand} خوش آمدید! 🎉', '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>خوش آمدید</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:right;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">خوش آمدید! 🎉</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">سلام {name}،</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">حساب <strong>{brand}</strong> شما آماده است! خوشحالیم که به ما پیوستید.</p><ul style="margin:0 0 16px;padding-right:20px;color:#475569;font-size:15px;line-height:28px;"><li>راه‌اندازی فضای کار</li><li>دعوت از اعضای تیم</li><li>بررسی امکانات</li></ul></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">شروع کنید</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'سلام {name}، به {brand} خوش آمدید! شروع: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'welcome' AND e.locale = 'fa');
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) SELECT NULL, 'welcome', 'tr', '{brand} hoş geldiniz! 🎉', '<!DOCTYPE html><html lang="tr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Hoş Geldiniz</title></head><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr><tr><td style="padding:40px;text-align:left;"><h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Hoş geldiniz! 🎉</h2><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Merhaba {name},</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;"><strong>{brand}</strong> hesabınız hazır!</p><ul style="margin:0 0 16px;padding-left:20px;color:#475569;font-size:15px;line-height:28px;"><li>Çalışma alanınızı kurun</li><li>Ekip üyelerinizi davet edin</li><li>Özellikleri keşfedin</li></ul></td></tr><tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">Başlayın</a></td></tr><tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr></table></td></tr></table></body></html>', 'Merhaba {name}, {brand} hoş geldiniz! Başlayın: {action_url}', 'true' WHERE NOT EXISTS (SELECT 1 FROM public.email_templates e WHERE e.workspace_id IS NOT DISTINCT FROM NULL AND e.slug = 'welcome' AND e.locale = 'tr');
