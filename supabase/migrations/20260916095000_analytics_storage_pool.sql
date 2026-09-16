-- 192 — Analytics storage pool: a SECOND, independent storage topology.
--
-- The platform already has one storage topology in
-- `app_runtime_config.storage_provider_pool` (migration 189): one primary
-- serving every attachment / avatar / recording / workspace file, plus
-- mirrors. Web Analytics needs its own canonical store — Parquet objects
-- under `analytics/` — and the two choices must be completely independent:
--
--   General Storage Primary   = e.g. Bunny   → workspace/, users/, platform/
--   Analytics Storage Primary = e.g. Arvan   → analytics/
--
-- Changing either one must have NO effect on the other. That independence is
-- mechanical here, not a convention: these functions touch exactly one key,
-- `analytics_storage_pool`, and never read or write `storage_provider_pool`
-- or `default_storage_provider`. There is no code path in this migration
-- through which promoting an analytics primary can move the general one.
--
-- What is shared is CREDENTIALS, not roles. This pool stores provider NAMES;
-- the endpoint/bucket/keys are resolved at use time from the general pool's
-- provider entries (server/services/analytics/pool.ts →
-- resolveAnalyticsTopology). So there is deliberately no
-- `analytics_access_key` / `analytics_secret` anywhere: an operator
-- configures Arvan once, in Providers → Storage, and both topologies use it.
--
-- Five functions, mirroring the proven semantics of 189 for a different
-- logical pool:
--
-- 1. set_analytics_storage_pool(pool, expected_revision)
--    Whole-pool compare-and-set. A settings save that read revision N cannot
--    overwrite a sync batch that has since committed N+1.
--
-- 2. set_analytics_replica_sync(...)
--    Back-fill progress for ONE replica. Guarded so a walk that started
--    under different conditions can never conclude something about the
--    present: the analytics primary must still be the one it copied FROM,
--    the replica must still be in the replica list, and no replication gap
--    may have been recorded since the walk began.
--
-- 3. mark_analytics_replica_dirty(provider, reason) /
-- 4. mark_analytics_replication_uncertain(reason)
--    Called when a mirrored analytics write fails, or when the topology
--    could not even be resolved for an object the primary already holds.
--    They clear promotion readiness without reading the pool first, so they
--    work on the flush path and on the path where the read is what failed.
--
-- 5. record_analytics_storage_write / record_analytics_storage_error
--    Counters and timestamps for the admin status panel. Deliberately
--    targeted rather than a whole-pool write: a flush happens continuously
--    and must never be able to restore a primary, replica list or setting
--    that an admin changed while it was in flight.
--
-- NON-DESTRUCTIVE: this migration creates no tables, alters no tables, and
-- drops nothing. `visitor_page_views`, `web_analytics_events`,
-- `visitor_sessions` and `web_analytics_funnels` are untouched — Phase 1
-- dual-writes, it does not cut over.

