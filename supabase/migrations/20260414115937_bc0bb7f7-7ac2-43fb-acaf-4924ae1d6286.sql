
-- ============================================================
-- Persistent auth infrastructure: sessions, reset tokens, verify tokens
-- These tables are accessed ONLY by the backend server via service_role.
-- No end-user RLS policies needed.
-- ============================================================

-- 1. Auth Sessions
CREATE TABLE public.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_auth_sessions_token_hash ON public.auth_sessions (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_user_id ON public.auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_expires_at ON public.auth_sessions (expires_at);

-- 2. Auth Reset Tokens
CREATE TABLE public.auth_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);

ALTER TABLE public.auth_reset_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_auth_reset_tokens_hash ON public.auth_reset_tokens (token_hash) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_auth_reset_tokens_user_id ON public.auth_reset_tokens (user_id);

-- 3. Auth Verify Tokens
CREATE TABLE public.auth_verify_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);

ALTER TABLE public.auth_verify_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_auth_verify_tokens_hash ON public.auth_verify_tokens (token_hash) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_auth_verify_tokens_user_id ON public.auth_verify_tokens (user_id);

-- 4. Cleanup function for expired entries
CREATE OR REPLACE FUNCTION public.cleanup_expired_auth_tokens()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete expired sessions older than 1 day past expiry
  DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day';
  -- Delete expired/used reset tokens older than 1 day
  DELETE FROM auth_reset_tokens WHERE expires_at < now() - interval '1 day';
  -- Delete expired/used verify tokens older than 1 day
  DELETE FROM auth_verify_tokens WHERE expires_at < now() - interval '1 day';
END;
$$;
