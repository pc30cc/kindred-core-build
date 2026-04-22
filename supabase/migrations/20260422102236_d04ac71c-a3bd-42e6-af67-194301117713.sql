-- Phase 5B: Performance alerting on top of Phase 5A perf metrics.

-- 1) widget_platform_settings: memory budget for rss_memory_high rule.
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS perf_memory_budget_mb integer NOT NULL DEFAULT 512;

CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
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

-- 2) Extend alert_rules with perf-oriented columns.
ALTER TABLE public.alert_rules
  ADD COLUMN IF NOT EXISTS route_group text,
  ADD COLUMN IF NOT EXISTS subrules    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS aggregation text;

-- Drop legacy strict shape constraints so we can add new kinds.
ALTER TABLE public.alert_rules DROP CONSTRAINT IF EXISTS alert_rules_kind_fields_chk;
ALTER TABLE public.alert_rules DROP CONSTRAINT IF EXISTS alert_rules_kind_check;

ALTER TABLE public.alert_rules
  ADD CONSTRAINT alert_rules_kind_check CHECK (
    kind IN (
      'count','ratio',
      'perf_p95','perf_p99','perf_error_rate',
      'process_avg','process_ratio',
      'combined'
    )
  );

CREATE OR REPLACE FUNCTION public.alert_rules_validate_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
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

DROP TRIGGER IF EXISTS alert_rules_validate_fields_t ON public.alert_rules;
CREATE TRIGGER alert_rules_validate_fields_t
  BEFORE INSERT OR UPDATE ON public.alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.alert_rules_validate_fields();

-- 3) Seed Phase 5B built-in rules. Idempotent.
INSERT INTO public.alert_rules
  (slug, title, description, kind, metric, numerator, denominator, route_group,
   aggregation, subrules,
   window_seconds, warn_threshold, critical_threshold, min_sample,
   enabled, is_builtin)
