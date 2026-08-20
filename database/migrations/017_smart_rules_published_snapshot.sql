-- 017_smart_rules_published_snapshot.sql
-- Smart Engagement: separate published (visitor-facing) snapshot columns
-- from the draft columns edited in the studio. Non-destructive.
--
-- ROOT CAUSE FIX (found by independent review of a fresh, unexcluded
-- self-host chain application): this file's own ALTER TABLE below has
-- always assumed public.widget_smart_rules and public.widget_smart_events
-- already exist — true on the hosted chain, where
-- supabase/migrations/20260806102816_79baf36e-...sql creates both tables
-- before supabase/migrations/20260806111801_387d9d1b-...sql (this file's
-- hosted counterpart) runs — but FALSE on the self-host chain, which never
-- ported that base migration at all. Every self-host install has
-- therefore always failed here with "relation public.widget_smart_rules
-- does not exist", meaning this file could never have successfully
-- applied on any self-host database — there is no existing self-host
-- Smart Engagement data this addition could conflict with or need to
-- preserve. Ported below (before the original ALTER logic) as the
-- byte-equivalent, current-final table/column/policy/index/trigger set
-- from that hosted migration, all IF NOT EXISTS / CREATE OR REPLACE, so
-- this file remains safe to re-run.
--
-- update_updated_at_column(): a generic updated_at-touching trigger
-- function the hosted chain already has (added long before Smart
-- Engagement, in supabase/migrations/20260428204448_...sql) but the
-- self-host chain never ported — server/routes/workspaceSmartRules.ts
-- relies on the DB trigger to keep updated_at current on every edit
-- (it never sets updated_at itself), so this is created here too.

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.widget_smart_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  priority INTEGER NOT NULL DEFAULT 100,
  schema_version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER NOT NULL DEFAULT 0,
  trigger_config JSONB NOT NULL DEFAULT '{"type":"time_on_page","seconds":20}'::jsonb,
  audience_config JSONB NOT NULL DEFAULT '{"match":"all","conditions":[]}'::jsonb,
  content_config JSONB NOT NULL DEFAULT '{"default_locale":"en","locales":{}}'::jsonb,
  presentation_config JSONB NOT NULL DEFAULT '{"mode":"launcher_nudge","action":"open_chat"}'::jsonb,
  schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  frequency_config JSONB NOT NULL DEFAULT '{"mode":"once_per_session"}'::jsonb,
  behavior_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CONSTRAINT widget_smart_rules_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT widget_smart_rules_name_len CHECK (length(name) <= 80),
  CONSTRAINT widget_smart_rules_status_valid CHECK (status IN ('draft','active','paused')),
  CONSTRAINT widget_smart_rules_priority_range CHECK (priority >= 0 AND priority <= 1000)
);

DO $grants$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.widget_smart_rules TO authenticated;
  GRANT ALL ON public.widget_smart_rules TO service_role;
END $grants$;

ALTER TABLE public.widget_smart_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can view smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can view smart rules"
  ON public.widget_smart_rules FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can create smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can create smart rules"
  ON public.widget_smart_rules FOR INSERT TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can update smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can update smart rules"
  ON public.widget_smart_rules FOR UPDATE TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can delete smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can delete smart rules"
  ON public.widget_smart_rules FOR DELETE TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE INDEX IF NOT EXISTS idx_widget_smart_rules_ws_status
  ON public.widget_smart_rules (workspace_id, status, priority DESC);

DROP TRIGGER IF EXISTS trg_widget_smart_rules_updated_at ON public.widget_smart_rules;
CREATE TRIGGER trg_widget_smart_rules_updated_at
  BEFORE UPDATE ON public.widget_smart_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.widget_smart_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES public.widget_smart_rules(id) ON DELETE CASCADE,
  rule_version INTEGER NOT NULL DEFAULT 1,
  visitor_id TEXT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  page_path TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT widget_smart_events_type_valid CHECK (
    event_type IN ('shown','opened','dismissed','cta_clicked','widget_opened','conversation_started','suppressed')
  )
);

DO $grants$ BEGIN
  GRANT SELECT ON public.widget_smart_events TO authenticated;
  GRANT ALL ON public.widget_smart_events TO service_role;
END $grants$;

ALTER TABLE public.widget_smart_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can view smart events" ON public.widget_smart_events;
CREATE POLICY "Workspace members can view smart events"
  ON public.widget_smart_events FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE UNIQUE INDEX IF NOT EXISTS uq_widget_smart_events_idem
  ON public.widget_smart_events (workspace_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_widget_smart_events_rule
  ON public.widget_smart_events (rule_id, event_type, created_at DESC);

-- Master switch, OFF by default for every existing workspace.
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS smart_engagement_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------- original 017 logic (published-snapshot columns) — unchanged below ----------

alter table public.widget_smart_rules
  add column if not exists published_trigger_config jsonb,
  add column if not exists published_audience_config jsonb,
  add column if not exists published_content_config jsonb,
  add column if not exists published_presentation_config jsonb,
  add column if not exists published_schedule_config jsonb,
  add column if not exists published_frequency_config jsonb,
  add column if not exists published_behavior_config jsonb,
  add column if not exists published_priority integer,
  add column if not exists published_schema_version integer;

-- Backfill: any rule already live (active + published) gets its current
-- draft snapshotted so it keeps rendering to visitors after this ships.
update public.widget_smart_rules
set
  published_trigger_config = trigger_config,
  published_audience_config = audience_config,
  published_content_config = content_config,
  published_presentation_config = presentation_config,
  published_schedule_config = schedule_config,
  published_frequency_config = frequency_config,
  published_behavior_config = behavior_config,
  published_priority = priority,
  published_schema_version = schema_version
where status = 'active'
  and published_version > 0
  and published_trigger_config is null;

-- Composite unique key so widget_smart_events can enforce workspace/rule
-- alignment via a composite FK (defense in depth alongside the app check).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'widget_smart_rules_workspace_id_id_key'
  ) then
    alter table public.widget_smart_rules
      add constraint widget_smart_rules_workspace_id_id_key unique (workspace_id, id);
  end if;
end $$;

-- Composite FK on widget_smart_events, only if it would not violate any
-- existing row (skip silently otherwise — non-destructive).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'widget_smart_events_workspace_rule_fkey'
  ) and not exists (
    select 1
    from public.widget_smart_events e
    left join public.widget_smart_rules r
      on r.id = e.rule_id and r.workspace_id = e.workspace_id
    where r.id is null
  ) then
    alter table public.widget_smart_events
      add constraint widget_smart_events_workspace_rule_fkey
      foreign key (workspace_id, rule_id)
      references public.widget_smart_rules (workspace_id, id)
      on delete cascade;
  end if;
end $$;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regclass('public.widget_smart_rules') IS NULL THEN
    RAISE EXCEPTION '017: public.widget_smart_rules was not created';
  END IF;
  IF to_regclass('public.widget_smart_events') IS NULL THEN
    RAISE EXCEPTION '017: public.widget_smart_events was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'widget_smart_rules' AND column_name = 'published_trigger_config'
  ) THEN
    RAISE EXCEPTION '017: widget_smart_rules.published_trigger_config was not added';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'widget_settings' AND column_name = 'smart_engagement_enabled'
  ) THEN
    RAISE EXCEPTION '017: widget_settings.smart_engagement_enabled was not added';
  END IF;
  RAISE NOTICE '017: Smart Engagement base schema + published-snapshot columns established';
END
$verify$;
