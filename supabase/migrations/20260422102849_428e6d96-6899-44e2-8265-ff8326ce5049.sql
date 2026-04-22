-- Phase 5C — Self-healing / Auto-actions
-- Built-in, low-risk reversible actions that activate when alerts fire.

-- ─── 1. Action definitions (built-in, controlled) ────────────────
CREATE TABLE IF NOT EXISTS public.auto_action_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'disable_typing_temporarily',
    'force_polling_mode',
    'increase_reconnect_backoff',
    'mark_system_degraded'
  )),
  trigger_rule_slug TEXT,                       -- which alert slug activates it
  min_severity TEXT NOT NULL DEFAULT 'critical' CHECK (min_severity IN ('warn','critical')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cooldown_seconds INTEGER NOT NULL DEFAULT 600 CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  max_duration_seconds INTEGER NOT NULL DEFAULT 900 CHECK (max_duration_seconds BETWEEN 60 AND 86400),
  is_builtin BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.auto_action_definitions ENABLE ROW LEVEL SECURITY;
-- No policies = no PostgREST access. Server-only via service role.

-- ─── 2. Action events / history ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auto_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID NOT NULL REFERENCES public.auto_action_definitions(id) ON DELETE CASCADE,
  action_slug TEXT NOT NULL,
  action_type TEXT NOT NULL,
  trigger_rule_slug TEXT,
  trigger_alert_event_id UUID,                  -- soft reference, may be null for manual
  trigger_severity TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','expired','resolved','overridden')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,                             -- 'expired' | 'alert_resolved' | 'manual' | 'admin_override'
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.auto_action_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS auto_action_events_active_idx
  ON public.auto_action_events (definition_id, state, started_at DESC)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS auto_action_events_recent_idx
  ON public.auto_action_events (started_at DESC);

-- ─── 3. Engine: activate / expire actions ────────────────────────
CREATE OR REPLACE FUNCTION public.activate_auto_actions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

GRANT EXECUTE ON FUNCTION public.activate_auto_actions() TO service_role;

-- ─── 4. Seed built-in definitions (idempotent) ───────────────────
INSERT INTO public.auto_action_definitions (
  slug, title, description, action_type, trigger_rule_slug, min_severity,
  enabled, cooldown_seconds, max_duration_seconds
) VALUES
  (
    'overload_disable_typing',
    'Pause typing indicators under overload',
    'Temporarily stops broadcasting typing indicators to reduce realtime pressure when overload is suspected.',
    'disable_typing_temporarily',
    'overload_suspected',
    'warn',
    FALSE,
    600,
    600
  ),
  (
    'realtime_force_polling',
    'Force polling fallback during realtime degradation',
    'Signals widget clients to use polling instead of websockets when combined realtime degradation is detected.',
    'force_polling_mode',
    'realtime_degradation_combined',
    'critical',
    FALSE,
    900,
    900
  ),
  (
    'eventloop_backoff',
    'Increase reconnect backoff on event-loop pressure',
    'Raises the reconnect backoff floor when the event loop is sustained under heavy lag, reducing reconnect storms.',
    'increase_reconnect_backoff',
    'event_loop_lag_sustained',
    'critical',
    FALSE,
    600,
    600
  ),
  (
    'system_degraded_banner',
    'Mark system as degraded',
    'Surfaces a degraded-system banner in admin UI when any critical alert fires. Purely informational; never blocks chat send flow.',
    'mark_system_degraded',
    NULL,                                       -- handled via wildcard in engine (any-critical)
    'critical',
    TRUE,
    300,
    900
  )
ON CONFLICT (slug) DO NOTHING;

-- ─── 5. Updated_at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_auto_action_definitions()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_action_definitions_touch ON public.auto_action_definitions;
CREATE TRIGGER auto_action_definitions_touch
BEFORE UPDATE ON public.auto_action_definitions
FOR EACH ROW EXECUTE FUNCTION public.touch_auto_action_definitions();