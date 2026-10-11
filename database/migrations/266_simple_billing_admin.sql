-- 266 — Simple billing, phase 6: the Super Admin's billing screens
-- (docs/billing/SIMPLE_BILLING.md).
--
--   Adjust        billing_account_admin_adjust gains a category and the
--                 balance the admin saw (8 arguments; the two new ones have
--                 defaults, so 259's 6-argument calls still resolve to it).
--                 The reason is required (3-500 characters), the size is
--                 capped per currency (TOPUP_LIMITS.max in
--                 shared/simpleBilling.ts), and a command key is bound to
--                 its charge: the same key for another workspace, another
--                 direction or another amount is refused instead of being
--                 answered as a replay. A replay is answered before the
--                 balance check, so a double submit still replays after the
--                 first one moved the balance.
--   Refund time   a refund the provider reports is stored in its payment's
--                 purpose_detail.refunds, which had no time. A trigger now
--                 stamps `refunded_at` on each new entry; the entries that
--                 exist are backfilled from their ledger row (the refund, or
--                 the prepaid / AI pack return the refund made), else from
--                 the payment's updated_at. The refund function itself is
--                 not touched.
--   Reports       read-only functions for the accounts list, an account's
--                 payments, revenue and balance movements per local day, and
--                 the outstanding balance per currency. The server groups the
--                 days into the edition's months (Jalali in Iran).
--   Indexes       succeeded payments by completed_at; the ledger by
--                 created_at (both read by the revenue report).
--
-- Inert for the code already deployed: nothing it calls changes behaviour
-- except the adjust's new checks, which only Super Admin reaches.
--
-- Server-only: every function here is reachable by service_role alone.
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. Adjust: category, reason, size cap, the balance the admin saw ─────
-- 259's body with the checks above. The 6-argument function is replaced, not
-- overloaded, so a 6-argument call reaches this one without ambiguity.
DROP FUNCTION IF EXISTS public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text);
CREATE OR REPLACE FUNCTION public.billing_account_admin_adjust(
  p_workspace_id           uuid,
  p_amount_minor           bigint,
  p_currency               text,
  p_reason                 text,
  p_actor_id               uuid,
  p_command_key            text,
  p_category               text   DEFAULT 'other',
  p_expected_balance_minor bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc     public.billing_accounts;
  v_entry   public.billing_account_ledger;
  v_balance bigint;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_kind    text;
  v_cap     bigint;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor = 0 THEN
    RAISE EXCEPTION 'billing_adjust_zero';
  END IF;
  IF coalesce(p_command_key, '') = '' THEN
    RAISE EXCEPTION 'billing_adjust_missing_key';
  END IF;
  IF p_category IS NULL
     OR p_category NOT IN ('goodwill', 'compensation', 'correction', 'migration', 'test', 'other') THEN
    RAISE EXCEPTION 'billing_adjust_bad_category';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'billing_adjust_reason_required';
  END IF;
  -- TOPUP_LIMITS.max (shared/simpleBilling.ts); another currency has the
  -- cents-based cap.
  v_cap := CASE upper(coalesce(p_currency, ''))
    WHEN 'IRR' THEN 10000000000
    WHEN 'USD' THEN 5000000
    WHEN 'TRY' THEN 200000000
    WHEN 'EUR' THEN 5000000
    WHEN 'GBP' THEN 5000000
    ELSE 5000000
  END;
  IF abs(p_amount_minor) > v_cap THEN
    RAISE EXCEPTION 'billing_adjust_too_large';
  END IF;
  v_kind := CASE WHEN p_amount_minor > 0 THEN 'admin_credit' ELSE 'admin_debit' END;

  PERFORM public.billing_account_ensure(p_workspace_id, p_currency);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;

  -- A replay is the same charge: same workspace, direction and amount.
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = 'admin:' || p_command_key;
  IF v_entry.id IS NOT NULL THEN
    IF v_entry.workspace_id <> p_workspace_id
       OR v_entry.kind <> v_kind
       OR v_entry.amount_minor <> p_amount_minor THEN
      RAISE EXCEPTION 'billing_adjust_key_reused';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_entry.id, 'balance_minor', v_entry.balance_after);
  END IF;

  IF v_acc.currency <> upper(p_currency) THEN
    RAISE EXCEPTION 'billing_account_currency_mismatch';
  END IF;
  IF p_expected_balance_minor IS NOT NULL AND v_acc.balance_minor <> p_expected_balance_minor THEN
    RAISE EXCEPTION 'billing_adjust_balance_changed';
  END IF;
  v_balance := v_acc.balance_minor + p_amount_minor;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'billing_insufficient_balance';
  END IF;

  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency,
    description, actor_id, idempotency_key
  ) VALUES (
    p_workspace_id, v_kind, p_amount_minor, v_balance, v_acc.currency,
    jsonb_build_object('reason', v_reason, 'category', p_category),
    p_actor_id,
    'admin:' || p_command_key
  ) RETURNING * INTO v_entry;

  UPDATE public.billing_accounts
     SET balance_minor = v_balance, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object('replayed', false, 'ledger_id', v_entry.id, 'balance_minor', v_balance);
