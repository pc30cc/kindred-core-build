-- Signup defaults have exactly two choices: the existing Trial plan or Free.
-- Trial duration is always read from billing_plans.trial_days.
ALTER TABLE public.platform_settings
  DROP COLUMN IF EXISTS signup_trial_plan_id,
  DROP COLUMN IF EXISTS signup_trial_days;