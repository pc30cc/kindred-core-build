
-- ============================================================================
-- Phase 7 — SLA / Reliability / Business metrics layer
-- ============================================================================

-- ─── 1. SLA / reliability hourly rollups ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sla_reliability_hourly (
  bucket_hour              timestamptz NOT NULL,
  scope_type               text        NOT NULL,        -- 'platform' | 'provider' | 'workspace'
  scope_key                text        NOT NULL,        -- 'platform' | provider id | workspace_id::text
  uptime_pct               numeric     NOT NULL DEFAULT 100,
  realtime_availability_pct numeric    NOT NULL DEFAULT 100,
  degraded_minutes         numeric     NOT NULL DEFAULT 0,
  forced_polling_minutes   numeric     NOT NULL DEFAULT 0,
  critical_alert_count     integer     NOT NULL DEFAULT 0,
  warn_alert_count         integer     NOT NULL DEFAULT 0,
  failover_count           integer     NOT NULL DEFAULT 0,
  recovery_count           integer     NOT NULL DEFAULT 0,
  mean_failover_recovery_seconds numeric,
  unhealthy_minutes        numeric     NOT NULL DEFAULT 0,
  details                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (bucket_hour, scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS sla_reliability_hourly_recent_idx
  ON public.sla_reliability_hourly (bucket_hour DESC, scope_type);

ALTER TABLE public.sla_reliability_hourly ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read sla_reliability_hourly" ON public.sla_reliability_hourly
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins write sla_reliability_hourly" ON public.sla_reliability_hourly
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));


-- ─── 2. Business metrics hourly rollups (per workspace) ─────────────────────
CREATE TABLE IF NOT EXISTS public.business_metrics_hourly (
  bucket_hour              timestamptz NOT NULL,
  workspace_id             uuid        NOT NULL,
  new_conversations        integer     NOT NULL DEFAULT 0,
  resolved_conversations   integer     NOT NULL DEFAULT 0,
  reopened_conversations   integer     NOT NULL DEFAULT 0,
  unanswered_conversations integer     NOT NULL DEFAULT 0,
  stale_open_conversations integer     NOT NULL DEFAULT 0,
  avg_conversation_duration_seconds numeric,
  avg_messages_per_conversation     numeric,
  first_response_time_p50  numeric,                                  -- seconds
  first_response_time_p95  numeric,
  next_response_time_p50   numeric,
  next_response_time_p95   numeric,
  messages_sent            integer     NOT NULL DEFAULT 0,
  active_operators         integer     NOT NULL DEFAULT 0,
  active_conversations     integer     NOT NULL DEFAULT 0,
  visitor_to_conversation_rate numeric,
  conversation_to_resolution_rate numeric,
  avg_resolution_time_seconds numeric,
  support_load_score       numeric,
  PRIMARY KEY (bucket_hour, workspace_id)
);

CREATE INDEX IF NOT EXISTS business_metrics_hourly_workspace_idx
  ON public.business_metrics_hourly (workspace_id, bucket_hour DESC);

ALTER TABLE public.business_metrics_hourly ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read business_metrics_hourly" ON public.business_metrics_hourly
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Workspace members read own business_metrics" ON public.business_metrics_hourly
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins write business_metrics_hourly" ON public.business_metrics_hourly
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));


-- ─── 3. Workspace health snapshots ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_health_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  health_score        integer     NOT NULL,
  state               text        NOT NULL,    -- 'healthy' | 'warning' | 'at_risk'
  components          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  inputs              jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS workspace_health_snapshots_recent_idx
  ON public.workspace_health_snapshots (workspace_id, captured_at DESC);

ALTER TABLE public.workspace_health_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read workspace_health_snapshots" ON public.workspace_health_snapshots
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Workspace members read own health" ON public.workspace_health_snapshots
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins write workspace_health_snapshots" ON public.workspace_health_snapshots
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));


-- ─── 4. SLO definitions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.slo_definitions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text        NOT NULL UNIQUE,
  title           text        NOT NULL,
  description     text,
  scope_type      text        NOT NULL,      -- 'platform' | 'provider' | 'workspace'
  metric_key      text        NOT NULL,
  target_type     text        NOT NULL,      -- 'min' | 'max'
  target_value    numeric     NOT NULL,
  window_seconds  integer     NOT NULL DEFAULT 86400,
  enabled         boolean     NOT NULL DEFAULT true,
  is_builtin      boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.slo_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read slo_definitions" ON public.slo_definitions
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins write slo_definitions" ON public.slo_definitions
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.slo_definitions_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS slo_definitions_touch_t ON public.slo_definitions;
CREATE TRIGGER slo_definitions_touch_t
  BEFORE UPDATE ON public.slo_definitions
  FOR EACH ROW EXECUTE FUNCTION public.slo_definitions_touch();

-- Protect built-in SLO shape (callers may only tune target_value / window / enabled)
CREATE OR REPLACE FUNCTION public.slo_definitions_protect_builtin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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

