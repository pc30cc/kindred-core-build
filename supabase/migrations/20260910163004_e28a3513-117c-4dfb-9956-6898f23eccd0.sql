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

REVOKE ALL ON FUNCTION public.admin_purge_workspaces(uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_purge_workspaces(uuid[]) TO service_role;