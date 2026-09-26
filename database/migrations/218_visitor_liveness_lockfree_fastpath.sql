-- 218: visitor liveness — a coalesced heartbeat no longer writes anything.
--
-- ADDITIVE ONLY. One function body replaced (same signature, same result
-- columns, same meaning), one index added. No column, table or row is
-- touched. Every statement is idempotent.
--
-- Why: the widget heartbeats every 60s per visible tab and the server keeps
-- only one liveness write per 120s (VISITOR_LIVENESS_REFRESH_MS), so about
-- half of all calls are meant to be no-ops. They were not: the body opened
-- with SELECT ... FOR NO KEY UPDATE, and a row lock is itself a write — it
-- assigns a transaction id, stamps the tuple, emits a WAL record and makes
-- the commit wait for a WAL flush. Measured on PostgreSQL 16 with the
-- previous body: a coalesced call (wrote = false) still assigned an xid and
-- wrote 96 bytes of WAL. With this body the same call assigns no xid and
-- writes 0 bytes — it is a plain read.
--
-- How: read the row WITHOUT a lock first. If that read already shows the
-- call is a no-op (same page, row younger than the interval), return. Only a
-- call that may have to write takes the old locked path, which is kept
-- exactly as it was, so concurrent multi-tab heartbeats still serialize on
-- the row and page_changed is still decided against the latest committed
-- current_page.
--
-- The self-host chain never had this function: there the server's missing-
-- RPC fallback ran SELECT + two unconditional UPDATEs on EVERY heartbeat.
-- Creating it here gives self-host the same coalescing hosted already had.
--
-- The index: visitor_presence was only indexed on (workspace_id, status), so
-- every presence write keyed by visitor_session_id — this function, /track on
-- every page view, the call-widget bootstrap — scanned the workspace's (or
-- the whole table's) presence rows, and the table only ever grows. It is
-- built CONCURRENTLY here because scripts/migrate-database.sh and CI apply
-- this chain with plain `psql -f` (autocommit), so the build never blocks the
-- widget's writes. The hosted mirror (supabase/migrations, applied inside a
-- transaction) cannot use CONCURRENTLY and builds it normally; whichever chain
-- runs first creates it and the other sees IF NOT EXISTS.

create or replace function public.visitor_touch_liveness(
  p_workspace_id uuid,
  p_session_id uuid,
  p_visitor_id text default null,
  p_current_page text default null,
  p_min_interval_ms integer default 120000
)
returns table (matched boolean, page_changed boolean, wrote boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_page text;
  v_last timestamptz;
  v_now timestamptz := clock_timestamp();
  v_page_changed boolean := false;
  v_wrote boolean := false;
  v_min_ms integer := greatest(coalesce(p_min_interval_ms, 120000), 0);
  v_cutoff timestamptz;
  v_exists boolean := false;
begin
  v_cutoff := v_now - make_interval(secs => v_min_ms / 1000.0);

  -- Fast path: a plain read, no lock. This is the common heartbeat and it
  -- must stay a read-only transaction.
  select vs.current_page, vs.last_seen_at, true
    into v_prev_page, v_last, v_exists
  from public.visitor_sessions vs
  where vs.id = p_session_id
    and vs.workspace_id = p_workspace_id
    and (p_visitor_id is null or vs.visitor_id = p_visitor_id)
  limit 1;

  if not coalesce(v_exists, false) then
    return query select false, false, false;
    return;
  end if;

  if not (
       (p_current_page is not null and p_current_page is distinct from v_prev_page)
       or v_last is null
       or v_last < v_cutoff
     ) then
    return query select true, false, false;
    return;
  end if;

  -- Slow path, unchanged from 20260904221939: a write looks due, so lock the
  -- row and decide again against the latest committed state. Concurrent
  -- heartbeats for the same session queue here; each one observes the state
  -- left by the previous winner (READ COMMITTED re-reads after the lock).
  -- FOR NO KEY UPDATE never conflicts with FK checks against visitor_sessions.
  v_exists := false;
  select vs.current_page, vs.last_seen_at, true
    into v_prev_page, v_last, v_exists
  from public.visitor_sessions vs
  where vs.id = p_session_id
    and vs.workspace_id = p_workspace_id
    and (p_visitor_id is null or vs.visitor_id = p_visitor_id)
  limit 1
  for no key update;

  if not coalesce(v_exists, false) then
    return query select false, false, false;
    return;
  end if;

  v_page_changed := p_current_page is not null
                    and p_current_page is distinct from v_prev_page;

  if v_page_changed
     or v_last is null
     or v_last < v_cutoff
  then
    -- Belt-and-braces: the predicate is repeated in the UPDATE so the write is
    -- still gated even if the row were somehow refreshed between statements.
    update public.visitor_sessions vs
       set last_seen_at = v_now,
           current_page = coalesce(p_current_page, vs.current_page)
     where vs.id = p_session_id
       and vs.workspace_id = p_workspace_id
       and (
         (p_current_page is not null and p_current_page is distinct from vs.current_page)
         or vs.last_seen_at is null
         or vs.last_seen_at < v_cutoff
       );

    if found then
      update public.visitor_presence vp
         set status = 'online',
             current_page = coalesce(p_current_page, vp.current_page),
             updated_at = v_now
       where vp.visitor_session_id = p_session_id
         and vp.workspace_id = p_workspace_id;

      v_wrote := true;
    end if;
  end if;

  return query select true, v_page_changed, v_wrote;
end;
$$;

-- Server-only (service_role), as before. The explicit anon/authenticated
-- revokes matter where default privileges hand new functions to those roles
-- directly — revoking PUBLIC alone would not remove such a grant.
revoke all on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) to service_role';
  end if;
end;
$$;

-- A failed CONCURRENTLY build leaves an INVALID index behind under this name,
-- which IF NOT EXISTS would then skip forever while writes keep maintaining
-- it. Clear such a leftover so a re-run builds a usable one.
do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'idx_visitor_presence_session'
       and not i.indisvalid
  ) then
    execute 'drop index public.idx_visitor_presence_session';
  end if;
end;
$$;

create index concurrently if not exists idx_visitor_presence_session
  on public.visitor_presence (visitor_session_id);