DROP TRIGGER IF EXISTS slo_definitions_protect_builtin_t ON public.slo_definitions;
CREATE TRIGGER slo_definitions_protect_builtin_t
  BEFORE UPDATE ON public.slo_definitions
  FOR EACH ROW EXECUTE FUNCTION public.slo_definitions_protect_builtin();


-- ============================================================================
-- 5. Rollup function — SLA / reliability (last full hour, idempotent)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.sla_reliability_rollup_and_prune()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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


-- ============================================================================
-- 6. Rollup function — Business metrics (last full hour, idempotent)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.business_metrics_rollup_and_prune()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  bucket      timestamptz := date_trunc('hour', now()) - interval '1 hour';
  bucket_end  timestamptz := bucket + interval '1 hour';
  rolled      integer := 0;
  pruned      integer := 0;
BEGIN
  -- Per-workspace aggregates.
  WITH conv_window AS (
    -- Conversations created in this bucket
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
  -- First contact message per conversation (for FRT)
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
     WHERE cm.sender_type IN ('agent','operator')
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
        WHERE x.workspace_id = w.id AND sender_type IN ('agent','operator')) AS active_ops,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id AND x.status IN ('open','pending')) AS active_c,
      (SELECT COUNT(*) FROM public.conversations x
        WHERE x.workspace_id = w.id
          AND x.status IN ('open','pending')
          AND NOT EXISTS (
            SELECT 1 FROM public.conversation_messages m
             WHERE m.conversation_id = x.id AND m.sender_type IN ('agent','operator'))
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
    -- support_load_score: 0..1, higher = more load
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

  -- Prune > 180 days
  DELETE FROM public.business_metrics_hourly WHERE bucket_hour < now() - interval '180 days';
  GET DIAGNOSTICS pruned = ROW_COUNT;

  RETURN jsonb_build_object('rolled', rolled, 'pruned', pruned, 'bucket', bucket, 'ran_at', now());
END $$;


-- ============================================================================
-- 7. Workspace health snapshot computation
-- ============================================================================
CREATE OR REPLACE FUNCTION public.workspace_health_snapshot_compute()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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


-- ============================================================================
-- 8. Seed built-in SLO definitions
-- ============================================================================
INSERT INTO public.slo_definitions
  (slug, title, description, scope_type, metric_key, target_type, target_value, window_seconds, enabled, is_builtin)
VALUES
  ('platform_uptime_24h', 'Platform uptime (24h)',
   'Percent of time platform was not in degraded mode in the last 24h.',
   'platform', 'uptime_pct', 'min', 99.0, 86400, true, true),
  ('realtime_availability_24h', 'Realtime availability (24h)',
   'Percent of time realtime was not forced to polling in the last 24h.',
   'platform', 'realtime_availability_pct', 'min', 99.0, 86400, true, true),
  ('failover_recovery_seconds', 'Failover recovery time',
   'Mean seconds between alert fire and resolve.',
   'platform', 'mean_failover_recovery_seconds', 'max', 300, 86400, true, true),
  ('first_response_time_p95', 'First response time p95',
   'Per-workspace 95th percentile first-response time, in seconds.',
   'workspace', 'first_response_time_p95', 'max', 600, 86400, true, true),
  ('unanswered_conversation_ratio', 'Unanswered open conversations',
   'Per-workspace unanswered open conversations.',
   'workspace', 'unanswered_conversations', 'max', 20, 86400, true, true),
  ('workspace_health_score', 'Workspace health score',
   'Per-workspace overall health score.',
   'workspace', 'health_score', 'min', 60, 86400, true, true)
ON CONFLICT (slug) DO NOTHING;


-- ============================================================================
-- 9. Seed alert rules wired to the new metrics
-- ============================================================================
INSERT INTO public.alert_rules
  (slug, title, description, kind, metric, window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin)
VALUES
  ('platform_uptime_breach', 'Platform uptime breach',
   'Triggered when platform uptime falls below SLO in the last hour.',
   'count', 'platform.uptime_breach', 3600, 1, 3, 1, true, true),
  ('degraded_minutes_high', 'High degraded minutes',
   'Auto-actions kept platform in degraded mode for too long.',
   'count', 'platform.degraded_minute', 3600, 10, 30, 1, true, true),
  ('failover_frequency_high', 'Failover frequency high',
   'Realtime failover engine switched providers too often.',
   'count', 'realtime.failover_switch', 3600, 3, 6, 1, true, true),
  ('first_response_time_breach', 'First response time breach',
   'p95 first-response time crossed SLO target.',
   'count', 'workspace.frt_breach', 3600, 1, 3, 1, true, true),
  ('unanswered_conversation_spike', 'Unanswered conversations spike',
   'Workspace has too many unanswered open conversations.',
   'count', 'workspace.unanswered_high', 3600, 1, 3, 1, true, true),
  ('workspace_health_score_low', 'Workspace health score low',
   'A workspace fell into the at_risk band.',
   'count', 'workspace.health_at_risk', 3600, 1, 3, 1, true, true)
ON CONFLICT (slug) DO NOTHING;
