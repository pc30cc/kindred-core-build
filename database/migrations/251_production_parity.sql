-- 251 — the database this chain builds behaves like production.
--
-- A database built from database/migrations was compared object by object
-- with the production project's catalog (read-only; scripts/db/schema-fingerprint.sql
-- normalizes what legitimately differs between a Supabase project and plain
-- PostgreSQL). Tables and columns matched; behaviour did not:
--
--   * the hosted billing gate was missing — check_workspace_entitlement and
--     its callers check_module_access, check_channel_access and
--     deduct_ai_credits. 239 left it out on purpose, because the server
--     treated "SELF_HOST_BILLING_MODE=unlimited AND the function is absent"
--     as unlimited. The server now honours that flag on its own
--     (server/middleware/featureGating.ts), so the gate is installed
--     everywhere and a moved production database enforces plans exactly as
--     production does, without that flag;
--   * 25 functions ran older bodies than production (wallet deposits,
--     entitlement cycles, checkout supersession, invitations without a
--     phone, offboarding cleanup, signup-email verification, commerce
--     tombstones, ...), 7 functions and 4 triggers production runs did not
--     exist here, and a trigger production dropped still ran here;
--   * CHECK constraints refused values production stores (wallet_deposit
--     invoices and intents, entitlement_cycle jobs, 'skipped' notification
--     jobs, invitations without a phone), two foreign keys refused rows
--     production holds, and audit_logs.workspace_id was NOT NULL where
--     production has NULLs — a data copy of production would have failed.
--
-- Sources, so the result can be re-verified:
--   A. functions whose last definition in supabase/migrations is exactly what
--      production runs (verified by hash), copied verbatim — file named
--      above each;
--   B. functions production runs that no migration defines, and three whose
--      production body differs from the hosted chain's last version — copied
--      from production's catalog;
--   C. wi_resolve_seat_capacity — production's resolution plus the self-host
--      fixed seat limit (identical to production on production's data);
--   D–K. ACLs, triggers, constraints, columns, indexes, policies and removed
--      objects, each stated below.
--
-- Deliberate, reviewed differences that remain are listed in
-- scripts/db/schema-parity-allowlist.txt. Forward-only; safe to re-run.

SET check_function_bodies = false;

-- ─────────────────────────────────────────────────────────────────────────
-- A. Functions as production runs them, from the hosted chain.
-- ─────────────────────────────────────────────────────────────────────────

-- check_workspace_entitlement — supabase/migrations/20260925120000_entitlement_plan_selection.sql
CREATE OR REPLACE FUNCTION public.check_workspace_entitlement(_workspace_id uuid, _feature text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _sub workspace_subscriptions%ROWTYPE;
  _plan billing_plans%ROWTYPE;
  _entitlements jsonb;
  _limits jsonb;
  _override_value integer;
  _sub_valid boolean := false;
BEGIN
  SELECT * INTO _sub FROM workspace_subscriptions
    WHERE workspace_id = _workspace_id;

  IF FOUND AND _sub.plan_id IS NOT NULL THEN
    IF _sub.status = 'active' THEN
      _sub_valid := true;
    ELSIF _sub.status = 'past_due' AND _sub.free_fallback_at IS NULL THEN
      _sub_valid := true;
    ELSIF _sub.status = 'trialing' AND (_sub.trial_end IS NULL OR _sub.trial_end > now()) THEN
      _sub_valid := true;
    ELSIF _sub.status IN ('canceled', 'cancelled')
      AND _sub.cancel_at_period_end IS TRUE
      AND _sub.current_period_end > now() THEN
      _sub_valid := true;
    END IF;
  END IF;

  IF _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE id = _sub.plan_id;
    _sub_valid := FOUND;
  END IF;

  IF NOT _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE slug = 'free' AND is_active = true LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed', false, 'plan', 'none', 'reason', 'no_plan_found');
    END IF;
  END IF;

  _entitlements := COALESCE(_plan.entitlements, '{}'::jsonb);
  _limits := COALESCE(_plan.limits, '{}'::jsonb);

  IF _entitlements ? _feature THEN
    RETURN jsonb_build_object('allowed', (_entitlements->>_feature)::boolean, 'plan', _plan.slug);
  END IF;

  SELECT limit_value INTO _override_value
    FROM workspace_limit_overrides
    WHERE workspace_id = _workspace_id AND limit_key = _feature;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'limit', _override_value, 'plan', _plan.slug, 'source', 'override');
  END IF;

  IF _limits ? _feature THEN
    RETURN jsonb_build_object('allowed', true, 'limit', (_limits->>_feature)::int, 'plan', _plan.slug, 'source', 'plan');
  END IF;

  RETURN jsonb_build_object('allowed', false, 'plan', _plan.slug, 'reason', 'feature_not_in_plan');
END;
$function$;

-- check_module_access — supabase/migrations/20260415220905_dd2492ef-b12d-414f-8de2-2deb4e20076d.sql
CREATE OR REPLACE FUNCTION public.check_module_access(
  _workspace_id uuid,
  _module_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _override workspace_module_overrides%ROWTYPE;
  _entitlement jsonb;
BEGIN
  -- Check workspace-level override first
  SELECT * INTO _override FROM workspace_module_overrides
  WHERE workspace_id = _workspace_id AND module_key = _module_key;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', _override.enabled, 'source', 'override');
  END IF;

  -- Fall back to plan entitlement
  _entitlement := check_workspace_entitlement(_workspace_id, _module_key);
  RETURN jsonb_build_object(
    'allowed', COALESCE((_entitlement->>'allowed')::boolean, false),
    'source', 'plan',
    'plan', _entitlement->>'plan'
  );
END;
$$;

-- check_channel_access — supabase/migrations/20260415220905_dd2492ef-b12d-414f-8de2-2deb4e20076d.sql
CREATE OR REPLACE FUNCTION public.check_channel_access(
  _workspace_id uuid,
  _channel_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _override workspace_channel_overrides%ROWTYPE;
  _entitlement jsonb;
BEGIN
  -- Check workspace-level override first
  SELECT * INTO _override FROM workspace_channel_overrides
  WHERE workspace_id = _workspace_id AND channel_key = _channel_key;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', _override.enabled, 'source', 'override');
  END IF;

  -- Fall back to plan entitlement
  _entitlement := check_workspace_entitlement(_workspace_id, _channel_key);
  RETURN jsonb_build_object(
    'allowed', COALESCE((_entitlement->>'allowed')::boolean, false),
    'source', 'plan',
    'plan', _entitlement->>'plan'
  );
END;
$$;

-- deduct_ai_credits — supabase/migrations/20260926100500_deduct_ai_credits_stop_counting_requests.sql
CREATE OR REPLACE FUNCTION public.deduct_ai_credits(
  _workspace_id uuid,
  _credits integer DEFAULT 1,
  _period text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _current_period text;
  _row workspace_usage_counters%ROWTYPE;
  _plan_limit integer;
  _entitlement_result jsonb;
BEGIN
  _current_period := COALESCE(_period, to_char(now(), 'YYYY-MM'));

  -- Ensure counter row exists
  INSERT INTO workspace_usage_counters (workspace_id, period)
  VALUES (_workspace_id, _current_period)
  ON CONFLICT (workspace_id, period) DO NOTHING;

  -- Lock row for atomic update
  SELECT * INTO _row FROM workspace_usage_counters
  WHERE workspace_id = _workspace_id AND period = _current_period
  FOR UPDATE;

  -- Get plan limit
  _entitlement_result := check_workspace_entitlement(_workspace_id, 'ai_credits');

  IF NOT (_entitlement_result->>'allowed')::boolean THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'ai_not_allowed',
      'credits_used', _row.ai_credits_used
    );
  END IF;

  _plan_limit := COALESCE((_entitlement_result->>'limit')::integer, 0);

  -- -1 means unlimited
  IF _plan_limit != -1 AND (_row.ai_credits_used + _credits) > _plan_limit THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'credits_exhausted',
      'credits_used', _row.ai_credits_used,
      'credits_limit', _plan_limit
    );
  END IF;

  -- Deduct. The request is counted by the ai_usage_logs row it writes.
  UPDATE workspace_usage_counters
  SET ai_credits_used = ai_credits_used + _credits,
      updated_at = now()
  WHERE workspace_id = _workspace_id AND period = _current_period;

  RETURN jsonb_build_object(
    'success', true,
    'credits_used', _row.ai_credits_used + _credits,
    'credits_limit', _plan_limit,
    'credits_remaining', CASE WHEN _plan_limit = -1 THEN -1 ELSE _plan_limit - (_row.ai_credits_used + _credits) END
  );
END;
$$;

-- admin_export_schema_ddl — supabase/migrations/20260913163359_49d85f41-39bd-4359-8113-23602268df49.sql
create or replace function public.admin_export_schema_ddl(_actor_user_id uuid)
returns setof text
language plpgsql
security definer
set search_path = public
set statement_timeout to '120s'
as $$
declare
  r record;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;

  return next 'CREATE SCHEMA IF NOT EXISTS public;';
  return next 'CREATE SCHEMA IF NOT EXISTS extensions;';

  -- extensions (recreate in the same schema they live in on the source)
  for r in
    select e.extname, n.nspname
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname not in ('plpgsql', 'supabase_vault')
    order by e.extname
  loop
    return next format(
      'DO $do$ BEGIN CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I; EXCEPTION WHEN others THEN NULL; END $do$;',
      r.extname, r.nspname);
  end loop;

  -- enum types (skip anything owned by an extension)
  for r in
    select t.typname,
           string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) as labels
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
    group by t.typname
    order by t.typname
  loop
    return next format(
      'DO $do$ BEGIN CREATE TYPE public.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $do$;',
      r.typname, r.labels);
  end loop;

  -- domains
  for r in
    select t.typname, format_type(t.typbasetype, t.typtypmod) as base
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'd'
      and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
    order by t.typname
  loop
    return next format(
      'DO $do$ BEGIN CREATE DOMAIN public.%I AS %s; EXCEPTION WHEN duplicate_object THEN NULL; END $do$;',
      r.typname, r.base);
  end loop;

  -- ALL sequences (including serial/identity-owned ones: a plain CREATE TABLE
  -- with DEFAULT nextval(...) does not create them)
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    order by 1
  loop
    return next format('CREATE SEQUENCE IF NOT EXISTS public.%I;', r.relname);
  end loop;

  -- functions, first pass: column defaults and generated expressions may call
  -- them, so they must exist before the tables (bodies referencing tables can
  -- fail here and are replayed again after the tables exist)
  for r in
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and p.proname not like 'admin_export_schema_ddl%'
      and p.prolang <> (select oid from pg_language where lanname = 'c')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by p.proname
  loop
    return next r.def || ';';
  end loop;

  -- tables + columns
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    order by c.relname
  loop
    return next format('CREATE TABLE IF NOT EXISTS public.%I (%s);', r.relname, (
      select string_agg(
        format('%I %s%s%s',
          a.attname,
          format_type(a.atttypid, a.atttypmod),
          case
            when a.attgenerated = 's'
              then ' GENERATED ALWAYS AS (' || pg_get_expr(ad.adbin, ad.adrelid) || ') STORED'
            when a.attidentity in ('a','d')
              then ' GENERATED ' || case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end || ' AS IDENTITY'
            when ad.adbin is not null then ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
            else '' end,
          case when a.attnotnull and a.attgenerated = '' then ' NOT NULL' else '' end),
        ', ' order by a.attnum)
      from pg_attribute a
      left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    ));
  end loop;

  -- missing columns for tables that already exist on the target
  for r in
    select cl.relname,
           a.attname,
           format_type(a.atttypid, a.atttypmod) as typ,
           case
             when a.attgenerated = 's'
               then ' GENERATED ALWAYS AS (' || pg_get_expr(ad.adbin, ad.adrelid) || ') STORED'
             when a.attidentity in ('a','d')
               then ' GENERATED ' || case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end || ' AS IDENTITY'
             when ad.adbin is not null then ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
             else '' end as extra
    from pg_class cl
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_attribute a on a.attrelid = cl.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname = 'public' and cl.relkind = 'r'
    order by cl.relname, a.attnum
  loop
    return next format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I %s%s;',
      r.relname, r.attname, r.typ, r.extra);
  end loop;

  -- link owned sequences back to their columns
  for r in
    select s.relname as seq, t.relname as tbl, a.attname as col
    from pg_class s
    join pg_namespace n on n.oid = s.relnamespace
    join pg_depend d on d.objid = s.oid and d.deptype in ('a','i')
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where n.nspname = 'public' and s.relkind = 'S'
    order by s.relname
  loop
    return next format('ALTER SEQUENCE public.%I OWNED BY public.%I.%I;', r.seq, r.tbl, r.col);
  end loop;

  -- constraints (pk / unique / fk / check), added after all tables exist
  for r in
    select c.conname, cl.relname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public' and cl.relkind = 'r'
    order by case c.contype when 'p' then 0 when 'u' then 1 when 'c' then 2 else 3 end, cl.relname, c.conname
  loop
    return next format(
      'DO $do$ BEGIN ALTER TABLE public.%I ADD CONSTRAINT %I %s; EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $do$;',
      r.relname, r.conname, r.def);
  end loop;

  -- indexes not backing a constraint
  for r in
    select replace(pg_get_indexdef(i.indexrelid), 'CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ') as def
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    where n.nspname = 'public' and tc.relkind = 'r'
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
    order by ic.relname
  loop
    return next replace(r.def, 'CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ') || ';';
  end loop;

  -- functions, second pass (bodies that depend on tables/views)
  for r in
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and p.proname not like 'admin_export_schema_ddl%'
      and p.prolang <> (select oid from pg_language where lanname = 'c')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by p.proname
  loop
    return next r.def || ';';
  end loop;

  -- views (may reference functions, so they come after them)
  for r in
    select c.relname, pg_get_viewdef(c.oid, true) as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
    order by c.relname
  loop
    return next format('CREATE OR REPLACE VIEW public.%I AS %s', r.relname, r.def);
  end loop;

  -- materialized views
  for r in
    select c.relname, pg_get_viewdef(c.oid, true) as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'm'
    order by c.relname
  loop
    return next format(
      'DO $do$ BEGIN CREATE MATERIALIZED VIEW public.%I AS %s; EXCEPTION WHEN duplicate_table THEN NULL; END $do$;',
      r.relname, r.def);
  end loop;

  -- triggers
  for r in
    select pg_get_triggerdef(t.oid) as def, t.tgname, cl.relname
    from pg_trigger t
    join pg_class cl on cl.oid = t.tgrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by cl.relname, t.tgname
  loop
    return next format('DROP TRIGGER IF EXISTS %I ON public.%I;', r.tgname, r.relname);
    return next r.def || ';';
  end loop;

  -- row level security + policies
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    order by c.relname
  loop
    return next format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
  end loop;

  for r in
    select p.policyname, p.tablename, p.permissive, p.roles, p.cmd, p.qual, p.with_check
    from pg_policies p
    where p.schemaname = 'public'
    order by p.tablename, p.policyname
  loop
    return next format('DROP POLICY IF EXISTS %I ON public.%I;', r.policyname, r.tablename);
    return next format(
      'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
      r.policyname, r.tablename,
      case when r.permissive = 'PERMISSIVE' then 'PERMISSIVE' else 'RESTRICTIVE' end,
      r.cmd,
      array_to_string(r.roles, ', '),
      case when r.qual is not null then ' USING (' || r.qual || ')' else '' end,
      case when r.with_check is not null then ' WITH CHECK (' || r.with_check || ')' else '' end);
  end loop;

  -- table grants
  for r in
    select distinct g.grantee, g.privilege_type, g.table_name
    from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.grantee in ('anon', 'authenticated', 'service_role')
    order by g.table_name, g.grantee, g.privilege_type
  loop
    return next format('GRANT %s ON public.%I TO %I;', r.privilege_type, r.table_name, r.grantee);
  end loop;

  -- sequence + function grants
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
    order by 1
  loop
    return next format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated, service_role;', r.relname);
  end loop;

  return;
