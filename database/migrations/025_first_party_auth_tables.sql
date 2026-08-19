-- 025 — SELF-HOST ONLY: create auth_sessions / auth_reset_tokens /
-- auth_verify_tokens, which the hosted chain already has
-- (supabase/migrations/20260414134600_baseline_remote_only_tables.sql) but
-- database/migrations never received. Discovered while wiring up
-- auth_sessions for real login sessions (auth migration Phase 7): applying
-- this chain against a real Postgres for the first time showed these three
-- tables simply don't exist on a fresh self-host bootstrap, even though
-- SELF_HOST_GUIDE.md documents "fully self-hosted custom token system" for
-- email verification and password reset. This is why the migration is NOT a
-- byte-identical hosted/self-host pair (unlike 022-024): the hosted chain
-- only needs an ADD COLUMN (its own separate file), self-host needs the full
-- CREATE TABLE. Definitions ported verbatim from the hosted chain's baseline
-- + its follow-up lockdown migration (20260415082424_...sql), with
-- `revoke_reason` added directly into the auth_sessions definition here
-- since this table doesn't exist yet to ALTER.

CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON public.auth_sessions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON public.auth_sessions USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON public.auth_sessions USING btree (token_hash) WHERE (revoked_at IS NULL);
GRANT ALL ON public.auth_sessions TO anon;
GRANT ALL ON public.auth_sessions TO authenticated;
GRANT ALL ON public.auth_sessions TO service_role;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No direct access to auth sessions" ON public.auth_sessions;
CREATE POLICY "No direct access to auth sessions"
  ON auth_sessions FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.auth_reset_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_auth_reset_tokens_user_id ON public.auth_reset_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_reset_tokens_hash ON public.auth_reset_tokens USING btree (token_hash) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));
GRANT ALL ON public.auth_reset_tokens TO anon;
GRANT ALL ON public.auth_reset_tokens TO authenticated;
GRANT ALL ON public.auth_reset_tokens TO service_role;
ALTER TABLE public.auth_reset_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No direct access to reset tokens" ON public.auth_reset_tokens;
CREATE POLICY "No direct access to reset tokens"
  ON auth_reset_tokens FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.auth_verify_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_auth_verify_tokens_user_id ON public.auth_verify_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_verify_tokens_hash ON public.auth_verify_tokens USING btree (token_hash) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));
GRANT ALL ON public.auth_verify_tokens TO anon;
GRANT ALL ON public.auth_verify_tokens TO authenticated;
GRANT ALL ON public.auth_verify_tokens TO service_role;
ALTER TABLE public.auth_verify_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No direct access to verify tokens" ON public.auth_verify_tokens;
CREATE POLICY "No direct access to verify tokens"
  ON auth_verify_tokens FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auth_sessions', 'auth_reset_tokens', 'auth_verify_tokens'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '025: % was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '025: RLS not enabled on %', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') IS NOT true THEN
      RAISE EXCEPTION '025: anon lacks expected table-level GRANT on % (RLS would be unreachable/moot)', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions' AND column_name = 'revoke_reason'
  ) THEN
    RAISE EXCEPTION '025: auth_sessions.revoke_reason missing';
  END IF;

  RAISE NOTICE '025: auth_sessions/auth_reset_tokens/auth_verify_tokens created, RLS-locked to service_role only';
END
$verify$;
