-- =========================================================================
-- Phase 4: Alerting & anomaly detection
-- =========================================================================

-- ---------- alert_rules ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alert_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  title         text NOT NULL,
  description   text,
  -- 'count' = absolute count of `metric` over window
  -- 'ratio' = numerator_metric / denominator_metric over window
  kind          text NOT NULL CHECK (kind IN ('count','ratio')),
  metric        text,                  -- used when kind = 'count'
  numerator     text,                  -- used when kind = 'ratio'
  denominator   text,                  -- used when kind = 'ratio'
  window_seconds integer NOT NULL DEFAULT 300 CHECK (window_seconds BETWEEN 60 AND 3600),
  warn_threshold  numeric NOT NULL,
  critical_threshold numeric NOT NULL,
  -- For ratio rules: minimum denominator sample size before the ratio is
  -- considered statistically meaningful. Avoids "1/1 = 100% failure" noise.
  min_sample      integer NOT NULL DEFAULT 0 CHECK (min_sample >= 0),
  enabled       boolean NOT NULL DEFAULT true,
  is_builtin    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_rules_kind_fields_chk CHECK (
    (kind = 'count' AND metric IS NOT NULL AND numerator IS NULL AND denominator IS NULL)
    OR
    (kind = 'ratio' AND numerator IS NOT NULL AND denominator IS NOT NULL AND metric IS NULL)
  ),
  CONSTRAINT alert_rules_threshold_chk CHECK (critical_threshold >= warn_threshold)
);

CREATE INDEX IF NOT EXISTS alert_rules_enabled_idx ON public.alert_rules(enabled);

ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read alert rules"
  ON public.alert_rules FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update alert rules"
  ON public.alert_rules FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access alert_rules"
  ON public.alert_rules FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.alert_rules_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS alert_rules_touch_t ON public.alert_rules;
CREATE TRIGGER alert_rules_touch_t
  BEFORE UPDATE ON public.alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.alert_rules_touch();

-- ---------- alert_events --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alert_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES public.alert_rules(id) ON DELETE CASCADE,
  rule_slug       text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('warn','critical','resolved')),
  state           text NOT NULL CHECK (state IN ('open','resolved')),
  metric_value    numeric,
  threshold_value numeric,
  window_seconds  integer NOT NULL,
  sample_size     integer,            -- denominator sample for ratio rules
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  fired_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  webhook_status  text,               -- 'pending' | 'delivered' | 'failed' | 'disabled'
  webhook_attempts integer NOT NULL DEFAULT 0,
  webhook_last_error text,
  webhook_last_attempt_at timestamptz
);

CREATE INDEX IF NOT EXISTS alert_events_rule_state_idx
  ON public.alert_events(rule_id, state);
CREATE INDEX IF NOT EXISTS alert_events_fired_at_idx
  ON public.alert_events(fired_at DESC);

ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read alert events"
  ON public.alert_events FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access alert_events"
  ON public.alert_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ---------- widget_platform_settings: new alerting fields -----------------
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS alerting_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alert_webhook_url text,
  ADD COLUMN IF NOT EXISTS alert_webhook_secret text;

-- Update validator to allow / sanity-check new fields without breaking existing checks.
CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Phase 1
  IF NEW.typing_rate_limit_window_ms < 250 OR NEW.typing_rate_limit_window_ms > 60000 THEN
    RAISE EXCEPTION 'typing_rate_limit_window_ms must be between 250 and 60000';
  END IF;
  IF NEW.typing_rate_limit_max_events < 1 OR NEW.typing_rate_limit_max_events > 100 THEN
    RAISE EXCEPTION 'typing_rate_limit_max_events must be between 1 and 100';
  END IF;

  -- Phase 2
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

  -- Phase 3
  IF NEW.observability_log_level NOT IN ('debug','info','warn','error') THEN
    RAISE EXCEPTION 'observability_log_level must be one of debug|info|warn|error';
  END IF;

  -- Phase 4: alerting webhook URL must look like an http(s) URL when set
  IF NEW.alert_webhook_url IS NOT NULL AND NEW.alert_webhook_url <> '' THEN
    IF NEW.alert_webhook_url !~ '^https?://' THEN
      RAISE EXCEPTION 'alert_webhook_url must start with http:// or https://';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------- Seed default rules (idempotent) -------------------------------
