-- ============================================================================
-- Phase 7.5 — SLA Enforcement Layer
-- ============================================================================

-- ─── 1. Extend auto_action_definitions CHECK with new enforcement action types ─
ALTER TABLE public.auto_action_definitions
  DROP CONSTRAINT IF EXISTS auto_action_definitions_action_type_check;

ALTER TABLE public.auto_action_definitions
  ADD CONSTRAINT auto_action_definitions_action_type_check
  CHECK (action_type IN (
    'disable_typing_temporarily',
    'force_polling_mode',
    'increase_reconnect_backoff',
    'mark_system_degraded',
    -- Phase 7.5 enforcement actions
    'throttle_new_conversations',
    'slow_mode_messages',
    'operator_load_shedding',
    'priority_only_mode'
  ));

-- ─── 2. SLO breach events (sustained breach tracking) ──────────────────────
CREATE TABLE IF NOT EXISTS public.slo_breach_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slo_id          uuid        NOT NULL REFERENCES public.slo_definitions(id) ON DELETE CASCADE,
  slo_slug        text        NOT NULL,
  scope_type      text        NOT NULL,            -- platform | provider | workspace
  scope_key       text        NOT NULL,
  state           text        NOT NULL,            -- open | resolved
  observed_value  numeric,
  target_value    numeric     NOT NULL,
  target_type     text        NOT NULL,            -- min | max
  consecutive_breaches integer NOT NULL DEFAULT 1,
  first_breach_at timestamptz NOT NULL DEFAULT now(),
  last_breach_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  details         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT slo_breach_events_state_check CHECK (state IN ('open','resolved'))
);

CREATE INDEX IF NOT EXISTS slo_breach_events_open_idx
  ON public.slo_breach_events (slo_id, scope_type, scope_key, state)
  WHERE state = 'open';

CREATE INDEX IF NOT EXISTS slo_breach_events_recent_idx
  ON public.slo_breach_events (last_breach_at DESC);

-- One open breach per (slo, scope) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS slo_breach_events_one_open_per_scope
  ON public.slo_breach_events (slo_id, scope_type, scope_key)
  WHERE state = 'open';

ALTER TABLE public.slo_breach_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read slo_breach_events" ON public.slo_breach_events
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins write slo_breach_events" ON public.slo_breach_events
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));


-- ─── 3. Enforcement rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enforcement_rules (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text        NOT NULL UNIQUE,
  title             text        NOT NULL,
  description       text,
  trigger_type      text        NOT NULL,         -- slo_breach | health_score | alert_rate
  condition_json    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actions_json      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cooldown_seconds  integer     NOT NULL DEFAULT 600,
  ttl_seconds       integer     NOT NULL DEFAULT 900,
  enabled           boolean     NOT NULL DEFAULT true,
  is_builtin        boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enforcement_rules_trigger_type_check
    CHECK (trigger_type IN ('slo_breach','health_score','alert_rate')),
  CONSTRAINT enforcement_rules_cooldown_check CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  CONSTRAINT enforcement_rules_ttl_check CHECK (ttl_seconds BETWEEN 60 AND 86400)
);

CREATE INDEX IF NOT EXISTS enforcement_rules_enabled_idx
  ON public.enforcement_rules (enabled) WHERE enabled = true;

ALTER TABLE public.enforcement_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read enforcement_rules" ON public.enforcement_rules
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins write enforcement_rules" ON public.enforcement_rules
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.touch_enforcement_rules()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS enforcement_rules_touch_t ON public.enforcement_rules;
CREATE TRIGGER enforcement_rules_touch_t
  BEFORE UPDATE ON public.enforcement_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_enforcement_rules();

-- Protect built-in rule shape (callers may only tune cooldown/ttl/enabled)
CREATE OR REPLACE FUNCTION public.enforcement_rules_protect_builtin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF OLD.is_builtin = true THEN
    NEW.slug := OLD.slug;
    NEW.trigger_type := OLD.trigger_type;
    NEW.condition_json := OLD.condition_json;
    NEW.actions_json := OLD.actions_json;
    NEW.is_builtin := true;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforcement_rules_protect_builtin_t ON public.enforcement_rules;
CREATE TRIGGER enforcement_rules_protect_builtin_t
  BEFORE UPDATE ON public.enforcement_rules
  FOR EACH ROW EXECUTE FUNCTION public.enforcement_rules_protect_builtin();


