-- 028 — Auth migration follow-up: admin user-impersonation ("login as
-- user") no longer routes through Supabase Auth's magic-link verify
-- endpoint (`${supabaseUrl}/auth/v1/verify?...&type=magiclink`) — that
-- endpoint establishes a SUPABASE session, which this app's backend no
-- longer accepts as identity. It's replaced with a first-party one-time,
-- short-lived, single-use token redeemed by a plain GET route that sets
-- the gs_session cookie directly and redirects into the app — the same
-- "browser opens a URL and ends up authenticated" UX the old flow had.
--
-- Same shape/conventions as auth_verify_tokens / auth_reset_tokens: only
-- the SHA-256 hash of the raw token is ever stored.

CREATE TABLE IF NOT EXISTS public.admin_impersonation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_impersonation_tokens_target_idx
  ON public.admin_impersonation_tokens(target_user_id);

ALTER TABLE public.admin_impersonation_tokens ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.admin_impersonation_tokens TO service_role;

DROP POLICY IF EXISTS "No direct access to impersonation tokens" ON public.admin_impersonation_tokens;
CREATE POLICY "No direct access to impersonation tokens"
  ON public.admin_impersonation_tokens FOR ALL TO anon, authenticated
  USING (false);

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'admin_impersonation_tokens'
  ) THEN
    RAISE EXCEPTION 'admin_impersonation_tokens table missing after migration';
  END IF;
END
$verify$;