INSERT INTO public.alert_rules
  (slug, title, description, kind, metric, numerator, denominator,
   window_seconds, warn_threshold, critical_threshold, min_sample, enabled, is_builtin)
VALUES
  ('subscribe_failed_spike',
   'Subscribe failures spiking',
   'Absolute count of realtime.subscribe_failed events in the window.',
   'count', 'realtime.subscribe_failed', NULL, NULL,
   300, 20, 100, 0, true, true),

  ('token_refresh_failed_sustained',
   'Token refresh failing repeatedly',
   'Absolute count of realtime.token_refresh_failed in the window.',
   'count', 'realtime.token_refresh_failed', NULL, NULL,
   300, 5, 25, 0, true, true),

  ('ws_error_spike',
   'WebSocket errors spiking',
   'Absolute count of realtime.ws_error in the window.',
   'count', 'realtime.ws_error', NULL, NULL,
   300, 25, 150, 0, true, true),

  ('channel_ownership_reject_burst',
   'Channel ownership rejects (possible abuse)',
   'Bursts of realtime.channel_ownership_reject indicate misuse or bug.',
   'count', 'realtime.channel_ownership_reject', NULL, NULL,
   300, 10, 50, 0, true, true),

  ('subscribe_failed_ratio',
   'High subscribe failure ratio',
   'subscribe_failed / token_minted exceeds threshold.',
   'ratio', NULL, 'realtime.subscribe_failed', 'realtime.token_minted',
   300, 0.05, 0.20, 20, true, true),

  ('fallback_engaged_ratio',
   'High realtime → polling fallback ratio',
   'fallback_engaged / reconnect_attempt exceeds threshold.',
   'ratio', NULL, 'realtime.fallback_engaged', 'realtime.reconnect_attempt',
   600, 0.10, 0.30, 20, true, true),

  ('ws_error_ratio',
   'High WebSocket error ratio per reconnect',
   'ws_error / reconnect_attempt exceeds threshold.',
   'ratio', NULL, 'realtime.ws_error', 'realtime.reconnect_attempt',
   600, 0.20, 0.50, 20, true, true)
ON CONFLICT (slug) DO NOTHING;

-- ---------- Engine: evaluate one rule -------------------------------------
-- Returns a jsonb describing the evaluation. The server-side ticker calls
-- evaluate_alert_rules() and reads/writes alert_events accordingly.
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
BEGIN
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
      WHERE metric = r.metric
        AND occurred_at >= v_window_start;

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
        -- Not enough sample; treat as no signal.
        v_value := 0;
      ELSE
        v_value := v_num / v_den;
        IF v_value >= r.critical_threshold THEN
          v_severity := 'critical'; v_threshold := r.critical_threshold;
        ELSIF v_value >= r.warn_threshold THEN
          v_severity := 'warn'; v_threshold := r.warn_threshold;
        END IF;
      END IF;
    END IF;

    -- Find currently-open event for this rule (if any).
    SELECT * INTO v_open
    FROM public.alert_events
    WHERE rule_id = r.id AND state = 'open'
    ORDER BY fired_at DESC
    LIMIT 1;

    IF v_severity IS NOT NULL THEN
      -- Threshold breached.
      IF v_open.id IS NULL THEN
        -- New alert
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
             'denominator', r.denominator
           ),
           'pending');
        v_changed := v_changed + 1;
      ELSIF v_open.severity <> v_severity THEN
        -- Severity escalation/de-escalation while still open.
        UPDATE public.alert_events
           SET severity = v_severity,
               metric_value = v_value,
               threshold_value = v_threshold,
               sample_size = v_sample,
               webhook_status = 'pending'
         WHERE id = v_open.id;
        v_changed := v_changed + 1;
      ELSE
        -- Still firing at same severity; refresh metric_value silently.
        UPDATE public.alert_events
           SET metric_value = v_value,
               sample_size = v_sample
         WHERE id = v_open.id;
      END IF;
    ELSE
      -- Below thresholds: resolve any open alert for this rule.
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