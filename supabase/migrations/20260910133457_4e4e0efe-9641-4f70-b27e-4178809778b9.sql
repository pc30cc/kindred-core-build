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