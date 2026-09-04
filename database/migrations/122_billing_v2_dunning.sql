-- ============================================================================
-- BILLING ENGINE V2 — PHASE E
-- Dunning, invoice reminders, grace period, wallet recovery, free fallback and
-- customer notifications.
--
-- Migrations 113–121 are FROZEN. Everything new lives here, additively.
--
-- THE LIFECYCLE THIS MIGRATION OWNS (and nothing else does):
--
--   renewal invoice open
--     → reminders at policy offsets before due_at
--     → due_at: lock, RECHECK payment, try wallet auto-pay
--     → still unpaid: invoice past_due + subscription past_due + grace deadline
--     → grace expires unpaid: subscription free_fallback (service degrades to
--       the platform fallback plan, DATA IS NEVER TOUCHED)
--     → paid at any point before fallback: deterministic, idempotent recovery
--
-- HARD RULES ENCODED HERE
--   * No DELETE of any customer data. Phase F owns retention/purge; this
--     migration only records a durable retention SIGNAL.
--   * Invoice status and subscription status are different vocabularies and
--     are never conflated.
--   * Notifications are durable jobs with a UNIQUE idempotency key: a replayed
--     scheduler run produces exactly one message.
--   * A notification failure never rolls back a settlement, a past-due
--     transition or a fallback.
--   * Grace length and the fallback plan are platform (Super Admin) policy and
--     are deliberately NOT workspace-overridable.
-- ============================================================================

-- ─── 1. Policy — canonical dunning knobs ───────────────────────────────────
ALTER TABLE public.billing_v2_policy
  ADD COLUMN IF NOT EXISTS reminder_days_before_due   INTEGER[] NOT NULL DEFAULT '{5,1}',
  ADD COLUMN IF NOT EXISTS grace_period_days          INTEGER   NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS fallback_plan_id           UUID REFERENCES public.billing_plans(id),
  ADD COLUMN IF NOT EXISTS send_invoice_issued_email  BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS send_invoice_issued_sms    BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_on_due              BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_past_due         BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_fallback         BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notification_max_attempts  INTEGER   NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS notification_retry_seconds INTEGER   NOT NULL DEFAULT 900,
  ADD COLUMN IF NOT EXISTS notification_max_per_hour  INTEGER   NOT NULL DEFAULT 20;

ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_dunning_sane;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_dunning_sane CHECK (
  grace_period_days BETWEEN 0 AND 30
  AND notification_max_attempts BETWEEN 1 AND 20
  AND notification_retry_seconds BETWEEN 60 AND 86400
  AND notification_max_per_hour BETWEEN 1 AND 500
  AND COALESCE(array_length(reminder_days_before_due, 1), 0) <= 6
);

COMMENT ON COLUMN public.billing_v2_policy.grace_period_days IS
  'Platform-only (Super Admin) grace length after an invoice goes past due. Deliberately NOT workspace-overridable.';
COMMENT ON COLUMN public.billing_v2_policy.fallback_plan_id IS
  'Platform-only fallback plan a workspace lands on when grace expires unpaid. NULL = the first free plan is used.';

-- Workspace overrides: reminders and the issued-SMS toggle only. Grace and the
-- fallback plan are intentionally absent — they are platform policy.
ALTER TABLE public.billing_v2_workspace_policy
  ADD COLUMN IF NOT EXISTS reminder_days_before_due  INTEGER[],
  ADD COLUMN IF NOT EXISTS send_invoice_issued_sms   BOOLEAN,
  ADD COLUMN IF NOT EXISTS notifications_enabled     BOOLEAN;

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
    -- Phase E
    'reminder_days_before_due',
      to_jsonb(COALESCE(v_ws.reminder_days_before_due, v_pol.reminder_days_before_due, ARRAY[5, 1])),
    'grace_period_days', COALESCE(v_pol.grace_period_days, 3),
    'fallback_plan_id', v_pol.fallback_plan_id,
    'send_invoice_issued_email', COALESCE(v_pol.send_invoice_issued_email, true),
    'send_invoice_issued_sms',
      COALESCE(v_ws.send_invoice_issued_sms, v_pol.send_invoice_issued_sms, false),
    'notify_on_due', COALESCE(v_pol.notify_on_due, true),
    'notify_on_past_due', COALESCE(v_pol.notify_on_past_due, true),
    'notify_on_fallback', COALESCE(v_pol.notify_on_fallback, true),
    'notifications_enabled', COALESCE(v_ws.notifications_enabled, true),
    'notification_max_attempts', COALESCE(v_pol.notification_max_attempts, 5),
    'notification_retry_seconds', COALESCE(v_pol.notification_retry_seconds, 900),
    'notification_max_per_hour', COALESCE(v_pol.notification_max_per_hour, 20)
  );
