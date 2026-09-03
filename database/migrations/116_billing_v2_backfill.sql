-- ============================================================
-- BILLING ENGINE V2 — 116: backfill and legacy handover.
--
-- Turns every EXISTING subscription into a V2 contract WITHOUT inventing
-- financial history: no invoice is fabricated, no payment is implied, no AI
-- allowance is granted or taken away by this migration.
--
-- What it does is give each live subscription a `legacy_migration` period that
-- describes the contract it is already on, so every V2 code path (entitlement
-- resolution, renewal scheduling, dunning) has a period to read from on day
-- one. The AI allowance deliberately stays on the legacy calendar path —
-- `v2_allowance_effective_period_id` remains NULL — until the workspace's
-- FIRST invoice-backed period activates and takes over.
--
-- Invariant this file exists to protect:
--   No workspace ends up with two allowances for the same time, and no
--   workspace ends up with none.
--
-- Re-runnable: every statement is guarded, so a partial run can be repeated.
-- ============================================================

-- ─── 1. Contract anchor for existing subscriptions ────────────────────────
UPDATE public.workspace_subscriptions
   SET billing_anchor_at = COALESCE(
         billing_anchor_at,
         current_period_start,
         created_at,
         now()
       )
 WHERE billing_anchor_at IS NULL;

-- ─── 2. One legacy_migration period per live subscription ─────────────────
--
-- `ai_allowance_irr` is 0 on purpose: this period documents the contract, it
-- does not grant. The legacy monthly grant is still the allowance authority,
-- and `billing_activate_period` retires it only when a real invoice period
-- supersedes this one.
INSERT INTO public.billing_subscription_periods (
  workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
  period_start, period_end, status, source, activated_at,
  plan_snapshot, limits_snapshot, ai_allowance_irr
)
SELECT
  s.workspace_id,
  s.id,
  s.plan_id,
  NULL,
  COALESCE(s.billing_interval, 'monthly'),
  COALESCE(s.current_period_start, s.billing_anchor_at, s.created_at, now()),
  COALESCE(
    s.current_period_end,
    COALESCE(s.current_period_start, s.billing_anchor_at, s.created_at, now())
      + CASE WHEN COALESCE(s.billing_interval, 'monthly') = 'yearly'
             THEN interval '1 year' ELSE interval '1 month' END
  ),
  'active',
  'legacy_migration',
  now(),
  COALESCE(to_jsonb(p.*), '{}'::jsonb),
  COALESCE(p.limits, '{}'::jsonb),
  0
FROM public.workspace_subscriptions s
LEFT JOIN public.billing_plans p ON p.id = s.plan_id
WHERE s.status IN ('active', 'trialing', 'past_due', 'free_fallback')
  AND NOT EXISTS (
    SELECT 1 FROM public.billing_subscription_periods bp
     WHERE bp.workspace_id = s.workspace_id
       AND bp.status = 'active'
  );

-- ─── 3. Point each subscription at its period ─────────────────────────────
UPDATE public.workspace_subscriptions s
   SET current_period_id      = bp.id,
       current_period_start   = COALESCE(s.current_period_start, bp.period_start),
       current_period_end     = COALESCE(s.current_period_end, bp.period_end),
       next_invoice_at        = COALESCE(s.next_invoice_at, bp.period_end),
       billing_engine_version = 'v2',
       updated_at             = now()
  FROM public.billing_subscription_periods bp
 WHERE bp.workspace_id = s.workspace_id
   AND bp.status = 'active'
   AND (s.current_period_id IS DISTINCT FROM bp.id OR s.billing_engine_version <> 'v2');

-- `billing_v2_effective_at` and `v2_allowance_effective_period_id` are left
-- untouched on purpose: V2 becomes the allowance authority only when a real
-- invoice-backed period activates, never merely because this migration ran.

-- ─── 4. Wallet account for every workspace that will need one ─────────────
INSERT INTO public.billing_wallet_accounts (workspace_id)
SELECT w.id FROM public.workspaces w
 WHERE NOT EXISTS (
   SELECT 1 FROM public.billing_wallet_accounts a WHERE a.workspace_id = w.id
 );

-- ─── 5. Adopt historical payments without rewriting them ──────────────────
--
-- Legacy payments have no invoice. They are marked `legacy` rather than
-- `unapplied` so the reconciliation queue — which is a real finance work list
-- — is not flooded with pre-V2 history that was already applied correctly by
-- the V1 engine.
UPDATE public.billing_payments
   SET reconciliation_state = 'legacy'
 WHERE invoice_id IS NULL
   AND reconciliation_state = 'settled'
   AND created_at < now();

-- ─── 6. Proof obligations (fail the migration, not production) ────────────
DO $$
DECLARE
  v_orphans   INTEGER;
  v_multi     INTEGER;
  v_allowance INTEGER;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM public.workspace_subscriptions s
   WHERE s.status IN ('active', 'trialing', 'past_due', 'free_fallback')
     AND s.current_period_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'backfill_incomplete: % live subscriptions without a period', v_orphans;
  END IF;

  SELECT count(*) INTO v_multi FROM (
    SELECT workspace_id FROM public.billing_subscription_periods
     WHERE status = 'active'
     GROUP BY workspace_id HAVING count(*) > 1
  ) x;
  IF v_multi > 0 THEN
    RAISE EXCEPTION 'backfill_invalid: % workspaces with more than one active period', v_multi;
  END IF;

  -- The handover invariant: nothing backfilled may have switched a workspace
  -- off the legacy allowance path.
  SELECT count(*) INTO v_allowance
    FROM public.workspace_subscriptions s
    JOIN public.billing_subscription_periods bp ON bp.id = s.v2_allowance_effective_period_id
   WHERE bp.source <> 'invoice';
  IF v_allowance > 0 THEN
    RAISE EXCEPTION 'backfill_invalid: % workspaces handed the AI allowance to a non-invoice period', v_allowance;
  END IF;
END $$;
