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
  -- Durable evaluation identity this nudge was generated from (see
  -- widget_ai_nudge_session_state.last_evaluation_id /
  -- ai_nudge_acquire_evaluation() below) — lets a replayed evaluation
  -- request look up and return this SAME row instead of paying for a
  -- second provider execution.
  evaluation_id uuid,
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
CREATE INDEX idx_widget_ai_nudges_evaluation ON public.widget_ai_nudges (workspace_id, evaluation_id) WHERE evaluation_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2b. Per-session AI-evaluation ceiling AND durable evaluation identity —
--    ONE small aggregate row per (workspace, trusted session), NOT a raw
--    event stream. Durable in Postgres (not in-process) so both the
--    ceiling and the evaluation identity survive a process restart and
--    are shared across every Core replica — see
--    ai_nudge_acquire_evaluation() below. last_fingerprint/
--    last_evaluation_id let that RPC tell "this is a retry of the same
--    evaluation" (same fingerprint, still inside the dedup window — reuse
--    the same evaluation_id, do not consume a ceiling slot) apart from
--    "this is a genuinely new evaluation" (different fingerprint, or the
--    same fingerprint after the dedup window lapsed — mint a new
--    evaluation_id, consume one ceiling slot). This durable identity is
--    what AI billing operation keys are built from, so a replayed request
--    can never mint a second provider charge and a later legitimate
--    evaluation can never reuse an old settled AI Run.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.widget_ai_nudge_session_state (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_key text NOT NULL,
  evaluation_count integer NOT NULL DEFAULT 0,
  shown_count integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz,
  last_fingerprint text,
  last_evaluation_id uuid,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_key),
  CONSTRAINT widget_ai_nudge_session_state_counts_nonneg CHECK (evaluation_count >= 0 AND shown_count >= 0)
);

GRANT ALL ON public.widget_ai_nudge_session_state TO service_role;
ALTER TABLE public.widget_ai_nudge_session_state ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: service_role only (bypasses RLS), same convention
-- as public.ai_billing_recovery_lease.

