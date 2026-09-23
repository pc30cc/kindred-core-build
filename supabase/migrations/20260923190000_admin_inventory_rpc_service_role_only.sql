-- 210_admin_inventory_rpc_service_role_only.sql
--
-- admin_database_inventory (166) and admin_export_column_meta (168) are
-- SECURITY DEFINER and authorise on a caller-supplied _actor_user_id, so any
-- role that can EXECUTE them could pass an admin's id and read the schema,
-- every table's row count and column layout straight through PostgREST. 166
-- granted EXECUTE to authenticated, and the default PUBLIC grant left anon
-- able to call it too. The only caller is the Express backend
-- (server/services/database/inventoryCompare.ts and sqlDump.ts) through
-- service_role, so EXECUTE now belongs to service_role alone.
--
-- Forward-only and re-runnable: REVOKE / GRANT only.

REVOKE ALL ON FUNCTION public.admin_database_inventory(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_export_column_meta(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.admin_database_inventory(uuid) FROM anon;
    REVOKE ALL ON FUNCTION public.admin_export_column_meta(uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.admin_database_inventory(uuid) FROM authenticated;
    REVOKE ALL ON FUNCTION public.admin_export_column_meta(uuid) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.admin_database_inventory(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.admin_export_column_meta(uuid) TO service_role;
  END IF;
END $$;
