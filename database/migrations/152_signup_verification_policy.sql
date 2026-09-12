-- 152_signup_verification_policy.sql
-- Self-host mirror of the hosted migration that adds the platform-wide
-- signup verification policy to `platform_settings`.
--
--   signup_verification_method — how the verification is delivered:
--     'link' (email a verification URL — the historical behaviour) or
--     'otp'  (email a 6-digit one-time code issued by the SELF-HOSTED
--             Generic Verification Core, migration 098; no link at all).
--
--   signup_verification_gate — when verification must happen:
--     'before' (no workspace until the email is verified — historical) or
--     'after'  (the user enters their workspace immediately and the
--               existing "email not verified" banner drives verification).
--
-- Defaults reproduce today's behaviour exactly, so applying this file is a
-- no-op for an existing deployment until an operator changes the setting in
-- Super Admin → Branding → Settings.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS signup_verification_method text NOT NULL DEFAULT 'link',
  ADD COLUMN IF NOT EXISTS signup_verification_gate text NOT NULL DEFAULT 'before';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_signup_verification_method_chk'
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_signup_verification_method_chk
      CHECK (signup_verification_method IN ('link', 'otp'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_signup_verification_gate_chk'
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_signup_verification_gate_chk
      CHECK (signup_verification_gate IN ('before', 'after'));
  END IF;
END $$;

-- `platform_settings` is a platform-wide singleton. Enforce that invariant
-- in the database so concurrent admin saves cannot create two competing rows
-- whose unordered reads make settings appear to revert.
CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_singleton_idx
  ON public.platform_settings ((true));
