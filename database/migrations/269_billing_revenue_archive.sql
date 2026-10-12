-- 269 — Revenue survives a workspace purge (docs/billing/SIMPLE_BILLING.md,
-- phase 6 "Known limits", follow-up).
--
-- A workspace deleted for good (admin_purge_workspaces, 263, used by
-- workspace and user deletion; or a plain workspace delete's ON DELETE
-- CASCADE) takes its gateway payments (billing_account_payments) and its
-- balance ledger (billing_account_ledger) with it, so Super Admin → Finance
-- → Revenue for a month already closed came out lower afterwards. From this
-- file on, the money facts of those rows are copied into two append-only
-- archives as the rows go, and the report reads them, so a closed month
-- never changes:
--
--   billing_revenue_archive  one row per deleted payment that is revenue:
--                            succeeded, or carrying refunds. Purpose,
--                            provider, source, status, currency, amount, net,
--                            tax, tax_percent, refunded_minor, the refunds
--                            (purpose_detail.refunds as it was, each with its
--                            refunded_at), created/updated/completed_at, the
--                            workspace's id and name at that moment.
--   billing_ledger_archive   one row per deleted ledger row: kind, amount,
--                            currency, net, tax, receipt number, payment id,
--                            created_at, the workspace's id.
--
-- No personal data is copied (no buyer, created_by, actor_id, description
-- or return_url): the purge is a deletion, and only what the revenue report
-- and the receipt sequence need stays.
--
-- How a row gets there: an AFTER DELETE row trigger on each source table
-- (SECURITY DEFINER; a trigger function cannot be called directly). AFTER
-- triggers fire only for rows really deleted, so a row 263's purge keeps (a
-- payment or ledger row of a workspace that survives a user's deletion) is
-- not archived. The purge deletes payments and ledger rows before the
-- workspace, so the workspace's name is still there to copy; a plain
-- workspace delete cascades after the workspace row is gone, and the name is
-- then NULL. The pruning job (unpaid attempts only) never matches.
--
-- Who can write the archives: nobody directly. PUBLIC, anon, authenticated
-- and service_role have no INSERT, UPDATE, DELETE or TRUNCATE on them;
-- service_role may SELECT (RLS on, one read-only policy). An UPDATE or a
-- DELETE is refused by a trigger for every role, the owner too, except the
-- one the copy itself makes when a payment restored from a backup is
-- deleted again: it adds the refunds the payment got in between (and raises
-- refunded_minor, updated_at), never changes or removes anything. The only way
-- in is deleting a real succeeded (or refunded) payment or a ledger row,
-- and the archive then holds that row as it was. The column naming the
-- workspace is `purged_workspace_id`, never `workspace_id`: the purge
-- (admin_purge_workspaces_core) deletes from every public table with a uuid
-- `workspace_id` column, and admin_delete_user from every one with a user
-- column (user_id, created_by, actor_id, …); neither may reach the archive.
--
-- The reports (266): billing_admin_revenue_days and billing_admin_ledger_days
-- add the archived rows whose source row no longer exists (a row restored
-- from a backup is never counted twice). Same arguments, same jsonb shape.
--
-- Payments purged before this file are not recoverable here (only from a
-- backup taken before the purge); those months stay as they are.
--
-- One transaction; lock_timeout 5s. The two source tables are locked first,
-- in the order requests take them (payments, then the ledger), for the
-- CREATE TRIGGERs. Re-runnable: every step is guarded or a no-op the second
-- time; a trigger is created only when missing, never dropped, so a second
-- run takes nothing stronger than that first lock. Server-only: every function here is reachable by service_role alone.
-- Dry run: the file with its final COMMIT; turned into ROLLBACK;.