END;
$$;

-- ─── 2. Refund timestamps ─────────────────────────────────────────────────
-- 2a. The entries that exist: the time of the ledger row the refund wrote
-- (the refund itself, or the prepaid period / AI pack it returned to the
-- balance first), else the payment's last change. updated_at is not moved.
-- Runs before the trigger exists; a second run finds nothing to stamp.
UPDATE public.billing_account_payments p
   SET purpose_detail = jsonb_set(
         p.purpose_detail, '{refunds}',
         (SELECT jsonb_object_agg(
                   e.key,
                   CASE
                     WHEN jsonb_typeof(e.value) <> 'object' OR e.value ? 'refunded_at' THEN e.value
                     ELSE e.value || jsonb_build_object('refunded_at', coalesce(
                       (SELECT min(l.created_at)
                          FROM public.billing_account_ledger l
                         WHERE l.idempotency_key IN (
                                 'refund:' || p.provider || ':' || e.key,
                                 'prepaid_return:refund:' || p.provider || ':' || e.key,
                                 'ai_pack_return:refund:' || p.provider || ':' || e.key)),
                       p.updated_at))
                   END)
            FROM jsonb_each(p.purpose_detail -> 'refunds') AS e))
 WHERE jsonb_typeof(p.purpose_detail -> 'refunds') = 'object'
   AND EXISTS (
     SELECT 1 FROM jsonb_each(p.purpose_detail -> 'refunds') AS e
      WHERE jsonb_typeof(e.value) = 'object' AND NOT e.value ? 'refunded_at'
   );

-- 2b. New entries: stamped when they are written. An entry that already had
-- a time keeps it, also when an update rewrites purpose_detail without it.
CREATE OR REPLACE FUNCTION public.billing_account_payments_stamp_refunds()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_refunds jsonb := NEW.purpose_detail -> 'refunds';
  v_old     jsonb := CASE WHEN jsonb_typeof(OLD.purpose_detail -> 'refunds') = 'object'
                          THEN OLD.purpose_detail -> 'refunds' ELSE '{}'::jsonb END;
  v_key     text;
  v_value   jsonb;
  v_changed boolean := false;
BEGIN
  IF jsonb_typeof(v_refunds) IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(v_refunds) LOOP
    IF jsonb_typeof(v_value) = 'object' AND NOT v_value ? 'refunded_at' THEN
      v_refunds := jsonb_set(v_refunds, ARRAY[v_key], v_value || jsonb_build_object(
        'refunded_at', coalesce(v_old -> v_key -> 'refunded_at', to_jsonb(clock_timestamp()))));
      v_changed := true;
    END IF;
  END LOOP;
  IF v_changed THEN
    NEW.purpose_detail := jsonb_set(NEW.purpose_detail, '{refunds}', v_refunds);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_account_payments_stamp_refunds ON public.billing_account_payments;
