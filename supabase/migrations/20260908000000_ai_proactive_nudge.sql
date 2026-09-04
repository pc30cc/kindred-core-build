-- AI Proactive Nudge (aka "AI Smart Nudge") — extends the existing Smart
-- Engagement architecture with an AI-generated launcher_nudge surface.
-- Reuses widget_smart_rules' launcher_nudge presentation, widget_smart_events'
-- lifecycle event model, and platform_ai_agent_settings' singleton-ceiling
-- pattern. Does NOT introduce a second Smart Engagement engine, a second AI
-- billing ledger, or a high-frequency raw telemetry table.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Per-workspace AI Proactive Nudge configuration (one row per workspace,
--    mirrors ai_agent_settings' shape). OFF by default for every workspace.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.widget_ai_nudge_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'balanced',
  include_paths text[] NOT NULL DEFAULT '{}',
  exclude_paths text[] NOT NULL DEFAULT '{}',
  guidance text,
  use_kb boolean NOT NULL DEFAULT true,
  use_journey boolean NOT NULL DEFAULT true,
  use_returning_visitor boolean NOT NULL DEFAULT true,
  max_per_session integer NOT NULL DEFAULT 2,
  cooldown_seconds integer NOT NULL DEFAULT 120,
  stop_after_dismiss boolean NOT NULL DEFAULT true,
  stop_after_widget_open boolean NOT NULL DEFAULT true,
  stop_after_conversation boolean NOT NULL DEFAULT true,
  mobile_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT widget_ai_nudge_settings_mode_valid CHECK (mode IN ('off','conservative','balanced','active')),
  CONSTRAINT widget_ai_nudge_settings_guidance_len CHECK (guidance IS NULL OR length(guidance) <= 500),
  CONSTRAINT widget_ai_nudge_settings_max_per_session_range CHECK (max_per_session >= 0 AND max_per_session <= 10),
  CONSTRAINT widget_ai_nudge_settings_cooldown_range CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 3600),
  CONSTRAINT widget_ai_nudge_settings_include_paths_len CHECK (array_length(include_paths, 1) IS NULL OR array_length(include_paths, 1) <= 50),
  CONSTRAINT widget_ai_nudge_settings_exclude_paths_len CHECK (array_length(exclude_paths, 1) IS NULL OR array_length(exclude_paths, 1) <= 50)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.widget_ai_nudge_settings TO authenticated;
GRANT ALL ON public.widget_ai_nudge_settings TO service_role;

ALTER TABLE public.widget_ai_nudge_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view ai nudge settings"
  ON public.widget_ai_nudge_settings FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can upsert ai nudge settings"
  ON public.widget_ai_nudge_settings FOR INSERT TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can update ai nudge settings"
  ON public.widget_ai_nudge_settings FOR UPDATE TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE TRIGGER trg_widget_ai_nudge_settings_updated_at
  BEFORE UPDATE ON public.widget_ai_nudge_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────
-- 2. Generated nudge records — ONE row per AI nudge actually shown (never
--    per evaluation/suppression — those are bounded in-memory metrics, see
--    server/services/observability/collector/). Volume is bounded by the
--    same max_per_session/cooldown gate that governs the AI call itself.
--    Purpose: attribution (shown -> clicked -> conversation_started) and
--    chat continuity (the widget passes nudge_id back when opening chat).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.widget_ai_nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_id text,
  session_id text,
  -- Trusted session lineage (sha256 of the widget token's stable nonce —
  -- see server/services/widget/aiNudge/session.ts). This, NOT session_id
  -- above (client-supplied, display/debug only), is what every frequency,
  -- cooldown, dedup and billing lookup keys on.
  session_key text NOT NULL,
  topic text NOT NULL,
  message text NOT NULL,
  cta_label text,
  cta_action text,
  cta_url text,
  page_path text,
  confidence numeric,
  ai_run_id uuid REFERENCES public.ai_runs(id) ON DELETE SET NULL,
  -- Lifecycle: generated -> shown -> dismissed | clicked -> converted, or
  -- generated -> expired. "generated" != "shown": a candidate is only
  -- "shown" once the browser acknowledges it actually rendered the bubble.
  -- See server/services/widget/aiNudge/lifecycle.ts for the guarded
  -- transition table.
  status text NOT NULL DEFAULT 'generated',
  shown_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  CONSTRAINT widget_ai_nudges_topic_len CHECK (length(topic) <= 60),
  CONSTRAINT widget_ai_nudges_message_len CHECK (length(message) <= 400),
  CONSTRAINT widget_ai_nudges_cta_label_len CHECK (cta_label IS NULL OR length(cta_label) <= 60),
  CONSTRAINT widget_ai_nudges_status_valid CHECK (status IN ('generated','shown','dismissed','clicked','converted','expired')),
  CONSTRAINT widget_ai_nudges_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