BEGIN;

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.billing_account_payments, public.billing_account_ledger IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. The archives ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_revenue_archive (
  payment_id          uuid PRIMARY KEY,
  purged_workspace_id uuid NOT NULL,
  workspace_name      text,
  provider            text NOT NULL,
  source              text NOT NULL,
  purpose             text NOT NULL,
  status              text NOT NULL,
  currency            text NOT NULL,
  amount_minor        bigint NOT NULL,
  net_minor           bigint NOT NULL,
  tax_minor           bigint NOT NULL,
  tax_percent         numeric(6,3),
  refunded_minor      bigint NOT NULL,
  -- purpose_detail.refunds as it was ({refund id: {amount_minor,
  -- credit_minor, …, refunded_at}}), or {}.
  refunds             jsonb NOT NULL,
  provider_payment_id text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  completed_at        timestamptz,
  archived_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_revenue_archive_completed_idx
  ON public.billing_revenue_archive (completed_at) WHERE status = 'succeeded';
CREATE INDEX IF NOT EXISTS billing_revenue_archive_workspace_idx
  ON public.billing_revenue_archive (purged_workspace_id);

CREATE TABLE IF NOT EXISTS public.billing_ledger_archive (
  ledger_id           uuid PRIMARY KEY,
  purged_workspace_id uuid NOT NULL,
  kind                text NOT NULL,
  amount_minor        bigint NOT NULL,
  currency            text NOT NULL,
  net_minor           bigint,
  tax_minor           bigint,
  receipt_number      text,
  payment_id          uuid,
  created_at          timestamptz NOT NULL,
  archived_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_ledger_archive_created_idx
  ON public.billing_ledger_archive (created_at);
CREATE INDEX IF NOT EXISTS billing_ledger_archive_workspace_idx
  ON public.billing_ledger_archive (purged_workspace_id);

-- Append-only, for every role (the owner too). No TRUNCATE trigger, as for
-- billing_account_ledger: no application role holds TRUNCATE, and a database
-- move (scripts/db/move-data.sh) truncates the target's tables before it
-- loads them.
--
-- One UPDATE is let through, on billing_revenue_archive only: the copy made
-- when a payment restored from a backup is deleted again (section 2). It
-- may only ADD refunds (every refund already archived stays, as it was),
-- raise refunded_minor and move updated_at forward; every other column must
-- stay as it is. Nothing is ever taken out of the archive.
CREATE OR REPLACE FUNCTION public.billing_archive_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_kept constant text[] := ARRAY['refunds', 'refunded_minor', 'updated_at'];
BEGIN
  -- Read through to_jsonb: this function serves the ledger archive too,
  -- whose rows have no such columns.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'billing_revenue_archive' THEN
    IF (to_jsonb(NEW) - v_kept) = (to_jsonb(OLD) - v_kept)
       AND jsonb_typeof(to_jsonb(NEW) -> 'refunds') = 'object'
       AND (to_jsonb(NEW) -> 'refunds') @> (to_jsonb(OLD) -> 'refunds')
       AND (to_jsonb(NEW) ->> 'refunded_minor')::bigint >= (to_jsonb(OLD) ->> 'refunded_minor')::bigint
       AND (to_jsonb(NEW) ->> 'updated_at')::timestamptz >= (to_jsonb(OLD) ->> 'updated_at')::timestamptz THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

-- Every trigger in this file is created only when it is missing, never
-- dropped and made again: a DROP TRIGGER takes ACCESS EXCLUSIVE on its table,
-- which on a second run (after the SHARE ROW EXCLUSIVE taken above) would
-- deadlock with a settle or a refund in flight, or wait out lock_timeout
-- behind a long reader (the nightly pg_dump). A changed trigger function
-- reaches the existing trigger through CREATE OR REPLACE FUNCTION.
DO $trg$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.billing_revenue_archive'::regclass
                    AND tgname = 'trg_billing_revenue_archive_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_billing_revenue_archive_immutable
      BEFORE UPDATE OR DELETE ON public.billing_revenue_archive
      FOR EACH ROW EXECUTE FUNCTION public.billing_archive_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.billing_ledger_archive'::regclass
                    AND tgname = 'trg_billing_ledger_archive_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_billing_ledger_archive_immutable
      BEFORE UPDATE OR DELETE ON public.billing_ledger_archive
      FOR EACH ROW EXECUTE FUNCTION public.billing_archive_immutable();
  END IF;
END
$trg$;

-- ─── 2. Copied as the source rows go ──────────────────────────────────────
-- SECURITY DEFINER: the deleting role (service_role in a direct delete) has
-- no INSERT on the archives, and needs none.
CREATE OR REPLACE FUNCTION public.billing_account_payments_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.billing_revenue_archive (
    payment_id, purged_workspace_id, workspace_name,
    provider, source, purpose, status, currency,
    amount_minor, net_minor, tax_minor, tax_percent, refunded_minor, refunds,
    provider_payment_id, created_at, updated_at, completed_at
  ) VALUES (
    OLD.id, OLD.workspace_id,
    (SELECT w.name FROM public.workspaces w WHERE w.id = OLD.workspace_id),
    OLD.provider, OLD.source, OLD.purpose, OLD.status, OLD.currency,
    OLD.amount_minor, OLD.net_minor, OLD.tax_minor, OLD.tax_percent, OLD.refunded_minor,
    CASE WHEN jsonb_typeof(OLD.purpose_detail -> 'refunds') = 'object'
         THEN OLD.purpose_detail -> 'refunds' ELSE '{}'::jsonb END,
    OLD.provider_payment_id, OLD.created_at, OLD.updated_at, OLD.completed_at
  )
  -- Archived before: the payment was restored (from a backup) and deleted
  -- again. Refunds it got in between are added (an archived refund keeps
  -- its archived value), so a closed month's refunds never drop; nothing
  -- else of the first copy changes (the immutability trigger lets only
  -- this through).
  ON CONFLICT (payment_id) DO UPDATE
     SET refunds        = EXCLUDED.refunds || billing_revenue_archive.refunds,
         refunded_minor = greatest(billing_revenue_archive.refunded_minor, EXCLUDED.refunded_minor),
         updated_at     = greatest(billing_revenue_archive.updated_at, EXCLUDED.updated_at)
   WHERE NOT (billing_revenue_archive.refunds @> EXCLUDED.refunds)
      OR EXCLUDED.refunded_minor > billing_revenue_archive.refunded_minor
      OR EXCLUDED.updated_at > billing_revenue_archive.updated_at;
  RETURN NULL;
END;
$$;

DO $trg$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.billing_account_payments'::regclass
                    AND tgname = 'trg_billing_account_payments_archive' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_billing_account_payments_archive
      AFTER DELETE ON public.billing_account_payments
      FOR EACH ROW
      WHEN (OLD.status = 'succeeded' OR jsonb_typeof(OLD.purpose_detail -> 'refunds') = 'object')
      EXECUTE FUNCTION public.billing_account_payments_archive();
  END IF;
END
$trg$;

CREATE OR REPLACE FUNCTION public.billing_account_ledger_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.billing_ledger_archive (
    ledger_id, purged_workspace_id, kind, amount_minor, currency,
    net_minor, tax_minor, receipt_number, payment_id, created_at
  ) VALUES (
    OLD.id, OLD.workspace_id, OLD.kind, OLD.amount_minor, OLD.currency,
    OLD.net_minor, OLD.tax_minor, OLD.receipt_number, OLD.payment_id, OLD.created_at
  )
  ON CONFLICT (ledger_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DO $trg$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.billing_account_ledger'::regclass
                    AND tgname = 'trg_billing_account_ledger_archive' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_billing_account_ledger_archive
      AFTER DELETE ON public.billing_account_ledger
      FOR EACH ROW EXECUTE FUNCTION public.billing_account_ledger_archive();
  END IF;
END
$trg$;

-- ─── 3. The reports read the archives (266's functions, same shape) ───────
CREATE OR REPLACE FUNCTION public.billing_admin_revenue_days(
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
    FROM (
      SELECT l.currency, l.provider, l.source, l.purpose, l.completed_at, l.amount_minor, l.tax_minor, l.net_minor
        FROM public.billing_account_payments l
       WHERE l.status = 'succeeded'
         AND l.completed_at >= p_from AND l.completed_at < p_to
      UNION ALL
      -- Payments of deleted workspaces (269) whose row is gone.
      SELECT a.currency, a.provider, a.source, a.purpose, a.completed_at, a.amount_minor, a.tax_minor, a.net_minor
        FROM public.billing_revenue_archive a
       WHERE a.status = 'succeeded'
         AND a.completed_at >= p_from AND a.completed_at < p_to
         AND NOT EXISTS (SELECT 1 FROM public.billing_account_payments x WHERE x.id = a.payment_id)
    ) p
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
        FROM (
          SELECT l.currency, l.provider, l.source, l.purpose, l.updated_at, l.purpose_detail -> 'refunds' AS refunds
            FROM public.billing_account_payments l
           WHERE jsonb_typeof(l.purpose_detail -> 'refunds') = 'object'
          UNION ALL
          SELECT a.currency, a.provider, a.source, a.purpose, a.updated_at, a.refunds
            FROM public.billing_revenue_archive a
           WHERE jsonb_typeof(a.refunds) = 'object' AND a.refunds <> '{}'::jsonb
             AND NOT EXISTS (SELECT 1 FROM public.billing_account_payments x WHERE x.id = a.payment_id)
        ) p
        CROSS JOIN LATERAL jsonb_each(p.refunds) AS e
       WHERE jsonb_typeof(e.value) = 'object'
    ) r
   WHERE r.at >= p_from AND r.at < p_to
   GROUP BY 1, 3, 4, 5, 6
    ) AS t (day, metric, currency, provider, source, purpose, count, gross_minor, tax_minor, net_minor);
$$;

CREATE OR REPLACE FUNCTION public.billing_admin_ledger_days(
  p_from      timestamptz,
  p_to        timestamptz,
  p_time_zone text DEFAULT 'UTC'
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH l AS (
    SELECT l.currency, l.kind, l.amount_minor, l.created_at
      FROM public.billing_account_ledger l
     WHERE l.created_at >= p_from AND l.created_at < p_to
    UNION ALL
    SELECT a.currency, a.kind, a.amount_minor, a.created_at
      FROM public.billing_ledger_archive a
     WHERE a.created_at >= p_from AND a.created_at < p_to
       AND NOT EXISTS (SELECT 1 FROM public.billing_account_ledger x WHERE x.id = a.ledger_id)
  )
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.day, t.currency, t.kind), '[]'::jsonb)
    FROM (
      SELECT (l.created_at AT TIME ZONE coalesce(p_time_zone, 'UTC'))::date,
             l.currency, l.kind, count(*)::bigint,
             coalesce(sum(l.amount_minor) FILTER (WHERE l.amount_minor > 0), 0)::bigint,
             coalesce(-sum(l.amount_minor) FILTER (WHERE l.amount_minor < 0), 0)::bigint
        FROM l
       GROUP BY 1, 2, 3
    ) AS t (day, currency, kind, count, in_minor, out_minor);
$$;

-- ─── 4. Access ────────────────────────────────────────────────────────────
DO $acl$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_revenue_archive', 'billing_ledger_archive'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      -- Read only: the default privileges of a hosted install may have
      -- granted it more when the table was created.
      EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
      EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = t AND policyname = 'service_role_read'
      ) THEN
        EXECUTE format(
          'CREATE POLICY service_role_read ON public.%I FOR SELECT TO service_role USING (true)', t);
      END IF;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.billing_archive_immutable()',
    'public.billing_account_payments_archive()',
    'public.billing_account_ledger_archive()',
    'public.billing_admin_revenue_days(timestamptz, timestamptz, text)',
    'public.billing_admin_ledger_days(timestamptz, timestamptz, text)'
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
END
$acl$;

-- ─── 5. Post-checks (one exception lists every failure) ───────────────────
DO $post$
DECLARE
  v_fail text[] := '{}';
  v_role text;
  v_list text;
BEGIN
  -- The purge and admin_delete_user must not see the archives as theirs.
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ') INTO v_list
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.oid IN ('public.billing_revenue_archive'::regclass, 'public.billing_ledger_archive'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname IN (
       'workspace_id', 'conversation_id',
       'user_id','owner_id','actor_user_id','created_by','updated_by','assigned_to',
       'assigned_user_id','operator_id','agent_id','invited_by','requested_by',
       'uploaded_by','resolved_by','reviewed_by','sender_user_id','actor_id',
       'deleted_by','author_id','member_user_id','target_user_id','admin_user_id');
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('archive columns the purge would delete by: ' || v_list); END IF;

  SELECT string_agg(x.name, ', ') INTO v_list
    FROM (VALUES
      ('public.billing_revenue_archive', 'trg_billing_revenue_archive_immutable'),
      ('public.billing_ledger_archive', 'trg_billing_ledger_archive_immutable'),
      ('public.billing_account_payments', 'trg_billing_account_payments_archive'),
      ('public.billing_account_ledger', 'trg_billing_account_ledger_archive')
    ) AS x(tbl, name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = x.tbl::regclass AND g.tgname = x.name AND NOT g.tgisinternal);
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('missing triggers: ' || v_list); END IF;

  IF position('billing_revenue_archive' IN pg_get_functiondef('public.billing_admin_revenue_days(timestamptz, timestamptz, text)'::regprocedure)) = 0
     OR position('billing_ledger_archive' IN pg_get_functiondef('public.billing_admin_ledger_days(timestamptz, timestamptz, text)'::regprocedure)) = 0 THEN
    v_fail := v_fail || 'the revenue reports do not read the archives'::text;
  END IF;

  FOREACH v_role IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN v_role <> 'public' AND to_regrole(v_role) IS NULL;
    SELECT string_agg(c.relname, ', ') INTO v_list FROM pg_class c
     WHERE c.oid IN ('public.billing_revenue_archive'::regclass, 'public.billing_ledger_archive'::regclass)
       AND (has_table_privilege(v_role, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR has_any_column_privilege(v_role, c.oid, 'INSERT, UPDATE'));
    IF v_list IS NOT NULL THEN v_fail := v_fail || format('%s can write {%s}', v_role, v_list); END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    CONTINUE WHEN to_regrole(v_role) IS NULL;
    IF has_table_privilege(v_role, 'public.billing_revenue_archive', 'SELECT')
       OR has_table_privilege(v_role, 'public.billing_ledger_archive', 'SELECT') THEN
      v_fail := v_fail || format('%s can read an archive', v_role);
    END IF;
  END LOOP;

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'billing_revenue_archive_check_failed: %', array_to_string(v_fail, ' | ');
  END IF;
END
$post$;

COMMIT;