end;
$$;

-- admin_purge_workspaces — supabase/migrations/20260910163004_e28a3513-117c-4dfb-9956-6898f23eccd0.sql
CREATE OR REPLACE FUNCTION public.admin_purge_workspaces(_ws uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _stmts text[] := '{}';
  _pending text[];
  _next text[];
  _s text;
  _pass int := 0;
  _rec record;
  _done int := 0;
BEGIN
  IF _ws IS NULL OR array_length(_ws, 1) IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.billing_purge', 'on', true);

  -- Explicitly remove AI allocation rows before their RESTRICT-protected
  -- ledger, reservation, and balance-lot parents.
  DELETE FROM public.workspace_ai_ledger_allocations a
  WHERE a.ledger_entry_id IN (
    SELECT l.id FROM public.workspace_ai_ledger l
    WHERE l.workspace_id = ANY (_ws)
  )
  OR a.lot_id IN (
    SELECT lot.id FROM public.workspace_ai_balance_lots lot
    WHERE lot.workspace_id = ANY (_ws)
  );
  _done := _done + 1;

  DELETE FROM public.workspace_ai_reservation_allocations a
  WHERE a.reservation_id IN (
    SELECT r.id FROM public.workspace_ai_reservations r
    WHERE r.workspace_id = ANY (_ws)
  )
  OR a.lot_id IN (
    SELECT lot.id FROM public.workspace_ai_balance_lots lot
    WHERE lot.workspace_id = ANY (_ws)
  );
  _done := _done + 1;

  DELETE FROM public.workspace_ai_reservations
  WHERE workspace_id = ANY (_ws);
  _done := _done + 1;

  DELETE FROM public.workspace_ai_ledger
  WHERE workspace_id = ANY (_ws);
  _done := _done + 1;

  DELETE FROM public.workspace_ai_balance_lots
  WHERE workspace_id = ANY (_ws);
  _done := _done + 1;

  -- grandchildren: tables without workspace_id/conversation_id that reference
  -- a table which itself has workspace_id
  FOR _rec IN
    SELECT DISTINCT gt.relname AS child_table, ga.attname AS child_col,
                    ct.relname AS mid_table, pa.attname AS mid_col
    FROM pg_constraint g
    JOIN pg_class gt ON gt.oid = g.conrelid
    JOIN pg_attribute ga ON ga.attrelid = g.conrelid AND ga.attnum = g.conkey[1]
    JOIN pg_class ct ON ct.oid = g.confrelid
    JOIN pg_attribute pa ON pa.attrelid = g.confrelid AND pa.attnum = g.confkey[1]
    JOIN pg_namespace n ON n.oid = gt.relnamespace AND n.nspname = 'public'
    WHERE g.contype = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute x
        WHERE x.attrelid = gt.oid
          AND x.attname IN ('workspace_id','conversation_id')
          AND NOT x.attisdropped
      )
      AND EXISTS (
        SELECT 1 FROM pg_attribute y
        WHERE y.attrelid = ct.oid
          AND y.attname = 'workspace_id'
          AND NOT y.attisdropped
      )
      AND gt.relname NOT IN (
        'workspace_ai_ledger_allocations',
        'workspace_ai_reservation_allocations'
      )
  LOOP
    _stmts := _stmts || format(
      'DELETE FROM public.%I WHERE %I IN (SELECT %I FROM public.%I WHERE workspace_id = ANY (%L::uuid[]))',
      _rec.child_table, _rec.child_col, _rec.mid_col, _rec.mid_table, _ws);
  END LOOP;

  -- conversation-scoped child rows
  FOR _rec IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'conversation_id'
      AND c.data_type = 'uuid'
      AND c.table_name <> 'conversations'
  LOOP
    _stmts := _stmts || format(
      'DELETE FROM public.%I WHERE conversation_id IN (SELECT id FROM public.conversations WHERE workspace_id = ANY (%L::uuid[]))',
      _rec.table_name, _ws);
  END LOOP;

  -- every remaining workspace-scoped table
  FOR _rec IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'workspace_id'
      AND c.data_type = 'uuid'
      AND c.table_name NOT IN (
        'workspaces',
        'workspace_ai_reservations',
        'workspace_ai_ledger',
        'workspace_ai_balance_lots'
      )
  LOOP
    _stmts := _stmts || format(
      'DELETE FROM public.%I WHERE workspace_id = ANY (%L::uuid[])',
      _rec.table_name, _ws);
  END LOOP;

  _stmts := _stmts || format('DELETE FROM public.workspaces WHERE id = ANY (%L::uuid[])', _ws);

  _pending := _stmts;
  WHILE array_length(_pending, 1) > 0 AND _pass < 12 LOOP
    _pass := _pass + 1;
    _next := '{}';
    FOREACH _s IN ARRAY _pending LOOP
      BEGIN
        EXECUTE _s;
        _done := _done + 1;
      EXCEPTION
        WHEN foreign_key_violation OR undefined_table OR undefined_column THEN
          _next := _next || _s;
      END;
    END LOOP;
    EXIT WHEN array_length(_next, 1) IS NULL;
    IF array_length(_next, 1) = array_length(_pending, 1) AND _pass > 1 THEN
      FOREACH _s IN ARRAY _next LOOP
        EXECUTE _s;
      END LOOP;
      _next := '{}';
    END IF;
    _pending := _next;
  END LOOP;

  RETURN _done;
END;
$function$;

-- ai_billing_try_acquire_recovery_lease — supabase/migrations/20260907201632_dd21ce59-41a1-4a8e-bf93-50de6204b2c2.sql
CREATE OR REPLACE FUNCTION public.ai_billing_try_acquire_recovery_lease(_owner text, _ttl_seconds integer DEFAULT 240)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _acquired boolean := false;
BEGIN
  IF _owner IS NULL OR length(_owner) = 0 THEN
    RAISE EXCEPTION 'recovery_lease_owner_required';
  END IF;
  IF _ttl_seconds IS NULL OR _ttl_seconds < 30 OR _ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'recovery_lease_ttl_out_of_range';
  END IF;

  INSERT INTO public.ai_billing_recovery_lease(id) VALUES (true) ON CONFLICT (id) DO NOTHING;

  UPDATE public.ai_billing_recovery_lease
     SET owner = _owner,
         acquired_at = now(),
         expires_at = now() + make_interval(secs => _ttl_seconds),
         passes = passes + 1
   WHERE id
     AND (owner IS NULL OR expires_at IS NULL OR expires_at <= now())
  RETURNING true INTO _acquired;

  RETURN COALESCE(_acquired, false);
END;
$$;

