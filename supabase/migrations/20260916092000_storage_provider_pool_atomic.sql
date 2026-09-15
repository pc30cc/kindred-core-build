-- Storage provider pool (hosted mirror of database/migrations/189): transactional writers with optimistic
-- concurrency, plus targeted writers for replica state.
--
-- The platform can hold credentials for several storage vendors at once
-- (server/services/storage/pool.ts). Two runtime-config keys describe that
-- state and MUST agree:
--
--   app_runtime_config.storage_provider_pool      — every vendor, which is
--                                                   primary, replication flags
--   app_runtime_config.default_storage_provider   — the legacy pointer every
--                                                   existing resolver reads
--
-- Three functions, three different jobs:
--
-- 1. set_storage_provider_pool(pool, default, expected_revision)
--    Whole-pool write. Both keys move inside one function body, so either
--    both land or neither does. `expected_revision` makes it a compare-and-
--    set: an admin request that read revision N cannot overwrite the work of
--    a request that has since committed N+1. Without that, a long-running
--    operation (a sync batch doing provider I/O for seconds) would write its
--    stale snapshot back over newer credentials, a newer primary, or a
--    newer enabled flag.
--
-- 2. set_storage_replica_sync(...)
--    Back-fill progress. Deliberately NOT a whole-pool write: it touches one
--    vendor's `sync` (and, when the walk earns it, its readiness) and nothing
--    else, so a sync in flight can never restore an old credential. It is
--    guarded three ways — the vendor's config must be unchanged since the
--    walk started, the primary must still be the one the walk copied FROM,
--    and no replication gap may have been recorded after the walk began.
--
-- 3. mark_storage_replica_dirty(provider, reason) /
--    mark_storage_replication_uncertain(reason)
--    Called when a mirrored write fails, or when replication could not even
--    be resolved. They clear promotion readiness for the affected vendor(s)
--    without reading the pool first, so they work on the hot upload path and
--    on the path where reading the pool is exactly what failed.
--
-- A NULL `_default` means "the pool has no primary" (the last vendor was
-- removed) and DELETES the legacy pointer, rather than leaving it pointing
-- at a vendor that is no longer configured.

