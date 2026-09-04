-- Visitor liveness coalescing, hardened for concurrent multi-tab heartbeats.
--
-- The previous body read the session row without a lock, so two heartbeats
-- arriving at the same moment could both observe a stale last_seen_at and both
-- write. The row is now locked with FOR NO KEY UPDATE before the decision, so
-- concurrent callers serialize on the session row: the loser re-reads the
-- freshly written last_seen_at (READ COMMITTED re-checks after the lock is
-- released) and coalesces away. FOR NO KEY UPDATE is used so we never conflict
-- with foreign-key reference checks against visitor_sessions.
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
  v_exists boolean := false;
begin
  -- Lock the liveness row first. Concurrent heartbeats for the same session
  -- queue here; each one observes the state left by the previous winner.
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
     or v_last < v_now - make_interval(secs => v_min_ms / 1000.0)
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
         or vs.last_seen_at < v_now - make_interval(secs => v_min_ms / 1000.0)
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

revoke all on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) from public;
grant execute on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) to service_role;