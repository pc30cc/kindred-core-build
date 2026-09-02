-- 016a_selfhost_product_parity_base_tables.sql
--
-- Self-host parity port of six base product tables that the hosted chain
-- creates but the self-host chain never did: billing_plans,
-- ai_agent_settings, widget_prechat_settings, widget_smart_rules,
-- call_sessions and call_queue_entries.
--
-- Without them the self-host chain could not be replayed from an empty
-- database: 017, 018, 047, 056, 064 and 067 all failed with "relation ...
-- does not exist", which in turn blocked every PostgreSQL integration
-- suite (workspace invitations v5.1 seat entitlement reads billing_plans).
--
-- DDL is a faithful structural port of the hosted chain's final shape.
-- Everything is IF NOT EXISTS / constraint-guarded so the file is safe to
-- replay and is a no-op on installs that already have these tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enum types these tables depend on (idempotent).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.app_role AS ENUM ('admin','moderator','user'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='article_status' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.article_status AS ENUM ('draft','published','archived'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_context_type' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_context_type AS ENUM ('conversation','internal','verification'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_participant_type' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_participant_type AS ENUM ('visitor','operator','admin','internal'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_queue_channel' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_queue_channel AS ENUM ('audio','video'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_queue_state' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_queue_state AS ENUM ('queued','offered','accepted','cancelled','expired','missed','callback_requested'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_recording_state' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_recording_state AS ENUM ('disabled','pending','recording','finalizing','available','failed'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_state' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_state AS ENUM ('pending','ringing','connecting','active','ended','failed','cancelled','missed'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='call_type' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.call_type AS ENUM ('audio','video','screenshare','meeting'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='conversation_priority' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.conversation_priority AS ENUM ('low','normal','high','urgent'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='conversation_status' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.conversation_status AS ENUM ('open','pending','resolved','closed'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='presence_status' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.presence_status AS ENUM ('online','idle','offline'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='sender_type' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.sender_type AS ENUM ('agent','contact','system','bot','ai'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='workspace_role' AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.workspace_role AS ENUM ('owner','admin','agent','viewer','team_lead','sales_agent','support_agent','marketing_manager','seo_manager','analyst','developer','billing'); END IF; END $$;

CREATE OR REPLACE FUNCTION public.set_callback_requests_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE TABLE IF NOT EXISTS public.callback_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid,
    contact_id uuid,
    visitor_session_id text,
    channel text DEFAULT 'audio'::text NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    contact_phone text,
    contact_email text,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    handled_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_for timestamp with time zone
);

COMMENT ON COLUMN public.callback_requests.scheduled_for IS 'Visitor-chosen callback time. NULL = immediate. Phase 8E.';

DO $$ BEGIN IF to_regclass('public.callback_requests') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='callback_requests_pkey' AND conrelid='public.callback_requests'::regclass) THEN ALTER TABLE ONLY public.callback_requests ADD CONSTRAINT callback_requests_pkey PRIMARY KEY (id); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_callback_requests_conversation ON public.callback_requests USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_callback_requests_scheduled_for ON public.callback_requests USING btree (workspace_id, scheduled_for) WHERE ((scheduled_for IS NOT NULL) AND (status = ANY (ARRAY['requested'::text, 'scheduled'::text, 'in_progress'::text])));

CREATE INDEX IF NOT EXISTS idx_callback_requests_workspace_status ON public.callback_requests USING btree (workspace_id, status, requested_at DESC);

CREATE OR REPLACE TRIGGER trg_callback_requests_updated_at BEFORE UPDATE ON public.callback_requests FOR EACH ROW EXECUTE FUNCTION public.set_callback_requests_updated_at();

DO $$ BEGIN IF to_regclass('public.callback_requests') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='callback_requests_contact_id_fkey' AND conrelid='public.callback_requests'::regclass) THEN ALTER TABLE ONLY public.callback_requests ADD CONSTRAINT callback_requests_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL; END IF; END $$;

DO $$ BEGIN IF to_regclass('public.callback_requests') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='callback_requests_conversation_id_fkey' AND conrelid='public.callback_requests'::regclass) THEN ALTER TABLE ONLY public.callback_requests ADD CONSTRAINT callback_requests_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL; END IF; END $$;

DO $$ BEGIN IF to_regclass('public.callback_requests') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='callback_requests_workspace_id_fkey' AND conrelid='public.callback_requests'::regclass) THEN ALTER TABLE ONLY public.callback_requests ADD CONSTRAINT callback_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.callback_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ai_agent_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    agent_name text DEFAULT 'AI Assistant'::text NOT NULL,
    agent_logo_url text,
    business_description text,
    answer_guidance text DEFAULT 'conservative'::text NOT NULL,
    mode text DEFAULT 'off'::text NOT NULL,
    answer_only_from_kb boolean DEFAULT true NOT NULL,
    welcome_message text,
    fallback_message text DEFAULT 'I''m not sure about that yet. I''ll connect you with a human agent.'::text NOT NULL,
    handoff_keywords text[] DEFAULT ARRAY['human'::text, 'agent'::text, 'operator'::text, 'representative'::text, 'speak to someone'::text, 'انسان'::text, 'اپراتور'::text, 'پشتیبان'::text, 'insan'::text, 'operatör'::text, 'temsilci'::text, 'yetkili'::text] NOT NULL,
    max_replies_per_conversation integer DEFAULT 3 NOT NULL,
    max_replies_per_hour integer DEFAULT 20 NOT NULL,
    allowed_locales text[] DEFAULT ARRAY['en'::text, 'tr'::text, 'fa'::text] NOT NULL,
    show_sources_to_operator boolean DEFAULT true NOT NULL,
    show_sources_to_visitor boolean DEFAULT false NOT NULL,
    handoff_on_low_confidence boolean DEFAULT true NOT NULL,
    handoff_on_human_request boolean DEFAULT true NOT NULL,
    handoff_when_no_kb_match boolean DEFAULT true NOT NULL,
    confidence_threshold numeric DEFAULT 0.55 NOT NULL,
    instructions jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ai_intro_enabled boolean DEFAULT true NOT NULL,
    intro_message text,
    fallback_behavior text DEFAULT 'handoff'::text NOT NULL,
    stop_on_handoff boolean DEFAULT true NOT NULL,
    pause_auto_reply_after_human_reply boolean DEFAULT true NOT NULL,
    allow_suggestions_after_takeover boolean DEFAULT true NOT NULL,
    keep_in_automated_until_handoff boolean DEFAULT true NOT NULL,
    escalation_style text DEFAULT 'balanced'::text NOT NULL,
    allow_clarifying_questions boolean DEFAULT true NOT NULL,
    max_clarification_attempts integer DEFAULT 1 NOT NULL,
    allow_answer_with_caveat boolean DEFAULT true NOT NULL,
    learning_enabled boolean DEFAULT true NOT NULL,
    auto_create_learning_candidates boolean DEFAULT true NOT NULL,
    require_approval_for_learning boolean DEFAULT true NOT NULL,
    intro_message_localized jsonb DEFAULT '{}'::jsonb NOT NULL,
    handoff_message_localized jsonb DEFAULT '{}'::jsonb NOT NULL,
    handoff_prechat_message_localized jsonb DEFAULT '{}'::jsonb NOT NULL,
    handoff_policy text,
    max_assist_attempts integer DEFAULT 1 NOT NULL,
    CONSTRAINT ai_agent_settings_escalation_style_check CHECK ((escalation_style = ANY (ARRAY['conservative'::text, 'balanced'::text, 'helpful_first'::text]))),
    CONSTRAINT ai_agent_settings_fallback_chk CHECK ((fallback_behavior = ANY (ARRAY['handoff'::text, 'silent'::text]))),
    CONSTRAINT ai_agent_settings_guidance_chk CHECK ((answer_guidance = ANY (ARRAY['conservative'::text, 'balanced'::text, 'creative'::text]))),
    CONSTRAINT ai_agent_settings_handoff_policy_chk CHECK (((handoff_policy IS NULL) OR (handoff_policy = ANY (ARRAY['immediate'::text, 'assist_first'::text, 'adaptive'::text])))),
    CONSTRAINT ai_agent_settings_max_clar_attempts_check CHECK (((max_clarification_attempts >= 0) AND (max_clarification_attempts <= 5))),
    CONSTRAINT ai_agent_settings_mode_chk CHECK ((mode = ANY (ARRAY['off'::text, 'suggest_only'::text, 'auto_reply_when_offline'::text, 'auto_reply_until_human_joins'::text, 'auto_reply_always'::text])))
);

CREATE TABLE IF NOT EXISTS public.billing_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    sort_order integer DEFAULT 0,
    prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    default_currency text DEFAULT 'USD'::text NOT NULL,
    entitlements jsonb DEFAULT '{}'::jsonb NOT NULL,
    limits jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_price_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    is_free boolean DEFAULT false,
    trial_days integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    localized jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL
);

COMMENT ON COLUMN public.billing_plans.entitlements IS 'Plan feature toggles. Canonical widget credit key is `widget_powered_by` (true = footer shown); `remove_powered_by` is deprecated legacy and read only as a fallback.';

COMMENT ON COLUMN public.billing_plans.localized IS 'Per-locale overrides: { "en": { "name": "...", "description": "..." }, "tr": { ... } }';

COMMENT ON COLUMN public.billing_plans.is_hidden IS 'When true, plan is excluded from user-facing plan listings (still usable by admin/system, e.g. Trial plan).';

CREATE TABLE IF NOT EXISTS public.call_queue_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    channel public.call_queue_channel NOT NULL,
    state public.call_queue_state DEFAULT 'queued'::public.call_queue_state NOT NULL,
    visitor_session_id uuid,
    contact_id uuid,
    conversation_id uuid,
    call_session_id uuid,
    requested_by text DEFAULT 'visitor'::text NOT NULL,
    priority smallint DEFAULT 0 NOT NULL,
    position_hint integer,
    offered_to_user_id uuid,
    offered_at timestamp with time zone,
    accepted_at timestamp with time zone,
    ended_at timestamp with time zone,
    ended_reason text,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    missed_offer_count integer DEFAULT 0 NOT NULL,
    last_offer_expires_at timestamp with time zone,
    offer_timeout_seconds integer DEFAULT 25 NOT NULL,
    sla_breached boolean DEFAULT false NOT NULL,
    callback_request_id uuid,
    entry_source text DEFAULT 'chat'::text NOT NULL,
    department_id uuid,
    assigned_agent_id uuid,
    routing_mode text,
    routing_attempts integer DEFAULT 0 NOT NULL,
    last_routing_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.call_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider text NOT NULL,
    provider_room_id text,
    call_type public.call_type NOT NULL,
    context_type public.call_context_type NOT NULL,
    context_id uuid,
    state public.call_state DEFAULT 'pending'::public.call_state NOT NULL,
    initiated_by uuid,
    initiated_by_type public.call_participant_type DEFAULT 'operator'::public.call_participant_type NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    duration_seconds integer,
    recording_enabled boolean DEFAULT false NOT NULL,
    recording_state public.call_recording_state DEFAULT 'disabled'::public.call_recording_state NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    connected_at timestamp with time zone,
    ended_by text,
    ended_by_user_id uuid,
    end_reason text,
    entry_source text DEFAULT 'chat'::text NOT NULL,
    subject text,
    page_url text,
    page_title text,
    origin text,
    direction text DEFAULT 'inbound'::text NOT NULL,
    visitor_name text,
    visitor_email text,
    visitor_phone text,
    wait_seconds integer DEFAULT 0 NOT NULL,
    department_id uuid,
    assigned_agent_id uuid,
    transfer_from_agent_id uuid,
    transfer_to_agent_id uuid,
    transfer_to_department_id uuid,
    transfer_reason text,
    visitor_session_id uuid,
    CONSTRAINT call_sessions_end_reason_check CHECK (((end_reason IS NULL) OR (end_reason = ANY (ARRAY['operator_ended'::text, 'visitor_ended'::text, 'system_ended'::text, 'failed'::text])))),
    CONSTRAINT call_sessions_ended_by_check CHECK (((ended_by IS NULL) OR (ended_by = ANY (ARRAY['operator'::text, 'visitor'::text, 'system'::text]))))
);

CREATE TABLE IF NOT EXISTS public.widget_prechat_settings (
    workspace_id uuid NOT NULL,
    ask_name boolean DEFAULT true NOT NULL,
    ask_email boolean DEFAULT true NOT NULL,
    ask_phone boolean DEFAULT false NOT NULL,
    require_name boolean DEFAULT true NOT NULL,
    require_email boolean DEFAULT true NOT NULL,
    require_phone boolean DEFAULT false NOT NULL,
    verify_email boolean DEFAULT false NOT NULL,
    verify_phone boolean DEFAULT false NOT NULL,
    history_continue_window_hours integer DEFAULT 24 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    prechat_timing text DEFAULT 'after_handoff'::text NOT NULL,
    CONSTRAINT widget_prechat_timing_check CHECK ((prechat_timing = ANY (ARRAY['always'::text, 'after_handoff'::text, 'never'::text])))
);

CREATE TABLE IF NOT EXISTS public.widget_smart_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    published_version integer DEFAULT 0 NOT NULL,
    trigger_config jsonb DEFAULT '{"type": "time_on_page", "seconds": 20}'::jsonb NOT NULL,
    audience_config jsonb DEFAULT '{"match": "all", "conditions": []}'::jsonb NOT NULL,
    content_config jsonb DEFAULT '{"locales": {}, "default_locale": "en"}'::jsonb NOT NULL,
    presentation_config jsonb DEFAULT '{"mode": "launcher_nudge", "action": "open_chat"}'::jsonb NOT NULL,
    schedule_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    frequency_config jsonb DEFAULT '{"mode": "once_per_session"}'::jsonb NOT NULL,
    behavior_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    published_trigger_config jsonb,
    published_audience_config jsonb,
    published_content_config jsonb,
    published_presentation_config jsonb,
    published_schedule_config jsonb,
    published_frequency_config jsonb,
    published_behavior_config jsonb,
    published_priority integer,
    published_schema_version integer,
    CONSTRAINT widget_smart_rules_name_len CHECK ((length(name) <= 80)),
    CONSTRAINT widget_smart_rules_name_not_blank CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT widget_smart_rules_priority_range CHECK (((priority >= 0) AND (priority <= 1000))),
    CONSTRAINT widget_smart_rules_status_valid CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text])))
);

