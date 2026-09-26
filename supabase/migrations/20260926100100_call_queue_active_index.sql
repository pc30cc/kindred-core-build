-- 20260926100100 (mirror of database/migrations/219): call_queue_entries —
-- a small index over the ACTIVE queue only.
--
-- ADDITIVE ONLY. One partial index. No column, table or row is touched.
-- Idempotent.
--
-- Why: the call-queue ticker (server/services/calls/queueTicker.ts) runs
-- every 10s on every API replica, and every step of it acts only on entries
-- in state 'queued' or 'offered'. None of the existing indexes leads with
-- `state` for both values, so the expiry sweep
--   UPDATE ... WHERE expires_at < now() AND state IN ('queued','offered')
-- and the ticker's "is anything active?" probe had to read the whole table —
-- a table that keeps every call ever queued. This index holds only the rows
-- that are active right now (usually none), so both become a lookup in an
-- index of a handful of entries, and it costs nothing to maintain for the
-- finished calls that make up almost all of the table.
--
-- Built CONCURRENTLY because this chain is applied with plain `psql -f`
-- (autocommit). The hosted mirror, applied inside a transaction, cannot.

-- A failed CONCURRENTLY build leaves an INVALID index behind under this name,
-- which IF NOT EXISTS would then skip forever. Clear such a leftover first.
do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'idx_call_queue_active'
       and not i.indisvalid
  ) then
    execute 'drop index public.idx_call_queue_active';
  end if;
end;
$$;

-- Plain (not CONCURRENTLY) build: this chain is applied inside a transaction.
-- The index covers only active queue entries, so the build is quick.
create index if not exists idx_call_queue_active
  on public.call_queue_entries (expires_at)
  where state in ('queued', 'offered');

-- The ticker's "is anything active?" probe, as a function so the two states
-- are LITERALS in the SQL the planner sees. Sent through PostgREST as a
-- filter they arrive as a bind parameter, and once Postgres switches that
-- prepared statement to a generic plan it can no longer prove the partial
-- index applies — a `LIMIT 1` probe then looks cheap as a sequential scan and
-- reads the whole table every 10s. Measured on PostgreSQL 16: index scan for
-- the first five executions, full scan from then on. With literals the index
-- is always usable. SECURITY INVOKER on purpose: the server calls it as
-- service_role, which can already read the table.
create or replace function public.call_queue_has_active_entries()
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.call_queue_entries where state in ('queued', 'offered')
  );
$$;

revoke all on function public.call_queue_has_active_entries() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.call_queue_has_active_entries() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.call_queue_has_active_entries() from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.call_queue_has_active_entries() to service_role';
  end if;
end;
$$;
