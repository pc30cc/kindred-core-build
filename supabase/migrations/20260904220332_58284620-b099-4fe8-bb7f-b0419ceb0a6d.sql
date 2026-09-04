-- Visitor liveness write coalescing.
-- Replaces the per-heartbeat (SELECT + UPDATE visitor_sessions + UPDATE
-- visitor_presence) pattern with a single atomic call that only writes when
-- something actually changed (page navigation) or the liveness row has aged
-- past p_min_interval_ms. Business/session state is untouched.
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
  v_now timestamptz := now();
  v_page_changed boolean := false;
  v_wrote boolean := false;
  v_min_ms integer := greatest(coalesce(p_min_interval_ms, 120000), 0);
begin
  select vs.current_page, vs.last_seen_at
    into v_prev_page, v_last
  from public.visitor_sessions vs
  where vs.id = p_session_id
    and vs.workspace_id = p_workspace_id
    and (p_visitor_id is null or vs.visitor_id = p_visitor_id)
  limit 1;

  if not found then
    return query select false, false, false;
    return;
  end if;

  v_page_changed := p_current_page is not null
                    and p_current_page is distinct from v_prev_page;

  if v_page_changed
     or v_last is null
     or v_last < v_now - make_interval(secs => v_min_ms / 1000.0)
  then
    update public.visitor_sessions
       set last_seen_at = v_now,
           current_page = coalesce(p_current_page, current_page)
     where id = p_session_id
       and workspace_id = p_workspace_id;

    update public.visitor_presence
       set status = 'online',
           current_page = coalesce(p_current_page, current_page),
           updated_at = v_now
     where visitor_session_id = p_session_id
       and workspace_id = p_workspace_id;

    v_wrote := true;
  end if;

  return query select true, v_page_changed, v_wrote;
end;
$$;

revoke all on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) from public;
grant execute on function public.visitor_touch_liveness(uuid, uuid, text, text, integer) to service_role;