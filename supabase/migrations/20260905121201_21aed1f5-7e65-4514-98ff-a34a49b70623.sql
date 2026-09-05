ALTER TABLE public.auth_sessions
  ADD COLUMN IF NOT EXISTS client_type text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_renewed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_sessions_client_type_check'
  ) THEN
    ALTER TABLE public.auth_sessions
      ADD CONSTRAINT auth_sessions_client_type_check
      CHECK (client_type IN ('web', 'mobile'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_client_type_active
  ON public.auth_sessions (user_id, client_type)
  WHERE revoked_at IS NULL;