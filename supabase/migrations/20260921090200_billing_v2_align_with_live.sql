-- ============================================================
-- SIX BILLING FUNCTIONS THE LIVE DATABASE HAD MOVED PAST
--
-- Hosted mirror of database/migrations/202_billing_v2_align_with_live.sql.
-- Every body here is copied from this database's own live definitions, so
-- applying it to production is a no-op: the md5 proof at the end is the same
-- check either way.
--
-- Comparing this chain against the live hosted database function by function
-- turned up 30 with differing bodies. Hashing them with comments stripped and
-- whitespace collapsed showed 21 to be the same code formatted differently.
-- Of the 9 that really differed, one was a backfill of ours overwriting the
-- hosted chain's own newer copy (fixed where it belonged), leaving 8.
--
-- In six of those eight the live database is ahead, and the changes are
-- deliberate. This brings them here. The other two go the other way -- our
-- billing_v2_dunning_metrics and billing_v2_scheduler_health are the ones the
-- server's contract matches -- so they are untouched.
--
-- Bodies are copied from the live database exactly, and the migration proves
-- it: the block at the end compares md5(pg_get_functiondef()) of each one
-- against the hash read off production, so a transcription slip fails the
-- migration rather than shipping.
--
-- WHAT EACH ONE CHANGES
--
--   apply_free_fallback        The fallback plan is looked up and then used
--                              without checking it was found. If
--                              billing_v2_policy.fallback_plan_id points at a
--                              deleted plan, v_plan is all NULL and the
--                              function goes on to insert a service period
--                              with a NULL plan. Live raises
--                              fallback_plan_not_configured instead, and
--                              separates "not past due" from "not in grace"
--                              so the skip reason says which.
--
--   run_invoice_scheduler      The guard that stops a second renewal invoice
--                              was matching ANY unpaid invoice past its due
--                              date. A wallet top-up invoice left unpaid
--                              therefore blocked the subscription renewal,
--                              while an unpaid renewal not yet due did not
--                              block anything. Live matches on
--                              invoice_type = 'subscription_renewal' and
--                              drops the due-date test, which is the pair of
--                              fixes that guard needed.
--
--   process_due_invoice        Records wallet_autopay_succeeded, which this
--                              chain never wrote even though its own
--                              billing_v2_dunning_metrics counts that exact
--                              event -- so autopay_success could only ever
--                              report zero. Also returns why an invoice went
--                              past due (auto_pay_disabled vs
--                              insufficient_balance vs unpaid).
--
--   invoice_notification_sync  Split. It used to cancel notifications AND
--                              recover the subscription; live keeps only the
--                              cancelling and moves recovery into two
--                              triggers of its own. That is not just tidier:
--                              the old code called
--                              billing_v2_restore_subscription on every
--                              payment and inferred from its return value
--                              whether the workspace had fallen back, while
--                              invoice_paid_recovery only restores when the
--                              subscription is actually past_due, and
--                              payment_after_fallback records a late payment
--                              separately. Both new functions are created
--                              here, with their triggers.
--
--   dunning_snapshot           COALESCE on metadata before reaching into it,
--                              and the synthesised snapshot for pre-Phase-E
--                              invoices is now marked frozen = false rather
--                              than being indistinguishable from a real one.
--
--   cancel_invoice_notifications
--                              The default type list no longer includes
--                              invoice_issued: closing an invoice should not
--                              retract the message that announced it. The
--                              call in invoice_notification_sync passes its
--                              own list, so the default only affects other
--                              callers.
-- ============================================================

-- ---------- cancel_invoice_notifications ----------
CREATE OR REPLACE FUNCTION public.billing_v2_cancel_invoice_notifications(
  p_invoice_id uuid,
  p_reason text DEFAULT 'invoice_closed'::text,
  p_types text[] DEFAULT ARRAY['invoice_reminder'::text, 'invoice_due'::text, 'invoice_past_due'::text])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n INTEGER;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'canceled', lease_until = NULL,
         last_error = left(p_reason, 200), updated_at = now()
   WHERE invoice_id = p_invoice_id
     AND status IN ('pending', 'processing')
     AND notification_type = ANY (p_types);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