CREATE OR REPLACE FUNCTION public.set_storage_provider_pool(
  _pool jsonb,
  _default jsonb,
  _expected_revision bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _revision bigint;
  _next jsonb;
BEGIN
  IF _pool IS NULL THEN
    RAISE EXCEPTION 'set_storage_provider_pool: _pool must not be null';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('storage_provider_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'storage_provider_pool';
  _revision := COALESCE((_current->>'revision')::bigint, 0);

  IF _expected_revision IS NOT NULL AND _expected_revision <> _revision THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revision_conflict', 'revision', _revision);
  END IF;

  _next := jsonb_set(_pool, '{revision}', to_jsonb(_revision + 1), true);

  INSERT INTO public.app_runtime_config (key, value, updated_at)
  VALUES ('storage_provider_pool', _next, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  IF _default IS NULL THEN
    DELETE FROM public.app_runtime_config WHERE key = 'default_storage_provider';
  ELSE
    INSERT INTO public.app_runtime_config (key, value, updated_at)
    VALUES ('default_storage_provider', _default, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;

  RETURN jsonb_build_object('ok', true, 'revision', _revision + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_storage_replica_sync(
  _provider text,
  _sync jsonb,
  _mark_synced boolean,
  _expected_config jsonb,
  _expected_primary text,
  _walk_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _entry jsonb;
  _revision bigint;
  _dirty_at timestamptz;
  _next_entry jsonb;
  _next jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('storage_provider_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'storage_provider_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pool_missing');
  END IF;

  _entry := _current->'providers'->_provider;
  IF _entry IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'provider_missing');
  END IF;

  IF COALESCE(_entry->'config', '{}'::jsonb) IS DISTINCT FROM COALESCE(_expected_config, '{}'::jsonb) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'config_changed');
  END IF;

  IF COALESCE(_current->>'primary', '') IS DISTINCT FROM COALESCE(_expected_primary, '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'primary_changed');
  END IF;

  _next_entry := jsonb_set(_entry, '{sync}', COALESCE(_sync, 'null'::jsonb), true);

  IF _mark_synced THEN
    _dirty_at := NULLIF(_entry->>'dirtyAt', '')::timestamptz;
    IF _dirty_at IS NOT NULL AND _walk_started_at IS NOT NULL AND _dirty_at >= _walk_started_at THEN
      RETURN jsonb_build_object('ok', false, 'error', 'replication_gap_during_walk');
    END IF;
    _next_entry := jsonb_set(_next_entry, '{syncedAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
    _next_entry := jsonb_set(_next_entry, '{syncedFrom}', to_jsonb(_expected_primary), true);
    _next_entry := jsonb_set(_next_entry, '{dirtyAt}', 'null'::jsonb, true);
    _next_entry := jsonb_set(_next_entry, '{dirtyReason}', 'null'::jsonb, true);
  END IF;

  _revision := COALESCE((_current->>'revision')::bigint, 0);
  _next := jsonb_set(_current, ARRAY['providers', _provider], _next_entry, true);
  _next := jsonb_set(_next, '{revision}', to_jsonb(_revision + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'storage_provider_pool';

  RETURN jsonb_build_object('ok', true, 'revision', _revision + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_storage_replica_dirty(_provider text, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _entry jsonb;
  _revision bigint;
  _next jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('storage_provider_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'storage_provider_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'pool_missing');
  END IF;

  _entry := _current->'providers'->_provider;
  IF _entry IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'provider_missing');
  END IF;

  _entry := jsonb_set(_entry, '{syncedAt}', 'null'::jsonb, true);
  _entry := jsonb_set(_entry, '{syncedFrom}', 'null'::jsonb, true);
  _entry := jsonb_set(_entry, '{dirtyAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
  _entry := jsonb_set(_entry, '{dirtyReason}', to_jsonb(COALESCE(_reason, 'replication_failed')), true);

  _revision := COALESCE((_current->>'revision')::bigint, 0);
  _next := jsonb_set(_current, ARRAY['providers', _provider], _entry, true);
  _next := jsonb_set(_next, '{revision}', to_jsonb(_revision + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'storage_provider_pool';

  RETURN jsonb_build_object('ok', true, 'revision', _revision + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_storage_replication_uncertain(_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _primary text;
  _name text;
  _entry jsonb;
  _revision bigint;
  _next jsonb;
  _marked int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('storage_provider_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'storage_provider_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'marked', 0);
  END IF;

  _primary := _current->>'primary';
  _next := _current;

  FOR _name IN SELECT jsonb_object_keys(COALESCE(_current->'providers', '{}'::jsonb)) LOOP
    IF _primary IS NULL OR _name <> _primary THEN
      _entry := _next->'providers'->_name;
      _entry := jsonb_set(_entry, '{syncedAt}', 'null'::jsonb, true);
      _entry := jsonb_set(_entry, '{syncedFrom}', 'null'::jsonb, true);
      _entry := jsonb_set(_entry, '{dirtyAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
      _entry := jsonb_set(_entry, '{dirtyReason}', to_jsonb(COALESCE(_reason, 'replication_unresolved')), true);
      _next := jsonb_set(_next, ARRAY['providers', _name], _entry, true);
      _marked := _marked + 1;
    END IF;
  END LOOP;

  IF _marked = 0 THEN
    RETURN jsonb_build_object('ok', true, 'marked', 0);
  END IF;

  _revision := COALESCE((_current->>'revision')::bigint, 0);
  _next := jsonb_set(_next, '{revision}', to_jsonb(_revision + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'storage_provider_pool';

  RETURN jsonb_build_object('ok', true, 'marked', _marked, 'revision', _revision + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.set_storage_provider_pool(jsonb, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_storage_replica_sync(text, jsonb, boolean, jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_storage_replica_dirty(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_storage_replication_uncertain(text) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.set_storage_provider_pool(jsonb, jsonb, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.set_storage_replica_sync(text, jsonb, boolean, jsonb, text, timestamptz) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_storage_replica_dirty(text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_storage_replication_uncertain(text) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.set_storage_provider_pool(jsonb, jsonb, bigint)') IS NULL THEN
    RAISE EXCEPTION 'storage_provider_pool_atomic: set_storage_provider_pool missing';
  END IF;
  IF to_regprocedure('public.set_storage_replica_sync(text, jsonb, boolean, jsonb, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'storage_provider_pool_atomic: set_storage_replica_sync missing';
  END IF;
  IF to_regprocedure('public.mark_storage_replica_dirty(text, text)') IS NULL THEN
    RAISE EXCEPTION 'storage_provider_pool_atomic: mark_storage_replica_dirty missing';
  END IF;
  IF to_regprocedure('public.mark_storage_replication_uncertain(text)') IS NULL THEN
    RAISE EXCEPTION 'storage_provider_pool_atomic: mark_storage_replication_uncertain missing';
  END IF;
END
$verify$;
