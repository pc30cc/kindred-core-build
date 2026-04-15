
-- 1. user_roles: explicit INSERT deny for non-admins (belt & suspenders)
CREATE POLICY "Non-admins cannot insert roles"
  ON user_roles FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'));

-- 2. billing_plans: restrict anon SELECT to safe columns via a view
-- First create a view with only public-safe columns
CREATE OR REPLACE VIEW public.billing_plans_public AS
  SELECT id, name, slug, description, prices, default_currency, is_free, trial_days, sort_order, limits, entitlements
  FROM billing_plans
  WHERE is_active = true;

-- Grant anon access to the view
GRANT SELECT ON public.billing_plans_public TO anon;

-- Remove direct anon access to the table
DROP POLICY IF EXISTS "Public can read active plans" ON billing_plans;