-- ---------- dunning_snapshot ----------
CREATE OR REPLACE FUNCTION public.billing_v2_dunning_snapshot(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv  public.billing_invoices;
  v_snap JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN NULL; END IF;
  v_snap := COALESCE(v_inv.metadata, '{}'::jsonb) -> 'dunning';
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    v_snap := public.billing_v2_policy_for(v_inv.workspace_id)
              || jsonb_build_object('frozen', false);
  END IF;
  RETURN v_snap;
END;
$function$;

-- ---------- invoice_notification_sync, now only cancelling ----------
CREATE OR REPLACE FUNCTION public.billing_v2_invoice_notification_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('paid', 'void', 'expired') THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(
      NEW.id, 'invoice_' || NEW.status,
      ARRAY['invoice_issued', 'invoice_reminder', 'invoice_due',
            'invoice_past_due', 'wallet_autopay_insufficient']);
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------- the recovery that moved out of it ----------
CREATE OR REPLACE FUNCTION public.billing_v2_invoice_paid_recovery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_status TEXT;
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    SELECT status INTO v_status FROM public.workspace_subscriptions
     WHERE workspace_id = NEW.workspace_id;
    IF v_status = 'past_due' THEN
      PERFORM public.billing_v2_restore_subscription(NEW.workspace_id);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (NEW.workspace_id, 'invoice_restored_during_grace', 'payment_settled',
              jsonb_build_object('invoice_id', NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.billing_v2_payment_after_fallback()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_status TEXT;
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    SELECT status INTO v_status FROM public.workspace_subscriptions
     WHERE workspace_id = NEW.workspace_id;
    IF v_status = 'free_fallback' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (NEW.workspace_id, 'payment_after_free_fallback', 'late_settlement',
              jsonb_build_object('invoice_id', NEW.id, 'amount_irr', NEW.amount_paid_irr));
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_billing_v2_invoice_paid_recovery ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_paid_recovery
AFTER UPDATE ON public.billing_invoices
FOR EACH ROW EXECUTE FUNCTION public.billing_v2_invoice_paid_recovery();

DROP TRIGGER IF EXISTS trg_billing_v2_payment_after_fallback ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_payment_after_fallback
AFTER UPDATE OF status ON public.billing_invoices
FOR EACH ROW EXECUTE FUNCTION public.billing_v2_payment_after_fallback();

-- ---------- apply_free_fallback ----------
CREATE OR REPLACE FUNCTION public.billing_v2_apply_free_fallback(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub      public.workspace_subscriptions;
  v_policy   JSONB;
  v_plan     public.billing_plans;
  v_plan_id  UUID;
  v_period   public.billing_subscription_periods;
  v_start    TIMESTAMPTZ;
  v_allow    BIGINT;
  v_expired  INTEGER := 0;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('skipped', 'no_subscription'); END IF;
  IF v_sub.status = 'free_fallback' THEN
    RETURN jsonb_build_object('skipped', 'already_free_fallback');
  END IF;
  IF v_sub.status <> 'past_due' THEN
    RETURN jsonb_build_object('skipped', 'not_past_due:' || v_sub.status);
  END IF;
  IF v_sub.grace_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_in_grace');
  END IF;
  IF v_sub.grace_period_ends_at > now() THEN
    RETURN jsonb_build_object('skipped', 'grace_active');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.billing_invoices
     WHERE workspace_id = p_workspace_id
       AND status IN ('open', 'partially_paid', 'past_due')
       AND amount_due_irr > 0
       AND due_at IS NOT NULL AND due_at <= now()
  ) THEN
    PERFORM public.billing_v2_restore_subscription(p_workspace_id);
    RETURN jsonb_build_object('skipped', 'nothing_unpaid');
  END IF;

  v_policy := public.billing_v2_policy_for(p_workspace_id);
  v_plan_id := NULLIF(v_policy->>'fallback_plan_id', '')::uuid;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_not_configured';
  END IF;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_not_configured';
  END IF;

  UPDATE public.billing_subscription_periods
     SET status = 'canceled', completed_at = now()
   WHERE workspace_id = p_workspace_id AND status = 'scheduled';

  v_start := now();
  v_allow := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, 'monthly',
    v_start, public.billing_v2_add_interval(v_start, 'monthly', 1), 'scheduled', 'free_fallback',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  PERFORM public.billing_activate_period(v_period.id);

  UPDATE public.billing_invoices
     SET status = 'expired', updated_at = now(),
         metadata = metadata || jsonb_build_object('expired_reason', 'nonpayment_after_grace')
   WHERE workspace_id = p_workspace_id
     AND status IN ('open', 'partially_paid', 'past_due')
     AND amount_due_irr > 0;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.workspace_subscriptions
     SET status = 'free_fallback',
         free_fallback_at = now(),
         past_due_since = NULL,
         grace_period_ends_at = NULL,
         pending_change_type = NULL,
         next_plan_id = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_retention_signals (workspace_id, state, reason, details)
  VALUES (p_workspace_id, 'pending', 'free_fallback_nonpayment',
          jsonb_build_object('subscription_id', v_sub.id, 'fallback_plan_id', v_plan_id))
  ON CONFLICT (workspace_id) DO UPDATE
    SET state = 'pending', reason = 'free_fallback_nonpayment',
        signaled_at = now(), cleared_at = NULL,
        details = EXCLUDED.details;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES
    (p_workspace_id, 'grace_expired', 'unpaid',
     jsonb_build_object('subscription_id', v_sub.id)),
    (p_workspace_id, 'subscription_free_fallback', 'grace_expired',
     jsonb_build_object('plan_id', v_plan_id, 'period_id', v_period.id)),
    (p_workspace_id, 'invoice_expired_after_nonpayment', 'grace_expired',
     jsonb_build_object('invoices_expired', v_expired));

  IF (v_policy->>'notify_on_fallback')::boolean THEN
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'subscription_free_fallback', 'email', NULL, now(),
      jsonb_build_object('plan_name', v_plan.name),
      v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'subscription_free_fallback', 'sms', NULL, now(), '{}'::jsonb,
      v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
  END IF;

  RETURN jsonb_build_object('free_fallback', true, 'plan_id', v_plan_id,
                            'period_id', v_period.id, 'invoices_expired', v_expired);
END;
$function$;

-- ---------- run_invoice_scheduler ----------
CREATE OR REPLACE FUNCTION public.billing_v2_run_invoice_scheduler(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_issued  INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.id AS sub_id, COALESCE(s.next_invoice_at, s.current_period_end) AS anchor
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status IN ('active', 'past_due')
       AND COALESCE(s.next_invoice_at, s.current_period_end) IS NOT NULL
       AND COALESCE(s.next_invoice_at, s.current_period_end)
           - make_interval(days => (public.billing_v2_policy_for(s.workspace_id)->>'invoice_lead_time_days')::int)
           <= now()
       AND NOT EXISTS (
         SELECT 1 FROM public.billing_invoices i
          WHERE i.workspace_id = s.workspace_id
            AND i.invoice_type = 'subscription_renewal'
            AND i.status IN ('open', 'partially_paid', 'past_due')
            AND i.amount_due_irr > 0)
     ORDER BY COALESCE(s.next_invoice_at, s.current_period_end)
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'renewal_invoice',
      r.sub_id::text || ':' || to_char(r.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      r.workspace_id,
      jsonb_build_object('subscription_id', r.sub_id, 'anchor', r.anchor)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('renewal_invoice', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_issue_renewal_invoice(j.workspace_id, false);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        IF split_part(v_res->>'skipped', ':', 1) IN
             ('not_yet_eligible', 'collection_active', 'period_exists', 'not_yet_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        v_issued := v_issued + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'renewal_invoice_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('renewal_invoice', v_issued + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('issued', v_issued, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$;

-- ---------- process_due_invoice ----------
CREATE OR REPLACE FUNCTION public.billing_v2_process_due_invoice(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv    public.billing_invoices;
  v_sub    public.workspace_subscriptions;
  v_policy JSONB;
  v_snap   JSONB;
  v_res    JSONB;
  v_grace  TIMESTAMPTZ;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;

  IF v_inv.status = 'paid' OR v_inv.amount_due_irr <= 0 THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_paid');
    PERFORM public.billing_v2_restore_subscription(v_inv.workspace_id);
    RETURN jsonb_build_object('skipped', 'already_paid');
  END IF;
  IF v_inv.status IN ('void', 'expired', 'refunded') THEN
    RETURN jsonb_build_object('skipped', 'not_collectible:' || v_inv.status);
  END IF;
  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  v_snap   := public.billing_v2_dunning_snapshot(v_inv.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_due', 'due_date_reached',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_due_irr', v_inv.amount_due_irr));

  IF (v_policy->>'wallet_auto_pay')::boolean THEN
    v_res := public.billing_v2_wallet_autopay_invoice(v_inv.id);
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_attempted', COALESCE(v_res->>'skipped', 'paid'),
            jsonb_build_object('invoice_id', v_inv.id));

    IF COALESCE((v_res->>'paid')::boolean, false) THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'wallet_autopay_succeeded', 'due_day',
              jsonb_build_object('invoice_id', v_inv.id));
      PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_paid');
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'payment_received', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr, 'method', 'wallet'),
        v_inv.id::text);
      PERFORM public.billing_v2_restore_subscription(v_inv.workspace_id);
      RETURN jsonb_build_object('paid', true, 'via', 'wallet');
    END IF;

    IF v_res->>'skipped' = 'collection_active' THEN
      RETURN jsonb_build_object('skipped', 'collection_active');
    END IF;
    IF v_res->>'skipped' = 'insufficient_balance' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'wallet_autopay_insufficient', 'due_day',
              jsonb_build_object('invoice_id', v_inv.id));
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'wallet_autopay_insufficient', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr),
        v_inv.id::text);
    END IF;
  END IF;

  UPDATE public.billing_invoices
     SET status = 'past_due', past_due_at = COALESCE(past_due_at, now()), updated_at = now()
   WHERE id = v_inv.id AND status IN ('open', 'partially_paid');

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  IF v_sub.id IS NOT NULL AND v_sub.status IN ('active', 'past_due') THEN
    v_grace := COALESCE(
      v_sub.grace_period_ends_at,
      now() + make_interval(days => COALESCE((v_snap->>'grace_period_days')::int,
                                             (v_policy->>'grace_period_days')::int)));
    UPDATE public.workspace_subscriptions
       SET status = 'past_due',
           past_due_since = COALESCE(past_due_since, now()),
           grace_period_ends_at = v_grace,
           updated_at = now()
     WHERE id = v_sub.id;

    IF v_sub.status <> 'past_due' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'subscription_past_due', 'grace_started',
              jsonb_build_object('subscription_id', v_sub.id, 'grace_period_ends_at', v_grace));
    END IF;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_past_due', 'unpaid_at_due',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_due_irr', v_inv.amount_due_irr));

  IF (v_policy->>'notify_on_past_due')::boolean THEN
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'email', v_inv.id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number,
                         'amount_irr', v_inv.amount_due_irr,
                         'grace_period_ends_at', v_grace),
      v_inv.id::text);
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'sms', v_inv.id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number),
      v_inv.id::text);
  END IF;

  RETURN jsonb_build_object(
    'past_due', true,
    'grace_period_ends_at', v_grace,
    'reason', CASE WHEN NOT (v_policy->>'wallet_auto_pay')::boolean THEN 'auto_pay_disabled'
                   WHEN v_res->>'skipped' = 'insufficient_balance' THEN 'insufficient_balance'
                   ELSE 'unpaid' END);
