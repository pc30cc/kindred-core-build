-- ============================================================
-- THE TWO REPORTING FUNCTIONS THE LIVE DATABASE WAS BEHIND ON
--
-- Hosted mirror of database/migrations/202_billing_v2_metrics_contract.sql.
-- This is the half that actually reaches the live database: applying it is
-- what stops the super-admin dunning panel rendering five blanks.
--
-- 201 took six billing functions from the live database, where it was ahead.
-- These are the other two, and they go the other way: the live versions are
-- stale and this chain has the correct ones.
--
-- The cost is visible. server/services/billing/dunning/index.ts declares what
-- /api/admin/billing-v2/dunning/metrics returns:
--
--   open_invoices, past_due_invoices, past_due_amount_irr, grace_subscriptions,
--   fallbacks_total, autopay_success, autopay_insufficient,
--   notification_backlog, notification_failures, retention_signals_pending,
--   checked_at
--
-- The live billing_v2_dunning_metrics returns five of those not at all --
-- open_invoices, past_due_amount_irr, autopay_success, autopay_insufficient
-- and notification_failures -- and returns notifications_failed,
-- grace_expired_pending and autopay_insufficient_events in their place, which
-- nothing in the codebase reads. So the super-admin dunning panel has been
-- rendering five blanks. TypeScript cannot catch it: the RPC result is cast,
-- not parsed.
--
-- billing_v2_scheduler_health is the same shape of problem, quieter: the live
-- version predates Phase E and is missing past_due_invoices,
-- notification_failures and retention_signals_pending.
--
-- WHY THIS MIGRATION EXISTS AT ALL
--
-- A fresh replay of either chain already builds these correctly -- 118 and 122
-- have them, and the hosted backfill carries them. Nothing here changes what a
-- replay produces; the md5 check at the end is exactly the assertion that it
-- does not. The file exists so the live database can receive them through the
-- migration chain instead of another hand edit, which is how the two drifted
-- apart in the first place.
--
-- Both functions are LANGUAGE sql STABLE. They read and return JSON and write
-- nothing, so replacing them cannot touch a row of financial data.
-- ============================================================

CREATE OR REPLACE FUNCTION public.billing_v2_dunning_metrics()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'open_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'open'),
    'past_due_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'past_due'),
    'past_due_amount_irr', (SELECT COALESCE(sum(amount_due_irr), 0)
                              FROM public.billing_invoices WHERE status = 'past_due'),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL),
    'fallbacks_total', (SELECT count(*) FROM public.workspace_subscriptions
                         WHERE status = 'free_fallback'),
    'autopay_success', (SELECT count(*) FROM public.billing_v2_audit
                         WHERE event = 'wallet_autopay_succeeded'),
    'autopay_insufficient', (SELECT count(*) FROM public.billing_v2_audit
                              WHERE event = 'wallet_autopay_skipped_insufficient'),
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending', 'processing')),
    'notification_failures', (SELECT count(*) FROM public.billing_notification_jobs
                               WHERE status = 'failed'),
    'retention_signals_pending', (SELECT count(*) FROM public.billing_retention_signals
                                   WHERE state = 'pending'),
    'checked_at', now()
  );
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_scheduler_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'workers', COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM public.billing_v2_worker_health h), '[]'::jsonb),
    'due_invoices', (SELECT count(*) FROM public.billing_invoices
                      WHERE status IN ('open','partially_paid','past_due')
                        AND amount_due_irr > 0 AND due_at IS NOT NULL AND due_at <= now()),
    'scheduled_periods_pending', (SELECT count(*) FROM public.billing_subscription_periods
                                   WHERE status = 'scheduled' AND period_start <= now()),
    'unapplied_active_periods', (SELECT count(*) FROM public.billing_period_allowance_grants
                                  WHERE status IN ('pending','failed')),
    'due_entitlement_cycles', (SELECT count(*) FROM public.billing_entitlement_cycles
                                WHERE status = 'scheduled' AND cycle_start <= now() AND cycle_end > now()),
    'unfunded_active_cycles', (SELECT count(*) FROM public.billing_entitlement_cycles
                                WHERE status = 'active' AND allowance_state IN ('pending','failed')),
    'failed_jobs', (SELECT count(*) FROM public.billing_v2_jobs WHERE status = 'failed'),
    -- Phase E
    'past_due_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'past_due'),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL),
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending','processing')),
    'notification_failures', (SELECT count(*) FROM public.billing_notification_jobs
                               WHERE status = 'failed'),
    'retention_signals_pending', (SELECT count(*) FROM public.billing_retention_signals
                                   WHERE state = 'pending'),
    'checked_at', now()
  );
$function$;

-- ---------- proof ----------
DO $verify$
DECLARE
  want_metrics CONSTANT text := 'c8ace253f52fef1185f2563f903889df';
  want_health  CONSTANT text := '1451ab63acc5415e656c2e0f7826137f';
  got_metrics  text;
  got_health   text;
  missing      text;
BEGIN
  -- These must come out identical to what 122 and 118 already produce.
  -- Anything else means this migration is not a no-op on a fresh replay,
  -- which is the one thing it must never be.
  SELECT md5(pg_get_functiondef(to_regprocedure('public.billing_v2_dunning_metrics()')))  INTO got_metrics;
  SELECT md5(pg_get_functiondef(to_regprocedure('public.billing_v2_scheduler_health()'))) INTO got_health;

  IF got_metrics IS DISTINCT FROM want_metrics THEN
    RAISE EXCEPTION 'billing_v2_dunning_metrics is not the chain definition (want %, got %)',
      want_metrics, COALESCE(got_metrics, 'ABSENT');
  END IF;
  IF got_health IS DISTINCT FROM want_health THEN
    RAISE EXCEPTION 'billing_v2_scheduler_health is not the chain definition (want %, got %)',
      want_health, COALESCE(got_health, 'ABSENT');
  END IF;

  -- And the contract the server declares, key by key, since that is the thing
  -- that was broken rather than the hash.
  SELECT string_agg(k, ', ' ORDER BY k) INTO missing
    FROM unnest(ARRAY['open_invoices','past_due_invoices','past_due_amount_irr',
                      'grace_subscriptions','fallbacks_total','autopay_success',
                      'autopay_insufficient','notification_backlog',
                      'notification_failures','retention_signals_pending','checked_at']) AS k
   WHERE NOT (public.billing_v2_dunning_metrics() ? k);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'dunning metrics still missing what DunningMetrics declares: %', missing;
  END IF;

  RAISE NOTICE 'both reporting functions match the chain, and dunning metrics answers every key the server declares';
END
$verify$;
