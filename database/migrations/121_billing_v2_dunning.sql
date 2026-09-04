-- ============================================================================
-- BILLING ENGINE V2 — PHASE E: DUNNING, GRACE, FREE FALLBACK, NOTIFICATIONS.
--
-- Migrations 113–120 are FROZEN. Everything here is additive.
--
-- The lifecycle this migration owns, end to end and without a human in the
-- loop:
--
--   renewal invoice issued (open)
--        └─ reminders scheduled from a FROZEN policy snapshot
--   due_at reached
--        └─ recheck → wallet auto-pay → paid?  yes → restore, cancel reminders
--                                        no  → invoice past_due
--                                              subscription past_due
--                                              grace_period_ends_at set
--   grace expires (DB now() is the only clock)
--        └─ final recheck → still unpaid → FREE FALLBACK
--                                          unpaid invoice → expired
--                                          retention CASE recorded (no purge)
--
-- Non-goals of this phase, deliberately absent: any DELETE, any storage or
-- operator or article purge, any customer-facing retention date. Phase F owns
-- data lifecycle; this migration only records the durable signal it will read.
--
-- Money safety: notifications are best-effort and NEVER participate in a money
-- transaction — a failed SMS cannot roll back a settlement or a fallback.
-- ============================================================================

-- ─── 1. Policy: the dunning contract (platform default + workspace override) ─
ALTER TABLE public.billing_v2_policy
  ADD COLUMN IF NOT EXISTS reminder_days_before_due   INTEGER[] NOT NULL DEFAULT ARRAY[5, 1],
  ADD COLUMN IF NOT EXISTS send_invoice_issued_email  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS send_invoice_issued_sms    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_on_due              BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_past_due         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_fallback         BOOLEAN NOT NULL DEFAULT true,
  -- Grace and fallback are SUPER-ADMIN ONLY. There is deliberately no
  -- workspace override column for either: a workspace cannot extend its own
  -- grace period or choose where it lands.
  ADD COLUMN IF NOT EXISTS grace_period_days          INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS fallback_plan_id           UUID REFERENCES public.billing_plans(id),
  ADD COLUMN IF NOT EXISTS notification_max_attempts  INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS notification_retry_minutes INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS notification_daily_cap     INTEGER NOT NULL DEFAULT 6;

ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_dunning_sane;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_dunning_sane CHECK (
  grace_period_days BETWEEN 0 AND 30
  AND notification_max_attempts BETWEEN 1 AND 20
  AND notification_retry_minutes BETWEEN 1 AND 720
  AND notification_daily_cap BETWEEN 1 AND 50
  AND array_length(reminder_days_before_due, 1) IS NOT NULL
  AND array_length(reminder_days_before_due, 1) <= 6
);

INSERT INTO public.billing_v2_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.billing_v2_workspace_policy
  ADD COLUMN IF NOT EXISTS reminder_days_before_due  INTEGER[],
  ADD COLUMN IF NOT EXISTS send_invoice_issued_sms   BOOLEAN,
  ADD COLUMN IF NOT EXISTS notifications_enabled     BOOLEAN;

