-- Mobile (Capacitor/iOS) session support on the EXISTING first-party
-- `public.auth_sessions` table. No new table, no new auth system: the same
-- opaque 256-bit token (stored only as a SHA-256 hash) and the same
-- revocation semantics now also back native app sessions, which travel as
-- `Authorization: Bearer <token>` instead of the `gs_session` cookie.
--
--  * client_type          — 'web' (cookie, 30-day fixed lifetime, unchanged)
--                           or 'mobile' (bearer, sliding 60-day idle window).
--  * absolute_expires_at  — hard cap for mobile sessions (365 days); NULL for
--                           web sessions, whose expires_at is already absolute.
--  * last_renewed_at      — throttles the sliding renewal to at most one write
--                           per 24h per session, keeping request validation a
--                           pure read.
--
-- No GRANTs are added: auth_sessions is service_role-only (read and written
-- exclusively by the Express backend), and this migration does not change
-- that exposure.

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
