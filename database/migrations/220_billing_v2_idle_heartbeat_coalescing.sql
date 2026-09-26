-- 220: billing_v2_note_worker_run — an idle, healthy scheduler run no longer
-- rewrites its heartbeat row every 5 minutes.
--
-- ADDITIVE ONLY. One function body replaced: same name, same signature, same
-- upsert. No table, column or row is touched. Idempotent.
--
-- Why: all five Billing V2 scheduler RPCs (invoice scheduler, wallet
-- auto-pay, period activation, dunning, grace expiry) end with
-- PERFORM billing_v2_note_worker_run(...), which was an unconditional
-- INSERT ... ON CONFLICT DO UPDATE. The scheduler ticks every 5 minutes on
-- every API replica, so an install with nothing to bill still wrote the
-- heartbeat table ~1,440 times a day per replica — and that heartbeat was
-- the only thing those idle transactions wrote.
--
-- Now: a run that processed nothing (p_batch = 0) and failed nothing, while
-- the row already records a clean idle run less than 15 minutes old, returns
-- without writing — a plain read. Everything else writes exactly as before:
-- any batch, any failure, the first clean run after a failure (so
-- consecutive_failures and last_error still reset at once), a missing row,
-- and an idle heartbeat every 15 minutes. Because the check reads the shared
-- row, the idle cadence is also no longer multiplied by the replica count.
--
-- Cost: while idle, last_run_at / last_success_at advance every ~15 minutes
-- instead of every 5. Nothing in the application reads them; they are an
-- operator-facing liveness record, and 15 minutes still distinguishes a live
-- scheduler from a dead one.
--
-- (ON CONFLICT DO UPDATE ... WHERE false was not used: it still takes a row
-- lock on the existing tuple, which is itself a WAL write.)

create or replace function public.billing_v2_note_worker_run(
  p_worker   text,
  p_batch    integer,
  p_failures integer,
  p_error    text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.billing_v2_worker_health%rowtype;
begin
  if coalesce(p_batch, 0) = 0 and coalesce(p_failures, 0) = 0 then
    select * into v_row
      from public.billing_v2_worker_health
     where worker = p_worker;
    if found
       and v_row.consecutive_failures = 0
       and v_row.last_error is null
       and v_row.last_batch_size = 0
       and v_row.last_run_at > now() - interval '15 minutes'
    then
      return;
    end if;
  end if;

  insert into public.billing_v2_worker_health as h (
    worker, last_run_at, last_success_at, last_failure_at, last_error,
    last_batch_size, consecutive_failures, updated_at
  ) values (
    p_worker, now(),
    case when coalesce(p_failures, 0) = 0 then now() end,
    case when coalesce(p_failures, 0) > 0 then now() end,
    left(p_error, 500), coalesce(p_batch, 0),
    case when coalesce(p_failures, 0) > 0 then 1 else 0 end, now()
  )
  on conflict (worker) do update set
    last_run_at = now(),
    last_success_at = case when coalesce(p_failures, 0) = 0 then now() else h.last_success_at end,
    last_failure_at = case when coalesce(p_failures, 0) > 0 then now() else h.last_failure_at end,
    last_error = case when coalesce(p_failures, 0) > 0 then left(p_error, 500) else null end,
    last_batch_size = coalesce(p_batch, 0),
    consecutive_failures = case when coalesce(p_failures, 0) > 0
                                then h.consecutive_failures + 1 else 0 end,
    updated_at = now();
end;
$$;

-- CREATE OR REPLACE keeps the existing ACL; restated so a fresh chain ends in
-- the same state.
revoke all on function public.billing_v2_note_worker_run(text, integer, integer, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.billing_v2_note_worker_run(text, integer, integer, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.billing_v2_note_worker_run(text, integer, integer, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.billing_v2_note_worker_run(text, integer, integer, text) to service_role';
  end if;
end;
$$;
