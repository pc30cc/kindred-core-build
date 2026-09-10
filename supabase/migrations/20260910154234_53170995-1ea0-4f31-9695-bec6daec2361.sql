ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS signup_default_plan_mode text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS signup_trial_plan_id uuid,
  ADD COLUMN IF NOT EXISTS signup_trial_days integer NOT NULL DEFAULT 14;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_signup_default_plan_mode_chk') THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_signup_default_plan_mode_chk
      CHECK (signup_default_plan_mode IN ('free', 'trial'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_signup_trial_days_chk') THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_signup_trial_days_chk
      CHECK (signup_trial_days >= 0 AND signup_trial_days <= 365);
  END IF;
END $$;