DO $$ BEGIN
  IF to_regclass('public.ai_agent_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_agent_settings_pkey' AND conrelid='public.ai_agent_settings'::regclass) THEN
    ALTER TABLE ONLY public.ai_agent_settings ADD CONSTRAINT ai_agent_settings_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.ai_agent_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_agent_settings_workspace_id_key' AND conrelid='public.ai_agent_settings'::regclass) THEN
    ALTER TABLE ONLY public.ai_agent_settings ADD CONSTRAINT ai_agent_settings_workspace_id_key UNIQUE (workspace_id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.billing_plans') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='billing_plans_pkey' AND conrelid='public.billing_plans'::regclass) THEN
    ALTER TABLE ONLY public.billing_plans ADD CONSTRAINT billing_plans_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.billing_plans') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='billing_plans_slug_key' AND conrelid='public.billing_plans'::regclass) THEN
    ALTER TABLE ONLY public.billing_plans ADD CONSTRAINT billing_plans_slug_key UNIQUE (slug);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_queue_entries') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_queue_entries_pkey' AND conrelid='public.call_queue_entries'::regclass) THEN
    ALTER TABLE ONLY public.call_queue_entries ADD CONSTRAINT call_queue_entries_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_sessions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_sessions_pkey' AND conrelid='public.call_sessions'::regclass) THEN
    ALTER TABLE ONLY public.call_sessions ADD CONSTRAINT call_sessions_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.widget_prechat_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_prechat_settings_pkey' AND conrelid='public.widget_prechat_settings'::regclass) THEN
    ALTER TABLE ONLY public.widget_prechat_settings ADD CONSTRAINT widget_prechat_settings_pkey PRIMARY KEY (workspace_id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.widget_smart_rules') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_rules_pkey' AND conrelid='public.widget_smart_rules'::regclass) THEN
    ALTER TABLE ONLY public.widget_smart_rules ADD CONSTRAINT widget_smart_rules_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.widget_smart_rules') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_rules_workspace_id_id_key' AND conrelid='public.widget_smart_rules'::regclass) THEN
    ALTER TABLE ONLY public.widget_smart_rules ADD CONSTRAINT widget_smart_rules_workspace_id_id_key UNIQUE (workspace_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS call_sessions_visitor_session_id_idx ON public.call_sessions USING btree (visitor_session_id) WHERE (visitor_session_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_ai_agent_settings_workspace ON public.ai_agent_settings USING btree (workspace_id);

CREATE INDEX IF NOT EXISTS idx_call_queue_assigned ON public.call_queue_entries USING btree (workspace_id, assigned_agent_id);

CREATE INDEX IF NOT EXISTS idx_call_queue_department ON public.call_queue_entries USING btree (workspace_id, department_id);

CREATE INDEX IF NOT EXISTS idx_call_queue_entries_offer_expires ON public.call_queue_entries USING btree (last_offer_expires_at) WHERE (state = 'offered'::public.call_queue_state);

CREATE INDEX IF NOT EXISTS idx_call_queue_offered_to ON public.call_queue_entries USING btree (offered_to_user_id) WHERE (state = 'offered'::public.call_queue_state);

CREATE INDEX IF NOT EXISTS idx_call_queue_workspace_channel_state ON public.call_queue_entries USING btree (workspace_id, channel, state, created_at);

CREATE INDEX IF NOT EXISTS idx_call_queue_ws_entrysource_state ON public.call_queue_entries USING btree (workspace_id, entry_source, state);

CREATE INDEX IF NOT EXISTS idx_call_sessions_assigned ON public.call_sessions USING btree (workspace_id, assigned_agent_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_context ON public.call_sessions USING btree (context_type, context_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_department ON public.call_sessions USING btree (workspace_id, department_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_state_active ON public.call_sessions USING btree (workspace_id, state) WHERE (state = ANY (ARRAY['pending'::public.call_state, 'ringing'::public.call_state, 'connecting'::public.call_state, 'active'::public.call_state]));

CREATE INDEX IF NOT EXISTS idx_call_sessions_workspace ON public.call_sessions USING btree (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_sessions_ws_entrysource_created ON public.call_sessions USING btree (workspace_id, entry_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_widget_smart_rules_ws_status ON public.widget_smart_rules USING btree (workspace_id, status, priority DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_queue_per_visitor_channel ON public.call_queue_entries USING btree (workspace_id, visitor_session_id, channel) WHERE ((state = ANY (ARRAY['queued'::public.call_queue_state, 'offered'::public.call_queue_state])) AND (visitor_session_id IS NOT NULL));

-- Trigger functions these tables depend on.

-- Portable `workspace_owner_phone_verified`. The hosted chain gates some
-- workspace-admin policies on owner phone verification; the self-host chain
-- has no phone-verification feature (no `user_phone_verifications` table), so
-- the check degrades to "verified" when the backing table is absent and to the
-- real lookup when a deployment does have it.
CREATE OR REPLACE FUNCTION public.workspace_owner_phone_verified(_workspace_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _ok boolean;
BEGIN
  IF to_regclass('public.user_phone_verifications') IS NULL THEN
    RETURN true;
  END IF;
  EXECUTE $q$
    SELECT EXISTS (
      SELECT 1
      FROM public.workspaces w
      JOIN public.user_phone_verifications v ON v.user_id = w.owner_id
      WHERE w.id = $1 AND v.verified_at IS NOT NULL
    )
  $q$ INTO _ok USING _workspace_id;
  RETURN COALESCE(_ok, false);
END
$function$;

CREATE OR REPLACE FUNCTION public.update_workspace_provider_settings_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.set_call_queue_entries_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.tg_call_sessions_bill_minutes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seconds  bigint;
  v_minutes  integer;
  v_period   text;
BEGIN
  -- Guard: only fire on transition into 'ended'.
  IF NEW.state IS DISTINCT FROM 'ended' THEN
    RETURN NEW;
  END IF;
  IF OLD.state IS NOT DISTINCT FROM 'ended' THEN
    -- Already ended; do not double-count on subsequent updates.
    RETURN NEW;
  END IF;

  -- Billable only if the call actually connected and we know when it ended.
  IF NEW.connected_at IS NULL OR NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_seconds := GREATEST(0, EXTRACT(EPOCH FROM (NEW.ended_at - NEW.connected_at))::bigint);
  IF v_seconds = 0 THEN
    RETURN NEW;
  END IF;

  v_minutes := CEIL(v_seconds::numeric / 60.0)::integer;
  v_period  := to_char((NEW.ended_at AT TIME ZONE 'UTC'), 'YYYY-MM');

  INSERT INTO public.workspace_usage_counters
    (workspace_id, period, call_minutes_used)
  VALUES
    (NEW.workspace_id, v_period, v_minutes)
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET call_minutes_used = public.workspace_usage_counters.call_minutes_used + v_minutes,
        updated_at        = now();

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.touch_call_sessions_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.widget_prechat_settings_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $function$
;

CREATE OR REPLACE TRIGGER call_queue_entries_set_updated_at BEFORE UPDATE ON public.call_queue_entries FOR EACH ROW EXECUTE FUNCTION public.set_call_queue_entries_updated_at();

CREATE OR REPLACE TRIGGER trg_ai_agent_settings_updated BEFORE UPDATE ON public.ai_agent_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_call_sessions_bill_minutes AFTER UPDATE OF state ON public.call_sessions FOR EACH ROW EXECUTE FUNCTION public.tg_call_sessions_bill_minutes();

CREATE OR REPLACE TRIGGER trg_call_sessions_updated_at BEFORE UPDATE ON public.call_sessions FOR EACH ROW EXECUTE FUNCTION public.touch_call_sessions_updated_at();

CREATE OR REPLACE TRIGGER trg_widget_prechat_settings_touch BEFORE UPDATE ON public.widget_prechat_settings FOR EACH ROW EXECUTE FUNCTION public.widget_prechat_settings_touch();

CREATE OR REPLACE TRIGGER trg_widget_smart_rules_updated_at BEFORE UPDATE ON public.widget_smart_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DO $$ BEGIN
  IF to_regclass('public.ai_agent_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_agent_settings_workspace_id_fkey' AND conrelid='public.ai_agent_settings'::regclass) THEN
    ALTER TABLE ONLY public.ai_agent_settings ADD CONSTRAINT ai_agent_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_queue_entries') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_queue_entries_call_session_id_fkey' AND conrelid='public.call_queue_entries'::regclass) THEN
    ALTER TABLE ONLY public.call_queue_entries ADD CONSTRAINT call_queue_entries_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_queue_entries') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_queue_entries_callback_request_fk' AND conrelid='public.call_queue_entries'::regclass) THEN
    ALTER TABLE ONLY public.call_queue_entries ADD CONSTRAINT call_queue_entries_callback_request_fk FOREIGN KEY (callback_request_id) REFERENCES public.callback_requests(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_queue_entries') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_queue_entries_contact_id_fkey' AND conrelid='public.call_queue_entries'::regclass) THEN
    ALTER TABLE ONLY public.call_queue_entries ADD CONSTRAINT call_queue_entries_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_queue_entries') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_queue_entries_conversation_id_fkey' AND conrelid='public.call_queue_entries'::regclass) THEN
    ALTER TABLE ONLY public.call_queue_entries ADD CONSTRAINT call_queue_entries_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_queue_entries') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_queue_entries_workspace_id_fkey' AND conrelid='public.call_queue_entries'::regclass) THEN
    ALTER TABLE ONLY public.call_queue_entries ADD CONSTRAINT call_queue_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_sessions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_sessions_visitor_session_id_fkey' AND conrelid='public.call_sessions'::regclass) THEN
    ALTER TABLE ONLY public.call_sessions ADD CONSTRAINT call_sessions_visitor_session_id_fkey FOREIGN KEY (visitor_session_id) REFERENCES public.visitor_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_sessions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_sessions_workspace_id_fkey' AND conrelid='public.call_sessions'::regclass) THEN
    ALTER TABLE ONLY public.call_sessions ADD CONSTRAINT call_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.widget_prechat_settings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_prechat_settings_workspace_id_fkey' AND conrelid='public.widget_prechat_settings'::regclass) THEN
    ALTER TABLE ONLY public.widget_prechat_settings ADD CONSTRAINT widget_prechat_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.widget_smart_rules') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_rules_workspace_id_fkey' AND conrelid='public.widget_smart_rules'::regclass) THEN
    ALTER TABLE ONLY public.widget_smart_rules ADD CONSTRAINT widget_smart_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE public.ai_agent_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.call_queue_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.widget_prechat_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.widget_smart_rules ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.workspace_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    plan_id uuid,
    provider_name text DEFAULT 'manual'::text NOT NULL,
    provider_subscription_id text,
    provider_customer_id text,
    status text DEFAULT 'active'::text NOT NULL,
    cancel_at_period_end boolean DEFAULT false,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    trial_end timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT workspace_subscriptions_status_check CHECK ((status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'expired'::text, 'incomplete'::text, 'paused'::text])))
);

DO $$ BEGIN IF to_regclass('public.workspace_subscriptions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_subscriptions_pkey' AND conrelid='public.workspace_subscriptions'::regclass) THEN ALTER TABLE ONLY public.workspace_subscriptions ADD CONSTRAINT workspace_subscriptions_pkey PRIMARY KEY (id); END IF; END $$;

DO $$ BEGIN IF to_regclass('public.workspace_subscriptions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_subscriptions_workspace_id_key' AND conrelid='public.workspace_subscriptions'::regclass) THEN ALTER TABLE ONLY public.workspace_subscriptions ADD CONSTRAINT workspace_subscriptions_workspace_id_key UNIQUE (workspace_id); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_ws_subs_plan ON public.workspace_subscriptions USING btree (plan_id);

CREATE INDEX IF NOT EXISTS idx_ws_subs_status ON public.workspace_subscriptions USING btree (status);

CREATE INDEX IF NOT EXISTS idx_ws_subs_workspace ON public.workspace_subscriptions USING btree (workspace_id);

CREATE OR REPLACE TRIGGER update_workspace_subscriptions_updated_at BEFORE UPDATE ON public.workspace_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_workspace_provider_settings_updated_at();

DO $$ BEGIN IF to_regclass('public.workspace_subscriptions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_subscriptions_plan_id_fkey' AND conrelid='public.workspace_subscriptions'::regclass) THEN ALTER TABLE ONLY public.workspace_subscriptions ADD CONSTRAINT workspace_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.billing_plans(id); END IF; END $$;

DO $$ BEGIN IF to_regclass('public.workspace_subscriptions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_subscriptions_workspace_id_fkey' AND conrelid='public.workspace_subscriptions'::regclass) THEN ALTER TABLE ONLY public.workspace_subscriptions ADD CONSTRAINT workspace_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.workspace_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_smart_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    rule_version integer DEFAULT 1 NOT NULL,
    visitor_id text,
    session_id text,
    event_type text NOT NULL,
    page_path text,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT widget_smart_events_type_valid CHECK ((event_type = ANY (ARRAY['shown'::text, 'opened'::text, 'dismissed'::text, 'cta_clicked'::text, 'widget_opened'::text, 'conversation_started'::text, 'suppressed'::text])))
);

