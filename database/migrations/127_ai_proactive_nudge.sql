-- 127_ai_proactive_nudge.sql
-- Self-host mirror of supabase/migrations/20260908000000_ai_proactive_nudge.sql
-- AI Proactive Nudge (aka "AI Smart Nudge") — extends Smart Engagement.
-- Access to these tables is exclusively through the first-party Express
-- backend (service_role); no anon/authenticated Postgres role touches them
-- directly in self-host, matching the existing widget_smart_* convention.

CREATE TABLE IF NOT EXISTS public.widget_ai_nudge_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    mode text DEFAULT 'balanced' NOT NULL,
    include_paths text[] DEFAULT '{}' NOT NULL,
    exclude_paths text[] DEFAULT '{}' NOT NULL,
    guidance text,
    use_kb boolean DEFAULT true NOT NULL,
    use_journey boolean DEFAULT true NOT NULL,
    use_returning_visitor boolean DEFAULT true NOT NULL,
    max_per_session integer DEFAULT 2 NOT NULL,
    cooldown_seconds integer DEFAULT 120 NOT NULL,
    stop_after_dismiss boolean DEFAULT true NOT NULL,
    stop_after_widget_open boolean DEFAULT true NOT NULL,
    stop_after_conversation boolean DEFAULT true NOT NULL,
    mobile_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT widget_ai_nudge_settings_mode_valid CHECK (mode = ANY (ARRAY['off'::text,'conservative'::text,'balanced'::text,'active'::text])),
    CONSTRAINT widget_ai_nudge_settings_guidance_len CHECK (guidance IS NULL OR length(guidance) <= 500),
    CONSTRAINT widget_ai_nudge_settings_max_per_session_range CHECK (max_per_session >= 0 AND max_per_session <= 10),
    CONSTRAINT widget_ai_nudge_settings_cooldown_range CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 3600)
);

DO $$ BEGIN IF to_regclass('public.widget_ai_nudge_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudge_settings_pkey' AND conrelid='public.widget_ai_nudge_settings'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudge_settings ADD CONSTRAINT widget_ai_nudge_settings_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_ai_nudge_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudge_settings_workspace_id_key' AND conrelid='public.widget_ai_nudge_settings'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudge_settings ADD CONSTRAINT widget_ai_nudge_settings_workspace_id_key UNIQUE (workspace_id); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_ai_nudge_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudge_settings_workspace_id_fkey' AND conrelid='public.widget_ai_nudge_settings'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudge_settings ADD CONSTRAINT widget_ai_nudge_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.widget_ai_nudge_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE TRIGGER trg_widget_ai_nudge_settings_updated_at BEFORE UPDATE ON public.widget_ai_nudge_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.widget_ai_nudges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    visitor_id text,
    session_id text,
    -- Trusted session lineage (sha256 of the widget token's stable nonce) —
    -- the ONLY key frequency/cooldown/dedup/billing lookups use. session_id
    -- above is client-supplied display/debug metadata only.
    session_key text NOT NULL,
    topic text NOT NULL,
    message text NOT NULL,
    cta_label text,
    cta_action text,
    cta_url text,
    page_path text,
    confidence numeric,
    ai_run_id uuid,
    evaluation_id uuid,
    -- Lifecycle: generated -> shown -> dismissed | clicked -> converted, or
    -- generated -> expired. See server/services/widget/aiNudge/lifecycle.ts.
    status text DEFAULT 'generated' NOT NULL,
    shown_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + interval '2 hours') NOT NULL,
    CONSTRAINT widget_ai_nudges_topic_len CHECK (length(topic) <= 60),
    CONSTRAINT widget_ai_nudges_message_len CHECK (length(message) <= 400),
    CONSTRAINT widget_ai_nudges_status_valid CHECK (status = ANY (ARRAY['generated'::text,'shown'::text,'dismissed'::text,'clicked'::text,'converted'::text,'expired'::text]))
);