/**
 * Effective policy, now dunning-aware.
 * Order: workspace override → wallet preference → platform default.
 * grace_period_days and fallback_plan_id come from the platform row ONLY.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_policy_for(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pol public.billing_v2_policy;
  v_ws  public.billing_v2_workspace_policy;
  v_wal BOOLEAN;
BEGIN
  SELECT * INTO v_pol FROM public.billing_v2_policy WHERE id;
  SELECT * INTO v_ws FROM public.billing_v2_workspace_policy WHERE workspace_id = p_workspace_id;
  SELECT auto_pay_enabled INTO v_wal FROM public.billing_wallet_accounts
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'invoice_lead_time_days',
      COALESCE(v_ws.invoice_lead_time_days, v_pol.invoice_lead_time_days, 10),
    'invoice_due_offset_days', COALESCE(v_pol.invoice_due_offset_days, 0),
    'wallet_auto_pay',
      COALESCE(v_ws.wallet_auto_pay_enabled, v_wal, v_pol.wallet_auto_pay_default, true),
    'collection_ttl_seconds', COALESCE(v_pol.collection_ttl_seconds, 300),
    'reminder_days_before_due',
      to_jsonb(COALESCE(v_ws.reminder_days_before_due, v_pol.reminder_days_before_due, ARRAY[5, 1])),
    'send_invoice_issued_email', COALESCE(v_pol.send_invoice_issued_email, true),
    'send_invoice_issued_sms',
      COALESCE(v_ws.send_invoice_issued_sms, v_pol.send_invoice_issued_sms, false),
    'notifications_enabled', COALESCE(v_ws.notifications_enabled, true),
    'notify_on_due', COALESCE(v_pol.notify_on_due, true),
    'notify_on_past_due', COALESCE(v_pol.notify_on_past_due, true),
    'notify_on_fallback', COALESCE(v_pol.notify_on_fallback, true),
    'grace_period_days', COALESCE(v_pol.grace_period_days, 3),
    'fallback_plan_id', v_pol.fallback_plan_id,
    'notification_max_attempts', COALESCE(v_pol.notification_max_attempts, 5),
    'notification_retry_minutes', COALESCE(v_pol.notification_retry_minutes, 15),
    'notification_daily_cap', COALESCE(v_pol.notification_daily_cap, 6)
  );
END;
$$;

-- ─── 2. Durable, idempotent notification queue ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_notification_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  invoice_id        UUID REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES public.workspace_subscriptions(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  channel           TEXT NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  lease_until       TIMESTAMPTZ,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   TEXT NOT NULL,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_notification_jobs_channel_check CHECK (channel IN ('email', 'sms')),
  CONSTRAINT billing_notification_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'canceled', 'skipped')),
  CONSTRAINT billing_notification_jobs_type_check CHECK (notification_type IN (
    'invoice_issued', 'invoice_reminder', 'invoice_due',
    'wallet_autopay_insufficient', 'invoice_past_due',
    'payment_succeeded', 'subscription_restored', 'free_fallback'
  ))
);

-- The single anti-duplicate authority: one message per (invoice, moment,
-- channel), enforced by the database, not by the scheduler.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_notification_jobs_key
  ON public.billing_notification_jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS ix_billing_notification_jobs_claimable
  ON public.billing_notification_jobs (next_attempt_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS ix_billing_notification_jobs_invoice
  ON public.billing_notification_jobs (invoice_id, status);

GRANT ALL ON public.billing_notification_jobs TO service_role;
ALTER TABLE public.billing_notification_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_notification_jobs_service_only ON public.billing_notification_jobs;
CREATE POLICY billing_notification_jobs_service_only ON public.billing_notification_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_notification_jobs IS
  'Durable customer billing notifications. idempotency_key is UNIQUE: a scheduler replay produces the same row, never a second message.';

-- ─── 3. Retention signal for Phase F (SIGNAL ONLY — never a purge) ──────────
CREATE TABLE IF NOT EXISTS public.billing_retention_cases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id  UUID REFERENCES public.workspace_subscriptions(id) ON DELETE SET NULL,
  reason           TEXT NOT NULL DEFAULT 'free_fallback',
  status           TEXT NOT NULL DEFAULT 'open',
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT billing_retention_cases_status_check CHECK (status IN ('open', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_retention_cases_open
  ON public.billing_retention_cases (workspace_id) WHERE status = 'open';

GRANT ALL ON public.billing_retention_cases TO service_role;
ALTER TABLE public.billing_retention_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_retention_cases_service_only ON public.billing_retention_cases;
CREATE POLICY billing_retention_cases_service_only ON public.billing_retention_cases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_retention_cases IS
  'Phase E writes it, Phase F reads it. Recording a case NEVER deletes anything.';

-- ─── 4. Policy snapshot frozen onto the documents it governs ────────────────
ALTER TABLE public.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS dunning_snapshot JSONB;

/**
 * Returns the dunning contract for an invoice, freezing it into the invoice's
 * metadata the first time it is asked for. A later Super Admin policy change
 * can shorten nobody's grace period retroactively.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_dunning_snapshot(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv  public.billing_invoices;
  v_snap JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id; END IF;

  v_snap := v_inv.metadata->'dunning';
  IF v_snap IS NOT NULL AND jsonb_typeof(v_snap) = 'object' THEN
    RETURN v_snap;
  END IF;

  v_snap := public.billing_v2_policy_for(v_inv.workspace_id)
            || jsonb_build_object('frozen_at', now());

  UPDATE public.billing_invoices
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('dunning', v_snap)
   WHERE id = p_invoice_id;

  RETURN v_snap;
END;
$$;

-- ─── 5. Canonical recipient resolution ──────────────────────────────────────
/**
 * owner → billing contact → any workspace admin. Written defensively against
 * column drift because this must never be the reason a lifecycle step fails:
 * a missing address produces `skipped_no_recipient`, not an exception.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_billing_recipient(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner  UUID;
  v_email  TEXT;
  v_phone  TEXT;
  v_locale TEXT;
BEGIN
  IF to_regclass('public.workspaces') IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='workspaces' AND column_name='owner_id') THEN
    EXECUTE 'SELECT owner_id FROM public.workspaces WHERE id = $1'
      INTO v_owner USING p_workspace_id;
  END IF;

  IF v_owner IS NULL AND to_regclass('public.workspace_members') IS NOT NULL THEN
    EXECUTE $q$
      SELECT user_id FROM public.workspace_members
       WHERE workspace_id = $1 AND role IN ('owner','admin')
       ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at
       LIMIT 1
    $q$ INTO v_owner USING p_workspace_id;
  END IF;

  IF v_owner IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE 'SELECT email, phone FROM public.profiles WHERE id = $1'
      INTO v_email, v_phone USING v_owner;
  END IF;

  IF to_regclass('public.workspaces') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='workspaces' AND column_name='locale') THEN
    EXECUTE 'SELECT locale FROM public.workspaces WHERE id = $1' INTO v_locale USING p_workspace_id;
  END IF;

  RETURN jsonb_build_object(
    'profile_id', v_owner,
    'email', NULLIF(btrim(COALESCE(v_email, '')), ''),
    'phone', NULLIF(btrim(COALESCE(v_phone, '')), ''),
    'locale', COALESCE(NULLIF(v_locale, ''), 'fa')
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('profile_id', NULL, 'email', NULL, 'phone', NULL, 'locale', 'fa');
END;
$$;

-- ─── 6. Notification enqueue / cancel / claim ───────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_enqueue_notification(
  p_workspace_id UUID,
  p_type         TEXT,
  p_channel      TEXT,
  p_key          TEXT,
  p_invoice_id   UUID DEFAULT NULL,
  p_subscription_id UUID DEFAULT NULL,
  p_scheduled_at TIMESTAMPTZ DEFAULT now(),
  p_payload      JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id  UUID;
  v_pol JSONB;
BEGIN
  v_pol := public.billing_v2_policy_for(p_workspace_id);
  IF NOT COALESCE((v_pol->>'notifications_enabled')::boolean, true) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.billing_notification_jobs (
    workspace_id, invoice_id, subscription_id, notification_type, channel,
    scheduled_at, next_attempt_at, max_attempts, payload, idempotency_key
  ) VALUES (
    p_workspace_id, p_invoice_id, p_subscription_id, p_type, p_channel,
    COALESCE(p_scheduled_at, now()), COALESCE(p_scheduled_at, now()),
    COALESCE((v_pol->>'notification_max_attempts')::int, 5),
    COALESCE(p_payload, '{}'::jsonb), p_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

/** Cancels work that reality has overtaken (paid, void, expired, reissued). */
CREATE OR REPLACE FUNCTION public.billing_v2_cancel_invoice_notifications(
  p_invoice_id UUID,
  p_reason     TEXT DEFAULT 'obsolete',
  p_types      TEXT[] DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'canceled', lease_until = NULL,
         last_error = left(p_reason, 200), updated_at = now()
   WHERE invoice_id = p_invoice_id
     AND status IN ('pending', 'processing')
     AND (p_types IS NULL OR notification_type = ANY (p_types));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_claim_notification_jobs(
  p_limit         INTEGER DEFAULT 25,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.billing_notification_jobs
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_notification_jobs j
     SET status = 'processing',
         attempt_count = j.attempt_count + 1,
         lease_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 30)),
         updated_at = now()
   WHERE j.id IN (
     SELECT c.id FROM public.billing_notification_jobs c
      WHERE c.status IN ('pending', 'processing')
        AND c.next_attempt_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until <= now())
      ORDER BY c.next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(COALESCE(p_limit, 25), 1)
   )
  RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_complete_notification_job(
  p_job_id UUID,
  p_detail JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_job public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'sent', sent_at = now(), lease_until = NULL, last_error = NULL,
         payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('delivery', COALESCE(p_detail, '{}'::jsonb)),
         updated_at = now()
   WHERE id = p_job_id
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_job.workspace_id, 'billing_notification_sent', v_job.notification_type,
            jsonb_build_object('job_id', v_job.id, 'channel', v_job.channel,
                               'invoice_id', v_job.invoice_id));
  END IF;