DO $$ BEGIN IF to_regclass('public.widget_smart_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_pkey' AND conrelid='public.widget_smart_events'::regclass) THEN ALTER TABLE ONLY public.widget_smart_events ADD CONSTRAINT widget_smart_events_pkey PRIMARY KEY (id); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_widget_smart_events_rule ON public.widget_smart_events USING btree (rule_id, event_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_widget_smart_events_idem ON public.widget_smart_events USING btree (workspace_id, idempotency_key);

DO $$ BEGIN IF to_regclass('public.widget_smart_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_rule_id_fkey' AND conrelid='public.widget_smart_events'::regclass) THEN ALTER TABLE ONLY public.widget_smart_events ADD CONSTRAINT widget_smart_events_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.widget_smart_rules(id) ON DELETE CASCADE; END IF; END $$;

DO $$ BEGIN IF to_regclass('public.widget_smart_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='widget_smart_events_workspace_id_fkey' AND conrelid='public.widget_smart_events'::regclass) THEN ALTER TABLE ONLY public.widget_smart_events ADD CONSTRAINT widget_smart_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.widget_smart_events ENABLE ROW LEVEL SECURITY;

-- Data API grants + RLS. These tables are workspace-scoped and reached only
-- through the first-party Express backend (service_role); no anon access.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_plans','ai_agent_settings','widget_prechat_settings',
                           'widget_smart_rules','call_sessions','call_queue_entries','callback_requests','workspace_subscriptions','widget_smart_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    END IF;
  END LOOP;
END $$;