DO $$ BEGIN IF to_regclass('public.widget_ai_nudges') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudges_pkey' AND conrelid='public.widget_ai_nudges'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_ai_nudges') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudges_workspace_id_fkey' AND conrelid='public.widget_ai_nudges'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_ai_nudges') IS NOT NULL AND to_regclass('public.ai_runs') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudges_ai_run_id_fkey' AND conrelid='public.widget_ai_nudges'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_ai_run_id_fkey FOREIGN KEY (ai_run_id) REFERENCES public.ai_runs(id) ON DELETE SET NULL; END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_widget_ai_nudges_ws_created ON public.widget_ai_nudges USING btree (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_ai_nudges_session ON public.widget_ai_nudges USING btree (workspace_id, session_key, created_at DESC);
-- UNIQUE: the final DB-level guarantee that no two rows ever exist for the
-- same durable evaluation_id, even if application-level ownership
-- (acquireAiNudgeEvaluation's isNew flag) were ever violated by a bug or
-- an unforeseen race. See evaluate.ts's insert-conflict (23505) handling.
CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_ai_nudges_evaluation ON public.widget_ai_nudges USING btree (workspace_id, evaluation_id) WHERE (evaluation_id IS NOT NULL);

ALTER TABLE public.widget_ai_nudges ENABLE ROW LEVEL SECURITY;

-- ─── Per-session AI-evaluation ceiling AND durable evaluation identity
--    (bounded aggregate, not a raw event stream — one row per
--    workspace+trusted-session). last_fingerprint/last_evaluation_id let
--    ai_nudge_acquire_evaluation() tell a retry of the same evaluation
--    (reuse evaluation_id, no ceiling consumption) apart from a
--    genuinely new evaluation (mint a new evaluation_id, consume one
--    ceiling slot) — see that function below. ───
CREATE TABLE IF NOT EXISTS public.widget_ai_nudge_session_state (
    workspace_id uuid NOT NULL,
    session_key text NOT NULL,
    evaluation_count integer DEFAULT 0 NOT NULL,
    shown_count integer DEFAULT 0 NOT NULL,
    last_evaluated_at timestamp with time zone,
    last_fingerprint text,
    last_evaluation_id uuid,
    expires_at timestamp with time zone DEFAULT (now() + interval '24 hours') NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT widget_ai_nudge_session_state_counts_nonneg CHECK (evaluation_count >= 0 AND shown_count >= 0)
);

DO $$ BEGIN IF to_regclass('public.widget_ai_nudge_session_state') IS NOT NULL THEN
  ALTER TABLE public.widget_ai_nudge_session_state ADD COLUMN IF NOT EXISTS last_fingerprint text;
  ALTER TABLE public.widget_ai_nudge_session_state ADD COLUMN IF NOT EXISTS last_evaluation_id uuid;
END IF; END $$;

DO $$ BEGIN IF to_regclass('public.widget_ai_nudge_session_state') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudge_session_state_pkey' AND conrelid='public.widget_ai_nudge_session_state'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudge_session_state ADD CONSTRAINT widget_ai_nudge_session_state_pkey PRIMARY KEY (workspace_id, session_key); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_ai_nudge_session_state') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudge_session_state_workspace_id_fkey' AND conrelid='public.widget_ai_nudge_session_state'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudge_session_state ADD CONSTRAINT widget_ai_nudge_session_state_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.widget_ai_nudge_session_state ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: service_role only, same convention as ai_billing_recovery_lease.

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

-- Extend widget_smart_events for AI-sourced lifecycle events.
ALTER TABLE public.widget_smart_events ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE public.widget_smart_events ADD COLUMN IF NOT EXISTS source text DEFAULT 'rule' NOT NULL;
ALTER TABLE public.widget_smart_events ADD COLUMN IF NOT EXISTS ai_nudge_id uuid;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_source_valid') THEN ALTER TABLE public.widget_smart_events ADD CONSTRAINT widget_smart_events_source_valid CHECK (source = ANY (ARRAY['rule'::text,'ai_proactive'::text])); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_source_id_consistent') THEN ALTER TABLE public.widget_smart_events ADD CONSTRAINT widget_smart_events_source_id_consistent CHECK (((source = 'rule'::text) AND (rule_id IS NOT NULL) AND (ai_nudge_id IS NULL)) OR ((source = 'ai_proactive'::text) AND (ai_nudge_id IS NOT NULL) AND (rule_id IS NULL))); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_smart_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_ai_nudge_id_fkey' AND conrelid='public.widget_smart_events'::regclass) THEN ALTER TABLE ONLY public.widget_smart_events ADD CONSTRAINT widget_smart_events_ai_nudge_id_fkey FOREIGN KEY (ai_nudge_id) REFERENCES public.widget_ai_nudges(id) ON DELETE CASCADE; END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_widget_smart_events_ai_nudge ON public.widget_smart_events USING btree (ai_nudge_id, event_type, created_at DESC) WHERE (ai_nudge_id IS NOT NULL);

-- ─── Atomic, server-owned lifecycle transition + event recording for an
--    ai_proactive nudge — the ONLY path allowed to move a
--    widget_ai_nudges row through shown/dismissed/clicked and the ONLY
--    path allowed to insert an 'ai_proactive' widget_smart_events row, so
--    analytics and status can never disagree. Idempotency key is derived
--    HERE, server-side, from immutable identifiers only — never from a
--    client-supplied key. Out-of-order arrival (e.g. click racing ahead
--    of the shown ack) is absorbed by atomically backfilling the implied
--    shown transition first. ───
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
        NULL;
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

-- Super Admin platform ceilings on the existing platform_ai_agent_settings singleton.
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_nudge_enabled boolean DEFAULT true NOT NULL;
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_default_mode text DEFAULT 'balanced' NOT NULL;
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_max_per_session_ceiling integer DEFAULT 3 NOT NULL;
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_min_cooldown_seconds_ceiling integer DEFAULT 60 NOT NULL;
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_max_evaluations_per_session_ceiling integer DEFAULT 20 NOT NULL;
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_max_message_length integer DEFAULT 220 NOT NULL;
ALTER TABLE public.platform_ai_agent_settings ADD COLUMN IF NOT EXISTS ai_proactive_min_confidence_floor numeric DEFAULT 0.55 NOT NULL;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_ai_agent_settings_proactive_mode_valid') THEN ALTER TABLE public.platform_ai_agent_settings ADD CONSTRAINT platform_ai_agent_settings_proactive_mode_valid CHECK (ai_proactive_default_mode = ANY (ARRAY['off'::text,'conservative'::text,'balanced'::text,'active'::text])); END IF; END $$;

-- Data API grants for the two new tables, matching the existing widget_smart_* convention.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['widget_ai_nudge_settings','widget_ai_nudges','widget_ai_nudge_session_state'] LOOP
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