CREATE TRIGGER trg_billing_account_payments_stamp_refunds
  BEFORE UPDATE OF purpose_detail ON public.billing_account_payments
  FOR EACH ROW
  WHEN ((NEW.purpose_detail -> 'refunds') IS DISTINCT FROM (OLD.purpose_detail -> 'refunds'))
  EXECUTE FUNCTION public.billing_account_payments_stamp_refunds();

-- ─── 3. Indexes for the revenue report ────────────────────────────────────
CREATE INDEX IF NOT EXISTS billing_account_payments_succeeded_idx
  ON public.billing_account_payments (completed_at) WHERE status = 'succeeded';
CREATE INDEX IF NOT EXISTS billing_account_ledger_created_idx
  ON public.billing_account_ledger (created_at);

-- ─── 4. Reports (read-only) ───────────────────────────────────────────────

-- The accounts list: every workspace, with its account when it has one, so
-- a workspace without an account can still be found and credited.
--   p_search  name or slug or owner email (contains, any case), or a
--             workspace or owner id (exact).
--   p_filter  with_account (default) | all | positive_balance | auto_renew |
--             card | prepaid | due_7d | owner:<uuid> (that owner's
--             workspaces, with or without an account).
--   p_currency  only accounts in this currency.
--   p_sort    balance_desc (default) | period_end_asc | last_payment_desc |
--             created_desc | name_asc. Ties are broken by workspace id, so
--             pages never overlap.
-- Returns {total, items}; p_limit is clamped to 1-100.
CREATE OR REPLACE FUNCTION public.billing_admin_accounts(
  p_search   text DEFAULT NULL,
  p_filter   text DEFAULT 'with_account',
  p_currency text DEFAULT NULL,
  p_sort     text DEFAULT 'balance_desc',
  p_limit    integer DEFAULT 25,
  p_offset   integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_filter   text := coalesce(nullif(btrim(p_filter), ''), 'with_account');
  v_sort     text := coalesce(nullif(btrim(p_sort), ''), 'balance_desc');
  v_search   text := nullif(btrim(coalesce(p_search, '')), '');
  v_currency text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_limit    integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset   integer := greatest(coalesce(p_offset, 0), 0);
  v_owner    uuid;
  v_id       uuid;
  v_like     text;
  v_result   jsonb;
BEGIN
  IF v_filter LIKE 'owner:%' THEN
    BEGIN
      v_owner := substr(v_filter, 7)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'billing_admin_bad_filter';
    END;
    v_filter := 'owner';
  ELSIF v_filter NOT IN ('with_account', 'all', 'positive_balance', 'auto_renew', 'card', 'prepaid', 'due_7d') THEN
    RAISE EXCEPTION 'billing_admin_bad_filter';
  END IF;
  IF v_sort NOT IN ('balance_desc', 'period_end_asc', 'last_payment_desc', 'created_desc', 'name_asc') THEN
    RAISE EXCEPTION 'billing_admin_bad_sort';
  END IF;
  IF v_currency IS NOT NULL AND v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'billing_admin_bad_currency';
  END IF;
  IF v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_id := v_search::uuid;
  ELSIF v_search IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH base AS (
    SELECT w.id AS workspace_id, w.name, w.slug, w.owner_id, w.status AS workspace_status,
           w.created_at AS workspace_created_at,
           pr.email AS owner_email,
           a.workspace_id IS NOT NULL AS has_account,
           a.currency, a.balance_minor, a.auto_renew, a.next_period_prepaid_minor, a.next_period_start,
           a.scheduled_plan_id, a.scheduled_interval, a.created_at AS account_created_at,
           s.plan_id, bp.name AS plan_name, bp.localized AS plan_localized, bp.is_free,
           s.status, s.billing_interval, s.current_period_end, s.trial_end,
           c.status AS card_status,
           lp.last_payment_at
      FROM public.workspaces w
      LEFT JOIN public.profiles pr ON pr.id = w.owner_id
      LEFT JOIN public.billing_accounts a ON a.workspace_id = w.id
      LEFT JOIN public.workspace_subscriptions s ON s.workspace_id = w.id
      LEFT JOIN public.billing_plans bp ON bp.id = s.plan_id
      LEFT JOIN public.billing_account_cards c
        ON c.workspace_id = w.id AND c.status IN ('active', 'past_due')
      LEFT JOIN LATERAL (
        SELECT max(p.completed_at) AS last_payment_at
          FROM public.billing_account_payments p
         WHERE p.workspace_id = w.id AND p.status = 'succeeded'
      ) lp ON true
  ), filtered AS (
    SELECT * FROM base b
     WHERE CASE v_filter
             WHEN 'all' THEN true
             WHEN 'owner' THEN b.owner_id = v_owner
             WHEN 'with_account' THEN b.has_account
             WHEN 'positive_balance' THEN b.balance_minor > 0
             WHEN 'auto_renew' THEN coalesce(b.auto_renew, false)
             WHEN 'card' THEN b.card_status IS NOT NULL
             WHEN 'prepaid' THEN b.next_period_prepaid_minor IS NOT NULL
             -- Live paid subscriptions only: an expired or canceled row
             -- keeps its paid plan and old period end (for renew), and
             -- would otherwise stay in this list forever.
             WHEN 'due_7d' THEN NOT coalesce(b.is_free, true)
                                AND b.status IN ('active', 'past_due', 'trialing')
                                AND b.current_period_end IS NOT NULL
                                AND b.current_period_end < now() + interval '7 days'
           END
       AND (v_currency IS NULL OR b.currency = v_currency)
       AND (v_search IS NULL
            OR (v_id IS NOT NULL AND (b.workspace_id = v_id OR b.owner_id = v_id))
            OR (v_like IS NOT NULL AND (b.name ILIKE v_like OR b.slug ILIKE v_like OR b.owner_email ILIKE v_like)))
  ), page AS (
    SELECT f.*,
           row_number() OVER (ORDER BY
             CASE WHEN v_sort = 'balance_desc' THEN f.balance_minor END DESC NULLS LAST,
             CASE WHEN v_sort = 'period_end_asc' THEN f.current_period_end END ASC NULLS LAST,
             CASE WHEN v_sort = 'last_payment_desc' THEN f.last_payment_at END DESC NULLS LAST,
             CASE WHEN v_sort = 'created_desc' THEN coalesce(f.account_created_at, f.workspace_created_at) END DESC NULLS LAST,
             CASE WHEN v_sort IN ('name_asc', 'balance_desc') THEN lower(f.name) END ASC,
             f.workspace_id
           ) AS rn
      FROM filtered f
  )
  SELECT jsonb_build_object(
           'total', (SELECT count(*) FROM filtered),
           'items', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'workspace_id', p.workspace_id,
                      'name', p.name,
                      'slug', p.slug,
                      'workspace_status', p.workspace_status,
                      'owner_id', p.owner_id,
                      'owner_email', p.owner_email,
                      'has_account', p.has_account,
                      'currency', p.currency,
                      'balance_minor', p.balance_minor,
                      'auto_renew', p.auto_renew,
                      'next_period_prepaid_minor', p.next_period_prepaid_minor,
                      'next_period_start', p.next_period_start,
                      'scheduled_plan_id', p.scheduled_plan_id,
                      'scheduled_interval', p.scheduled_interval,
                      'plan_id', p.plan_id,
                      'plan_name', p.plan_name,
                      'plan_localized', p.plan_localized,
                      'is_free', p.is_free,
                      'status', p.status,
                      'billing_interval', p.billing_interval,
                      'current_period_end', p.current_period_end,
                      'trial_end', p.trial_end,
                      'card_status', p.card_status,
                      'last_payment_at', p.last_payment_at,
                      'ledger_count', (SELECT count(*) FROM public.billing_account_ledger l
                                        WHERE l.workspace_id = p.workspace_id),
                      'account_created_at', p.account_created_at
                    ) ORDER BY p.rn)
               FROM page p
              WHERE p.rn > v_offset AND p.rn <= v_offset + v_limit
           ), '[]'::jsonb)
         )
    INTO v_result;
  RETURN v_result;
