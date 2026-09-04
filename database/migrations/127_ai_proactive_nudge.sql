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
    topic text NOT NULL,
    message text NOT NULL,
    cta_label text,
    cta_action text,
    cta_url text,
    page_path text,
    confidence numeric,
    ai_run_id uuid,
    status text DEFAULT 'shown' NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + interval '2 hours') NOT NULL,
    CONSTRAINT widget_ai_nudges_topic_len CHECK (length(topic) <= 60),
    CONSTRAINT widget_ai_nudges_message_len CHECK (length(message) <= 400),
    CONSTRAINT widget_ai_nudges_status_valid CHECK (status = ANY (ARRAY['shown'::text,'dismissed'::text,'clicked'::text,'converted'::text,'expired'::text]))
);

DO $$ BEGIN IF to_regclass('public.widget_ai_nudges') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudges_pkey' AND conrelid='public.widget_ai_nudges'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_ai_nudges') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_ai_nudges_workspace_id_fkey' AND conrelid='public.widget_ai_nudges'::regclass) THEN ALTER TABLE ONLY public.widget_ai_nudges ADD CONSTRAINT widget_ai_nudges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_widget_ai_nudges_ws_created ON public.widget_ai_nudges USING btree (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_ai_nudges_session ON public.widget_ai_nudges USING btree (workspace_id, session_id, created_at DESC);

ALTER TABLE public.widget_ai_nudges ENABLE ROW LEVEL SECURITY;

-- Extend widget_smart_events for AI-sourced lifecycle events.
ALTER TABLE public.widget_smart_events ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE public.widget_smart_events ADD COLUMN IF NOT EXISTS source text DEFAULT 'rule' NOT NULL;
ALTER TABLE public.widget_smart_events ADD COLUMN IF NOT EXISTS ai_nudge_id uuid;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_source_valid') THEN ALTER TABLE public.widget_smart_events ADD CONSTRAINT widget_smart_events_source_valid CHECK (source = ANY (ARRAY['rule'::text,'ai_proactive'::text])); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_source_id_consistent') THEN ALTER TABLE public.widget_smart_events ADD CONSTRAINT widget_smart_events_source_id_consistent CHECK (((source = 'rule'::text) AND (rule_id IS NOT NULL) AND (ai_nudge_id IS NULL)) OR ((source = 'ai_proactive'::text) AND (ai_nudge_id IS NOT NULL) AND (rule_id IS NULL))); END IF; END $$;
DO $$ BEGIN IF to_regclass('public.widget_smart_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_ai_nudge_id_fkey' AND conrelid='public.widget_smart_events'::regclass) THEN ALTER TABLE ONLY public.widget_smart_events ADD CONSTRAINT widget_smart_events_ai_nudge_id_fkey FOREIGN KEY (ai_nudge_id) REFERENCES public.widget_ai_nudges(id) ON DELETE CASCADE; END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_widget_smart_events_ai_nudge ON public.widget_smart_events USING btree (ai_nudge_id, event_type, created_at DESC) WHERE (ai_nudge_id IS NOT NULL);

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
  FOREACH t IN ARRAY ARRAY['widget_ai_nudge_settings','widget_ai_nudges'] LOOP
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