-- billing_activate_period — supabase/migrations/20260904122306_d0131c4b-ec95-4739-97ee-850331a9c465.sql
CREATE OR REPLACE FUNCTION public.billing_activate_period(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period    public.billing_subscription_periods;
  v_inv       public.billing_invoices;
  v_prev_src  TEXT;
  v_sync      JSONB;
  v_retired   INTEGER := 0;
  v_subscription_id UUID;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'unknown_period:%', p_period_id;
  END IF;
  IF v_period.status = 'active' THEN
    -- Self-heal historical active periods that were created before their
    -- workspace subscription projection existed.
    INSERT INTO public.workspace_subscriptions (
      workspace_id, plan_id, provider_name, status, current_period_id,
      current_period_start, current_period_end, billing_interval,
      next_invoice_at, billing_engine_version, updated_at
    ) VALUES (
      v_period.workspace_id, v_period.plan_id, 'manual', 'active', v_period.id,
      v_period.period_start, v_period.period_end, v_period.billing_interval,
      v_period.period_end, 'v2', now()
    )
    ON CONFLICT (workspace_id) DO NOTHING;

    SELECT id INTO v_subscription_id
      FROM public.workspace_subscriptions
     WHERE workspace_id = v_period.workspace_id;

    UPDATE public.billing_subscription_periods
       SET subscription_id = COALESCE(subscription_id, v_subscription_id)
     WHERE id = v_period.id;

    v_sync := public.billing_v2_sync_period_cycles(v_period.id);
    RETURN jsonb_build_object('period_id', v_period.id, 'replayed', true, 'cycles', v_sync);
  END IF;
  IF v_period.status <> 'scheduled' THEN
    RAISE EXCEPTION 'period_not_activatable:%:%', v_period.id, v_period.status;
  END IF;

  IF v_period.invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.billing_invoices WHERE id = v_period.invoice_id;
    IF v_inv.status <> 'paid' THEN
      RAISE EXCEPTION 'period_invoice_not_paid:%:%', v_period.id, v_inv.status;
    END IF;
  END IF;

  PERFORM 1 FROM public.workspace_subscriptions
   WHERE workspace_id = v_period.workspace_id FOR UPDATE;

  SELECT source INTO v_prev_src FROM public.billing_subscription_periods
   WHERE workspace_id = v_period.workspace_id AND status = 'active' AND id <> v_period.id
   LIMIT 1;

  UPDATE public.billing_subscription_periods
     SET status = 'completed', completed_at = now()
   WHERE workspace_id = v_period.workspace_id
     AND status = 'active'
     AND id <> v_period.id;

  UPDATE public.billing_subscription_periods
     SET status = 'active', activated_at = now()
   WHERE id = v_period.id;

  -- A first-time workspace has no projection row yet. Create it before the
  -- canonical update below, in the same transaction, so an admin grant or a
  -- paid first subscription can never leave an orphan active period.
  INSERT INTO public.workspace_subscriptions (
    workspace_id, plan_id, provider_name, status, current_period_id,
    current_period_start, current_period_end, billing_interval,
    next_invoice_at, billing_engine_version, updated_at
  ) VALUES (
    v_period.workspace_id, v_period.plan_id, 'manual', 'active', v_period.id,
    v_period.period_start, v_period.period_end, v_period.billing_interval,
    v_period.period_end, 'v2', now()
  )
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT id INTO v_subscription_id
    FROM public.workspace_subscriptions
   WHERE workspace_id = v_period.workspace_id
   FOR UPDATE;

  UPDATE public.billing_subscription_periods
     SET subscription_id = COALESCE(subscription_id, v_subscription_id)
   WHERE id = v_period.id;

  IF v_period.source = 'invoice' THEN
    v_retired := public.billing_retire_legacy_allowance(v_period.workspace_id);
  END IF;

  UPDATE public.workspace_subscriptions
     SET plan_id              = COALESCE(v_period.plan_id, plan_id),
         status               = 'active',
         current_period_id    = v_period.id,
         current_period_start = v_period.period_start,
         current_period_end   = v_period.period_end,
         billing_interval     = v_period.billing_interval,
         next_invoice_at      = GREATEST(COALESCE(next_invoice_at, v_period.period_end), v_period.period_end),
         past_due_since       = NULL,
         grace_period_ends_at = NULL,
         free_fallback_at     = NULL,
         pending_change_type  = NULL,
         next_plan_id         = NULL,
         billing_engine_version = 'v2',
         billing_v2_effective_at = CASE
           WHEN v_period.source = 'invoice' THEN COALESCE(billing_v2_effective_at, now())
           ELSE billing_v2_effective_at END,
         v2_allowance_effective_period_id = CASE
           WHEN v_period.source = 'invoice'
             THEN COALESCE(v2_allowance_effective_period_id, v_period.id)
           ELSE v2_allowance_effective_period_id END,
         updated_at = now()
   WHERE workspace_id = v_period.workspace_id;

  INSERT INTO public.billing_period_allowance_grants (period_id, workspace_id, allowance_irr, status, granted_at)
  VALUES (v_period.id, v_period.workspace_id, v_period.ai_allowance_irr, 'skipped', now())
  ON CONFLICT (period_id) DO NOTHING;

  v_sync := public.billing_v2_sync_period_cycles(v_period.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_period.workspace_id, 'period_activated', v_period.source,
          jsonb_build_object('period_id', v_period.id, 'invoice_id', v_period.invoice_id,
                             'period_start', v_period.period_start,
                             'period_end', v_period.period_end,
                             'active_cycle_id', v_sync->>'active_cycle_id'));

  RETURN jsonb_build_object(
    'period_id', v_period.id,
    'lot_id', (v_sync->'grant'->>'lot_id')::uuid,
    'active_cycle_id', (v_sync->>'active_cycle_id')::uuid,
    'allowance_irr', COALESCE((v_sync->'grant'->>'allowance_irr')::bigint, 0),
    'previous_period_source', v_prev_src,
    'legacy_lots_retired', v_retired,
    'cycles', v_sync,
    'replayed', false
  );
END;
$function$;

-- billing_apply_invoice_effects — supabase/migrations/20260907091007_7d9a2c41-9adb-4baf-af6c-0e17ef464b09.sql
CREATE OR REPLACE FUNCTION public.billing_apply_invoice_effects(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv       public.billing_invoices;
  v_app       public.billing_invoice_applications;
  v_snap      JSONB;
  v_sub       public.workspace_subscriptions;
  v_period    public.billing_subscription_periods;
  v_period_id UUID;
  v_start     TIMESTAMPTZ;
  v_end       TIMESTAMPTZ;
  v_activate  BOOLEAN;
  v_lot       UUID;
  v_type      TEXT;
  v_entry     public.billing_wallet_ledger;
  v_result    JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status <> 'paid' THEN
    RAISE EXCEPTION 'invoice_not_paid:%:%', v_inv.id, v_inv.status;
  END IF;

  v_snap := COALESCE(v_inv.effect_snapshot, '{}'::jsonb);
  v_type := COALESCE(v_snap->>'action_type', v_inv.invoice_type);

  INSERT INTO public.billing_invoice_applications (
    invoice_id, workspace_id, application_type, application_status
  ) VALUES (v_inv.id, v_inv.workspace_id, v_type, 'pending')
  ON CONFLICT (invoice_id) DO NOTHING;

  SELECT * INTO v_app FROM public.billing_invoice_applications
   WHERE invoice_id = v_inv.id FOR UPDATE;

  IF v_app.application_status = 'applied' THEN
    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'application_id', v_app.id,
      'period_id', v_app.period_id,
      'lot_id', v_app.result_snapshot->>'lot_id',
      'wallet_entry_id', v_app.result_snapshot->>'wallet_entry_id',
      'replayed', true
    );
  END IF;

  UPDATE public.billing_invoice_applications
     SET application_status = 'processing',
         attempt_count = attempt_count + 1,
         lease_until = now() + interval '5 minutes'
   WHERE id = v_app.id;

  IF v_inv.invoice_type = 'ai_credit_purchase' THEN
    v_lot := public.ai_purchase_credit(
      v_inv.workspace_id,
      COALESCE((v_snap->>'ai_credit_amount_irr')::numeric, v_inv.total_irr::numeric),
      'invoice:' || v_inv.id::text,
      'invoice_' || v_inv.invoice_number
    );
    v_result := jsonb_build_object('lot_id', v_lot, 'amount_irr', v_inv.total_irr);

    UPDATE public.billing_invoice_applications
       SET application_status = 'applied', application_type = 'ai_credit_purchase',
           applied_at = now(), lease_until = NULL, last_error = NULL,
           result_snapshot = v_result
     WHERE id = v_app.id;

    UPDATE public.billing_payment_intents
       SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, now()),
           failure_reason = NULL, updated_at = now()
     WHERE invoice_id = v_inv.id AND status = 'processing';
    UPDATE public.billing_invoice_collections
       SET status = 'released', released_at = COALESCE(released_at, now()),
           release_reason = COALESCE(release_reason, 'payment_applied')
     WHERE invoice_id = v_inv.id AND status = 'active';

    RETURN jsonb_build_object('invoice_id', v_inv.id, 'application_id', v_app.id,
      'lot_id', v_lot, 'replayed', false);
  END IF;

  IF v_inv.invoice_type = 'wallet_deposit' THEN
    SELECT * INTO v_entry FROM public.billing_wallet_append(
      v_inv.workspace_id,
      'deposit',
      COALESCE((v_snap->>'wallet_deposit_amount_irr')::bigint, v_inv.total_irr::bigint),
      'invoice_deposit:' || v_inv.id::text,
      'invoice_' || v_inv.invoice_number,
      v_inv.id,
      NULL,
      NULL,
      NULL,
      '{}'::jsonb
    );
    v_result := jsonb_build_object(
      'wallet_entry_id', v_entry.id,
      'amount_irr', v_inv.total_irr,
      'balance_after_irr', v_entry.balance_after_irr
    );

    UPDATE public.billing_invoice_applications
       SET application_status = 'applied', application_type = 'wallet_deposit',
           applied_at = now(), lease_until = NULL, last_error = NULL,
           result_snapshot = v_result
     WHERE id = v_app.id;

    UPDATE public.billing_payment_intents
       SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, now()),
           failure_reason = NULL, updated_at = now()
     WHERE invoice_id = v_inv.id AND status = 'processing';
    UPDATE public.billing_invoice_collections
       SET status = 'released', released_at = COALESCE(released_at, now()),
           release_reason = COALESCE(release_reason, 'payment_applied')
     WHERE invoice_id = v_inv.id AND status = 'active';

    RETURN jsonb_build_object('invoice_id', v_inv.id, 'application_id', v_app.id,
      'wallet_entry_id', v_entry.id, 'replayed', false);
  END IF;

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  v_start := COALESCE((v_snap->>'period_start')::timestamptz, v_inv.period_start, now());
  v_end := COALESCE((v_snap->>'period_end')::timestamptz, v_inv.period_end, v_start + interval '1 month');
  v_activate := v_start <= now();

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source,
    plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    v_inv.workspace_id, v_sub.id,
    COALESCE((v_snap->>'target_plan_id')::uuid, v_inv.plan_id),
    v_inv.id,
    COALESCE(v_snap->>'billing_interval', v_inv.billing_interval, 'monthly'),
    v_start, v_end, 'scheduled', 'invoice',
    COALESCE(v_snap->'plan_snapshot', '{}'::jsonb),
    COALESCE(v_snap->'limits_snapshot', '{}'::jsonb),
    GREATEST(COALESCE((v_snap->>'ai_allowance_irr')::bigint, 0), 0)
  ) RETURNING * INTO v_period;

  v_period_id := v_period.id;
  v_result := jsonb_build_object('period_start', v_start, 'period_end', v_end,
    'scheduled_only', NOT v_activate);

  UPDATE public.billing_invoice_applications
     SET application_status = 'applied', application_type = v_type,
         period_id = v_period_id, applied_at = now(), lease_until = NULL,
         last_error = NULL, result_snapshot = v_result
   WHERE id = v_app.id;

  IF v_activate THEN
    PERFORM public.billing_activate_period(v_period_id);
  END IF;

  UPDATE public.billing_payment_intents
     SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, now()),
         failure_reason = NULL, updated_at = now()
   WHERE invoice_id = v_inv.id AND status = 'processing';
  UPDATE public.billing_invoice_collections
     SET status = 'released', released_at = COALESCE(released_at, now()),
         release_reason = COALESCE(release_reason, 'payment_applied')
   WHERE invoice_id = v_inv.id AND status = 'active';

  RETURN jsonb_build_object('invoice_id', v_inv.id, 'application_id', v_app.id,
    'period_id', v_period_id, 'activated', v_activate, 'replayed', false);
