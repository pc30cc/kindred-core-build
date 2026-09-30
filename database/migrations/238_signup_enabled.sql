-- 238 — Public self-signup on/off switch.
--
-- One platform-wide operator choice on the `platform_settings` singleton,
-- edited in Super Admin → Core settings → Signup and resolved server-side by
-- server/services/auth/signupPolicy.ts:
--
--   signup_enabled  true  — anyone may create an account at /auth/signup
--                           (historical behaviour, hence the default).
--                   false — POST /api/auth/signup refuses every request.
--                           Existing users still sign in, and workspace
--                           invitations (accept-new) still create accounts.
--
-- The default reproduces today's behaviour, so applying this file is a no-op
-- until an operator flips the switch.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS signup_enabled boolean NOT NULL DEFAULT true;