GRANT SELECT ON public.widget_ai_nudges TO authenticated;
GRANT ALL ON public.widget_ai_nudges TO service_role;

ALTER TABLE public.widget_ai_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view ai nudges"
  ON public.widget_ai_nudges FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE INDEX idx_widget_ai_nudges_ws_created ON public.widget_ai_nudges (workspace_id, created_at DESC);
CREATE INDEX idx_widget_ai_nudges_session ON public.widget_ai_nudges (workspace_id, session_key, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 2b. Per-session AI-evaluation ceiling — ONE small aggregate row per
--    (workspace, trusted session), NOT a raw event stream. Durable in
--    Postgres (not in-process) so the ceiling survives a process restart
--    and is shared across every Core replica — see
--    ai_nudge_try_increment_session_counter() below for the atomic,
--    concurrency-safe increment.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.widget_ai_nudge_session_state (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_key text NOT NULL,
  evaluation_count integer NOT NULL DEFAULT 0,
  shown_count integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_key),
  CONSTRAINT widget_ai_nudge_session_state_counts_nonneg CHECK (evaluation_count >= 0 AND shown_count >= 0)
);

GRANT ALL ON public.widget_ai_nudge_session_state TO service_role;
ALTER TABLE public.widget_ai_nudge_session_state ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: service_role only (bypasses RLS), same convention
-- as public.ai_billing_recovery_lease.