END;
$$;

-- One account's gateway payments, every status, newest first, with the
-- refunds each one had. Returns {total, items}; p_limit is clamped to 1-100.
CREATE OR REPLACE FUNCTION public.billing_admin_account_payments(
  p_workspace_id uuid,
  p_limit        integer DEFAULT 25,
  p_offset       integer DEFAULT 0
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.billing_account_payments WHERE workspace_id = p_workspace_id),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.id,
               'provider', p.provider,
               'source', p.source,
               'purpose', p.purpose,
               'purpose_result', p.purpose_result,
               'status', p.status,
               'currency', p.currency,
               'amount_minor', p.amount_minor,
               'net_minor', p.net_minor,
               'tax_minor', p.tax_minor,
               'tax_percent', p.tax_percent,
               'refunded_minor', p.refunded_minor,
               'refunds', coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'refund_id', r.key,
                          'amount_minor', r.value -> 'amount_minor',
                          'credit_minor', r.value -> 'credit_minor',
                          'shortfall_minor', r.value -> 'shortfall_minor',
                          'released_prepaid_minor', r.value -> 'released_prepaid_minor',
                          'pack_returned_minor', r.value -> 'pack_returned_minor',
                          'refunded_at', r.value -> 'refunded_at'
                        ) ORDER BY r.value ->> 'refunded_at', r.key)
                   FROM jsonb_each(CASE WHEN jsonb_typeof(p.purpose_detail -> 'refunds') = 'object'
                                        THEN p.purpose_detail -> 'refunds' ELSE '{}'::jsonb END) AS r
                  WHERE jsonb_typeof(r.value) = 'object'
               ), '[]'::jsonb),
               'failure_reason', p.failure_reason,
               'provider_ref', p.provider_ref,
               'provider_payment_id', p.provider_payment_id,
               'ledger_id', p.ledger_id,
               'card_id', p.card_id,
               'review', p.review,
               'created_at', p.created_at,
               'completed_at', p.completed_at
             ) ORDER BY p.created_at DESC, p.id)
        FROM (
          SELECT * FROM public.billing_account_payments
           WHERE workspace_id = p_workspace_id
           ORDER BY created_at DESC, id
           LIMIT least(greatest(coalesce(p_limit, 25), 1), 100)
          OFFSET greatest(coalesce(p_offset, 0), 0)
        ) p
    ), '[]'::jsonb)
  );
