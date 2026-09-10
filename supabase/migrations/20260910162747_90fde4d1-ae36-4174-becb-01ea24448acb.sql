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

  -- grandchildren: tables without workspace_id/conversation_id that reference
  -- a table which itself references a workspace-scoped table
  FOR _rec IN
    SELECT DISTINCT gt.relname AS child_table, ga.attname AS child_col,
                    ct.relname AS mid_table, pa.attname AS mid_col,
                    cc.relname AS ws_table, ca.attname AS ws_col,
                    cb.relname AS mid_fk_col_table, cm.attname AS mid_fk_col
    FROM pg_constraint g
    JOIN pg_class gt ON gt.oid = g.conrelid
    JOIN pg_attribute ga ON ga.attrelid = g.conrelid AND ga.attnum = g.conkey[1]
    JOIN pg_class ct ON ct.oid = g.confrelid
    JOIN pg_attribute pa ON pa.attrelid = g.confrelid AND pa.attnum = g.confkey[1]
    JOIN pg_constraint f ON f.conrelid = ct.oid AND f.contype = 'f'
    JOIN pg_class cc ON cc.oid = f.confrelid
    JOIN pg_attribute ca ON ca.attrelid = f.confrelid AND ca.attnum = f.confkey[1]
    JOIN pg_class cb ON cb.oid = f.conrelid
    JOIN pg_attribute cm ON cm.attrelid = f.conrelid AND cm.attnum = f.conkey[1]
    JOIN pg_namespace n ON n.oid = gt.relnamespace AND n.nspname = 'public'
    WHERE g.contype = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = gt.oid AND x.attname IN ('workspace_id','conversation_id') AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = ct.oid AND y.attname = 'workspace_id' AND NOT y.attisdropped)
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

  -- every workspace-scoped table
  FOR _rec IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'workspace_id'
      AND c.data_type = 'uuid'
      AND c.table_name <> 'workspaces'
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

CREATE OR REPLACE FUNCTION public.admin_delete_workspace(_actor_user_id uuid, _workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.billing_purge', 'on', true);
  IF NOT has_role(_actor_user_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = _workspace_id) THEN
    RAISE EXCEPTION 'Workspace not found';
  END IF;
  PERFORM admin_purge_workspaces(ARRAY[_workspace_id]);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(_actor_user_id uuid, _user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _ws uuid[];
  _stmts text[] := '{}';
  _pending text[];
  _next text[];
  _s text;
  _pass int := 0;
  _rec record;
  _tables int := 0;
  _admin_count int;
BEGIN
  PERFORM set_config('app.billing_purge', 'on', true);
  IF NOT has_role(_actor_user_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _actor_user_id = _user_id THEN
    RAISE EXCEPTION 'Cannot delete your own account';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = _user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = 'admin') THEN
    SELECT count(*) INTO _admin_count FROM user_roles WHERE role = 'admin';
    IF _admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot delete the last platform admin';
    END IF;
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO _ws FROM workspaces WHERE owner_id = _user_id;

  IF array_length(_ws, 1) > 0 THEN
    _tables := admin_purge_workspaces(_ws);
  END IF;

  FOR _rec IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.data_type = 'uuid'
      AND c.table_name <> 'profiles'
      AND c.column_name IN (
        'user_id','owner_id','actor_user_id','created_by','updated_by','assigned_to',
        'assigned_user_id','operator_id','agent_id','invited_by','requested_by',
        'uploaded_by','resolved_by','reviewed_by','sender_user_id','actor_id',
        'deleted_by','author_id','member_user_id','target_user_id','admin_user_id'
      )
  LOOP
    _stmts := _stmts || format(
      'DELETE FROM public.%I WHERE %I = %L::uuid',
      _rec.table_name, _rec.column_name, _user_id);
  END LOOP;

  _stmts := _stmts || format('DELETE FROM public.profiles WHERE id = %L::uuid', _user_id);

  _pending := _stmts;
  WHILE array_length(_pending, 1) > 0 AND _pass < 12 LOOP
    _pass := _pass + 1;
    _next := '{}';
    FOREACH _s IN ARRAY _pending LOOP
      BEGIN
        EXECUTE _s;
        _tables := _tables + 1;
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

  RETURN jsonb_build_object(
    'deleted_user_id', _user_id,
    'workspaces_deleted', coalesce(array_length(_ws, 1), 0),
    'statements_executed', _tables
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_purge_workspaces(uuid[]) FROM public, anon, authenticated;