END;
$function$;

-- billing_begin_collection — supabase/migrations/20260906104338_07f55760-f59d-4c15-ac79-4f5d464d058b.sql
CREATE OR REPLACE FUNCTION public.billing_begin_collection(
  p_invoice_id uuid,
  p_channel text,
  p_amount_irr bigint,
  p_command_key text,
  p_intent_id uuid DEFAULT NULL::uuid,
  p_ttl_seconds integer DEFAULT 1800
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv public.billing_invoices;
  v_col public.billing_invoice_collections;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'collection_command_key_required';
  END IF;
  IF p_channel NOT IN ('gateway', 'wallet', 'admin') THEN
    RAISE EXCEPTION 'collection_channel_invalid:%', p_channel;
  END IF;

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status;
  END IF;
  IF p_amount_irr IS NULL OR p_amount_irr <= 0 OR p_amount_irr <> v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'collection_amount_mismatch:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  PERFORM public.billing_expire_stale_collections(v_inv.id);

  -- A fresh gateway attempt explicitly supersedes an older attempt that never
  -- reached finalization. Invoice locking above serializes concurrent tabs, so
  -- exactly one latest intent can own the reservation. Processing attempts are
  -- never displaced because verified money may already be settling.
  IF p_channel = 'gateway' AND p_intent_id IS NOT NULL THEN
    UPDATE public.billing_payment_intents pi
       SET status = 'canceled',
           failure_reason = 'superseded_by_new_checkout',
           updated_at = now()
      FROM public.billing_invoice_collections c
     WHERE c.invoice_id = v_inv.id
       AND c.status = 'active'
       AND c.channel = 'gateway'
       AND c.payment_intent_id = pi.id
       AND pi.id <> p_intent_id
       AND pi.status = 'pending';

    UPDATE public.billing_invoice_collections c
       SET status = 'released',
           released_at = now(),
           release_reason = 'superseded_by_new_checkout'
     WHERE c.invoice_id = v_inv.id
       AND c.status = 'active'
       AND c.channel = 'gateway'
       AND c.payment_intent_id <> p_intent_id
       AND EXISTS (
         SELECT 1
           FROM public.billing_payment_intents pi
          WHERE pi.id = c.payment_intent_id
            AND pi.status = 'canceled'
            AND pi.failure_reason = 'superseded_by_new_checkout'
       );
  END IF;

  -- Repair reservations produced by the former two-step flow, where a crash
  -- could leave an active collection with no usable payment intent.
  UPDATE public.billing_invoice_collections c
     SET status = 'released', released_at = now(), release_reason = 'orphaned_checkout'
   WHERE c.invoice_id = v_inv.id
     AND c.status = 'active'
     AND c.channel = 'gateway'
     AND (
       c.payment_intent_id IS NULL
       OR EXISTS (
         SELECT 1 FROM public.billing_payment_intents pi
          WHERE pi.id = c.payment_intent_id
            AND pi.status IN ('failed', 'expired', 'canceled')
       )
     );

  SELECT * INTO v_col FROM public.billing_invoice_collections WHERE command_key = p_command_key;
  IF v_col.id IS NOT NULL THEN
    IF v_col.status <> 'active' THEN
      RAISE EXCEPTION 'collection_not_active:%:%', v_col.id, v_col.status;
    END IF;
    RETURN jsonb_build_object(
      'collection_id', v_col.id, 'channel', v_col.channel,
      'amount_irr', v_col.amount_irr, 'expires_at', v_col.expires_at, 'replayed', true
    );
  END IF;

  SELECT * INTO v_col FROM public.billing_invoice_collections
   WHERE invoice_id = v_inv.id AND status = 'active' FOR UPDATE;
  IF v_col.id IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_collection_locked:%:%', v_inv.id, v_col.channel
      USING HINT = 'Another collection channel already holds this invoice. Release or expire it before collecting again.';
  END IF;

  INSERT INTO public.billing_invoice_collections (
    invoice_id, workspace_id, channel, amount_irr, payment_intent_id, command_key, expires_at
  ) VALUES (
    v_inv.id, v_inv.workspace_id, p_channel, p_amount_irr, p_intent_id, p_command_key,
    now() + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 1800), 30))
  )
  RETURNING * INTO v_col;

  RETURN jsonb_build_object(
    'collection_id', v_col.id, 'channel', v_col.channel,
    'amount_irr', v_col.amount_irr, 'expires_at', v_col.expires_at, 'replayed', false
  );
END;
$function$;

-- commerce_tombstone_product — supabase/migrations/20260921180000_commerce_hard_delete_products.sql
CREATE OR REPLACE FUNCTION public.commerce_tombstone_product(
  p_connection_id uuid,
  p_external_id text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_live_version text;
  v_deleted integer := 0;
BEGIN
  SELECT entity_version INTO v_live_version
    FROM public.commerce_products
   WHERE connection_id = p_connection_id AND external_id = p_external_id;

  IF v_live_version IS NOT NULL AND p_entity_version <= v_live_version THEN
    RETURN false; -- a straggler; what we hold is newer than this delete
  END IF;

  DELETE FROM public.commerce_products
   WHERE connection_id = p_connection_id AND external_id = p_external_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
  VALUES (p_connection_id, 'product', p_external_id, p_entity_version)
  ON CONFLICT (connection_id, kind, external_id) DO UPDATE
    SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version),
        deleted_at     = now();

  PERFORM public.commerce_purge_expired_deletions();
  RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- commerce_tombstone_variant — supabase/migrations/20260921180000_commerce_hard_delete_products.sql
CREATE OR REPLACE FUNCTION public.commerce_tombstone_variant(
  p_connection_id uuid,
  p_external_id text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_live_version text;
  v_deleted integer := 0;
BEGIN
  SELECT entity_version INTO v_live_version
    FROM public.commerce_product_variants
   WHERE connection_id = p_connection_id AND external_id = p_external_id;

  IF v_live_version IS NOT NULL AND p_entity_version <= v_live_version THEN
    RETURN false;
  END IF;

  DELETE FROM public.commerce_product_variants
   WHERE connection_id = p_connection_id AND external_id = p_external_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
  VALUES (p_connection_id, 'variant', p_external_id, p_entity_version)
  ON CONFLICT (connection_id, kind, external_id) DO UPDATE
    SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version),
        deleted_at     = now();

  PERFORM public.commerce_purge_expired_deletions();
  RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- commerce_upsert_product — supabase/migrations/20260921180000_commerce_hard_delete_products.sql
CREATE OR REPLACE FUNCTION public.commerce_upsert_product(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_external_id text,
  p_product_type text,
  p_sku text,
  p_title text,
  p_short_description text,
  p_canonical_url text,
  p_image_url text,
  p_currency text,
  p_regular_price_minor numeric,
  p_sale_price_minor numeric,
  p_effective_price_minor numeric,
  p_stock_state text,
  p_stock_quantity integer,
  p_categories jsonb,
  p_tags jsonb,
  p_attributes jsonb,
  p_is_virtual boolean,
  p_is_downloadable boolean,
  p_entity_version text
) RETURNS TABLE(product_id uuid, written boolean) AS $$
DECLARE
  v_id uuid;
  v_written boolean;
  v_deleted_version text;
BEGIN
  SELECT entity_version INTO v_deleted_version
    FROM public.commerce_deleted_entities
   WHERE connection_id = p_connection_id AND kind = 'product' AND external_id = p_external_id;

  IF v_deleted_version IS NOT NULL AND p_entity_version <= v_deleted_version THEN
    -- A write that left the store before the delete did. Letting it through
    -- would put a product the store no longer sells back in front of
    -- customers.
    RETURN QUERY SELECT NULL::uuid, false;
    RETURN;
  END IF;

  -- Strictly newer than the delete means the store has it again (an
  -- un-trashed product keeps its id), so the gravestone has served its turn.
  IF v_deleted_version IS NOT NULL THEN
    DELETE FROM public.commerce_deleted_entities
     WHERE connection_id = p_connection_id AND kind = 'product' AND external_id = p_external_id;
  END IF;

  INSERT INTO public.commerce_products (
    workspace_id, connection_id, external_id, product_type, sku, title,
    short_description, canonical_url, image_url, currency,
    regular_price_minor, sale_price_minor, effective_price_minor,
    stock_state, stock_quantity, categories, tags, attributes,
    is_virtual, is_downloadable, entity_version, updated_at
  ) VALUES (
    p_workspace_id, p_connection_id, p_external_id, p_product_type, p_sku, p_title,
    p_short_description, p_canonical_url, p_image_url, p_currency,
    p_regular_price_minor, p_sale_price_minor, p_effective_price_minor,
    p_stock_state, p_stock_quantity, p_categories, p_tags, p_attributes,
    p_is_virtual, p_is_downloadable, p_entity_version, now()
  )
  ON CONFLICT (connection_id, external_id) DO UPDATE SET
    product_type = EXCLUDED.product_type,
    sku = EXCLUDED.sku,
    title = EXCLUDED.title,
    short_description = EXCLUDED.short_description,
    canonical_url = EXCLUDED.canonical_url,
    image_url = EXCLUDED.image_url,
    currency = EXCLUDED.currency,
    regular_price_minor = EXCLUDED.regular_price_minor,
    sale_price_minor = EXCLUDED.sale_price_minor,
    effective_price_minor = EXCLUDED.effective_price_minor,
    stock_state = EXCLUDED.stock_state,
    stock_quantity = EXCLUDED.stock_quantity,
    categories = EXCLUDED.categories,
    tags = EXCLUDED.tags,
    attributes = EXCLUDED.attributes,
    is_virtual = EXCLUDED.is_virtual,
    is_downloadable = EXCLUDED.is_downloadable,
    entity_version = EXCLUDED.entity_version,
    updated_at = now()
  WHERE EXCLUDED.entity_version > public.commerce_products.entity_version
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.commerce_products WHERE connection_id = p_connection_id AND external_id = p_external_id;
    v_written := false;
  ELSE
    v_written := true;
  END IF;

  RETURN QUERY SELECT v_id, v_written;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- commerce_upsert_variant — supabase/migrations/20260921180000_commerce_hard_delete_products.sql
