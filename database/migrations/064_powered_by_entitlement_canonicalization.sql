-- 064 — Canonicalize the "Powered by" plan entitlement.
--
-- Two keys used to coexist:
--   * `remove_powered_by` (legacy, inverse: true => footer hidden)
--   * `widget_powered_by` (canonical: true => footer shown)
--
-- From now on `widget_powered_by` is the single plan-configurable toggle and
-- `remove_powered_by` is deprecated (kept only so historical JSON stays known).
-- Backfill the canonical key for every plan that does not define it yet,
-- deriving the value from the legacy inverse when present.
--
-- No new tables => no GRANT changes required.

UPDATE public.billing_plans
SET entitlements = entitlements || jsonb_build_object(
      'widget_powered_by',
      NOT COALESCE((entitlements->>'remove_powered_by')::boolean, false)
    )
WHERE entitlements IS NOT NULL
  AND NOT (entitlements ? 'widget_powered_by');

COMMENT ON COLUMN public.billing_plans.entitlements IS
  'Plan feature toggles. Canonical widget credit key is `widget_powered_by` (true = footer shown); `remove_powered_by` is deprecated legacy and read only as a fallback.';