$$;

-- Money that came in, per local day (p_time_zone; the edition's: Asia/Tehran
-- or UTC) in [p_from, p_to):
--   metric 'payment'  succeeded gateway payments, by completed_at: gross is
--                     what the gateway charged, net what the balance got.
--   metric 'refund'   refunds the providers reported, by refunded_at: gross
--                     is the refund, net the credit taken back, tax the rest.
-- Split by currency, provider, source and purpose (the refunded payment's).
-- Never added across currencies; the server drops test gateways.
--
-- Returns ONE jsonb array of {day, metric, currency, provider, source,
-- purpose, count, gross_minor, tax_minor, net_minor}, not a set of rows:
-- PostgREST (and the postgres-only engine) cap a set-returning RPC at
-- db-max-rows (1000 by default) without an error, and a 12- to 36-month
-- window easily has more rows than that. A scalar has no such cap.
DROP FUNCTION IF EXISTS public.billing_admin_revenue_days(timestamptz, timestamptz, text);
CREATE FUNCTION public.billing_admin_revenue_days(
  p_from      timestamptz,
  p_to        timestamptz,
  p_time_zone text DEFAULT 'UTC'
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.day, t.metric, t.currency, t.provider, t.source, t.purpose), '[]'::jsonb)
    FROM (
  SELECT (p.completed_at AT TIME ZONE coalesce(p_time_zone, 'UTC'))::date,
         'payment'::text, p.currency, p.provider, p.source, p.purpose,
         count(*)::bigint, sum(p.amount_minor)::bigint, sum(p.tax_minor)::bigint, sum(p.net_minor)::bigint
    FROM public.billing_account_payments p
   WHERE p.status = 'succeeded'
     AND p.completed_at >= p_from AND p.completed_at < p_to
   GROUP BY 1, 3, 4, 5, 6
  UNION ALL
  SELECT (r.at AT TIME ZONE coalesce(p_time_zone, 'UTC'))::date,
         'refund'::text, r.currency, r.provider, r.source, r.purpose,
         count(*)::bigint, sum(r.gross)::bigint, sum(r.gross - r.net)::bigint, sum(r.net)::bigint
    FROM (
      SELECT p.currency, p.provider, p.source, p.purpose,
             coalesce((e.value ->> 'refunded_at')::timestamptz, p.updated_at) AS at,
             coalesce((e.value ->> 'amount_minor')::bigint, 0) AS gross,
             coalesce((e.value ->> 'credit_minor')::bigint, 0) AS net
        FROM public.billing_account_payments p
        CROSS JOIN LATERAL jsonb_each(p.purpose_detail -> 'refunds') AS e
       WHERE jsonb_typeof(p.purpose_detail -> 'refunds') = 'object'
         AND jsonb_typeof(e.value) = 'object'
    ) r
   WHERE r.at >= p_from AND r.at < p_to
   GROUP BY 1, 3, 4, 5, 6
    ) AS t (day, metric, currency, provider, source, purpose, count, gross_minor, tax_minor, net_minor);