END;
$$;

/** A recipient we do not have is not a failure — it is a recorded skip. */
CREATE OR REPLACE FUNCTION public.billing_v2_skip_notification_job(
  p_job_id UUID,
  p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_job public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'skipped', lease_until = NULL, last_error = left(p_reason, 200), updated_at = now()
   WHERE id = p_job_id
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_job.workspace_id, 'billing_notification_skipped', left(p_reason, 200),
            jsonb_build_object('job_id', v_job.id, 'channel', v_job.channel,
                               'type', v_job.notification_type, 'invoice_id', v_job.invoice_id));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_fail_notification_job(
  p_job_id UUID,
  p_error  TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.billing_notification_jobs;
  v_pol JSONB;
  v_back INTEGER;
BEGIN
  SELECT * INTO v_job FROM public.billing_notification_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RETURN; END IF;

  v_pol := public.billing_v2_policy_for(v_job.workspace_id);
  v_back := COALESCE((v_pol->>'notification_retry_minutes')::int, 15);

  UPDATE public.billing_notification_jobs
     SET status = CASE WHEN v_job.attempt_count >= v_job.max_attempts THEN 'failed' ELSE 'pending' END,
         lease_until = NULL,
         last_error = left(COALESCE(p_error, 'unknown'), 500),
         next_attempt_at = now() + LEAST(
           make_interval(mins => v_back * GREATEST(v_job.attempt_count, 1)),
           interval '6 hours'
         ),
         updated_at = now()
   WHERE id = p_job_id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_job.workspace_id, 'billing_notification_failed', left(COALESCE(p_error, 'unknown'), 200),
          jsonb_build_object('job_id', v_job.id, 'channel', v_job.channel,
                             'type', v_job.notification_type, 'attempt', v_job.attempt_count));
