UPDATE public.billing_plans
SET entitlements = entitlements || jsonb_build_object(
      'widget_powered_by',
      NOT COALESCE((entitlements->>'remove_powered_by')::boolean, false)
    )
WHERE entitlements IS NOT NULL
  AND NOT (entitlements ? 'widget_powered_by');

COMMENT ON COLUMN public.billing_plans.entitlements IS
  'Plan feature toggles. Canonical widget credit key is `widget_powered_by` (true = footer shown); `remove_powered_by` is deprecated legacy and read only as a fallback.';