VALUES
  ('operator_connect_p95_latency', 'Operator connect p95 latency high',
   'p95 latency of /api/realtime/operator-connect over the window.',
   'perf_p95', NULL, NULL, NULL, 'realtime.operator_connect', 'p95_ms', '[]'::jsonb,
   300, 800, 2000, 20, true, true),
  ('subscribe_p95_latency', 'Realtime subscribe p95 latency high',
   'p95 latency of /api/realtime/subscribe over the window.',
   'perf_p95', NULL, NULL, NULL, 'realtime.subscribe', 'p95_ms', '[]'::jsonb,
   300, 700, 1500, 20, true, true),
  ('widget_bootstrap_p95_latency', 'Widget bootstrap p95 latency high',
   'p95 latency of /api/widget/bootstrap over the window.',
   'perf_p95', NULL, NULL, NULL, 'widget.bootstrap', 'p95_ms', '[]'::jsonb,
   300, 1000, 2500, 20, true, true),
  ('session_refresh_p95_latency', 'Widget session refresh p95 latency high',
   'p95 latency of /api/widget/session/refresh over the window.',
   'perf_p95', NULL, NULL, NULL, 'widget.session_refresh', 'p95_ms', '[]'::jsonb,
   300, 600, 1500, 20, true, true),
  ('widget_action_p95_latency', 'Widget action p95 latency high',
   'p95 latency of /api/widget/action over the window.',
   'perf_p95', NULL, NULL, NULL, 'widget.action', 'p95_ms', '[]'::jsonb,
   300, 500, 1200, 30, true, true),
  ('operator_connect_error_rate', 'Operator connect error rate elevated',
   '5xx rate on /api/realtime/operator-connect.',
   'perf_error_rate', NULL, NULL, NULL, 'realtime.operator_connect', 'error_rate', '[]'::jsonb,
   300, 0.02, 0.05, 20, true, true),
  ('subscribe_error_rate', 'Realtime subscribe error rate elevated',
   '5xx rate on /api/realtime/subscribe.',
   'perf_error_rate', NULL, NULL, NULL, 'realtime.subscribe', 'error_rate', '[]'::jsonb,
   300, 0.02, 0.05, 20, true, true),
  ('widget_bootstrap_error_rate', 'Widget bootstrap error rate elevated',
   '5xx rate on /api/widget/bootstrap.',
   'perf_error_rate', NULL, NULL, NULL, 'widget.bootstrap', 'error_rate', '[]'::jsonb,
   300, 0.03, 0.08, 20, true, true),
  ('session_refresh_error_rate', 'Widget session refresh error rate elevated',
   '5xx rate on /api/widget/session/refresh.',
   'perf_error_rate', NULL, NULL, NULL, 'widget.session_refresh', 'error_rate', '[]'::jsonb,
   300, 0.03, 0.08, 20, true, true),
  ('event_loop_lag_sustained', 'Event loop lag sustained high',
   'Average node event-loop lag (ms) over the window.',
   'process_avg', 'event_loop_lag_ms', NULL, NULL, NULL, 'avg_ms', '[]'::jsonb,
   300, 80, 150, 3, true, true),
  ('rss_memory_high', 'RSS memory sustained high',
   'avg(RSS) / perf_memory_budget_mb. Threshold is a fraction (0..1).',
   'process_avg', 'rss_pct_of_budget', NULL, NULL, NULL, 'fraction', '[]'::jsonb,
   600, 0.70, 0.85, 5, true, true),
  ('heap_usage_high', 'Heap usage sustained high',
   'avg(heap_used) / avg(heap_total). Threshold is a fraction (0..1).',
   'process_ratio', 'heap_used_over_total', NULL, NULL, NULL, 'fraction', '[]'::jsonb,
   600, 0.75, 0.90, 5, true, true),
  ('realtime_degradation_combined', 'Realtime degradation (combined)',
   'Open if any realtime degradation signal is currently firing.',
   'combined', NULL, NULL, NULL, NULL, 'or_open',
   '["operator_connect_p95_latency","subscribe_p95_latency","operator_connect_error_rate","subscribe_error_rate","fallback_engaged_ratio","ws_error_ratio"]'::jsonb,
   300, 1, 2, 0, true, true),
  ('overload_suspected', 'Server overload suspected',
   'Open if event-loop lag and any p95 latency rule are firing together.',
   'combined', NULL, NULL, NULL, NULL, 'or_open',
   '["event_loop_lag_sustained","widget_bootstrap_p95_latency","operator_connect_p95_latency","heap_usage_high"]'::jsonb,
   300, 2, 3, 0, true, true)
ON CONFLICT (slug) DO NOTHING;

-- 4) Replace evaluate_alert_rules() to handle the new kinds.
CREATE OR REPLACE FUNCTION public.evaluate_alert_rules()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r              public.alert_rules%ROWTYPE;
  v_value        numeric;
  v_num          numeric;
  v_den          numeric;
  v_severity     text;
  v_threshold    numeric;
  v_open         public.alert_events%ROWTYPE;
  v_changed      integer := 0;
  v_evaluated    integer := 0;
  v_now          timestamptz := now();
  v_window_start timestamptz;
  v_sample       integer;
  v_pct          numeric;
  v_budget_bytes numeric;
  v_combined_cnt integer;
