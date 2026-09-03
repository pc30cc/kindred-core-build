-- 110_admin_data_reset.sql
-- Platform-admin database maintenance: JSON backup (export), restore and
-- data purge. All logic runs in SECURITY DEFINER functions guarded by an
-- explicit `_actor_user_id` admin check (service_role has no auth.uid()).
--
-- Scopes:
--   'data' — wipe operational data, KEEP users/identity AND all settings
--            (platform + workspace configuration, plans, branding...).
--   'full' — wipe everything except user identity tables, so the install
--            behaves like a fresh deployment.

create or replace function public.admin_reset_identity_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'profiles','user_credentials','user_roles','accounts','account_members',
    'auth_sessions','user_notification_prefs','user_availability_prefs',
    'user_phone_verifications'
  ]::text[]
$$;

create or replace function public.admin_reset_settings_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'platform_settings','platform_branding','platform_branding_localized',
    'platform_call_center_settings','platform_ai_agent_settings','platform_domains',
    'platform_sms_provider_config','app_runtime_config','feature_flags',
    'billing_plans','role_permissions','translations','legal_policy_versions',
    'email_settings','email_settings_localized','email_templates',
    'ai_models','ai_rate_cards','ai_rate_card_components','ai_sell_policies',
    'ai_exchange_rates','provider_configs','verification_purpose_settings',
    'widget_platform_settings','widget_settings','widget_prechat_settings',
    'workspaces','workspace_settings','workspace_members','workspace_branding',
    'workspace_branding_localized','workspace_domains','workspace_domains_extended',
    'workspace_departments','workspace_department_members','workspace_subscriptions',
    'workspace_limit_overrides','workspace_module_overrides','workspace_provider_settings',
    'workspace_seat_entitlement_mode','workspace_channel_overrides',
    'workspace_plugin_installations','call_center_settings','call_center_departments',
    'call_center_department_agents','channel_integrations','plugin_platform_state',
    'plugin_secrets','ai_agent_settings','enforcement_rules','auto_action_definitions',
    'slo_definitions','alert_rules'
  ]::text[]
$$;

create or replace function public.admin_reset_preserved_tables(_scope text)
returns text[]
language sql
stable
as $$
  select case
    when _scope = 'full' then public.admin_reset_identity_tables()
    else public.admin_reset_identity_tables() || public.admin_reset_settings_tables()
  end
$$;

create or replace function public.admin_reset_target_tables(_scope text)
returns setof text
language sql
stable
set search_path = public
as $$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not (c.relname::text = any (public.admin_reset_preserved_tables(_scope)))
  order by 1
$$;

-- ── Export ──────────────────────────────────────────────────────────────
-- Returns { version, scope, exported_at, tables: { <name>: [ ...rows ] } }
create or replace function public.admin_export_database(
  _actor_user_id uuid,
  _scope text default 'all'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _t text;
  _rows jsonb;
  _tables jsonb := '{}'::jsonb;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;
  if _scope not in ('all', 'data', 'full') then
    raise exception 'invalid scope';
  end if;

  for _t in
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (_scope = 'all' or c.relname::text in (select public.admin_reset_target_tables(_scope)))
    order by 1
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', _t)
      into _rows;
    _tables := _tables || jsonb_build_object(_t, _rows);
  end loop;

  return jsonb_build_object(
    'version', 1,
    'scope', _scope,
    'exported_at', now(),
    'tables', _tables
  );
end;
$$;

-- ── Purge ───────────────────────────────────────────────────────────────
create or replace function public.admin_purge_database(
  _actor_user_id uuid,
  _scope text default 'data'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _t text;
  _n bigint;
  _list text[] := '{}';
  _counts jsonb := '{}'::jsonb;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;
  if _scope not in ('data', 'full') then
    raise exception 'invalid scope';
  end if;

  for _t in select public.admin_reset_target_tables(_scope) loop
    execute format('select count(*) from public.%I', _t) into _n;
    if _n > 0 then
      _counts := _counts || jsonb_build_object(_t, _n);
    end if;
    _list := _list || format('public.%I', _t);
  end loop;

  if array_length(_list, 1) > 0 then
    execute 'truncate table ' || array_to_string(_list, ', ') || ' restart identity cascade';
  end if;

  return jsonb_build_object(
    'scope', _scope,
    'tables_truncated', coalesce(array_length(_list, 1), 0),
    'rows_deleted', _counts
  );
end;
$$;

-- ── Restore ─────────────────────────────────────────────────────────────
create or replace function public.admin_restore_database(
  _actor_user_id uuid,
  _payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _tables jsonb;
  _t text;
  _rows jsonb;
  _restored jsonb := '{}'::jsonb;
  _list text[] := '{}';
  _n bigint;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;

  _tables := _payload -> 'tables';
  if _tables is null or jsonb_typeof(_tables) <> 'object' then
    raise exception 'invalid backup payload';
  end if;

  -- Only restore tables that actually exist right now.
  for _t in select key from jsonb_each(_tables) loop
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname::text = _t
    ) then
      _list := _list || format('public.%I', _t);
    end if;
  end loop;

  if array_length(_list, 1) is null then
    raise exception 'backup contains no known tables';
  end if;

  execute 'truncate table ' || array_to_string(_list, ', ') || ' cascade';

  for _t in select key from jsonb_each(_tables) order by key loop
    continue when not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname::text = _t
    );
    _rows := _tables -> _t;
    if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) = 0 then
      continue;
    end if;
    begin
      execute format(
        'insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1)',
        _t, _t
      ) using _rows;
      _n := jsonb_array_length(_rows);
      _restored := _restored || jsonb_build_object(_t, _n);
    exception when others then
      _restored := _restored || jsonb_build_object(_t, 'error: ' || sqlerrm);
    end;
  end loop;

  return jsonb_build_object('restored', _restored);
end;
$$;

revoke all on function public.admin_export_database(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_purge_database(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_restore_database(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_export_database(uuid, text) to service_role;
grant execute on function public.admin_purge_database(uuid, text) to service_role;
grant execute on function public.admin_restore_database(uuid, jsonb) to service_role;

-- Helper ACL/search_path hardening (applied together with the functions above).
alter function public.admin_reset_identity_tables() set search_path = public;
alter function public.admin_reset_settings_tables() set search_path = public;
alter function public.admin_reset_preserved_tables(text) set search_path = public;
revoke all on function public.admin_reset_identity_tables() from public, anon, authenticated;
revoke all on function public.admin_reset_settings_tables() from public, anon, authenticated;
revoke all on function public.admin_reset_preserved_tables(text) from public, anon, authenticated;
revoke all on function public.admin_reset_target_tables(text) from public, anon, authenticated;
grant execute on function public.admin_reset_target_tables(text) to service_role;