END;
$$;

-- ─── 7. Reminder scheduling from the frozen snapshot ────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_schedule_invoice_notifications(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv   public.billing_invoices;
  v_snap  JSONB;
  v_days  INTEGER;
  v_at    TIMESTAMPTZ;
  v_sched INTEGER := 0;
  v_obs   INTEGER := 0;
  v_day   JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid') THEN
    RETURN jsonb_build_object('skipped', 'not_schedulable:' || v_inv.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_v2_rollout
                  WHERE workspace_id = v_inv.workspace_id AND state = 'v2_active') THEN
    RETURN jsonb_build_object('skipped', 'not_v2_active');
  END IF;

  v_snap := public.billing_v2_dunning_snapshot(v_inv.id);

  IF COALESCE((v_snap->>'send_invoice_issued_email')::boolean, true) THEN
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_issued', 'email',
      'invoice:' || v_inv.id::text || ':issued:email',
      v_inv.id, v_inv.subscription_id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number,
                         'amount_irr', v_inv.total_irr, 'due_at', v_inv.due_at));
  END IF;
  IF COALESCE((v_snap->>'send_invoice_issued_sms')::boolean, false) THEN
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_issued', 'sms',
      'invoice:' || v_inv.id::text || ':issued:sms',
      v_inv.id, v_inv.subscription_id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number, 'due_at', v_inv.due_at));
  END IF;

  IF v_inv.due_at IS NOT NULL THEN
    FOR v_day IN SELECT jsonb_array_elements(COALESCE(v_snap->'reminder_days_before_due', '[5,1]'::jsonb))
    LOOP
      v_days := (v_day #>> '{}')::int;
      v_at := v_inv.due_at - make_interval(days => v_days);
      -- Catch-up must not flood: a reminder whose moment has passed is
      -- recorded as obsolete, never sent late.
      IF v_at <= now() THEN
        v_obs := v_obs + 1;
        CONTINUE;
      END IF;
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'invoice_reminder', 'email',
        'invoice:' || v_inv.id::text || ':reminder_' || v_days || 'd:email',
        v_inv.id, v_inv.subscription_id, v_at,
        jsonb_build_object('days_before_due', v_days, 'invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr, 'due_at', v_inv.due_at));
      v_sched := v_sched + 1;
    END LOOP;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_reminders_scheduled', 'issue',
          jsonb_build_object('invoice_id', v_inv.id, 'scheduled', v_sched, 'obsolete', v_obs));

  RETURN jsonb_build_object('scheduled', v_sched, 'obsolete', v_obs);
END;
$$;

-- ─── 8. Restore path — payment anywhere in the lifecycle ────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_restore_after_payment(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv public.billing_invoices;
  v_sub public.workspace_subscriptions;
  v_restored BOOLEAN := false;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL OR v_inv.status <> 'paid' THEN
    RETURN jsonb_build_object('skipped', 'not_paid');
  END IF;

  PERFORM public.billing_v2_cancel_invoice_notifications(
    v_inv.id, 'invoice_paid', ARRAY['invoice_reminder', 'invoice_due', 'invoice_past_due',
                                    'wallet_autopay_insufficient']);

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  IF v_sub.workspace_id IS NOT NULL
     AND v_sub.status = 'past_due'
     AND v_sub.free_fallback_at IS NULL THEN
    UPDATE public.workspace_subscriptions
       SET status = 'active', past_due_since = NULL, grace_period_ends_at = NULL, updated_at = now()
     WHERE workspace_id = v_inv.workspace_id;
    v_restored := true;

    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'invoice_restored_during_grace', 'payment',
            jsonb_build_object('invoice_id', v_inv.id));
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'subscription_restored', 'payment',
            jsonb_build_object('invoice_id', v_inv.id));
  ELSIF v_sub.free_fallback_at IS NOT NULL THEN
    -- A payment landing after fallback NEVER silently revives the old plan.
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'payment_after_free_fallback', 'no_auto_revive',
            jsonb_build_object('invoice_id', v_inv.id, 'fallback_at', v_sub.free_fallback_at));
  END IF;

  PERFORM public.billing_v2_enqueue_notification(
    v_inv.workspace_id, 'payment_succeeded', 'email',
    'invoice:' || v_inv.id::text || ':paid:email',
    v_inv.id, v_inv.subscription_id, now(),
    jsonb_build_object('invoice_number', v_inv.invoice_number, 'amount_irr', v_inv.total_irr));

  RETURN jsonb_build_object('restored', v_restored);