$$;

-- Balance movements per local day, currency and ledger kind: money in
-- (positive amounts) and out (negative amounts, as positive numbers). Not
-- revenue: a top-up and the renewal it pays are both here.
-- One jsonb array of {day, currency, kind, count, in_minor, out_minor}, for
-- the same reason as billing_admin_revenue_days (no db-max-rows cap).
DROP FUNCTION IF EXISTS public.billing_admin_ledger_days(timestamptz, timestamptz, text);
CREATE FUNCTION public.billing_admin_ledger_days(
  p_from      timestamptz,
  p_to        timestamptz,
  p_time_zone text DEFAULT 'UTC'
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.day, t.currency, t.kind), '[]'::jsonb)
    FROM (
      SELECT (l.created_at AT TIME ZONE coalesce(p_time_zone, 'UTC'))::date,
             l.currency, l.kind, count(*)::bigint,
             coalesce(sum(l.amount_minor) FILTER (WHERE l.amount_minor > 0), 0)::bigint,
             coalesce(-sum(l.amount_minor) FILTER (WHERE l.amount_minor < 0), 0)::bigint
        FROM public.billing_account_ledger l
       WHERE l.created_at >= p_from AND l.created_at < p_to
       GROUP BY 1, 2, 3
    ) AS t (day, currency, kind, count, in_minor, out_minor);
$$;

-- What the platform owes now, per currency: the balances (service credit not
-- spent yet) and the next periods already paid for.
CREATE OR REPLACE FUNCTION public.billing_admin_liability()
RETURNS TABLE (
  currency          text,
  accounts          bigint,
  positive_accounts bigint,
  balance_minor     bigint,
  prepaid_minor     bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.currency,
         count(*)::bigint,
         count(*) FILTER (WHERE a.balance_minor > 0)::bigint,
         coalesce(sum(a.balance_minor), 0)::bigint,
         coalesce(sum(a.next_period_prepaid_minor), 0)::bigint
    FROM public.billing_accounts a
   GROUP BY a.currency
   ORDER BY a.currency;
$$;

-- ─── 5. Access: service_role only ─────────────────────────────────────────
DO $acl$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text, text, bigint)',
    'public.billing_account_payments_stamp_refunds()',
    'public.billing_admin_accounts(text, text, text, text, integer, integer)',
    'public.billing_admin_account_payments(uuid, integer, integer)',
    'public.billing_admin_revenue_days(timestamptz, timestamptz, text)',
    'public.billing_admin_ledger_days(timestamptz, timestamptz, text)',
    'public.billing_admin_liability()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl$;