BEGIN
  SELECT (perf_memory_budget_mb::numeric * 1024 * 1024)
    INTO v_budget_bytes
    FROM public.widget_platform_settings
    LIMIT 1;
  v_budget_bytes := COALESCE(v_budget_bytes, 512::numeric * 1024 * 1024);

  FOR r IN SELECT * FROM public.alert_rules WHERE enabled = true LOOP
    v_evaluated := v_evaluated + 1;
    v_window_start := v_now - (r.window_seconds || ' seconds')::interval;
    v_severity := NULL;
    v_threshold := NULL;
    v_value := NULL;
    v_sample := NULL;

    IF r.kind = 'count' THEN
      SELECT COUNT(*)::numeric INTO v_value
      FROM public.realtime_metric_events
      WHERE metric = r.metric AND occurred_at >= v_window_start;
      IF v_value >= r.critical_threshold THEN
        v_severity := 'critical'; v_threshold := r.critical_threshold;
      ELSIF v_value >= r.warn_threshold THEN
        v_severity := 'warn'; v_threshold := r.warn_threshold;
      END IF;

    ELSIF r.kind = 'ratio' THEN
      SELECT COUNT(*)::numeric INTO v_num
      FROM public.realtime_metric_events
      WHERE metric = r.numerator AND occurred_at >= v_window_start;
      SELECT COUNT(*)::numeric INTO v_den
      FROM public.realtime_metric_events
      WHERE metric = r.denominator AND occurred_at >= v_window_start;
      v_sample := COALESCE(v_den, 0)::integer;
      IF v_den IS NULL OR v_den = 0 OR v_sample < r.min_sample THEN
        v_value := 0;
      ELSE
        v_value := v_num / v_den;
        IF v_value >= r.critical_threshold THEN
          v_severity := 'critical'; v_threshold := r.critical_threshold;
        ELSIF v_value >= r.warn_threshold THEN
          v_severity := 'warn'; v_threshold := r.warn_threshold;
        END IF;
      END IF;

    ELSIF r.kind IN ('perf_p95','perf_p99') THEN
      v_pct := CASE WHEN r.kind = 'perf_p95' THEN 0.95 ELSE 0.99 END;
      SELECT COUNT(*)::integer INTO v_sample
      FROM public.perf_request_samples
      WHERE route_group = r.route_group AND occurred_at >= v_window_start;
      IF v_sample IS NULL OR v_sample < GREATEST(r.min_sample, 1) THEN
        v_value := 0;
      ELSE
        SELECT percentile_cont(v_pct) WITHIN GROUP (ORDER BY duration_ms)
          INTO v_value
          FROM public.perf_request_samples
         WHERE route_group = r.route_group AND occurred_at >= v_window_start;
        v_value := COALESCE(v_value, 0);
        IF v_value >= r.critical_threshold THEN
          v_severity := 'critical'; v_threshold := r.critical_threshold;
        ELSIF v_value >= r.warn_threshold THEN
          v_severity := 'warn'; v_threshold := r.warn_threshold;
        END IF;
      END IF;

    ELSIF r.kind = 'perf_error_rate' THEN
      SELECT COUNT(*)::integer, COUNT(*) FILTER (WHERE is_error)::integer
        INTO v_sample, v_num
        FROM public.perf_request_samples
       WHERE route_group = r.route_group AND occurred_at >= v_window_start;
      IF v_sample IS NULL OR v_sample < GREATEST(r.min_sample, 1) THEN
        v_value := 0;
      ELSE
        v_value := v_num::numeric / v_sample::numeric;
        IF v_value >= r.critical_threshold THEN
          v_severity := 'critical'; v_threshold := r.critical_threshold;
        ELSIF v_value >= r.warn_threshold THEN
          v_severity := 'warn'; v_threshold := r.warn_threshold;
        END IF;
      END IF;

    ELSIF r.kind = 'process_avg' THEN
      IF r.metric = 'event_loop_lag_ms' THEN
        SELECT COUNT(*)::integer, AVG(event_loop_lag_ms)
          INTO v_sample, v_value
          FROM public.perf_process_samples
         WHERE occurred_at >= v_window_start;
      ELSIF r.metric = 'rss_pct_of_budget' THEN
        SELECT COUNT(*)::integer, AVG(rss_bytes::numeric / NULLIF(v_budget_bytes,0))
          INTO v_sample, v_value
          FROM public.perf_process_samples
         WHERE occurred_at >= v_window_start;
      ELSE
        v_value := 0; v_sample := 0;
      END IF;
      v_value := COALESCE(v_value, 0);
      IF v_sample IS NULL OR v_sample < GREATEST(r.min_sample, 1) THEN
        NULL;
      ELSIF v_value >= r.critical_threshold THEN
        v_severity := 'critical'; v_threshold := r.critical_threshold;
      ELSIF v_value >= r.warn_threshold THEN
        v_severity := 'warn'; v_threshold := r.warn_threshold;
      END IF;

    ELSIF r.kind = 'process_ratio' THEN
      IF r.metric = 'heap_used_over_total' THEN
        SELECT COUNT(*)::integer,
               AVG(heap_used_bytes::numeric) / NULLIF(AVG(heap_total_bytes::numeric),0)
          INTO v_sample, v_value
          FROM public.perf_process_samples
         WHERE occurred_at >= v_window_start;
      ELSE
        v_value := 0; v_sample := 0;
      END IF;
      v_value := COALESCE(v_value, 0);
      IF v_sample IS NULL OR v_sample < GREATEST(r.min_sample, 1) THEN
        NULL;
      ELSIF v_value >= r.critical_threshold THEN
        v_severity := 'critical'; v_threshold := r.critical_threshold;
      ELSIF v_value >= r.warn_threshold THEN
        v_severity := 'warn'; v_threshold := r.warn_threshold;
      END IF;

    ELSIF r.kind = 'combined' THEN
      SELECT COUNT(DISTINCT ae.rule_slug)::integer INTO v_combined_cnt
        FROM public.alert_events ae
       WHERE ae.state = 'open'
         AND ae.rule_slug IN (SELECT jsonb_array_elements_text(r.subrules));
      v_value := COALESCE(v_combined_cnt, 0)::numeric;
      v_sample := jsonb_array_length(r.subrules);
      IF v_value >= r.critical_threshold THEN
        v_severity := 'critical'; v_threshold := r.critical_threshold;
      ELSIF v_value >= r.warn_threshold THEN
        v_severity := 'warn'; v_threshold := r.warn_threshold;
      END IF;
    END IF;

    -- Lifecycle: open / change-severity / resolve. Same rules as before.
    SELECT * INTO v_open
    FROM public.alert_events
    WHERE rule_id = r.id AND state = 'open'
    ORDER BY fired_at DESC
    LIMIT 1;

    IF v_severity IS NOT NULL THEN
      IF v_open.id IS NULL THEN
        INSERT INTO public.alert_events
          (rule_id, rule_slug, severity, state, metric_value, threshold_value,
           window_seconds, sample_size, details, webhook_status)
        VALUES
          (r.id, r.slug, v_severity, 'open', v_value, v_threshold,
           r.window_seconds, v_sample,
           jsonb_build_object(
             'kind', r.kind,
             'metric', r.metric,
             'numerator', r.numerator,
             'denominator', r.denominator,
             'route_group', r.route_group,
             'aggregation', r.aggregation,
             'subrules', r.subrules
           ),
           'pending');
        v_changed := v_changed + 1;
      ELSIF v_open.severity <> v_severity THEN
        UPDATE public.alert_events
           SET severity = v_severity,
               metric_value = v_value,
               threshold_value = v_threshold,
               sample_size = v_sample,
               webhook_status = 'pending'
         WHERE id = v_open.id;
        v_changed := v_changed + 1;
      ELSE
        UPDATE public.alert_events
           SET metric_value = v_value, sample_size = v_sample
         WHERE id = v_open.id;
      END IF;
    ELSE
      IF v_open.id IS NOT NULL THEN
        UPDATE public.alert_events
           SET state = 'resolved',
               severity = 'resolved',
               resolved_at = v_now,
               metric_value = v_value,
               sample_size = v_sample,
               webhook_status = 'pending'
         WHERE id = v_open.id;
        v_changed := v_changed + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'evaluated', v_evaluated,
    'state_changes', v_changed,
    'ran_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_alert_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_alert_rules() TO service_role;