END;
$function$;

-- ---------- ACLs: the two new trigger functions ----------
-- Triggers fire as the table's owner without consulting the session user's
-- EXECUTE privilege, so taking PUBLIC away costs them nothing — and 200 and
-- the CI security script both refuse a SECURITY DEFINER function that PUBLIC
-- can call.
REVOKE ALL ON FUNCTION public.billing_v2_invoice_paid_recovery()  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_v2_payment_after_fallback() FROM PUBLIC;

-- ---------- proof: these are the live bodies, not an approximation ----------
DO $verify$
DECLARE
  expected CONSTANT jsonb := jsonb_build_object(
    'billing_v2_apply_free_fallback(uuid)',            '8b6cb54d6da275ddfc630c2775b946ad',
    'billing_v2_cancel_invoice_notifications(uuid,text,text[])',
                                                       'e75a5dd5aab9b8410337a451ec4671be',
    'billing_v2_dunning_snapshot(uuid)',               '143afc51c8e8b248b98c1579c5db3d6d',
    'billing_v2_invoice_notification_sync()',          '75757361136f006a12b0e5732a48ed20',
    'billing_v2_invoice_paid_recovery()',              'e159d2ad0b814c7c946ab3b86ffb65c3',
    'billing_v2_payment_after_fallback()',             '3a9652cd12d04cc703511e61159ff9d3',
    'billing_v2_process_due_invoice(uuid)',            'd8dab8b0460fb1458aed107c0d8e866a',
    'billing_v2_run_invoice_scheduler(integer)',       '6578fa39697ec5f5da4c6d6a293ffa93');
  sig  text;
  got  text;
  bad  text := '';
BEGIN
  FOR sig IN SELECT jsonb_object_keys(expected) LOOP
    SELECT md5(pg_get_functiondef(to_regprocedure('public.' || sig))) INTO got;
    IF got IS DISTINCT FROM (expected->>sig) THEN
      bad := bad || format('%s (want %s, got %s); ', sig, expected->>sig, COALESCE(got, 'ABSENT'));
    END IF;
  END LOOP;

  IF bad <> '' THEN
    RAISE EXCEPTION 'these are not the live definitions — %', bad;
  END IF;

  -- And the two triggers that carry the split, without which adopting the
  -- slimmer notification_sync would simply delete the recovery behaviour.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_v2_invoice_paid_recovery')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_v2_payment_after_fallback') THEN
    RAISE EXCEPTION 'the recovery triggers are missing';
  END IF;

  RAISE NOTICE 'eight billing functions now match the live database byte for byte';
END
$verify$;
