-- 263 — The workspace and user purge gets through the simple billing ledger
-- (docs/billing/SIMPLE_BILLING.md).
--
-- Since 259 the balance ledger (billing_account_ledger) is append-only: its
-- trigger lets a row go only in the cascade of its workspace's delete
-- (trigger depth > 1). admin_purge_workspaces (251) deletes every
-- workspace-scoped table directly, before the workspace, so it hit that
-- trigger ('billing_account_ledger is append-only', P0001, which the purge's
-- retry loop does not catch) and the whole purge rolled back:
-- admin_delete_workspace and admin_delete_user failed for any workspace that
-- ever had a ledger row, and the deletion jobs stayed in `deleting`.
--
-- The fix, without copying the purge's body:
--   1. admin_purge_workspaces keeps its body under a new name,
--      admin_purge_workspaces_core (renamed once; a re-run finds it renamed).
--   2. A new admin_purge_workspaces records, transaction-local, which
--      workspaces are being purged (app.billing_purge_workspaces, appended
--      to, as admin_delete_user may purge more than once) and calls the core.
--      admin_delete_workspace and admin_delete_user call it by that name and
--      are not changed.
--   3. The ledger's trigger lets a purge delete the rows of the workspaces
--      it purges. Any other delete inside a purge (admin_delete_user deletes
--      every row whose actor_id is the user) keeps the row: a workspace that
--      survives keeps its whole ledger and its balance_after chain, with
--      actor_id left pointing at nobody (the column has no foreign key).
--      UPDATE is always refused; outside a purge a direct DELETE is too.
--   4. The same for gateway payments (billing_account_payments): inside a
--      purge, a payment of a workspace that survives is kept
--      (admin_delete_user deletes rows whose created_by is the user, and a
--      payment is the record a late gateway callback or a refund is settled
--      against). Outside a purge nothing changes (the pruning job deletes
--      old unpaid attempts).
--
-- The saved cards (262) need nothing: the purge's delete of a card that is
-- not cancelled yet turns into `canceling` and the row stays (no foreign key
-- to its workspace), so the job still cancels it at Paddle.
--
-- Server-only: every function here is reachable by service_role alone.
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. The purge's body, under its new name ──────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.admin_purge_workspaces_core(uuid[])') IS NULL THEN
    ALTER FUNCTION public.admin_purge_workspaces(uuid[]) RENAME TO admin_purge_workspaces_core;
  END IF;
END $$;

-- ─── 2. The purge: names the workspaces it purges, then runs the body ─────
CREATE OR REPLACE FUNCTION public.admin_purge_workspaces(_ws uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.billing_purge', 'on', true);
  -- Appended to: admin_delete_user, or a caller purging in several calls in
  -- one transaction, keeps every workspace it purged in the list.
  PERFORM set_config(
    'app.billing_purge_workspaces',
    concat_ws(',',
      nullif(current_setting('app.billing_purge_workspaces', true), ''),
      nullif(array_to_string(_ws, ','), '')),
    true);
  RETURN public.admin_purge_workspaces_core(_ws);
END;
$function$;

-- True inside a purge for a workspace that purge is deleting.
CREATE OR REPLACE FUNCTION public.billing_purge_includes(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p_workspace_id IS NOT NULL
     AND p_workspace_id::text = ANY (string_to_array(
           coalesce(current_setting('app.billing_purge_workspaces', true), ''), ','));
$$;

-- ─── 3. The ledger: append-only, except for the workspaces being purged ───
CREATE OR REPLACE FUNCTION public.billing_account_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The cascade of its workspace's delete.
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    IF public.billing_purge_active() THEN
      IF public.billing_purge_includes(OLD.workspace_id) THEN
        RETURN OLD;
      END IF;
      -- A purge of something else (a user's rows by actor_id): the row stays.
      RETURN NULL;
    END IF;
  END IF;
  RAISE EXCEPTION 'billing_account_ledger is append-only';
END;
$$;

-- ─── 4. Payments: a purge keeps those of the workspaces that survive ──────
CREATE OR REPLACE FUNCTION public.billing_account_payments_keep_on_purge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF public.billing_purge_active() AND NOT public.billing_purge_includes(OLD.workspace_id) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_account_payments_keep_on_purge ON public.billing_account_payments;
CREATE TRIGGER trg_billing_account_payments_keep_on_purge
  BEFORE DELETE ON public.billing_account_payments
  FOR EACH ROW EXECUTE FUNCTION public.billing_account_payments_keep_on_purge();

-- ─── 5. Access: as admin_purge_workspaces had (182, 217) ──────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.admin_purge_workspaces(uuid[])',
    'public.admin_purge_workspaces_core(uuid[])',
    'public.billing_purge_includes(uuid)',
    'public.billing_account_ledger_immutable()',
    'public.billing_account_payments_keep_on_purge()'
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
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.admin_purge_workspaces_core(uuid[])') IS NULL
     OR to_regprocedure('public.admin_purge_workspaces(uuid[])') IS NULL THEN
    RAISE EXCEPTION '263_billing_purge_ledger: admin_purge_workspaces or its core is missing';
  END IF;
  IF position('admin_purge_workspaces_core' IN
       pg_get_functiondef('public.admin_purge_workspaces(uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '263_billing_purge_ledger: admin_purge_workspaces is not the wrapper';
  END IF;
END;
$verify$;