CREATE OR REPLACE FUNCTION public.commerce_upsert_variant(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_product_id uuid,
  p_external_id text,
  p_sku text,
  p_attributes jsonb,
  p_currency text,
  p_regular_price_minor numeric,
  p_sale_price_minor numeric,
  p_effective_price_minor numeric,
  p_stock_state text,
  p_stock_quantity integer,
  p_image_url text,
  p_entity_version text
) RETURNS boolean AS $$
DECLARE
  v_id uuid;
  v_deleted_version text;
BEGIN
  SELECT entity_version INTO v_deleted_version
    FROM public.commerce_deleted_entities
   WHERE connection_id = p_connection_id AND kind = 'variant' AND external_id = p_external_id;

  IF v_deleted_version IS NOT NULL AND p_entity_version <= v_deleted_version THEN
    RETURN false;
  END IF;

  IF v_deleted_version IS NOT NULL THEN
    DELETE FROM public.commerce_deleted_entities
     WHERE connection_id = p_connection_id AND kind = 'variant' AND external_id = p_external_id;
  END IF;

  INSERT INTO public.commerce_product_variants (
    workspace_id, connection_id, product_id, external_id, sku, attributes,
    currency, regular_price_minor, sale_price_minor, effective_price_minor,
    stock_state, stock_quantity, image_url, entity_version, updated_at
  ) VALUES (
    p_workspace_id, p_connection_id, p_product_id, p_external_id, p_sku, p_attributes,
    p_currency, p_regular_price_minor, p_sale_price_minor, p_effective_price_minor,
    p_stock_state, p_stock_quantity, p_image_url, p_entity_version, now()
  )
  ON CONFLICT (connection_id, external_id) DO UPDATE SET
    product_id = EXCLUDED.product_id,
    sku = EXCLUDED.sku,
    attributes = EXCLUDED.attributes,
    currency = EXCLUDED.currency,
    regular_price_minor = EXCLUDED.regular_price_minor,
    sale_price_minor = EXCLUDED.sale_price_minor,
    effective_price_minor = EXCLUDED.effective_price_minor,
    stock_state = EXCLUDED.stock_state,
    stock_quantity = EXCLUDED.stock_quantity,
    image_url = EXCLUDED.image_url,
    entity_version = EXCLUDED.entity_version,
    updated_at = now()
  WHERE EXCLUDED.entity_version > public.commerce_product_variants.entity_version
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- create_workspace_invitation_v2 — supabase/migrations/20260910213618_0e0a1f40-0c77-4b3c-ba38-45397fb3c315.sql
CREATE OR REPLACE FUNCTION public.create_workspace_invitation_v2(_workspace_id uuid, _actor_id uuid, _first_name text, _last_name text, _email_normalized text, _phone_e164 text, _member_type text, _role workspace_role, _expires_at timestamp with time zone, _department_ids uuid[], _manual_token_hash text, _manual_token_prefix text, _manual_token_expires_at timestamp with time zone, _email_job_idempotency_key text, _sms_job_idempotency_key text, _email_destination_hash text, _sms_destination_hash text, _job_title text DEFAULT NULL::text, _staff_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _actor_role public.workspace_role;
  _invitation_id uuid;
  _dept uuid;
  _seat_limit integer;
  _seat_used integer;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKSPACE_NOT_FOUND';
  END IF;

  SELECT role INTO _actor_role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;

  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  IF _member_type NOT IN ('staff', 'customer_facing') THEN
    RAISE EXCEPTION 'INVALID_MEMBER_TYPE';
  END IF;

  IF _member_type = 'staff' AND array_length(_department_ids, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT';
  END IF;

  IF _member_type = 'customer_facing' AND array_length(_department_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT';
  END IF;

  PERFORM public.wi_expire_due(_workspace_id);

  IF EXISTS (
    SELECT 1 FROM public.workspace_invitations
    WHERE workspace_id = _workspace_id
      AND status = 'pending'
      AND (invited_email_normalized = _email_normalized
        OR (_phone_e164 IS NOT NULL AND invited_phone_e164 = _phone_e164))
  ) THEN
    RAISE EXCEPTION 'INVITATION_DUPLICATE';
  END IF;

  SELECT c.limit_value, c.used INTO _seat_limit, _seat_used
  FROM public.wi_resolve_seat_capacity(_workspace_id) c;

  IF _seat_limit IS NOT NULL AND _seat_used >= _seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED';
  END IF;

  INSERT INTO public.workspace_invitations (
    workspace_id, token, role, max_uses, use_count, expires_at, created_by,
    invited_email, invitation_flow_version, first_name, last_name,
    invited_email_normalized, invited_phone_e164, member_type, status,
    notification_generation, job_title, staff_code
  ) VALUES (
    _workspace_id, NULL, _role, 1, 0, _expires_at, _actor_id,
    _email_normalized, 2, _first_name, _last_name,
    _email_normalized, _phone_e164, _member_type, 'pending',
    1, _job_title, _staff_code
  )
  RETURNING id INTO _invitation_id;

  IF _department_ids IS NOT NULL THEN
    FOREACH _dept IN ARRAY _department_ids LOOP
      INSERT INTO public.workspace_invitation_departments (invitation_id, workspace_id, department_id)
      VALUES (_invitation_id, _workspace_id, _dept);
    END LOOP;
  END IF;

  INSERT INTO public.workspace_invitation_tokens (
    invitation_id, workspace_id, purpose, token_hash, token_prefix,
    token_generation, notification_generation, expires_at
  ) VALUES (
    _invitation_id, _workspace_id, 'manual_handoff', _manual_token_hash,
    _manual_token_prefix, 1, 1, _manual_token_expires_at
  );

  INSERT INTO public.workspace_invitation_jobs (
    invitation_id, workspace_id, channel, notification_generation,
    email_token_generation, destination_hash, idempotency_key
  ) VALUES
    (_invitation_id, _workspace_id, 'email', 1, 1, _email_destination_hash, _email_job_idempotency_key);

  IF _phone_e164 IS NOT NULL THEN
    INSERT INTO public.workspace_invitation_jobs (
      invitation_id, workspace_id, channel, notification_generation,
      email_token_generation, destination_hash, idempotency_key
    ) VALUES
      (_invitation_id, _workspace_id, 'sms', 1, NULL, _sms_destination_hash, _sms_job_idempotency_key);
  END IF;

  INSERT INTO public.workspace_invitation_deliveries (
    invitation_id, workspace_id, job_id, channel, notification_generation, status
  )
  SELECT _invitation_id, _workspace_id, j.id, j.channel, 1, 'queued'
  FROM public.workspace_invitation_jobs j
  WHERE j.invitation_id = _invitation_id;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.created', _invitation_id,
          jsonb_build_object('role', _role, 'member_type', _member_type, 'flow_version', 2));

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$function$;

-- edit_workspace_invitation_v2 — supabase/migrations/20260910213700_6a4a7dc9-6715-40ba-adea-6f6c03b56aec.sql
CREATE OR REPLACE FUNCTION public.edit_workspace_invitation_v2(_invitation_id uuid, _actor_id uuid, _first_name text, _last_name text, _email_normalized text, _phone_e164 text, _member_type text, _role workspace_role, _expires_at timestamp with time zone, _department_ids uuid[], _email_job_idempotency_key text DEFAULT NULL::text, _sms_job_idempotency_key text DEFAULT NULL::text, _email_destination_hash text DEFAULT NULL::text, _sms_destination_hash text DEFAULT NULL::text, _job_title text DEFAULT NULL::text, _staff_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
  _dept uuid;
  _contact_changed boolean;
  _generation integer;
BEGIN
  SELECT workspace_id INTO _workspace_id
  FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  PERFORM public.wi_expire_due(_workspace_id);

  SELECT * INTO _inv FROM public.workspace_invitations
  WHERE id = _invitation_id FOR UPDATE;

  IF _inv.id IS NULL OR _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending' THEN
    RAISE EXCEPTION 'INVITATION_NOT_PENDING';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;

  IF _actor_role IS NULL
     OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role)
     OR NOT public.wi_can_manage_invitation(_actor_role, _role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  IF _member_type = 'staff' AND array_length(_department_ids, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT';
  END IF;
  IF _member_type = 'customer_facing' AND array_length(_department_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT';
  END IF;

  _contact_changed := (_inv.invited_email_normalized IS DISTINCT FROM _email_normalized)
                   OR (_inv.invited_phone_e164 IS DISTINCT FROM _phone_e164);
  _generation := _inv.notification_generation + CASE WHEN _contact_changed THEN 1 ELSE 0 END;

  IF _contact_changed THEN
    PERFORM public.wi_revoke_secrets(_invitation_id, _inv.notification_generation, NULL);
  END IF;

  UPDATE public.workspace_invitations
  SET first_name = _first_name,
      last_name = _last_name,
      invited_email_normalized = _email_normalized,
      invited_email = _email_normalized,
      invited_phone_e164 = _phone_e164,
      member_type = _member_type,
      role = _role,
      expires_at = _expires_at,
      job_title = _job_title,
      staff_code = _staff_code,
      notification_generation = _generation
  WHERE id = _invitation_id;

  DELETE FROM public.workspace_invitation_departments WHERE invitation_id = _invitation_id;
  IF _department_ids IS NOT NULL THEN
    FOREACH _dept IN ARRAY _department_ids LOOP
      INSERT INTO public.workspace_invitation_departments (invitation_id, workspace_id, department_id)
      VALUES (_invitation_id, _workspace_id, _dept);
    END LOOP;
  END IF;

  IF _contact_changed THEN
    IF _email_job_idempotency_key IS NULL
       OR (_phone_e164 IS NOT NULL AND _sms_job_idempotency_key IS NULL) THEN
      RAISE EXCEPTION 'MISSING_JOB_IDEMPOTENCY_KEYS';
    END IF;

    INSERT INTO public.workspace_invitation_jobs (
      invitation_id, workspace_id, channel, notification_generation,
      email_token_generation, destination_hash, idempotency_key
    ) VALUES
      (_invitation_id, _workspace_id, 'email', _generation, 1, _email_destination_hash, _email_job_idempotency_key);

    IF _phone_e164 IS NOT NULL THEN
      INSERT INTO public.workspace_invitation_jobs (
        invitation_id, workspace_id, channel, notification_generation,
        email_token_generation, destination_hash, idempotency_key
      ) VALUES
        (_invitation_id, _workspace_id, 'sms', _generation, NULL, _sms_destination_hash, _sms_job_idempotency_key);
    END IF;

    INSERT INTO public.workspace_invitation_deliveries (
      invitation_id, workspace_id, job_id, channel, notification_generation, status
    )
    SELECT _invitation_id, _workspace_id, j.id, j.channel, _generation, 'queued'
    FROM public.workspace_invitation_jobs j
    WHERE j.invitation_id = _invitation_id AND j.notification_generation = _generation;
  END IF;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.edited', _invitation_id,
          jsonb_build_object('contact_changed', _contact_changed, 'generation', _generation));

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$function$;

-- get_invitation_info — supabase/migrations/20260415100153_78c1a3ae-c6c3-4c82-af97-2914daabe149.sql
CREATE OR REPLACE FUNCTION public.get_invitation_info(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _result jsonb;
  _user_id uuid;
  _user_email text;
  _is_member boolean;
BEGIN
  _user_id := auth.uid();

  -- Get user email if authenticated
  IF _user_id IS NOT NULL THEN
    SELECT email INTO _user_email FROM profiles WHERE id = _user_id;
  END IF;

  SELECT jsonb_build_object(
    'workspace_name', w.name,
    'workspace_slug', w.slug,
    'workspace_id', w.id,
    'role', wi.role,
    'expires_at', wi.expires_at,
    'expired', (wi.expires_at IS NOT NULL AND wi.expires_at < now()),
    'revoked', wi.revoked_at IS NOT NULL,
    'invited_email', wi.invited_email,
    'inviter_name', COALESCE(p.full_name, ''),
    'inviter_email', COALESCE(p.email, ''),
    'created_at', wi.created_at,
    'email_match', CASE
      WHEN wi.invited_email IS NULL THEN true
      WHEN _user_email IS NULL THEN null
      ELSE lower(trim(_user_email)) = lower(trim(wi.invited_email))
    END,
    'already_member', CASE
      WHEN _user_id IS NULL THEN false
      ELSE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = w.id AND user_id = _user_id)
    END
  ) INTO _result
  FROM workspace_invitations wi
  JOIN workspaces w ON w.id = wi.workspace_id
  LEFT JOIN profiles p ON p.id = wi.created_by
  WHERE wi.token = _token;

  IF _result IS NULL THEN
    RAISE EXCEPTION 'Invalid invitation';
  END IF;

  RETURN _result;
END;
$function$;

-- gv_admin_consumer_implemented — supabase/migrations/20260910135111_4e962667-a7fe-4ff3-8e03-39f541691a67.sql
CREATE OR REPLACE FUNCTION public.gv_admin_consumer_implemented(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY['signup_email']::text[]);
$function$;

-- gv_admin_deployment_allowlisted — supabase/migrations/20260910135111_4e962667-a7fe-4ff3-8e03-39f541691a67.sql
CREATE OR REPLACE FUNCTION public.gv_admin_deployment_allowlisted(_purpose text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT _purpose = ANY(ARRAY['signup_email']::text[]);
$function$;

-- handle_new_user — supabase/migrations/20260415075437_update_handle_new_user.sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $handle_new_user$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, company_name, website_domain, main_goal, ai_mode, signup_locale, signup_ip)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.raw_user_meta_data->>'companyName',
    NEW.raw_user_meta_data->>'websiteDomain',
    NEW.raw_user_meta_data->>'mainGoal',
    NEW.raw_user_meta_data->>'aiMode',
    NEW.raw_user_meta_data->>'locale',
    NEW.raw_user_meta_data->>'signup_ip'
  );

  PERFORM public.provision_account_on_signup(NEW.id);

  RETURN NEW;
END;
$handle_new_user$;

-- is_workspace_member — supabase/migrations/20260422123023_fbbf7cec-d781-4a5f-be72-748a67ae75fa.sql
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = _workspace_id AND user_id = _user_id
  );
$$;

-- offboard_workspace_member — supabase/migrations/20260902104739_266d2a49-c673-474e-9a60-f421456f7b7c.sql
CREATE OR REPLACE FUNCTION public.offboard_workspace_member(
  _workspace_id uuid,
  _user_id uuid,
  _actor_id uuid,
  _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _owner_id uuid;
  _actor_role public.workspace_role;
  _target_role public.workspace_role;
  _first_name text;
  _last_name text;
  _email text;
  _phone text;
  _member_type text;
  _job_title text;
  _staff_code text;
  _invited_by uuid;
  _invitation_id uuid;
  _joined_at timestamptz;
  _revoked integer := 0;
  _revoked_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT owner_id INTO _owner_id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF _owner_id IS NULL THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND'; END IF;

  SELECT role INTO _target_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id FOR UPDATE;
  IF _target_role IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;

  IF _user_id = _owner_id OR _target_role = 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_WORKSPACE_OWNER';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _target_role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  SELECT d.first_name, d.last_name, d.work_email_normalized, d.work_phone_e164,
         d.member_type, d.job_title, d.staff_code, d.invited_by, d.invitation_id, d.joined_at
    INTO _first_name, _last_name, _email, _phone,
         _member_type, _job_title, _staff_code, _invited_by, _invitation_id, _joined_at
  FROM public.workspace_member_details d
  WHERE d.workspace_id = _workspace_id AND d.user_id = _user_id;

  INSERT INTO public.workspace_member_details_history (
    workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164,
    member_type, job_title, staff_code, invited_by, invitation_id, joined_at,
    offboarded_by, reason
  ) VALUES (
    _workspace_id, _user_id, _first_name, _last_name, _email, _phone,
    _member_type, _job_title, _staff_code, _invited_by, _invitation_id, _joined_at,
    _actor_id, _reason
  );

  IF _email IS NOT NULL OR _phone IS NOT NULL THEN
    WITH revoked AS (
      UPDATE public.workspace_invitations
      SET status = 'revoked', revoked_at = now(), revoked_by = _actor_id,
          revoked_reason = COALESCE(_reason, 'member_offboarded')
      WHERE workspace_id = _workspace_id
        AND status = 'pending'
        AND (invited_email_normalized = _email OR invited_phone_e164 = _phone)
      RETURNING id
    )
    SELECT count(*)::integer, COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO _revoked, _revoked_ids
    FROM revoked;

    IF array_length(_revoked_ids, 1) IS NOT NULL THEN
      PERFORM public.wi_revoke_secrets(rid, NULL, NULL) FROM unnest(_revoked_ids) AS rid;
    END IF;
  END IF;

  DELETE FROM public.call_center_department_agents
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.call_center_agent_presence
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.operator_call_availability
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.user_notification_prefs
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  -- Workspace-scoped availability only. The global (workspace_id IS NULL)
  -- preference row must survive.
  DELETE FROM public.user_availability_prefs
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.workspace_department_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.workspace_member_details
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  IF EXISTS (SELECT 1 FROM public.workspace_members
             WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.workspace_department_members
                WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.workspace_member_details
                WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.call_center_department_agents
                WHERE workspace_id = _workspace_id AND user_id = _user_id) THEN
    RAISE EXCEPTION 'OFFBOARDING_INCOMPLETE';
  END IF;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'workspace_member.offboarded', _user_id,
          jsonb_build_object('role', _target_role, 'revoked_invitations', _revoked,
                             'reason', _reason), 'workspace_member');

  RETURN jsonb_build_object(
    'workspace_id', _workspace_id,
    'user_id', _user_id,
    'revoked_invitations', _revoked
  );
END;
$$;

-- wi_heartbeat_invitation_job — supabase/migrations/20260902123400_f000e574-476f-4a89-8c0e-78e76651af65.sql
CREATE OR REPLACE FUNCTION public.wi_heartbeat_invitation_job(
  _job_id uuid,
  _claim_token uuid,
  _lease_seconds integer DEFAULT 120
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _claim_token IS NULL THEN
    RAISE EXCEPTION 'CLAIM_TOKEN_REQUIRED';
  END IF;
  IF _lease_seconds < 30 OR _lease_seconds > 600 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS';
  END IF;
  UPDATE public.workspace_invitation_jobs
  SET claim_expires_at = now() + make_interval(secs => _lease_seconds),
      updated_at = now()
  WHERE id = _job_id
    AND claim_token = _claim_token
    AND status = 'claimed'
    AND claim_expires_at > now();
  RETURN FOUND;
END;
$$;

-- workspace_owner_phone_verified — supabase/migrations/20260801214300_73468a38-4cf9-4e9c-baf7-007b7973c647.sql
CREATE OR REPLACE FUNCTION public.workspace_owner_phone_verified(_workspace_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces w
    JOIN public.user_phone_verifications v ON v.user_id = w.owner_id
    WHERE w.id = _workspace_id AND v.phone_verified_at IS NOT NULL
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- B. Functions production runs that neither chain defines (added to the
--    hosted project outside its migrations). Definitions copied from
--    production's catalog (pg_get_functiondef), unchanged.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.billing_v2_billing_recipient(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT public.billing_v2_resolve_billing_recipient(p_workspace_id) $function$;

CREATE OR REPLACE FUNCTION public.billing_v2_skip_notification_job(p_job_id uuid, p_reason text DEFAULT 'skipped'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_row public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'skipped', lease_until = NULL,
         last_error = left(COALESCE(p_reason, 'skipped'), 200), updated_at = now()
   WHERE id = p_job_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_job'); END IF;
  RETURN jsonb_build_object('job_id', v_row.id, 'status', v_row.status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_complete_notification_job(p_job_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_row public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'sent', sent_at = now(), lease_until = NULL,
         last_error = NULL, payload = payload || jsonb_build_object('result', p_result),
         updated_at = now()
   WHERE id = p_job_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_job'); END IF;
  RETURN jsonb_build_object('job_id', v_row.id, 'status', v_row.status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_validate_policy()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol      public.billing_v2_policy;
  v_errors   JSONB := '[]'::jsonb;
  v_warnings JSONB := '[]'::jsonb;
  v_plan     public.billing_plans;
  v_free     INTEGER;
BEGIN
  SELECT * INTO v_pol FROM public.billing_v2_policy WHERE id;
  IF v_pol.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'errors',
      jsonb_build_array(jsonb_build_object('code', 'policy_row_missing')),
      'warnings', '[]'::jsonb, 'policy', 'null'::jsonb);
  END IF;

  SELECT count(*) INTO v_free
    FROM public.billing_plans WHERE is_free = true AND is_active = true;

  IF v_pol.fallback_plan_id IS NULL THEN
    IF v_free = 0 THEN
      v_errors := v_errors || jsonb_build_object('code', 'no_active_free_plan_for_fallback');
    ELSE
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'fallback_plan_id_implicit', 'detail', v_free);
    END IF;
  ELSE
    SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_pol.fallback_plan_id;
    IF v_plan.id IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'code', 'fallback_plan_missing', 'detail', v_pol.fallback_plan_id);
    ELSE
      IF NOT COALESCE(v_plan.is_free, false) THEN
        v_errors := v_errors || jsonb_build_object(
          'code', 'fallback_plan_not_free', 'detail', v_plan.id);
      END IF;
      IF NOT COALESCE(v_plan.is_active, false) THEN
        v_errors := v_errors || jsonb_build_object(
          'code', 'fallback_plan_inactive', 'detail', v_plan.id);
      END IF;
    END IF;
  END IF;

  IF v_pol.invoice_lead_time_days IS NULL OR v_pol.invoice_lead_time_days < 1 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'invoice_lead_time_zero', 'detail', v_pol.invoice_lead_time_days);
  END IF;

  IF COALESCE(array_length(v_pol.reminder_days_before_due, 1), 0) = 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'no_invoice_reminders');
  END IF;

  IF v_pol.grace_period_days IS NULL THEN
    v_errors := v_errors || jsonb_build_object('code', 'grace_period_days_null');
  END IF;

  IF v_pol.new_workspace_default_state NOT IN
       ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active') THEN
    v_errors := v_errors || jsonb_build_object(
      'code', 'invalid_new_workspace_default_state',
      'detail', v_pol.new_workspace_default_state);
  END IF;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_errors) = 0,
    'errors', v_errors,
    'warnings', v_warnings,
    'policy', jsonb_build_object(
      'invoice_lead_time_days', v_pol.invoice_lead_time_days,
      'invoice_due_offset_days', v_pol.invoice_due_offset_days,
      'grace_period_days', v_pol.grace_period_days,
      'reminder_days_before_due', to_jsonb(v_pol.reminder_days_before_due),
      'wallet_auto_pay_default', v_pol.wallet_auto_pay_default,
      'fallback_plan_id', v_pol.fallback_plan_id,
      'new_workspace_default_state', v_pol.new_workspace_default_state,
      'new_workspace_default_region', v_pol.new_workspace_default_region,
      'active_free_plans', v_free));
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_freeze_invoice_dunning()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_policy JSONB;
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NEW.status NOT IN ('open', 'partially_paid') THEN RETURN NEW; END IF;
  IF (COALESCE(NEW.metadata, '{}'::jsonb) ? 'dunning') THEN RETURN NEW; END IF;

  v_policy := public.billing_v2_policy_for(NEW.workspace_id);
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
    'dunning', jsonb_build_object(
      'frozen', true,
      'frozen_at', now(),
      'grace_period_days', (v_policy->>'grace_period_days')::int,
      'fallback_plan_id', v_policy->>'fallback_plan_id',
      'reminder_days_before_due', v_policy->'reminder_days_before_due'
    ));
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_arm_invoice_dunning()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'open'
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    PERFORM public.billing_v2_schedule_invoice_notifications(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_seed_new_workspace_rollout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state  TEXT;
  v_region TEXT;
BEGIN
  SELECT new_workspace_default_state, new_workspace_default_region
    INTO v_state, v_region
    FROM public.billing_v2_policy WHERE id;

  IF v_state IS NULL OR v_state = 'legacy' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.billing_v2_rollout (workspace_id, state, region,
                                         shadow_enabled_at, cutover_pending_at, activated_at)
  VALUES (
    NEW.id, v_state, v_region,
    CASE WHEN v_state <> 'legacy' THEN now() END,
    CASE WHEN v_state IN ('v2_cutover_pending', 'v2_active') THEN now() END,
    CASE WHEN v_state = 'v2_active' THEN now() END)
  ON CONFLICT (workspace_id) DO NOTHING;

  INSERT INTO public.billing_wallet_accounts (workspace_id)
  VALUES (NEW.id) ON CONFLICT (workspace_id) DO NOTHING;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (NEW.id, 'billing_v2_new_workspace_default', 'policy_default',
          jsonb_build_object('state', v_state, 'region', v_region));

  RETURN NEW;
END;
$function$;

-- Production differs from the hosted chain's last definition here (changed in
-- place on the hosted project): entitlement-cycle allowances (`cycle:%`) are
-- canonical V2, not legacy.
CREATE OR REPLACE FUNCTION public.billing_v2_block_legacy_allowance_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owned BOOLEAN;
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NEW.source_type <> 'PLAN_ALLOWANCE' THEN RETURN NEW; END IF;

  -- Canonical V2 allowances are attached to either the original service
  -- period identity or (since entitlement-cycle rollout) its concrete cycle.
  -- Only calendar keys such as YYYY-MM belong to the retired legacy path.
  IF NEW.billing_cycle_id LIKE 'period:%'
     OR NEW.billing_cycle_id LIKE 'cycle:%' THEN
    RETURN NEW;
  END IF;

  SELECT (v2_allowance_effective_period_id IS NOT NULL) INTO v_owned
    FROM public.workspace_subscriptions
   WHERE workspace_id = NEW.workspace_id;

  IF COALESCE(v_owned, false) THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (NEW.workspace_id, 'billing_v2_legacy_path_rejected',
            'legacy_calendar_allowance_grant',
            jsonb_build_object('billing_cycle_id', NEW.billing_cycle_id));
    RAISE EXCEPTION 'billing_v2_legacy_allowance_grant_forbidden:%', NEW.workspace_id;
  END IF;

  RETURN NEW;