END;
$$;

-- ─── 2. Durable notification jobs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_notification_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  invoice_id        UUID REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES public.workspace_subscriptions(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL,
  channel           TEXT NOT NULL,
  locale            TEXT,
  scheduled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  lease_until       TIMESTAMPTZ,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  idempotency_key   TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_notification_jobs_channel_check CHECK (channel IN ('email', 'sms')),
  CONSTRAINT billing_notification_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'sent', 'failed', 'canceled', 'skipped_no_recipient')
  ),
  CONSTRAINT billing_notification_jobs_type_check CHECK (notification_type IN (
    'invoice_issued', 'invoice_reminder', 'invoice_due', 'wallet_autopay_insufficient',
    'invoice_past_due', 'payment_received', 'subscription_restored',
    'subscription_free_fallback'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_notification_jobs_idem
  ON public.billing_notification_jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS ix_billing_notification_jobs_claimable
  ON public.billing_notification_jobs (next_attempt_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS ix_billing_notification_jobs_invoice
  ON public.billing_notification_jobs (invoice_id) WHERE invoice_id IS NOT NULL;

GRANT ALL ON public.billing_notification_jobs TO service_role;
ALTER TABLE public.billing_notification_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_notification_jobs_service_only ON public.billing_notification_jobs;
CREATE POLICY billing_notification_jobs_service_only ON public.billing_notification_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_notification_jobs IS
  'Durable, idempotent customer billing notifications. The UNIQUE idempotency key is what makes a replayed scheduler run send exactly one message. Transactional only — never marketing.';

-- ─── 3. Retention SIGNAL for Phase F (no purge here, ever) ─────────────────
CREATE TABLE IF NOT EXISTS public.billing_retention_signals (
  workspace_id   UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'pending',
  reason         TEXT NOT NULL,
  signaled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at     TIMESTAMPTZ,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT billing_retention_signals_state_check CHECK (state IN ('pending', 'cleared'))
);

GRANT ALL ON public.billing_retention_signals TO service_role;
ALTER TABLE public.billing_retention_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_retention_signals_service_only ON public.billing_retention_signals;
CREATE POLICY billing_retention_signals_service_only ON public.billing_retention_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_retention_signals IS
  'Phase E writes ONLY a durable signal here when a workspace falls back to free. No data is deleted in Phase E; Phase F owns retention and purge.';

-- ─── 4. Vocabulary extensions ──────────────────────────────────────────────
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_type_check;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_type_check
  CHECK (job_type IN (
    'renewal_invoice', 'wallet_autopay', 'period_activation', 'free_period',
    'dunning_due', 'grace_expiry'
  ));

ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_source_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_source_check
  CHECK (source IN ('invoice', 'legacy_migration', 'free_plan', 'trial', 'admin', 'free_fallback'));

-- ─── 5. Recipient resolution ───────────────────────────────────────────────
/**
 * Canonical recipient: workspace billing contact (subscription metadata) →
 * workspace owner profile. SMS requires a VERIFIED phone; email requires a
 * non-empty address. A missing channel is a skip, never a failure, and the
 * absence of a phone never suppresses the email.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_resolve_billing_recipient(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner   UUID;
  v_email   TEXT;
  v_locale  TEXT;
  v_phone   TEXT;
  v_contact JSONB;
BEGIN
  SELECT metadata->'billing_contact' INTO v_contact
    FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;

  SELECT owner_id INTO v_owner FROM public.workspaces WHERE id = p_workspace_id;
  IF v_owner IS NOT NULL THEN
    SELECT email, COALESCE(preferred_locale, 'fa') INTO v_email, v_locale
      FROM public.profiles WHERE id = v_owner;
  END IF;

  IF to_regclass('public.user_phone_verifications') IS NOT NULL AND v_owner IS NOT NULL THEN
    EXECUTE 'SELECT phone_e164 FROM public.user_phone_verifications
              WHERE user_id = $1 AND phone_verified_at IS NOT NULL'
      INTO v_phone USING v_owner;
  END IF;

  RETURN jsonb_build_object(
    'user_id', v_owner,
    'email', NULLIF(COALESCE(v_contact->>'email', v_email), ''),
    'phone', NULLIF(COALESCE(v_contact->>'phone', v_phone), ''),
    'locale', COALESCE(v_contact->>'locale', v_locale, 'fa')
  );
END;
$$;

-- ─── 6. Notification enqueue / cancel ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_enqueue_notification(
  p_workspace_id UUID,
  p_type         TEXT,
  p_channel      TEXT,
  p_invoice_id   UUID DEFAULT NULL,
  p_scheduled_at TIMESTAMPTZ DEFAULT now(),
  p_payload      JSONB DEFAULT '{}'::jsonb,
  p_suffix       TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_policy JSONB;
  v_rcpt   JSONB;
  v_sub    UUID;
  v_key    TEXT;
  v_id     UUID;
  v_recent INTEGER;
BEGIN
  v_policy := public.billing_v2_policy_for(p_workspace_id);
  IF NOT (v_policy->>'notifications_enabled')::boolean THEN
    RETURN NULL;
  END IF;

  v_rcpt := public.billing_v2_resolve_billing_recipient(p_workspace_id);
  SELECT id INTO v_sub FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;

  v_key := p_type || ':' || p_channel || ':' ||
           COALESCE(p_invoice_id::text, p_workspace_id::text) || ':' ||
           COALESCE(p_suffix, to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'));

  -- Rate guard: never let a catch-up run flood one workspace.
  SELECT count(*) INTO v_recent FROM public.billing_notification_jobs
   WHERE workspace_id = p_workspace_id AND created_at > now() - interval '1 hour';
  IF v_recent >= (v_policy->>'notification_max_per_hour')::int THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'billing_notification_rate_limited', p_type,
            jsonb_build_object('channel', p_channel, 'recent', v_recent));
    RETURN NULL;
  END IF;

  INSERT INTO public.billing_notification_jobs (
    workspace_id, invoice_id, subscription_id, notification_type, channel, locale,
    scheduled_at, next_attempt_at, max_attempts, idempotency_key, payload, status
  ) VALUES (
    p_workspace_id, p_invoice_id, v_sub, p_type, p_channel, v_rcpt->>'locale',
    p_scheduled_at, p_scheduled_at, (v_policy->>'notification_max_attempts')::int,
    v_key, COALESCE(p_payload, '{}'::jsonb),
    CASE
      WHEN p_channel = 'email' AND (v_rcpt->>'email') IS NULL THEN 'skipped_no_recipient'
      WHEN p_channel = 'sms'   AND (v_rcpt->>'phone') IS NULL THEN 'skipped_no_recipient'
      ELSE 'pending'
    END
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

/** A paid / voided / expired invoice must not keep reminding anyone. */
CREATE OR REPLACE FUNCTION public.billing_v2_cancel_invoice_notifications(
  p_invoice_id UUID,
  p_reason     TEXT DEFAULT 'invoice_closed',
  p_types      TEXT[] DEFAULT ARRAY['invoice_reminder', 'invoice_due', 'invoice_past_due']
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
     AND notification_type = ANY (p_types);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_invoice_notification_sync()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('paid', 'void', 'expired') THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(NEW.id, 'invoice_' || NEW.status);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_invoice_notification_sync ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_notification_sync
  AFTER UPDATE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_invoice_notification_sync();

-- ─── 7. Reminder scheduling ────────────────────────────────────────────────
/**
 * Schedules the "issued" message and every reminder offset for one open
 * invoice. Catch-up safe: an offset already in the past is NOT back-filled as
 * a flood of stale reminders — only the still-future ones are scheduled, and
 * the due-day worker owns everything from `due_at` on.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_schedule_invoice_notifications(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv     public.billing_invoices;
  v_policy  JSONB;
  v_days    INTEGER;
  v_at      TIMESTAMPTZ;
  v_created INTEGER := 0;
  v_payload JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid') THEN
    RETURN jsonb_build_object('skipped', 'not_open:' || v_inv.status);
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  v_payload := jsonb_build_object(
    'invoice_number', v_inv.invoice_number,
    'amount_irr', v_inv.amount_due_irr,
    'due_at', v_inv.due_at
  );

  IF (v_policy->>'send_invoice_issued_email')::boolean THEN
    IF public.billing_v2_enqueue_notification(
         v_inv.workspace_id, 'invoice_issued', 'email', v_inv.id, now(), v_payload,
         v_inv.id::text) IS NOT NULL THEN v_created := v_created + 1; END IF;
  END IF;
  IF (v_policy->>'send_invoice_issued_sms')::boolean THEN
    IF public.billing_v2_enqueue_notification(
         v_inv.workspace_id, 'invoice_issued', 'sms', v_inv.id, now(), v_payload,
         v_inv.id::text) IS NOT NULL THEN v_created := v_created + 1; END IF;
  END IF;

  IF v_inv.due_at IS NOT NULL THEN
    FOR v_days IN
      SELECT DISTINCT (value)::int
        FROM jsonb_array_elements_text(v_policy->'reminder_days_before_due')
    LOOP
      v_at := v_inv.due_at - make_interval(days => GREATEST(v_days, 0));
      CONTINUE WHEN v_at <= now();   -- no stale reminder floods on catch-up
      IF public.billing_v2_enqueue_notification(
           v_inv.workspace_id, 'invoice_reminder', 'email', v_inv.id, v_at, v_payload,
           v_inv.id::text || ':d' || v_days::text) IS NOT NULL THEN
        v_created := v_created + 1;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_reminders_scheduled', 'dunning',
          jsonb_build_object('invoice_id', v_inv.id, 'created', v_created));

  RETURN jsonb_build_object('invoice_id', v_inv.id, 'created', v_created);
END;
$$;

-- ─── 8. Recovery — deterministic and idempotent ────────────────────────────
/**
 * Called whenever an invoice is observed paid while its subscription is in
 * dunning. Clears the dunning markers ONLY when nothing else is past due, and
 * never revives a subscription that has already fallen back.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_restore_subscription(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub    public.workspace_subscriptions;
  v_unpaid INTEGER;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('skipped', 'no_subscription'); END IF;
  IF v_sub.status = 'free_fallback' THEN
    -- A late payment never silently revives a fallen-back subscription: the
    -- money becomes a new invoice/period decision, not a rollback.
    RETURN jsonb_build_object('skipped', 'already_free_fallback');
  END IF;
  IF v_sub.status <> 'past_due' AND v_sub.grace_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_in_dunning');
  END IF;

  SELECT count(*) INTO v_unpaid FROM public.billing_invoices
   WHERE workspace_id = p_workspace_id
     AND status IN ('open', 'partially_paid', 'past_due')
     AND amount_due_irr > 0
     AND due_at IS NOT NULL AND due_at <= now();
  IF v_unpaid > 0 THEN
    RETURN jsonb_build_object('skipped', 'still_unpaid', 'open_due_invoices', v_unpaid);
  END IF;

  UPDATE public.workspace_subscriptions
     SET status = 'active', past_due_since = NULL, grace_period_ends_at = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'subscription_restored', 'payment_during_grace',
          jsonb_build_object('subscription_id', v_sub.id));

  PERFORM public.billing_v2_enqueue_notification(
    p_workspace_id, 'subscription_restored', 'email', NULL, now(), '{}'::jsonb,
    v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));

  RETURN jsonb_build_object('restored', true);
END;
$$;

-- ─── 9. Due-day processing (the CRITICAL order) ────────────────────────────
/**
 * ORDER IS THE CONTRACT:
 *   1. lock the invoice and RECHECK payment — a paid invoice stops everything
 *   2. an active gateway collection defers (money may be in flight)
 *   3. wallet auto-pay attempt when enabled (full payment or nothing)
 *   4. only then: invoice past_due, subscription past_due, grace deadline
 */
CREATE OR REPLACE FUNCTION public.billing_v2_process_due_invoice(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv    public.billing_invoices;
  v_sub    public.workspace_subscriptions;
  v_policy JSONB;
  v_res    JSONB;
  v_grace  TIMESTAMPTZ;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;

  -- (1) Recheck under the lock — the authority is the row, not the scan.
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

  -- (2) Live gateway collection: money may be in flight. NEVER assume paid.
  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);

  -- (3) Wallet auto-pay.
  IF (v_policy->>'wallet_auto_pay')::boolean THEN
    v_res := public.billing_v2_wallet_autopay_invoice(v_inv.id);
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_attempted', COALESCE(v_res->>'skipped', 'paid'),
            jsonb_build_object('invoice_id', v_inv.id));

    IF COALESCE((v_res->>'paid')::boolean, false) THEN
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
      -- Insufficient wallet is a customer-actionable event; auto-pay being
      -- DISABLED is not a failure and produces no such message.
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'wallet_autopay_insufficient', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr),
        v_inv.id::text);
    END IF;
  END IF;

  -- (4) Past due. Invoice vocabulary and subscription vocabulary, separately.
  UPDATE public.billing_invoices
     SET status = 'past_due', past_due_at = COALESCE(past_due_at, now()), updated_at = now()
   WHERE id = v_inv.id AND status IN ('open', 'partially_paid');

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  IF v_sub.id IS NOT NULL AND v_sub.status IN ('active', 'past_due') THEN
    v_grace := COALESCE(v_sub.grace_period_ends_at,
                        now() + make_interval(days => (v_policy->>'grace_period_days')::int));
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

  RETURN jsonb_build_object('past_due', true, 'grace_period_ends_at', v_grace);
END;
$$;

-- ─── 10. Worker D — dunning ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_run_dunning(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r          RECORD;
  j          public.billing_v2_jobs;
  v_res      JSONB;
  v_past_due INTEGER := 0;
  v_paid     INTEGER := 0;
  v_skipped  INTEGER := 0;
  v_failed   INTEGER := 0;
  v_last     TEXT;
BEGIN
  -- Reminder scheduling for every live renewal invoice of a V2 workspace.
  FOR r IN
    SELECT i.id
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid')
       AND i.amount_due_irr > 0
     ORDER BY i.due_at NULLS LAST
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_schedule_invoice_notifications(r.id);
  END LOOP;

  -- Due invoices become durable work items.
  FOR r IN
    SELECT i.id, i.workspace_id, i.amount_paid_irr
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
      'dunning_due',
      r.id::text || ':' || r.amount_paid_irr::text,
      r.workspace_id,
      jsonb_build_object('invoice_id', r.id));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('dunning_due', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_process_due_invoice((j.payload->>'invoice_id')::uuid);
      IF COALESCE((v_res->>'paid')::boolean, false) THEN
        v_paid := v_paid + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      ELSIF COALESCE((v_res->>'past_due')::boolean, false) THEN
        v_past_due := v_past_due + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      ELSE
        v_skipped := v_skipped + 1;
        IF split_part(COALESCE(v_res->>'skipped', ''), ':', 1) IN ('collection_active', 'not_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'dunning_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('dunning', v_past_due + v_paid + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('past_due', v_past_due, 'paid', v_paid,
                            'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 11. Free fallback ─────────────────────────────────────────────────────
/**
 * Moves ONE workspace to the platform fallback plan after grace expired
 * unpaid. Degrades SERVICE, never data: no row of customer content is touched
 * here, and Phase F reads `billing_retention_signals` for whatever comes next.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_apply_free_fallback(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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
  IF v_sub.status <> 'past_due' OR v_sub.grace_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_in_grace');
  END IF;
  -- DB clock is the only authority for the deadline.
  IF v_sub.grace_period_ends_at > now() THEN
    RETURN jsonb_build_object('skipped', 'grace_active');
  END IF;

  -- FINAL recheck: any settled money before this instant cancels the fallback.
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
    SELECT id INTO v_plan_id FROM public.billing_plans
     WHERE is_free ORDER BY sort_order NULLS LAST, created_at LIMIT 1;
  END IF;
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_fallback_plan');
  END IF;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_plan_id;

  -- An unfunded scheduled period (the renewal nobody paid for) is canceled,
  -- never activated — and it must go before the fallback period is inserted,
  -- because only one scheduled period per workspace may exist.
  UPDATE public.billing_subscription_periods
     SET status = 'canceled', completed_at = now()
   WHERE workspace_id = p_workspace_id AND status = 'scheduled';

  -- The free period starts at the fallback instant, not at the unpaid window.
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

  -- Unpaid documents are closed as expired — never deleted, never paid.
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
$$;

-- ─── 12. Worker E — grace expiry ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_run_grace_expiry(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r           RECORD;
  j           public.billing_v2_jobs;
  v_res       JSONB;
  v_fallbacks INTEGER := 0;
  v_skipped   INTEGER := 0;
  v_failed    INTEGER := 0;
  v_last      TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.id AS sub_id, s.grace_period_ends_at
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status = 'past_due'
       AND s.grace_period_ends_at IS NOT NULL
       AND s.grace_period_ends_at <= now()
     ORDER BY s.grace_period_ends_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'grace_expiry',
      r.sub_id::text || ':' || to_char(r.grace_period_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      r.workspace_id,
      jsonb_build_object('subscription_id', r.sub_id));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('grace_expiry', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_apply_free_fallback(j.workspace_id);
      IF COALESCE((v_res->>'free_fallback')::boolean, false) THEN
        v_fallbacks := v_fallbacks + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
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

  PERFORM public.billing_v2_note_worker_run('grace_expiry', v_fallbacks + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('fallbacks', v_fallbacks, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 13. Notification job claim / complete / fail ──────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_claim_notification_jobs(
  p_limit         INTEGER DEFAULT 25,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.billing_notification_jobs
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_notification_jobs n
     SET status = 'processing',
         attempt_count = n.attempt_count + 1,
         lease_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 30)),
         updated_at = now()
   WHERE n.id IN (
     SELECT c.id FROM public.billing_notification_jobs c
      WHERE c.status IN ('pending', 'processing')
        AND c.scheduled_at <= now()
        AND c.next_attempt_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until <= now())
      ORDER BY c.scheduled_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(COALESCE(p_limit, 25), 1)
   )
  RETURNING n.*;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_complete_notification_job(
  p_job_id UUID,
  p_status TEXT DEFAULT 'sent',
  p_error  TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_job public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = CASE WHEN p_status IN ('sent', 'skipped_no_recipient', 'canceled')
                       THEN p_status ELSE 'sent' END,
         sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
         lease_until = NULL, last_error = left(p_error, 300), updated_at = now()
   WHERE id = p_job_id
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_job.workspace_id,
            CASE WHEN v_job.status = 'sent' THEN 'billing_notification_sent'
                 ELSE 'billing_notification_skipped' END,
            v_job.notification_type,
            jsonb_build_object('channel', v_job.channel, 'invoice_id', v_job.invoice_id));
  END IF;
END;
$$;

/** Bounded retry. A dead notification NEVER rolls back financial state. */
CREATE OR REPLACE FUNCTION public.billing_v2_fail_notification_job(
  p_job_id UUID,
  p_error  TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_job    public.billing_notification_jobs;
  v_policy JSONB;
BEGIN
  SELECT * INTO v_job FROM public.billing_notification_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RETURN; END IF;
  v_policy := public.billing_v2_policy_for(v_job.workspace_id);

  UPDATE public.billing_notification_jobs
     SET status = CASE WHEN v_job.attempt_count >= v_job.max_attempts THEN 'failed' ELSE 'pending' END,
         lease_until = NULL,
         last_error = left(COALESCE(p_error, 'unknown'), 300),
         next_attempt_at = now() + make_interval(
           secs => LEAST((v_policy->>'notification_retry_seconds')::int
                         * GREATEST(v_job.attempt_count, 1), 21600)),
         updated_at = now()
   WHERE id = p_job_id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_job.workspace_id, 'billing_notification_failed', left(COALESCE(p_error, 'unknown'), 200),
          jsonb_build_object('channel', v_job.channel, 'type', v_job.notification_type,
                             'attempt', v_job.attempt_count));
END;
$$;

-- ─── 14. Operational metrics ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_dunning_metrics()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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
$$;

-- ─── 15. ACL — service_role only, exactly like the rest of V2 ──────────────
DO $acl$
DECLARE f TEXT;
BEGIN
  FOR f IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'billing_v2_policy_for', 'billing_v2_resolve_billing_recipient',
         'billing_v2_enqueue_notification', 'billing_v2_cancel_invoice_notifications',
         'billing_v2_schedule_invoice_notifications', 'billing_v2_restore_subscription',
         'billing_v2_process_due_invoice', 'billing_v2_run_dunning',
         'billing_v2_apply_free_fallback', 'billing_v2_run_grace_expiry',
         'billing_v2_claim_notification_jobs', 'billing_v2_complete_notification_job',
         'billing_v2_fail_notification_job', 'billing_v2_dunning_metrics')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$acl$;