CREATE OR REPLACE FUNCTION public.set_analytics_storage_pool(
  _pool jsonb,
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
    RAISE EXCEPTION 'set_analytics_storage_pool: _pool must not be null';
  END IF;

  -- Its OWN advisory lock. Sharing 189's would serialize analytics settings
  -- against every general-storage write for no reason, and would couple two
  -- topologies whose whole point is to be independent.
  PERFORM pg_advisory_xact_lock(hashtext('analytics_storage_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'analytics_storage_pool';
  _revision := COALESCE((_current->>'revision')::bigint, 0);

  IF _expected_revision IS NOT NULL AND _expected_revision <> _revision THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revision_conflict', 'revision', _revision);
  END IF;

  _next := jsonb_set(_pool, '{revision}', to_jsonb(_revision + 1), true);

  INSERT INTO public.app_runtime_config (key, value, updated_at)
  VALUES ('analytics_storage_pool', _next, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object('ok', true, 'revision', _revision + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_analytics_replica_sync(
  _provider text,
  _sync jsonb,
  _mark_synced boolean,
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
  _state jsonb;
  _revision bigint;
  _dirty_at timestamptz;
  _next jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('analytics_storage_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'analytics_storage_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pool_missing');
  END IF;

  IF COALESCE(_current->>'primary', '') IS DISTINCT FROM COALESCE(_expected_primary, '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'primary_changed');
  END IF;

  IF NOT (COALESCE(_current->'replicas', '[]'::jsonb) ? _provider) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'replica_removed');
  END IF;

  _state := COALESCE(_current->'replicaState'->_provider, '{}'::jsonb);
  _state := jsonb_set(_state, '{sync}', COALESCE(_sync, 'null'::jsonb), true);

  IF _mark_synced THEN
    _dirty_at := NULLIF(_state->>'dirtyAt', '')::timestamptz;
    IF _dirty_at IS NOT NULL AND _walk_started_at IS NOT NULL AND _dirty_at >= _walk_started_at THEN
      RETURN jsonb_build_object('ok', false, 'error', 'replication_gap_during_walk');
    END IF;
    _state := jsonb_set(_state, '{syncedAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
    _state := jsonb_set(_state, '{syncedFrom}', to_jsonb(_expected_primary), true);
    _state := jsonb_set(_state, '{dirtyAt}', 'null'::jsonb, true);
    _state := jsonb_set(_state, '{dirtyReason}', 'null'::jsonb, true);
    _state := jsonb_set(_state, '{lastError}', 'null'::jsonb, true);
  END IF;

  _revision := COALESCE((_current->>'revision')::bigint, 0);
  _next := jsonb_set(
    jsonb_set(_current, '{replicaState}', COALESCE(_current->'replicaState', '{}'::jsonb), true),
    ARRAY['replicaState', _provider], _state, true
  );
  _next := jsonb_set(_next, '{revision}', to_jsonb(_revision + 1), true);
  _next := jsonb_set(_next, '{lastReplicationAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'analytics_storage_pool';

  RETURN jsonb_build_object('ok', true, 'revision', _revision + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_analytics_replica_dirty(_provider text, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _state jsonb;
  _revision bigint;
  _next jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('analytics_storage_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'analytics_storage_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'pool_missing');
  END IF;

  _state := COALESCE(_current->'replicaState'->_provider, '{}'::jsonb);
  _state := jsonb_set(_state, '{syncedAt}', 'null'::jsonb, true);
  _state := jsonb_set(_state, '{syncedFrom}', 'null'::jsonb, true);
  _state := jsonb_set(_state, '{dirtyAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
  _state := jsonb_set(_state, '{dirtyReason}', to_jsonb(COALESCE(_reason, 'replication_failed')), true);

  _revision := COALESCE((_current->>'revision')::bigint, 0);
  _next := jsonb_set(
    jsonb_set(_current, '{replicaState}', COALESCE(_current->'replicaState', '{}'::jsonb), true),
    ARRAY['replicaState', _provider], _state, true
  );
  _next := jsonb_set(_next, '{revision}', to_jsonb(_revision + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'analytics_storage_pool';

  RETURN jsonb_build_object('ok', true, 'revision', _revision + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_analytics_replication_uncertain(_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _name text;
  _state jsonb;
  _revision bigint;
  _next jsonb;
  _marked int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('analytics_storage_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'analytics_storage_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'marked', 0);
  END IF;

  _next := jsonb_set(_current, '{replicaState}', COALESCE(_current->'replicaState', '{}'::jsonb), true);

  FOR _name IN SELECT jsonb_array_elements_text(COALESCE(_current->'replicas', '[]'::jsonb)) LOOP
    _state := COALESCE(_next->'replicaState'->_name, '{}'::jsonb);
    _state := jsonb_set(_state, '{syncedAt}', 'null'::jsonb, true);
    _state := jsonb_set(_state, '{syncedFrom}', 'null'::jsonb, true);
    _state := jsonb_set(_state, '{dirtyAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
    _state := jsonb_set(_state, '{dirtyReason}', to_jsonb(COALESCE(_reason, 'replication_unresolved')), true);
    _next := jsonb_set(_next, ARRAY['replicaState', _name], _state, true);
    _marked := _marked + 1;
  END LOOP;

  IF _marked = 0 THEN
    RETURN jsonb_build_object('ok', true, 'marked', 0);
  END IF;

  _revision := COALESCE((_current->>'revision')::bigint, 0);
  _next := jsonb_set(_next, '{revision}', to_jsonb(_revision + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'analytics_storage_pool';

  RETURN jsonb_build_object('ok', true, 'marked', _marked, 'revision', _revision + 1);
END;
$$;

-- Counters for the admin status panel. Targeted so a continuous flush loop
-- can never write a stale topology snapshot back over an admin's change.
CREATE OR REPLACE FUNCTION public.record_analytics_storage_write(
  _objects bigint,
  _bytes bigint,
  _rows bigint,
  _replicated boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _next jsonb;
  _now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('analytics_storage_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'analytics_storage_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'pool_missing');
  END IF;

  _next := jsonb_set(_current, '{objectsWritten}',
    to_jsonb(COALESCE((_current->>'objectsWritten')::bigint, 0) + COALESCE(_objects, 0)), true);
  _next := jsonb_set(_next, '{bytesWritten}',
    to_jsonb(COALESCE((_current->>'bytesWritten')::bigint, 0) + COALESCE(_bytes, 0)), true);
  _next := jsonb_set(_next, '{rowsWritten}',
    to_jsonb(COALESCE((_current->>'rowsWritten')::bigint, 0) + COALESCE(_rows, 0)), true);
  _next := jsonb_set(_next, '{lastWriteAt}', to_jsonb(_now), true);
  IF _replicated THEN
    _next := jsonb_set(_next, '{lastReplicationAt}', to_jsonb(_now), true);
  END IF;
  -- A successful canonical write clears the last error banner; a later
  -- failure sets it again. The counters above are cumulative, the banner is
  -- current state.
  _next := jsonb_set(_next, '{lastError}', 'null'::jsonb, true);
  _next := jsonb_set(_next, '{lastErrorAt}', 'null'::jsonb, true);
  _next := jsonb_set(_next, '{revision}',
    to_jsonb(COALESCE((_current->>'revision')::bigint, 0) + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'analytics_storage_pool';

  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_analytics_storage_error(_error text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current jsonb;
  _next jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('analytics_storage_pool'));

  SELECT value INTO _current FROM public.app_runtime_config WHERE key = 'analytics_storage_pool';
  IF _current IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'pool_missing');
  END IF;

  _next := jsonb_set(_current, '{lastError}', to_jsonb(COALESCE(_error, 'unknown')), true);
  _next := jsonb_set(_next, '{lastErrorAt}',
    to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
  _next := jsonb_set(_next, '{revision}',
    to_jsonb(COALESCE((_current->>'revision')::bigint, 0) + 1), true);

  UPDATE public.app_runtime_config SET value = _next, updated_at = now()
  WHERE key = 'analytics_storage_pool';

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_analytics_storage_pool(jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_analytics_replica_sync(text, jsonb, boolean, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_analytics_replica_dirty(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_analytics_replication_uncertain(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_analytics_storage_write(bigint, bigint, bigint, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_analytics_storage_error(text) FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.set_analytics_storage_pool(jsonb, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.set_analytics_replica_sync(text, jsonb, boolean, text, timestamptz) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_analytics_replica_dirty(text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_analytics_replication_uncertain(text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.record_analytics_storage_write(bigint, bigint, bigint, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION public.record_analytics_storage_error(text) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.set_analytics_storage_pool(jsonb, bigint)') IS NULL THEN
    RAISE EXCEPTION 'analytics_storage_pool: set_analytics_storage_pool missing';
  END IF;
  IF to_regprocedure('public.set_analytics_replica_sync(text, jsonb, boolean, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'analytics_storage_pool: set_analytics_replica_sync missing';
  END IF;
  IF to_regprocedure('public.mark_analytics_replica_dirty(text, text)') IS NULL THEN
    RAISE EXCEPTION 'analytics_storage_pool: mark_analytics_replica_dirty missing';
  END IF;
  IF to_regprocedure('public.mark_analytics_replication_uncertain(text)') IS NULL THEN
    RAISE EXCEPTION 'analytics_storage_pool: mark_analytics_replication_uncertain missing';
  END IF;
  IF to_regprocedure('public.record_analytics_storage_write(bigint, bigint, bigint, boolean)') IS NULL THEN
    RAISE EXCEPTION 'analytics_storage_pool: record_analytics_storage_write missing';
  END IF;
  IF to_regprocedure('public.record_analytics_storage_error(text)') IS NULL THEN
    RAISE EXCEPTION 'analytics_storage_pool: record_analytics_storage_error missing';
  END IF;
END
$verify$;