-- Atomically increments the per-session evaluation counter and returns the
-- NEW count, or NULL if the ceiling has already been reached — the caller
-- MUST treat NULL as "suppress, zero provider calls, zero AI charge".
-- The single INSERT ... ON CONFLICT DO UPDATE ... WHERE ... statement is
-- what makes this safe under concurrent requests and multiple replicas:
-- Postgres row-locks the conflicting row for the statement's duration, so
-- two simultaneous callers can never both observe "count < ceiling" and
-- both proceed.
CREATE OR REPLACE FUNCTION public.ai_nudge_try_increment_session_counter(
  _workspace_id uuid,
  _session_key text,
  _max_evaluations integer,
  _ttl_seconds integer DEFAULT 86400
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _count integer;
BEGIN
  IF _workspace_id IS NULL OR _session_key IS NULL OR length(_session_key) = 0 THEN
    RAISE EXCEPTION 'ai_nudge_session_key_required';
  END IF;
  IF _max_evaluations IS NULL OR _max_evaluations < 0 THEN
    RAISE EXCEPTION 'ai_nudge_max_evaluations_invalid';
  END IF;

  INSERT INTO public.widget_ai_nudge_session_state (
    workspace_id, session_key, evaluation_count, shown_count, last_evaluated_at, expires_at
  )
  VALUES (_workspace_id, _session_key, 1, 0, now(), now() + make_interval(secs => _ttl_seconds))
  ON CONFLICT (workspace_id, session_key) DO UPDATE SET
    evaluation_count = CASE
      WHEN widget_ai_nudge_session_state.expires_at < now() THEN 1
      ELSE widget_ai_nudge_session_state.evaluation_count + 1
    END,
    shown_count = CASE
      WHEN widget_ai_nudge_session_state.expires_at < now() THEN 0
      ELSE widget_ai_nudge_session_state.shown_count
    END,
    last_evaluated_at = now(),
    expires_at = CASE
      WHEN widget_ai_nudge_session_state.expires_at < now() THEN now() + make_interval(secs => _ttl_seconds)
      ELSE widget_ai_nudge_session_state.expires_at
    END
  WHERE widget_ai_nudge_session_state.expires_at < now()
     OR widget_ai_nudge_session_state.evaluation_count < _max_evaluations
  RETURNING evaluation_count INTO _count;

  RETURN _count;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_nudge_try_increment_session_counter(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_nudge_try_increment_session_counter(uuid, text, integer, integer) TO service_role;

-- Best-effort observability counter — never gates anything, so a plain
-- (non-atomic-critical) update is fine.
CREATE OR REPLACE FUNCTION public.ai_nudge_record_shown(_workspace_id uuid, _session_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.widget_ai_nudge_session_state
  SET shown_count = shown_count + 1
  WHERE workspace_id = _workspace_id AND session_key = _session_key;
$$;

REVOKE ALL ON FUNCTION public.ai_nudge_record_shown(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_nudge_record_shown(uuid, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Extend widget_smart_events (the existing, already-analytics-ready
--    lifecycle table) so an AI-sourced nudge's shown/dismissed/cta_clicked/
--    widget_opened/conversation_started events land in the SAME analytics
--    surface as static-rule events, distinguished by `source`.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.widget_smart_events
  ALTER COLUMN rule_id DROP NOT NULL;

ALTER TABLE public.widget_smart_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'rule',
  ADD COLUMN IF NOT EXISTS ai_nudge_id uuid REFERENCES public.widget_ai_nudges(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_smart_events_source_valid') THEN
    ALTER TABLE public.widget_smart_events
      ADD CONSTRAINT widget_smart_events_source_valid CHECK (source IN ('rule','ai_proactive'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_smart_events_source_id_consistent') THEN
    ALTER TABLE public.widget_smart_events
      ADD CONSTRAINT widget_smart_events_source_id_consistent CHECK (
        (source = 'rule' AND rule_id IS NOT NULL AND ai_nudge_id IS NULL)
        OR (source = 'ai_proactive' AND ai_nudge_id IS NOT NULL AND rule_id IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_widget_smart_events_ai_nudge
  ON public.widget_smart_events (ai_nudge_id, event_type, created_at DESC)
  WHERE ai_nudge_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Super Admin platform ceilings — reuse the existing
--    platform_ai_agent_settings singleton (the AI Agent's own platform
--    ceiling table) rather than inventing a second settings hierarchy.
--    These are hard ceilings: workspace configuration is always clamped
--    against them server-side (see server/services/widget/aiNudge/*).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.platform_ai_agent_settings
  ADD COLUMN IF NOT EXISTS ai_proactive_nudge_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_proactive_default_mode text NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS ai_proactive_max_per_session_ceiling integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS ai_proactive_min_cooldown_seconds_ceiling integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS ai_proactive_max_evaluations_per_session_ceiling integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS ai_proactive_max_message_length integer NOT NULL DEFAULT 220,
  ADD COLUMN IF NOT EXISTS ai_proactive_min_confidence_floor numeric NOT NULL DEFAULT 0.55;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_ai_agent_settings_proactive_mode_valid') THEN
    ALTER TABLE public.platform_ai_agent_settings
      ADD CONSTRAINT platform_ai_agent_settings_proactive_mode_valid
      CHECK (ai_proactive_default_mode IN ('off','conservative','balanced','active'));
  END IF;
END $$;

COMMENT ON TABLE public.widget_ai_nudge_settings IS 'Per-workspace AI Proactive Nudge (AI Smart Nudge) configuration. Extends Smart Engagement; does not fork it.';
COMMENT ON TABLE public.widget_ai_nudges IS 'One row per AI-generated nudge actually shown to a visitor. Bounded by max_per_session/cooldown — never per evaluation.';
