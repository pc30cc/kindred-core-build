-- 017_smart_rules_published_snapshot.sql
-- Smart Engagement: separate published (visitor-facing) snapshot columns
-- from the draft columns edited in the studio. Non-destructive.
-- NOTE: could not be applied live in this session (no DB tool access) —
-- must be run via the supabase--migration tool before this ships.

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
