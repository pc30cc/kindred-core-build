-- Add `revoke_reason` to the existing (currently unused) auth_sessions
-- table, ahead of wiring it up as the real first-party session store (auth
-- migration Phase 7). Purely additive: nullable column, no backfill needed —
-- the table has zero rows in production today (created by
-- 20260414134600_baseline_remote_only_tables.sql, never written to by any
-- login flow). Lets session revocation record *why* (logout, logout-all,
-- password-reset invalidation, admin action, account disabled) for the
-- security-event logging in Phase 29, without a separate audit table.
--
-- Self-host counterpart: database/migrations/025_first_party_auth_tables.sql
-- creates auth_sessions with this column already included, since that table
-- doesn't exist there yet to ALTER (a separate, pre-existing gap discovered
-- while building this — see that file's own header comment).

ALTER TABLE public.auth_sessions
  ADD COLUMN IF NOT EXISTS revoke_reason text;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions' AND column_name = 'revoke_reason'
  ) THEN
    RAISE EXCEPTION 'auth_sessions.revoke_reason was not added';
  END IF;
  RAISE NOTICE 'auth_sessions.revoke_reason added';
END
$verify$;
