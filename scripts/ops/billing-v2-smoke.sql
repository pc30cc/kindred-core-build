-- Billing V2 production READ-ONLY smoke. Creates no data, moves no money.
-- Usage: psql "$DSN" -v ws="<workspace-uuid>" -f scripts/ops/billing-v2-smoke.sql
\set ON_ERROR_STOP on
\pset pager off

\echo == engine / rollout state ==
SELECT public.billing_v2_state(:'ws'::uuid) AS engine_state;

\echo == cutover readiness (canonical) ==
SELECT jsonb_pretty(public.billing_v2_evaluate_cutover(:'ws'::uuid)) AS readiness;

\echo == plans ==
SELECT count(*) FILTER (WHERE is_active) AS active_plans,
       count(*) FILTER (WHERE is_active AND is_free) AS active_free_plans
  FROM public.billing_plans;

\echo == invoices ==
SELECT status, count(*), COALESCE(sum(amount_due_irr), 0) AS due_irr
  FROM public.billing_invoices WHERE workspace_id = :'ws'::uuid
 GROUP BY status ORDER BY status;

\echo == wallet ==
SELECT a.workspace_id IS NOT NULL AS wallet_account,
       COALESCE(a.balance_irr, 0) AS balance_irr
  FROM public.billing_wallet_accounts a WHERE a.workspace_id = :'ws'::uuid;

\echo == subscription period ==
SELECT status, billing_interval, period_start, period_end, billing_engine_version
  FROM public.billing_subscription_periods
 WHERE workspace_id = :'ws'::uuid ORDER BY period_start DESC LIMIT 3;

\echo == AI allowance cycle ==
SELECT jsonb_pretty(public.billing_v2_current_entitlement_cycle(:'ws'::uuid)) AS current_cycle;

\echo == AI wallet / transactions ==
SELECT COALESCE((SELECT count(*) FROM public.workspace_ai_ledger WHERE workspace_id = :'ws'::uuid), 0)
       AS ai_ledger_rows,
       COALESCE((SELECT count(*) FROM public.billing_payments WHERE workspace_id = :'ws'::uuid), 0)
       AS payments;

\echo == scheduler / worker health ==
SELECT jsonb_pretty(public.billing_v2_scheduler_health()) AS scheduler_health;

\echo == dunning metrics ==
SELECT jsonb_pretty(public.billing_v2_dunning_metrics()) AS dunning_metrics;

\echo == policy validation ==
SELECT jsonb_pretty(public.billing_v2_validate_policy()) AS policy;