-- ─── 4. Enforcement engine audit (which rule triggered which action) ──────
-- We REUSE auto_action_events as the canonical "active actions" store so
-- the existing autoActionsCache + effective_policy resolver pick them up
-- automatically. enforcement_actions is a thin audit linking rule→event.
CREATE TABLE IF NOT EXISTS public.enforcement_actions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id             uuid        NOT NULL REFERENCES public.enforcement_rules(id) ON DELETE CASCADE,
  rule_slug           text        NOT NULL,
  trigger_type        text        NOT NULL,
  trigger_payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  auto_action_event_id uuid       REFERENCES public.auto_action_events(id) ON DELETE SET NULL,
  scope_type          text        NOT NULL,
  scope_key           text        NOT NULL,
  dry_run             boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enforcement_actions_recent_idx
  ON public.enforcement_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS enforcement_actions_rule_idx
  ON public.enforcement_actions (rule_id, created_at DESC);

ALTER TABLE public.enforcement_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read enforcement_actions" ON public.enforcement_actions
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins write enforcement_actions" ON public.enforcement_actions
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));


-- ─── 5. Seed built-in auto_action_definitions for the new action types ────
INSERT INTO public.auto_action_definitions (
  slug, title, description, action_type, trigger_rule_slug,
  min_severity, enabled, cooldown_seconds, max_duration_seconds, is_builtin
) VALUES
  ('throttle_new_conversations_builtin',
   'Throttle new conversations',
   'Asks widget clients to slow new conversation creation under load. Reversible.',
   'throttle_new_conversations', NULL, 'critical', false, 600, 900, true),
  ('slow_mode_messages_builtin',
   'Slow-mode messages',
   'Adds a small client-side delay between messages to reduce burst load.',
   'slow_mode_messages', NULL, 'critical', false, 600, 900, true),
  ('operator_load_shedding_builtin',
   'Operator load shedding',
   'Reduces non-critical operator UI polling/subscriptions when overloaded.',
   'operator_load_shedding', NULL, 'critical', false, 600, 900, true),
  ('priority_only_mode_builtin',
   'Priority-only mode',
   'Routes only high-priority conversations through realtime; others poll.',
   'priority_only_mode', NULL, 'critical', false, 900, 1800, true)
ON CONFLICT (slug) DO NOTHING;


-- ─── 6. Seed enforcement rules ────────────────────────────────────────────
INSERT INTO public.enforcement_rules (
  slug, title, description, trigger_type, condition_json, actions_json,
  cooldown_seconds, ttl_seconds, enabled, is_builtin
) VALUES
  ('health_score_warning',
   'Health < 60 → degraded + typing off',
   'When workspace or platform health drops below 60, mark degraded and suppress typing.',
   'health_score',
   '{"max_score": 60, "min_score": 40, "scope": "any"}'::jsonb,
   '["mark_system_degraded","disable_typing_temporarily"]'::jsonb,
   600, 900, true, true),
  ('health_score_critical',
   'Health < 40 → force polling',
   'When health drops below 40, force polling transport across clients.',
   'health_score',
   '{"max_score": 40, "scope": "any"}'::jsonb,
   '["mark_system_degraded","force_polling_mode","disable_typing_temporarily"]'::jsonb,
   600, 900, true, true),
  ('frt_p95_breach_throttle',
   'FRT p95 breach → throttle conversations',
   'When first-response-time p95 SLO is breached, throttle new conversations.',
   'slo_breach',
   '{"slo_slug": "first_response_time_p95", "min_consecutive_breaches": 2}'::jsonb,
   '["throttle_new_conversations","slow_mode_messages"]'::jsonb,
   900, 1200, true, true),
  ('platform_uptime_breach_degraded',
   'Platform uptime breach → degraded mode',
   'When the platform uptime SLO is breached, mark system degraded.',
   'slo_breach',
   '{"slo_slug": "platform_uptime", "min_consecutive_breaches": 1}'::jsonb,
   '["mark_system_degraded"]'::jsonb,
   600, 1800, true, true),
  ('alert_rate_high_priority_only',
   'High alert rate → priority-only mode',
   'When critical alerts spike, switch to priority-only routing.',
   'alert_rate',
   '{"min_critical_in_window": 5, "window_seconds": 600}'::jsonb,
   '["priority_only_mode","operator_load_shedding"]'::jsonb,
   900, 1800, true, true)
ON CONFLICT (slug) DO NOTHING;


-- ─── 7. Runtime config: kill switch + dry-run + max concurrent ────────────
INSERT INTO public.app_runtime_config (key, value) VALUES
  ('enforcement_kill_switch', '{"enabled": false}'::jsonb),
  ('enforcement_dry_run',     '{"enabled": false}'::jsonb),
  ('enforcement_max_concurrent', '{"value": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;