-- ============================================================
-- Baseline restoration: public.cleanup_expired_auth_tokens()
--
-- This SECURITY DEFINER maintenance routine exists in the linked hosted
-- Supabase project (pg_proc), but no migration in the clean chain ever
-- created it, so a fresh `supabase db reset` reached the historical ACL
-- migration 20260731160434 and failed with SQLSTATE 42883.
--
-- The definition below is the EXACT hosted definition (pg_get_functiondef):
-- same signature, RETURNS void, LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER,
-- search_path = public, identical body. Owner expectation: postgres (the
-- migration role). Grants are asserted by the later ACL migrations
-- (service_role only) — no grant is issued here.
--
-- Migration-history reconciliation for the already-provisioned hosted project:
-- the function is already present there, and `CREATE OR REPLACE` is byte-identical,
-- so re-applying this file is a no-op. Record it with
-- `supabase migration repair --status applied 20260414134700` if the hosted
-- history is being realigned instead of reset.
--
-- Depends on public.auth_sessions / auth_reset_tokens / auth_verify_tokens,
-- created by 20260414134600_baseline_remote_only_tables.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_auth_tokens()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cleanup_expired_auth_tokens$
BEGIN
  -- Delete expired sessions older than 1 day past expiry
  DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day';
  -- Delete expired/used reset tokens older than 1 day
  DELETE FROM auth_reset_tokens WHERE expires_at < now() - interval '1 day';
  -- Delete expired/used verify tokens older than 1 day
  DELETE FROM auth_verify_tokens WHERE expires_at < now() - interval '1 day';
END;
$cleanup_expired_auth_tokens$;