END;
$function$;

-- Production enables the signup-email verification purpose (with the two
-- gv_admin_* helpers in section A).
CREATE OR REPLACE FUNCTION public.gv_is_purpose_enabled(_purpose text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT _purpose = ANY(ARRAY['commerce_order_lookup','signup_email']::text[]);
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $function$;

-- ─────────────────────────────────────────────────────────────────────────
-- C. Seat capacity: production's plan-authoritative resolution, keeping the
--    self-host fixed limit. Production stores mode=plan_authoritative with
--    seat_limit NULL, so on production's data this is production's function
--    exactly; an install that sets SELF_HOST_SEAT_LIMIT (seat_limit NOT
--    NULL) keeps its fixed limit, as before. The one deliberate difference
--    from production's text, listed in scripts/db/schema-parity-allowlist.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.wi_resolve_seat_capacity(_workspace_id uuid)
 RETURNS TABLE(limit_value integer, used integer, source text, version integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _mode text;
  _config_version integer;
  _seat_limit integer;
  _status text;
  _plan_id uuid;
  _raw text;
  _limit integer;
BEGIN
  SELECT m.mode, m.config_version, m.seat_limit
    INTO _mode, _config_version, _seat_limit
  FROM public.workspace_seat_entitlement_mode m WHERE m.id = true;

  IF _mode IS NULL THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;

  SELECT count(*)::integer INTO used
  FROM public.workspace_members WHERE workspace_id = _workspace_id;

  IF _mode = 'self_host_unlimited' THEN
    limit_value := NULL;
    source := 'self_host_unlimited';
    version := _config_version;
    RETURN NEXT;
    RETURN;
  END IF;

  -- A fixed install-wide limit (SELF_HOST_SEAT_LIMIT) wins when configured.
  IF _seat_limit IS NOT NULL THEN
    IF _seat_limit < 0 THEN
      RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
    END IF;
    limit_value := _seat_limit;
    source := 'self_host_fixed_limit';
    version := _config_version;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT s.status, s.plan_id, p.limits->>'max_agents'
    INTO _status, _plan_id, _raw
  FROM public.workspace_subscriptions s
  LEFT JOIN public.billing_plans p ON p.id = s.plan_id
  WHERE s.workspace_id = _workspace_id;

  IF _status IS NULL OR _plan_id IS NULL OR _raw IS NULL OR _raw !~ '^-?[0-9]+$' THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;

  IF _status IN ('canceled', 'unpaid', 'expired', 'incomplete', 'paused') THEN
    limit_value := 0;
    source := 'subscription_inactive';
    version := _config_version;
    RETURN NEXT;
    RETURN;
  END IF;

  _limit := _raw::integer;
  limit_value := CASE WHEN _limit < 0 THEN NULL ELSE _limit END;
  source := 'plan_authoritative';
  version := _config_version;
  RETURN NEXT;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- D. Who may execute the functions this file creates: as on production,
--    the role the server runs as and nobody else.
-- ─────────────────────────────────────────────────────────────────────────

DO $acl$
DECLARE
  f text;
  r text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.check_workspace_entitlement(uuid, text)',
    'public.check_module_access(uuid, text)',
    'public.check_channel_access(uuid, text)',
    'public.deduct_ai_credits(uuid, integer, text)',
    'public.billing_v2_billing_recipient(uuid)',
    'public.billing_v2_skip_notification_job(uuid, text)',
    'public.billing_v2_complete_notification_job(uuid, jsonb)',
    'public.billing_v2_validate_policy()',
    'public.billing_v2_freeze_invoice_dunning()',
    'public.billing_v2_arm_invoice_dunning()',
    'public.billing_v2_seed_new_workspace_rollout()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END
$acl$;

-- ─────────────────────────────────────────────────────────────────────────
-- E. Triggers, as on production.
-- ─────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_billing_v2_seed_new_workspace ON public.workspaces;
CREATE TRIGGER trg_billing_v2_seed_new_workspace
  AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_seed_new_workspace_rollout();

DROP TRIGGER IF EXISTS trg_billing_v2_freeze_invoice_dunning ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_freeze_invoice_dunning
  BEFORE INSERT OR UPDATE OF status ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_freeze_invoice_dunning();

-- Same trigger name, production's function name.
DROP TRIGGER IF EXISTS trg_billing_v2_invoice_arm_dunning ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_arm_dunning
  AFTER INSERT OR UPDATE OF status ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_arm_invoice_dunning();
DROP FUNCTION IF EXISTS public.billing_v2_invoice_arm_dunning();

DROP TRIGGER IF EXISTS trg_protect_workspace_domains ON public.workspace_branding;
CREATE TRIGGER trg_protect_workspace_domains
  BEFORE UPDATE ON public.workspace_branding
  FOR EACH ROW EXECUTE FUNCTION public.protect_workspace_domain_fields();

-- widget_templates is gone from production (and from the code); its slug
-- validator would refuse widget_settings writes production accepts.
DROP TRIGGER IF EXISTS validate_widget_template_slug_trg ON public.widget_settings;
DROP FUNCTION IF EXISTS public.validate_widget_template_slug();

-- ─────────────────────────────────────────────────────────────────────────
-- F. CHECK and FOREIGN KEY constraints, as on production. Widened ones
--    (wallet deposits, entitlement cycles, skipped notification jobs,
--    invitations without a phone) are replaced outright; the two production
--    narrows more are added NOT VALID and validated where existing rows allow.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.billing_payment_intents DROP CONSTRAINT IF EXISTS billing_payment_intents_subscription_shape;
ALTER TABLE public.billing_payment_intents ADD CONSTRAINT billing_payment_intents_subscription_shape
  CHECK ((((purchase_type = 'subscription'::text) AND (plan_id IS NOT NULL) AND (billing_interval IS NOT NULL))
    OR ((purchase_type = ANY (ARRAY['ai_credit_topup'::text, 'wallet_deposit'::text])) AND (plan_id IS NULL) AND (billing_interval IS NULL))));

ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_type_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_type_check
  CHECK ((invoice_type = ANY (ARRAY['new_subscription'::text, 'subscription_renewal'::text, 'plan_upgrade'::text,
    'addon'::text, 'manual'::text, 'ai_credit_purchase'::text, 'wallet_deposit'::text])));

ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_type_check;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_type_check
  CHECK ((line_type = ANY (ARRAY['plan'::text, 'upgrade_proration'::text, 'addon'::text, 'ai_credit'::text,
    'wallet_deposit'::text, 'discount'::text, 'tax'::text, 'credit'::text, 'manual_adjustment'::text])));

ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_type_check;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_type_check
  CHECK ((job_type = ANY (ARRAY['renewal_invoice'::text, 'wallet_autopay'::text, 'period_activation'::text,
    'free_period'::text, 'entitlement_cycle'::text, 'dunning_due'::text, 'grace_expiry'::text])));

ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_status_check;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_status_check
  CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'canceled'::text,
    'skipped'::text, 'skipped_no_recipient'::text])));

