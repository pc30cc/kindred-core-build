-- 189 — Storage provider pool: one transactional writer for the pool and
-- the legacy primary pointer.
--
-- The platform can hold credentials for several storage vendors at once
-- (server/services/storage/pool.ts). Two runtime-config keys describe that
-- state and MUST agree:
--
--   app_runtime_config.storage_provider_pool      — every vendor, which is
--                                                   primary, replication flags
--   app_runtime_config.default_storage_provider   — the legacy pointer every
--                                                   existing resolver reads
--                                                   (resolveStorageConfig and
--                                                   friends)
--
-- Writing them as two independent statements from the application leaves a
-- window — and, if the second write fails, a COMMITTED split brain — where
-- the admin screen shows one primary while every upload goes to another.
-- That is not a cosmetic inconsistency: the pointer decides where bytes
-- physically land, and the pool decides which vendors deletion walks.
--
-- set_storage_provider_pool() writes both inside one function body, so
-- either both land or neither does. The application no longer has a
-- non-atomic path: pool.ts calls this function only.
--
-- A NULL `_default` means "the pool has no primary" (the last vendor was
-- removed) and DELETES the legacy pointer, rather than leaving it pointing
-- at a vendor that is no longer configured.

CREATE OR REPLACE FUNCTION public.set_storage_provider_pool(_pool jsonb, _default jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _pool IS NULL THEN
    RAISE EXCEPTION 'set_storage_provider_pool: _pool must not be null';
  END IF;

  INSERT INTO public.app_runtime_config (key, value, updated_at)
  VALUES ('storage_provider_pool', _pool, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  IF _default IS NULL THEN
    DELETE FROM public.app_runtime_config WHERE key = 'default_storage_provider';
  ELSE
    INSERT INTO public.app_runtime_config (key, value, updated_at)
    VALUES ('default_storage_provider', _default, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_storage_provider_pool(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.set_storage_provider_pool(jsonb, jsonb) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.set_storage_provider_pool(jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION '189_storage_provider_pool_atomic: set_storage_provider_pool missing';
  END IF;
END
$verify$;