-- Atomically resolves ONE evaluation attempt's durable identity for a
-- trusted session, and returns it as jsonb:
--   {ok:true, evaluation_id, evaluation_count, is_new}   — proceed
--   {ok:false, reason:'ceiling_reached'}                 — suppress
-- A row-level lock (SELECT ... FOR UPDATE) on the single per-session row
-- makes this safe under concurrent requests and multiple replicas: two
-- simultaneous callers can never both mint a new evaluation_id for the
-- same fresh fingerprint, and a retry can never be mistaken for new work.
CREATE OR REPLACE FUNCTION public.ai_nudge_acquire_evaluation(
  _workspace_id uuid,
  _session_key text,
  _fingerprint text,
  _max_evaluations integer,
  _dedup_window_seconds integer DEFAULT 60,
  _ttl_seconds integer DEFAULT 86400
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _row public.widget_ai_nudge_session_state%ROWTYPE;
  _now timestamptz := now();
  _evaluation_id uuid;
  _evaluation_count integer;
BEGIN
  IF _workspace_id IS NULL OR _session_key IS NULL OR length(_session_key) = 0 THEN
    RAISE EXCEPTION 'ai_nudge_session_key_required';
  END IF;
  IF _fingerprint IS NULL OR length(_fingerprint) = 0 THEN
    RAISE EXCEPTION 'ai_nudge_fingerprint_required';
  END IF;
  IF _max_evaluations IS NULL OR _max_evaluations < 0 THEN
    RAISE EXCEPTION 'ai_nudge_max_evaluations_invalid';
  END IF;

  INSERT INTO public.widget_ai_nudge_session_state (workspace_id, session_key, expires_at)
  VALUES (_workspace_id, _session_key, _now + make_interval(secs => _ttl_seconds))
  ON CONFLICT (workspace_id, session_key) DO NOTHING;

  SELECT * INTO _row
    FROM public.widget_ai_nudge_session_state
    WHERE workspace_id = _workspace_id AND session_key = _session_key
    FOR UPDATE;

  -- Fully expired session window: reset counters and fingerprint lineage,
  -- as if this were a brand-new session.
  IF _row.expires_at < _now THEN
    UPDATE public.widget_ai_nudge_session_state
      SET evaluation_count = 0, shown_count = 0, last_fingerprint = NULL,
          last_evaluation_id = NULL, last_evaluated_at = NULL,
          expires_at = _now + make_interval(secs => _ttl_seconds)
      WHERE workspace_id = _workspace_id AND session_key = _session_key;
    _row.evaluation_count := 0;
    _row.last_fingerprint := NULL;
    _row.last_evaluation_id := NULL;
    _row.last_evaluated_at := NULL;
  END IF;

  -- Same fingerprint replayed within the dedup window: a RETRY of the same
  -- logical evaluation, never a new one — reuse its evaluation_id, do not
  -- consume another ceiling slot.
  IF _row.last_fingerprint IS NOT NULL
     AND _row.last_fingerprint = _fingerprint
     AND _row.last_evaluation_id IS NOT NULL
     AND _row.last_evaluated_at IS NOT NULL
     AND _row.last_evaluated_at >= _now - make_interval(secs => _dedup_window_seconds) THEN
    UPDATE public.widget_ai_nudge_session_state
      SET last_evaluated_at = _now
      WHERE workspace_id = _workspace_id AND session_key = _session_key;
    RETURN jsonb_build_object(
      'ok', true, 'evaluation_id', _row.last_evaluation_id,
      'evaluation_count', _row.evaluation_count, 'is_new', false
    );
  END IF;

  -- Genuinely new evaluation (new fingerprint, or the same fingerprint
  -- after the dedup window lapsed): enforce the ceiling, mint a new id.
  IF _row.evaluation_count >= _max_evaluations THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ceiling_reached');
  END IF;

  _evaluation_id := gen_random_uuid();
  UPDATE public.widget_ai_nudge_session_state
    SET evaluation_count = evaluation_count + 1,
        last_fingerprint = _fingerprint,
        last_evaluation_id = _evaluation_id,
        last_evaluated_at = _now
    WHERE workspace_id = _workspace_id AND session_key = _session_key
    RETURNING evaluation_count INTO _evaluation_count;

  RETURN jsonb_build_object('ok', true, 'evaluation_id', _evaluation_id, 'evaluation_count', _evaluation_count, 'is_new', true);
END;
$$;

REVOKE ALL ON FUNCTION public.ai_nudge_acquire_evaluation(uuid, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_nudge_acquire_evaluation(uuid, text, text, integer, integer, integer) TO service_role;

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
-- 3b. Atomic, server-owned lifecycle transition + event recording for an
--    ai_proactive nudge. This is the ONLY path that may move a
--    widget_ai_nudges row through shown/dismissed/clicked and the ONLY
--    path that may insert an 'ai_proactive' widget_smart_events row —
--    both happen in one transaction (this function call), so analytics
--    and status can never disagree, and an invalid transition never
--    leaves behind a lifecycle event.
--
--    The idempotency key is computed HERE, server-side, from immutable
--    identifiers only ('ai_nudge:<workspace>:<nudge>:<event_type>') — a
--    client-supplied idempotency key is never accepted for this source,
--    so a rotated client session_id/token, a retried request, or a
--    duplicate call from another replica can never produce a second
--    event or a second shown-counter increment.
--
--    Out-of-order arrival (e.g. a click racing ahead of the shown ack) is
--    handled by atomically backfilling the implied generated -> shown
--    transition (its own canonical 'shown' event + shown_count bump)
--    before applying the requested transition — the allowed-from table
--    below stays strictly canonical (no skipped states) while real-world
--    races are still absorbed safely.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_nudge_apply_lifecycle_event(
  _workspace_id uuid,
  _nudge_id uuid,
  _event_type text,
  _visitor_id text DEFAULT NULL,
  _session_id text DEFAULT NULL,
  _page_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _nudge public.widget_ai_nudges%ROWTYPE;
  _target_status text;
  _idem_key text;
  _inserted boolean := false;
  _shown_backfilled boolean := false;
BEGIN
  IF _workspace_id IS NULL OR _nudge_id IS NULL OR _event_type IS NULL OR length(_event_type) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_args');
  END IF;

  SELECT * INTO _nudge
    FROM public.widget_ai_nudges
    WHERE id = _nudge_id AND workspace_id = _workspace_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Only these three event types drive a status transition; everything
  -- else (opened, widget_opened, conversation_started, suppressed) is a
  -- pure analytics event recorded against the nudge with no status change.
  _target_status := CASE _event_type
    WHEN 'shown' THEN 'shown'
    WHEN 'dismissed' THEN 'dismissed'
    WHEN 'cta_clicked' THEN 'clicked'
    ELSE NULL
  END;

  IF _target_status IS NOT NULL THEN
    IF _nudge.status = 'generated' AND _target_status <> 'shown' THEN
      IF _nudge.expires_at < now() THEN
        UPDATE public.widget_ai_nudges SET status = 'expired' WHERE id = _nudge_id;
        RETURN jsonb_build_object('ok', false, 'reason', 'expired');
      END IF;
      UPDATE public.widget_ai_nudges SET status = 'shown', shown_at = now() WHERE id = _nudge_id;
      _nudge.status := 'shown';
      _shown_backfilled := true;
      INSERT INTO public.widget_smart_events (
        workspace_id, source, ai_nudge_id, visitor_id, session_id, event_type, page_path, idempotency_key
      ) VALUES (
        _workspace_id, 'ai_proactive', _nudge_id, _visitor_id, _session_id, 'shown', _page_path,
        'ai_nudge:' || _workspace_id::text || ':' || _nudge_id::text || ':shown'
      )
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;
      IF _nudge.session_key IS NOT NULL THEN
        UPDATE public.widget_ai_nudge_session_state
          SET shown_count = shown_count + 1
          WHERE workspace_id = _workspace_id AND session_key = _nudge.session_key;
      END IF;
    END IF;

    IF _target_status = 'shown' THEN
      IF _nudge.status = 'shown' THEN
        NULL; -- idempotent replay: fall through, event insert below is a safe no-op
      ELSIF _nudge.status = 'generated' THEN
        IF _nudge.expires_at < now() THEN
          UPDATE public.widget_ai_nudges SET status = 'expired' WHERE id = _nudge_id;
          RETURN jsonb_build_object('ok', false, 'reason', 'expired');
        END IF;
        UPDATE public.widget_ai_nudges SET status = 'shown', shown_at = now() WHERE id = _nudge_id;
        IF _nudge.session_key IS NOT NULL THEN
          UPDATE public.widget_ai_nudge_session_state
            SET shown_count = shown_count + 1
            WHERE workspace_id = _workspace_id AND session_key = _nudge.session_key;
        END IF;
      ELSE
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
      END IF;
    ELSIF _target_status = 'dismissed' THEN
      IF _nudge.status = 'dismissed' THEN
        NULL;
      ELSIF _nudge.status = 'shown' THEN
        UPDATE public.widget_ai_nudges SET status = 'dismissed' WHERE id = _nudge_id;
      ELSE
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
      END IF;
    ELSIF _target_status = 'clicked' THEN
      IF _nudge.status = 'clicked' THEN
        NULL;
      ELSIF _nudge.status = 'shown' THEN
        UPDATE public.widget_ai_nudges SET status = 'clicked' WHERE id = _nudge_id;
      ELSE
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
      END IF;
    END IF;
  END IF;

  _idem_key := 'ai_nudge:' || _workspace_id::text || ':' || _nudge_id::text || ':' || _event_type;
  INSERT INTO public.widget_smart_events (
    workspace_id, source, ai_nudge_id, visitor_id, session_id, event_type, page_path, idempotency_key
  ) VALUES (
    _workspace_id, 'ai_proactive', _nudge_id, _visitor_id, _session_id, _event_type, _page_path, _idem_key
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING true INTO _inserted;

  RETURN jsonb_build_object(
    'ok', true,
    'status', COALESCE(_target_status, _nudge.status),
    'inserted', COALESCE(_inserted, false),
    'shown_backfilled', _shown_backfilled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ai_nudge_apply_lifecycle_event(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_nudge_apply_lifecycle_event(uuid, uuid, text, text, text, text) TO service_role;

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