ALTER TABLE public.workspace_invitations DROP CONSTRAINT IF EXISTS workspace_invitations_v2_required_chk;
ALTER TABLE public.workspace_invitations ADD CONSTRAINT workspace_invitations_v2_required_chk
  CHECK (((invitation_flow_version <> 2) OR ((first_name IS NOT NULL) AND (btrim(first_name) <> ''::text)
    AND (last_name IS NOT NULL) AND (btrim(last_name) <> ''::text) AND (invited_email_normalized IS NOT NULL)
    AND (invited_email_normalized = lower(btrim(invited_email_normalized)))
    AND ((invited_phone_e164 IS NULL) OR (invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'::text))
    AND (member_type IS NOT NULL) AND (role IS NOT NULL) AND (role <> 'owner'::workspace_role)
    AND (workspace_id IS NOT NULL) AND (created_by IS NOT NULL) AND (created_at IS NOT NULL)
    AND (expires_at IS NOT NULL) AND (expires_at > created_at) AND (notification_generation IS NOT NULL)
    AND (notification_generation >= 1) AND (token IS NULL))));

-- health_score rules read the workspace-health snapshots production dropped
-- (section K); the engine already treats them as inert
-- (server/services/observability/enforcementEngine.ts) and production has
-- none, so they go before its narrower check is added.
DELETE FROM public.enforcement_rules WHERE trigger_type = 'health_score';
ALTER TABLE public.enforcement_rules DROP CONSTRAINT IF EXISTS enforcement_rules_trigger_type_check;
ALTER TABLE public.enforcement_rules ADD CONSTRAINT enforcement_rules_trigger_type_check
  CHECK ((trigger_type = ANY (ARRAY['slo_breach'::text, 'alert_rate'::text]))) NOT VALID;

ALTER TABLE public.visitor_sessions DROP CONSTRAINT IF EXISTS visitor_sessions_geo_accuracy_level_check;
ALTER TABLE public.visitor_sessions ADD CONSTRAINT visitor_sessions_geo_accuracy_level_check
  CHECK (((geo_accuracy_level IS NULL) OR (geo_accuracy_level = ANY (ARRAY['country'::text, 'region'::text, 'city'::text])))) NOT VALID;

DO $validate$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
      ('public.enforcement_rules', 'enforcement_rules_trigger_type_check'),
      ('public.visitor_sessions', 'visitor_sessions_geo_accuracy_level_check')) v(tbl, con) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.con);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '251: % left NOT VALID — existing rows violate it (new rows are checked)', c.con;
    END;
  END LOOP;
