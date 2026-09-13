-- ============================================================================
-- 181_retention_partition_integration.sql
--
-- Retention on a partitioned table should eventually DETACH/DROP a whole
-- month instead of DELETEing millions of rows. This migration builds only the
-- SAFE half of that: the preview. There is deliberately NO drop/detach
-- function anywhere in this phase — destructive partition lifecycle waits for
-- a separate task after a production observation period, and cleanup stays
-- disabled by default.
--
-- Guarantees enforced here, independently of the application layer:
--   * a permanent policy, a financial/core policy, or a policy on a
--     billing_* / protected table can NEVER produce partition candidates
--   * a disabled policy produces no candidates
--   * a policy with no retention window produces no candidates
-- ============================================================================

create or replace function public.retention_partition_preview(_policy_key text)
returns table (
  policy_key      text,
  parent_table    text,
  partition_key   text,
  cutoff          timestamptz,
  partition_name  text,
  range_start     timestamptz,
  range_end       timestamptz,
  est_rows        bigint,
  est_bytes       bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p record;
  v_days int;
  v_cutoff timestamptz;
  v_key text;
begin
  select * into p from public.data_retention_policies where data_retention_policies.policy_key = _policy_key;
  if p is null then
    raise exception 'policy_not_found: %', _policy_key using errcode = '22023';
  end if;

  -- Protected policies never yield a droppable partition. Three independent
  -- conditions, matching server/services/retention/types.ts exactly.
  if p.retention_mode = 'permanent'
     or p.category in ('financial', 'core')
     or p.table_name like 'billing\_%'
     or p.table_name in (
       'profiles','users','workspaces','accounts','account_members','conversations',
       'conversation_messages','contacts','knowledge_base_articles','knowledge_base_categories',
       'ai_agent_sources','ai_source_pages','ai_knowledge_chunks','ai_run_settlements','financial_settlements'
     )
  then
    return;
  end if;

  if not p.enabled then
    return;
  end if;

  v_days := case when p.retention_mode = 'archive_then_delete'
                 then p.archive_after_days else p.hot_retention_days end;
  if v_days is null or v_days <= 0 then
    return;
  end if;

  select m.partition_key into v_key
  from public.partition_managed_tables() m
  where m.parent_table = p.table_name;
  if v_key is null then
    return; -- not partitioned: the row-based retention engine handles it
  end if;

  v_cutoff := now() - make_interval(days => v_days);

  return query
  select _policy_key, p.table_name, v_key, v_cutoff,
         c.partition_name, c.range_start, c.range_end, c.est_rows, c.total_bytes
  from public.partition_retention_candidates(p.table_name, v_cutoff) c;
end;
$$;

revoke all on function public.retention_partition_preview(text) from public;
revoke all on function public.retention_partition_preview(text) from anon;
revoke all on function public.retention_partition_preview(text) from authenticated;
grant execute on function public.retention_partition_preview(text) to service_role;

comment on function public.retention_partition_preview(text) is
  'READ-ONLY partition retention preview. Never detaches, drops, truncates or deletes. Returns no rows for protected, permanent or disabled policies.';