END;
$$;

/**
 * Lifecycle reaction to an invoice status change. Deliberately AFTER the row
 * is written: the money decision is already committed, and nothing here can
 * roll it back.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_invoice_dunning_reaction()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NULL; END IF;

  IF NEW.status IN ('open') AND OLD.status = 'draft' THEN
    PERFORM public.billing_v2_schedule_invoice_notifications(NEW.id);
  ELSIF NEW.status = 'paid' THEN
    PERFORM public.billing_v2_restore_after_payment(NEW.id);
  ELSIF NEW.status IN ('void', 'expired', 'refunded') THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(NEW.id, 'invoice_' || NEW.status);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_invoice_dunning ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_dunning
  AFTER UPDATE OF status ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_invoice_dunning_reaction();

-- ─── 9. Due-day processing (ORDER IS THE CONTRACT) ──────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_process_invoice_due(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv    public.billing_invoices;
  v_snap   JSONB;
  v_sub    public.workspace_subscriptions;
  v_pay    JSONB;
  v_reason TEXT;
  v_grace  TIMESTAMPTZ;
BEGIN
  -- 1. Lock and recheck: the invoice may have been paid a millisecond ago.
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;

  IF v_inv.status IN ('paid', 'void', 'expired', 'refunded') THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_' || v_inv.status);
    RETURN jsonb_build_object('skipped', 'terminal:' || v_inv.status);
  END IF;
  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  -- A live gateway collection means the customer is mid-payment right now:
  -- we neither assume success nor start the grace clock against them.
  PERFORM public.billing_expire_stale_collections(v_inv.id);
  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  v_snap := public.billing_v2_dunning_snapshot(v_inv.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_due', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'due_at', v_inv.due_at,
                             'amount_due_irr', v_inv.amount_due_irr));

  -- 2. Wallet auto-pay: full payment or nothing.
  IF COALESCE((v_snap->>'wallet_auto_pay')::boolean, true) AND v_inv.amount_due_irr > 0 THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_attempted', 'due_day',
            jsonb_build_object('invoice_id', v_inv.id));
    BEGIN
      v_pay := public.billing_v2_wallet_autopay_invoice(v_inv.id);
    EXCEPTION WHEN OTHERS THEN
      v_pay := jsonb_build_object('skipped', 'autopay_error');
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'wallet_autopay_failed', left(SQLERRM, 200),
              jsonb_build_object('invoice_id', v_inv.id));
    END;
    v_reason := v_pay->>'skipped';
    IF v_reason = 'insufficient_balance' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'wallet_autopay_insufficient', 'due_day',
              jsonb_build_object('invoice_id', v_inv.id));
    END IF;
  ELSE
    v_reason := 'auto_pay_disabled';
  END IF;

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.status = 'paid' THEN
    RETURN jsonb_build_object('paid', true, 'invoice_id', v_inv.id);
  END IF;

  -- 3. Past due. Auto-pay being OFF is a customer choice, not a system failure,
  --    but the invoice is still unpaid, so the lifecycle continues either way.
  IF v_inv.status IN ('open', 'partially_paid') THEN
    UPDATE public.billing_invoices
       SET status = 'past_due', past_due_at = COALESCE(past_due_at, now())
     WHERE id = v_inv.id;

    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'invoice_past_due', COALESCE(v_reason, 'unpaid'),
            jsonb_build_object('invoice_id', v_inv.id, 'amount_due_irr', v_inv.amount_due_irr));
  END IF;

  -- 4. Subscription past due + grace deadline, from the FROZEN snapshot.
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  IF v_sub.workspace_id IS NOT NULL AND v_sub.free_fallback_at IS NULL THEN
    v_grace := COALESCE(
      v_sub.grace_period_ends_at,
      now() + make_interval(days => COALESCE((v_snap->>'grace_period_days')::int, 3))
    );
    UPDATE public.workspace_subscriptions
       SET status = CASE WHEN status IN ('active', 'trialing', 'past_due') THEN 'past_due' ELSE status END,
           past_due_since = COALESCE(past_due_since, now()),
           grace_period_ends_at = v_grace,
           dunning_snapshot = COALESCE(dunning_snapshot, v_snap),
           updated_at = now()
     WHERE workspace_id = v_inv.workspace_id;

    IF v_sub.status <> 'past_due' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'subscription_past_due', COALESCE(v_reason, 'unpaid'),
              jsonb_build_object('invoice_id', v_inv.id, 'grace_period_ends_at', v_grace));
    END IF;
  END IF;

  -- 5. ONE customer message for this moment — the insufficient-wallet case and
  --    the past-due case are the same event, not two.
  IF COALESCE((v_snap->>'notify_on_past_due')::boolean, true) THEN
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'email',
      'invoice:' || v_inv.id::text || ':past_due:email',
      v_inv.id, v_inv.subscription_id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number,
                         'amount_irr', v_inv.amount_due_irr,
                         'grace_period_ends_at', v_grace,
                         'reason', COALESCE(v_reason, 'unpaid')));
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'sms',
      'invoice:' || v_inv.id::text || ':past_due:sms',
      v_inv.id, v_inv.subscription_id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number,
                         'grace_period_ends_at', v_grace));
  END IF;

  RETURN jsonb_build_object('past_due', true, 'invoice_id', v_inv.id,
                            'reason', COALESCE(v_reason, 'unpaid'),
                            'grace_period_ends_at', v_grace);
END;
$$;

-- ─── 10. Grace expiry → FREE FALLBACK ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_expire_grace(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub    public.workspace_subscriptions;
  v_snap   JSONB;
  v_plan   public.billing_plans;
  v_period public.billing_subscription_periods;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  v_allow  BIGINT;
  v_expired INTEGER := 0;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.workspace_id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_subscription'); END IF;
  IF v_sub.free_fallback_at IS NOT NULL THEN RETURN jsonb_build_object('skipped', 'already_fallback'); END IF;
  IF v_sub.status <> 'past_due' THEN RETURN jsonb_build_object('skipped', 'not_past_due:' || v_sub.status); END IF;
  -- DB now() is the ONLY clock that may expire a grace period.
  IF v_sub.grace_period_ends_at IS NULL OR v_sub.grace_period_ends_at > now() THEN
    RETURN jsonb_build_object('skipped', 'grace_active');
  END IF;

  -- FINAL recheck: a payment that landed during grace wins over the worker.
  IF NOT EXISTS (
    SELECT 1 FROM public.billing_invoices
     WHERE workspace_id = p_workspace_id
       AND status IN ('open', 'partially_paid', 'past_due')
       AND amount_due_irr > 0
  ) THEN
    UPDATE public.workspace_subscriptions
       SET status = 'active', past_due_since = NULL, grace_period_ends_at = NULL, updated_at = now()
     WHERE workspace_id = p_workspace_id;
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'subscription_restored', 'no_outstanding_invoice', '{}'::jsonb);
    RETURN jsonb_build_object('restored', true);
  END IF;

  v_snap := COALESCE(v_sub.dunning_snapshot, public.billing_v2_policy_for(p_workspace_id));

  IF (v_snap->>'fallback_plan_id') IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_not_configured:%', p_workspace_id
      USING HINT = 'Super Admin must set billing_v2_policy.fallback_plan_id.';
  END IF;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = (v_snap->>'fallback_plan_id')::uuid;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_missing:%', v_snap->>'fallback_plan_id';
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'grace_expired', 'unpaid',
          jsonb_build_object('grace_period_ends_at', v_sub.grace_period_ends_at));

  -- The unpaid contract ends here: its invoice expires and its scheduled
  -- period is canceled so no worker can later activate a plan nobody paid for.
  UPDATE public.billing_invoices
     SET status = 'expired'
   WHERE workspace_id = p_workspace_id
     AND status IN ('open', 'partially_paid', 'past_due')
     AND amount_due_irr > 0;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.billing_subscription_periods
     SET status = 'canceled'
   WHERE workspace_id = p_workspace_id AND status = 'scheduled';

  IF v_expired > 0 THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'invoice_expired_after_nonpayment', 'grace_expired',
            jsonb_build_object('count', v_expired));
  END IF;

  -- The free period starts at the fallback moment, not at any earlier anchor.
  v_start := now();
  v_end   := public.billing_v2_add_interval(v_start, 'monthly', 1);
  v_allow := COALESCE((v_plan.limits->>'ai_credits_per_month')::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, 'monthly',
    v_start, v_end, 'scheduled', 'free_fallback',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  PERFORM public.billing_activate_period(v_period.id);

  UPDATE public.workspace_subscriptions
     SET status = 'free_fallback',
         free_fallback_at = now(),
         grace_period_ends_at = NULL,
         next_invoice_at = v_end,
         updated_at = now()
   WHERE workspace_id = p_workspace_id;

  -- Phase F signal ONLY. No data is touched, now or by this migration ever.
  INSERT INTO public.billing_retention_cases (workspace_id, subscription_id, reason, details)
  VALUES (p_workspace_id, v_sub.id, 'free_fallback',
          jsonb_build_object('fallback_at', now(), 'previous_plan_id', v_sub.plan_id,
                             'expired_invoices', v_expired))
  ON CONFLICT (workspace_id) WHERE status = 'open' DO NOTHING;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'subscription_free_fallback', 'grace_expired',
          jsonb_build_object('plan_id', v_plan.id, 'period_id', v_period.id,
                             'previous_plan_id', v_sub.plan_id));

  IF COALESCE((v_snap->>'notify_on_fallback')::boolean, true) THEN
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'free_fallback', 'email',
      'subscription:' || v_sub.id::text || ':fallback:' || to_char(now(), 'YYYYMMDDHH24MISS') || ':email',
      NULL, v_sub.id, now(),
      jsonb_build_object('plan_name', v_plan.name));
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'free_fallback', 'sms',
      'subscription:' || v_sub.id::text || ':fallback:' || to_char(now(), 'YYYYMMDDHH24MISS') || ':sms',
      NULL, v_sub.id, now(), '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object('fallback', true, 'plan_id', v_plan.id, 'period_id', v_period.id,
                            'expired_invoices', v_expired);
END;
$$;

-- ─── 11. Workers D and E on the Phase C substrate ───────────────────────────
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_type_check;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_type_check
  CHECK (job_type IN ('renewal_invoice', 'wallet_autopay', 'period_activation', 'free_period',
                      'invoice_dunning', 'grace_expiry'));

/** Worker D — due-day dunning. */
CREATE OR REPLACE FUNCTION public.billing_v2_run_dunning(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_paid    INTEGER := 0;
  v_past    INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  -- Reminder scheduling for anything issued while the worker was down.
  FOR r IN
    SELECT i.id FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid')
       AND i.metadata->'dunning' IS NULL
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_schedule_invoice_notifications(r.id);
  END LOOP;

  FOR r IN
    SELECT i.id, i.workspace_id
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid', 'past_due')
       AND i.amount_due_irr > 0
       AND i.due_at IS NOT NULL
       AND i.due_at <= now()
     ORDER BY i.due_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'invoice_dunning',
      r.id::text || ':' || to_char(date_trunc('day', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
      r.workspace_id,
      jsonb_build_object('invoice_id', r.id));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('invoice_dunning', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_process_invoice_due((j.payload->>'invoice_id')::uuid);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        IF split_part(v_res->>'skipped', ':', 1) IN ('collection_active', 'not_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        IF COALESCE((v_res->>'paid')::boolean, false) THEN v_paid := v_paid + 1;
        ELSE v_past := v_past + 1; END IF;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'invoice_dunning_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'invoice_id', j.payload->>'invoice_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('invoice_dunning', v_paid + v_past + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('paid', v_paid, 'past_due', v_past, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

/** Worker E — grace expiry and free fallback. */
CREATE OR REPLACE FUNCTION public.billing_v2_run_grace_expiry(p_limit INTEGER DEFAULT 25)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r          RECORD;
  j          public.billing_v2_jobs;
  v_res      JSONB;
  v_fallback INTEGER := 0;
  v_restored INTEGER := 0;
  v_skipped  INTEGER := 0;
  v_failed   INTEGER := 0;
  v_last     TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.grace_period_ends_at
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status = 'past_due'
       AND s.free_fallback_at IS NULL
       AND s.grace_period_ends_at IS NOT NULL
       AND s.grace_period_ends_at <= now()
     ORDER BY s.grace_period_ends_at
     LIMIT GREATEST(COALESCE(p_limit, 25), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'grace_expiry',
      r.workspace_id::text || ':' || to_char(r.grace_period_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      r.workspace_id,
      jsonb_build_object('workspace_id', r.workspace_id));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('grace_expiry', p_limit, 180) LOOP
    BEGIN
      v_res := public.billing_v2_expire_grace(j.workspace_id);
      IF v_res ? 'skipped' THEN v_skipped := v_skipped + 1;
      ELSIF COALESCE((v_res->>'restored')::boolean, false) THEN v_restored := v_restored + 1;
      ELSE v_fallback := v_fallback + 1; END IF;
      PERFORM public.billing_v2_complete_job(j.id, v_res);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'grace_expiry_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('grace_expiry', v_fallback + v_restored + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('fallback', v_fallback, 'restored', v_restored,
                            'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 12. No new renewal while the customer already owes us ──────────────────
/**
 * Same Worker A as 118, with ONE behavioural change required by Phase E:
 * a past_due subscription does not get another renewal invoice stacked on top
 * of the one it has not paid.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_run_invoice_scheduler(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r        RECORD;
  j        public.billing_v2_jobs;
  v_res    JSONB;
  v_issued INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed INTEGER := 0;
  v_last   TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.id AS sub_id, COALESCE(s.next_invoice_at, s.current_period_end) AS anchor
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status = 'active'
       AND s.free_fallback_at IS NULL
       AND COALESCE(s.next_invoice_at, s.current_period_end) IS NOT NULL
       AND COALESCE(s.next_invoice_at, s.current_period_end)
           - make_interval(days => (public.billing_v2_policy_for(s.workspace_id)->>'invoice_lead_time_days')::int)
           <= now()
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
        IF (v_res->>'invoice_id') IS NOT NULL THEN
          PERFORM public.billing_v2_schedule_invoice_notifications((v_res->>'invoice_id')::uuid);
        END IF;
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
$$;

-- ─── 13. Operational surface ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_scheduler_health()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending','processing') AND next_attempt_at <= now()),
    'notification_failures', (SELECT count(*) FROM public.billing_notification_jobs WHERE status = 'failed'),
    'checked_at', now()
  );
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_dunning_metrics()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'open_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'open'),
    'past_due_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'past_due'),
    'past_due_amount_irr', (SELECT COALESCE(sum(amount_due_irr), 0) FROM public.billing_invoices
                             WHERE status = 'past_due'),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL
                               AND grace_period_ends_at > now()),
    'fallbacks_total', (SELECT count(*) FROM public.workspace_subscriptions
                         WHERE free_fallback_at IS NOT NULL),
    'autopay_insufficient_24h', (SELECT count(*) FROM public.billing_v2_audit
                                  WHERE event = 'wallet_autopay_insufficient' AND created_at > now() - interval '24 hours'),
    'autopay_success_24h', (SELECT count(*) FROM public.billing_v2_audit
                             WHERE event = 'wallet_autopay_succeeded' AND created_at > now() - interval '24 hours'),
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending','processing')),
    'notification_failures', (SELECT count(*) FROM public.billing_notification_jobs WHERE status = 'failed'),
    'open_retention_cases', (SELECT count(*) FROM public.billing_retention_cases WHERE status = 'open'),
    'checked_at', now()
  );
$$;

-- ─── 14. ACL — service_role only, never anon/authenticated ──────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_v2_policy_for(uuid)',
    'public.billing_v2_dunning_snapshot(uuid)',
    'public.billing_v2_billing_recipient(uuid)',
    'public.billing_v2_enqueue_notification(uuid,text,text,text,uuid,uuid,timestamptz,jsonb)',
    'public.billing_v2_cancel_invoice_notifications(uuid,text,text[])',
    'public.billing_v2_claim_notification_jobs(integer,integer)',
    'public.billing_v2_complete_notification_job(uuid,jsonb)',
    'public.billing_v2_skip_notification_job(uuid,text)',
    'public.billing_v2_fail_notification_job(uuid,text)',
    'public.billing_v2_schedule_invoice_notifications(uuid)',
    'public.billing_v2_restore_after_payment(uuid)',
    'public.billing_v2_process_invoice_due(uuid)',
    'public.billing_v2_expire_grace(uuid)',
    'public.billing_v2_run_dunning(integer)',
    'public.billing_v2_run_grace_expiry(integer)',
    'public.billing_v2_run_invoice_scheduler(integer)',
    'public.billing_v2_scheduler_health()',
    'public.billing_v2_dunning_metrics()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