END
$validate$;

-- Checks and foreign keys production does not have. Each would refuse rows
-- production holds or accepts (production has accounts and account_members
-- rows whose profile is gone, which the two foreign keys would reject).
ALTER TABLE public.call_center_settings DROP CONSTRAINT IF EXISTS call_center_settings_widget_template_id_check;
ALTER TABLE public.call_center_settings DROP CONSTRAINT IF EXISTS call_center_settings_offline_behavior_check;
ALTER TABLE public.call_center_settings DROP CONSTRAINT IF EXISTS call_center_settings_widget_theme_object_check;
ALTER TABLE public.call_center_settings DROP CONSTRAINT IF EXISTS call_center_settings_pre_call_form_array_check;
ALTER TABLE public.call_center_settings DROP CONSTRAINT IF EXISTS call_center_settings_avatar_path_scope_check;
ALTER TABLE public.privacy_jobs DROP CONSTRAINT IF EXISTS privacy_jobs_artifact_path_scope_check;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_owner_id_fkey;
ALTER TABLE public.account_members DROP CONSTRAINT IF EXISTS account_members_user_id_fkey;
-- Exact duplicates of the *_profiles_fkey constraints beside them (same
-- columns, same target, same ON DELETE); production has one of each.
ALTER TABLE public.canned_responses DROP CONSTRAINT IF EXISTS canned_responses_created_by_fkey;
ALTER TABLE public.user_notification_prefs DROP CONSTRAINT IF EXISTS user_notification_prefs_user_id_fkey;

-- ─────────────────────────────────────────────────────────────────────────
-- G. Column nullability and defaults, as on production. Where production is
--    stricter (NOT NULL), it is applied only when no existing row breaks it.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.audit_logs ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE public.billing_entitlement_cycles ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE public.billing_payments
  ALTER COLUMN created_at DROP NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD'::text,
  ALTER COLUMN metadata DROP NOT NULL,
  ALTER COLUMN refund_amount DROP NOT NULL,
  ALTER COLUMN refund_amount DROP DEFAULT,
  ALTER COLUMN status SET DEFAULT 'pending'::text;
ALTER TABLE public.widget_settings
  ALTER COLUMN primary_color SET DEFAULT '#6D5DFB'::text,
  ALTER COLUMN show_powered_by DROP NOT NULL;

DO $not_null$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES ('provider_name'), ('workspace_id')) v(col) LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.billing_payments'::regclass
                AND attname = c.col AND NOT attnotnull) THEN
      BEGIN
        EXECUTE format('ALTER TABLE public.billing_payments ALTER COLUMN %I SET NOT NULL', c.col);
      EXCEPTION WHEN not_null_violation THEN
        RAISE NOTICE '251: billing_payments.% stays nullable — existing rows hold NULL', c.col;
      END;
    END IF;
  END LOOP;
END
$not_null$;

-- billing_v2_policy.new_workspace_default_state is not written here: 250 gave
-- the row a database already had 'legacy' (the trigger above then does
-- nothing, as before), and whatever an administrator set since is theirs.

-- ─────────────────────────────────────────────────────────────────────────
-- H. Commerce catalogue: production hard-deletes and records a tombstone in
--    commerce_deleted_entities (section A's functions); this chain used a
--    soft delete (deleted_at). Rows already soft-deleted become tombstones,
--    then the column (and the partial indexes over it) goes, and production's
--    indexes take their place.
-- ─────────────────────────────────────────────────────────────────────────

DO $commerce$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.commerce_product_variants'::regclass
              AND attname = 'deleted_at' AND NOT attisdropped) THEN
    INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
    SELECT connection_id, 'variant', external_id, entity_version
      FROM public.commerce_product_variants WHERE deleted_at IS NOT NULL
    ON CONFLICT (connection_id, kind, external_id) DO UPDATE
      SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version);
    DELETE FROM public.commerce_product_variants WHERE deleted_at IS NOT NULL;
    ALTER TABLE public.commerce_product_variants DROP COLUMN deleted_at;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.commerce_products'::regclass
              AND attname = 'deleted_at' AND NOT attisdropped) THEN
    INSERT INTO public.commerce_deleted_entities (connection_id, kind, external_id, entity_version)
    SELECT connection_id, 'product', external_id, entity_version
      FROM public.commerce_products WHERE deleted_at IS NOT NULL
    ON CONFLICT (connection_id, kind, external_id) DO UPDATE
      SET entity_version = GREATEST(EXCLUDED.entity_version, public.commerce_deleted_entities.entity_version);
    DELETE FROM public.commerce_products WHERE deleted_at IS NOT NULL;
    ALTER TABLE public.commerce_products DROP COLUMN deleted_at;
  END IF;
END
$commerce$;

CREATE INDEX IF NOT EXISTS commerce_products_price_idx ON public.commerce_products USING btree (connection_id, effective_price_minor);
CREATE INDEX IF NOT EXISTS commerce_products_stock_idx ON public.commerce_products USING btree (connection_id, stock_state);
CREATE INDEX IF NOT EXISTS commerce_variants_product_idx ON public.commerce_product_variants USING btree (product_id);

-- ─────────────────────────────────────────────────────────────────────────
-- I. Indexes, as on production.
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_visitor_sessions_geo_map ON public.visitor_sessions USING btree (workspace_id, last_seen_at DESC)
  WHERE ((geo_latitude IS NOT NULL) AND (geo_longitude IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_geo_warm ON public.visitor_sessions USING btree (workspace_id, geo_resolved_at)
  WHERE (ip_raw IS NOT NULL);
-- Covered by the (workspace_id, period) unique index; production has only that.
DROP INDEX IF EXISTS public.idx_workspace_usage_counters_workspace;
-- Production enforces the same uniqueness through uq_billing_payments_provider_ref
-- (provider_payment_id IS NOT NULL), which this chain has as well.
DROP INDEX IF EXISTS public.uq_billing_payments_provider_payment;

-- ─────────────────────────────────────────────────────────────────────────
-- J. Row-level-security policies production has. They concern the customer
--    roles only (the server runs as service_role, which bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────

DO $policies$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    DROP POLICY IF EXISTS "service role only" ON public.seo_explorer_keyword_scans;
    CREATE POLICY "service role only" ON public.seo_explorer_keyword_scans AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
    DROP POLICY IF EXISTS "service role only" ON public.seo_explorer_backlink_scans;
    CREATE POLICY "service role only" ON public.seo_explorer_backlink_scans AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
    DROP POLICY IF EXISTS "service role only" ON public.seo_explorer_backlinks;
    CREATE POLICY "service role only" ON public.seo_explorer_backlinks AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
    DROP POLICY IF EXISTS "service role only" ON public.seo_explorer_keywords;
    CREATE POLICY "service role only" ON public.seo_explorer_keywords AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    DROP POLICY IF EXISTS "Public can read support widget config" ON public.app_runtime_config;
    CREATE POLICY "Public can read support widget config" ON public.app_runtime_config AS PERMISSIVE FOR SELECT
      TO anon, authenticated USING ((key = 'support_widget_workspace_id'::text));
    DROP POLICY IF EXISTS "Members can read ws domains extended" ON public.workspace_domains_extended;
    CREATE POLICY "Members can read ws domains extended" ON public.workspace_domains_extended AS PERMISSIVE FOR SELECT
      TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));
  END IF;
END
$policies$;

-- ─────────────────────────────────────────────────────────────────────────
-- K. Objects production dropped and nothing in the code reads or writes:
--    the workspace health snapshot family and widget templates (with the
--    widget_settings.template_slug column that pointed at them).
--
--    Dropped only while they hold nothing but what the chain itself put
--    there — as on a fresh install: no snapshot, and in widget_templates only
--    the two rows 239 seeds, unchanged (their own ids and updated_at; the
--    table's trigger moves updated_at on any edit). A table with other rows,
--    and template_slug while widget_templates has such rows or any widget
--    names a template other than 'default', are KEPT, with a WARNING: those
--    rows are the operator's to
--    export or empty, not this file's to delete for the sake of matching
--    production's schema (scripts/db/schema-diff.sh then reports them, and
--    scripts/db/move-data.sh refuses to move into a target that holds them).
--    No CASCADE: anything else that depends on them stops this file instead
--    of disappearing with them. Running it again, after the rows are gone,
--    drops what was kept.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.workspace_health_snapshot_compute();
DO $leftovers$
DECLARE t text; n bigint; named bigint := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_health_snapshots', 'workspace_health_snapshots_legacy'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n = 0 THEN
        EXECUTE format('DROP TABLE public.%I', t);
      ELSE
        RAISE WARNING '251: kept public.% — it holds % row(s); production no longer has the table. Export or empty it, then run 251 again to drop it.', t, n;
      END IF;
    END IF;
  END LOOP;

  n := 0;
  IF to_regclass('public.widget_templates') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM public.widget_templates
                WHERE NOT coalesce((id, updated_at) IN (('a25826ee-431c-443b-8a23-d4c938f8742b'::uuid, '2026-09-30 04:34:03.946197+00'::timestamptz),
                                                        ('d33d4466-9056-4550-814c-4e3c2544cbf7'::uuid, '2026-09-30 04:34:03.948071+00'::timestamptz)), false)$q$ INTO n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.widget_settings'::regclass
              AND attname = 'template_slug' AND NOT attisdropped) THEN
    EXECUTE $q$SELECT count(*) FROM public.widget_settings WHERE template_slug IS DISTINCT FROM 'default'$q$ INTO named;
  END IF;
  IF n = 0 AND named = 0 THEN
    ALTER TABLE public.widget_settings DROP COLUMN IF EXISTS template_slug;
    DROP TABLE IF EXISTS public.widget_templates;
  ELSE
    RAISE WARNING '251: kept public.widget_templates (% row(s) besides the two 239 seeds) and widget_settings.template_slug (% widget(s) naming a template other than ''default''); production no longer has them. Export or empty them, then run 251 again to drop them.', n, named;
  END IF;
END
$leftovers$;
