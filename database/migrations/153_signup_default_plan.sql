-- 153 — Default plan for NEW signups.
--
-- One platform-wide operator choice, stored on the `platform_settings`
-- singleton and resolved server-side by
-- server/services/billing/signupPlan.ts:
--
--   signup_default_plan_mode  'free' | 'trial'
--     free  — a new workspace gets no subscription row and falls back to the
--             free plan (historical behaviour, hence the default).
--     trial — a new workspace gets a `trialing` subscription on the plan
--             chosen below, ending after `signup_trial_days`.
--   signup_trial_plan_id  which plan the trial runs on (NULL → the cheapest
--                         active non-free plan at provisioning time).
--   signup_trial_days     trial length; 0 → fall back to the plan's own
--                         `trial_days`, then to 14.
--
-- Applies to NEW signups only: existing workspaces are never touched.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS signup_default_plan_mode text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS signup_trial_plan_id uuid,
  ADD COLUMN IF NOT EXISTS signup_trial_days integer NOT NULL DEFAULT 14;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_signup_default_plan_mode_chk'
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_signup_default_plan_mode_chk
      CHECK (signup_default_plan_mode IN ('free', 'trial'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_signup_trial_days_chk'
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_signup_trial_days_chk
      CHECK (signup_trial_days >= 0 AND signup_trial_days <= 365);
  END IF;
END $$;
