-- 271 — Plans: storage in megabytes, and one monthly AI credit.
--
-- Storage. The plan limit becomes `limits.storage_mb` (megabytes; -1 =
-- unlimited, 0 = no file storage), converted from `storage_gb` × 1024. The
-- old key stays on each plan for the code that runs until the new code is
-- deployed (WebYar applies this file by hand first; RESPOK's migrator runs
-- it on the same push as the code); the new code reads `storage_mb`, falls
-- back to `storage_gb` × 1024 only where `storage_mb` is absent
-- (shared/planLimits.ts), and the plan editor saves `storage_mb` only.
-- Workspace overrides keyed `storage_gb` get a `storage_mb` copy (× 1024);
-- the old row stays for the old code, and setting or removing the MB
-- override removes it (server/routes/plans.ts).
--
-- AI credit. A plan's monthly AI credit is what billing_plan_ai_allowance
-- (261) grants: `ai_allowance.IRR`, else `limits.included_ai_allowance_irr`,
-- else `limits.ai_credits_per_month`. Plans carried a second, different
-- number next to it (Startup: ai_allowance.IRR 300000 but
-- ai_credits_per_month 0) that the downgrade report and other screens
-- showed. Here every plan gets its granted amount written as
-- `ai_allowance.IRR` (the value billing_plan_ai_allowance returns now, so no
-- grant changes), `limits.included_ai_allowance_irr` mirrors it (as every plan editor
-- save does), and the legacy `limits.ai_credits_per_month`
-- is removed. Workspace overrides keyed `ai_credits_per_month` are left as
-- they are: the grant never read them, and turning them into credit would
-- start granting money (the owner decides; a NOTICE counts them).
--
-- Functions. billing_storage_limit_mb(ws, plan): the storage limit that
-- blocks uploads, in MB (storage_mb, else storage_gb × 1024; NULL =
-- unlimited, absent or unreadable). billing_lock_report answers storage in
-- MB (limit_mb, used_mb) and keeps 265's limit_gb/used_gb for old code.
--
-- Re-runnable: every UPDATE changes only rows that still differ, the
-- override copy is ON CONFLICT DO NOTHING, and the functions are CREATE OR
-- REPLACE. Works on both editions' databases. Dry run: wrap the file in
-- BEGIN; … ROLLBACK; (it opens no transaction of its own). Deletes no row.

-- ─── 1. storage_mb on every plan that names storage_gb ───────────────────
UPDATE public.billing_plans p
   SET limits = coalesce(p.limits, '{}'::jsonb)
                || jsonb_build_object('storage_mb',
                     CASE WHEN public.billing_jsonb_number(p.limits -> 'storage_gb') < 0 THEN -1
                          ELSE round(public.billing_jsonb_number(p.limits -> 'storage_gb') * 1024)::bigint END),
       updated_at = now()
 WHERE public.billing_jsonb_number(p.limits -> 'storage_gb') IS NOT NULL
   AND public.billing_jsonb_number(p.limits -> 'storage_mb') IS DISTINCT FROM
       CASE WHEN public.billing_jsonb_number(p.limits -> 'storage_gb') < 0 THEN -1
            ELSE round(public.billing_jsonb_number(p.limits -> 'storage_gb') * 1024) END;

-- ─── 2. A storage_mb copy of every storage_gb workspace override ─────────
DO $$
BEGIN
  IF to_regclass('public.workspace_limit_overrides') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value, admin_notes, created_at, updated_at)
  SELECT o.workspace_id, 'storage_mb',
         CASE WHEN o.limit_value < 0 THEN -1 ELSE o.limit_value * 1024 END,
         o.admin_notes, now(), now()
    FROM public.workspace_limit_overrides o
   WHERE o.limit_key = 'storage_gb'
     AND o.limit_value <= 2097151          -- × 1024 still fits an integer
  ON CONFLICT (workspace_id, limit_key) DO NOTHING;
END $$;

-- ─── 3. One monthly AI credit per plan ───────────────────────────────────
-- 3a. ai_allowance.IRR names what is granted today (no grant changes).
UPDATE public.billing_plans p
   SET ai_allowance = coalesce(p.ai_allowance, '{}'::jsonb)
                      || jsonb_build_object('IRR', round(public.billing_plan_ai_allowance(p.id, NULL))::bigint),
       updated_at = now()
 WHERE public.billing_jsonb_number(coalesce(p.ai_allowance, '{}'::jsonb) -> 'IRR') IS NULL;

-- 3b. The limits mirror it; the legacy count goes.
UPDATE public.billing_plans p
   SET limits = (coalesce(p.limits, '{}'::jsonb) - 'ai_credits_per_month')
                || jsonb_build_object('included_ai_allowance_irr',
                                      round(public.billing_jsonb_number(p.ai_allowance -> 'IRR'))::bigint),
       updated_at = now()
 WHERE public.billing_jsonb_number(p.ai_allowance -> 'IRR') IS NOT NULL
   AND (coalesce(p.limits, '{}'::jsonb) ? 'ai_credits_per_month'
        OR public.billing_jsonb_number(p.limits -> 'included_ai_allowance_irr')
           IS DISTINCT FROM round(public.billing_jsonb_number(p.ai_allowance -> 'IRR')));

DO $$
DECLARE
  v_count integer := 0;
BEGIN
  IF to_regclass('public.workspace_limit_overrides') IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.workspace_limit_overrides WHERE limit_key = 'ai_credits_per_month';
  END IF;
  IF v_count > 0 THEN
    RAISE NOTICE '271: % workspace override(s) keyed ai_credits_per_month were never read by the AI grant and are left unchanged', v_count;
  END IF;
END $$;

-- ─── 4. The storage limit that blocks uploads, in MB ─────────────────────
-- storage_mb (override, then plan), else storage_gb × 1024 (override, then
-- plan): a whole number >= 0, else NULL (unlimited: -1; absent; unreadable).
CREATE OR REPLACE FUNCTION public.billing_storage_limit_mb(p_workspace_id uuid, p_plan_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN v >= 0 AND v = trunc(v) AND v <= 9223372036854775807 THEN v::bigint END
    FROM (SELECT coalesce(public.billing_limit_raw(p_workspace_id, 'storage_mb', p_plan_id),
                          CASE WHEN g < 0 THEN -1 ELSE round(g * 1024) END) AS v
            FROM (SELECT public.billing_limit_raw(p_workspace_id, 'storage_gb', p_plan_id) AS g) y) x
$$;

-- ─── 5. The downgrade report: 265's, storage in MB ───────────────────────
CREATE OR REPLACE FUNCTION public.billing_lock_report(p_workspace_id uuid, p_plan_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan      uuid := coalesce(p_plan_id, public.billing_effective_plan_id(p_workspace_id));
  v_kb        record;
  v_contact   record;
  v_member    record;
  v_conv      record;
  v_seats     bigint;
  v_retention integer;
  v_conv_lim  bigint;
  v_conv_used bigint;
  v_store_lim bigint;
  v_bytes     bigint;
  v_kb_items  jsonb;
  v_members   jsonb;
  v_oldest    timestamptz;
  v_any       boolean;
  v_period    text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
BEGIN
  SELECT * INTO v_kb FROM public.billing_lock_compute(p_workspace_id, 'kb_article', v_plan);
  SELECT * INTO v_contact FROM public.billing_lock_compute(p_workspace_id, 'contact', v_plan);
  SELECT * INTO v_member FROM public.billing_lock_compute(p_workspace_id, 'member', v_plan);
  SELECT * INTO v_conv FROM public.billing_lock_compute(p_workspace_id, 'conversation', v_plan);
  v_seats := public.billing_effective_limit(p_workspace_id, 'max_agents', v_plan);
  SELECT p.locked_data_retention_days INTO v_retention FROM public.billing_plans p WHERE p.id = v_plan;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title) ORDER BY r.ts, r.id), '[]'::jsonb)
    INTO v_kb_items
    FROM public.billing_lock_rows_after(p_workspace_id, 'kb_article', v_kb.cut_ts, v_kb.cut_id, 50) r
    JOIN public.knowledge_base_articles a ON a.id = r.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', r.id, 'name', pr.full_name, 'email', pr.email)
                            ORDER BY r.ts, r.id), '[]'::jsonb)
    INTO v_members
    FROM public.billing_lock_rows_after(p_workspace_id, 'member', v_member.cut_ts, v_member.cut_id, 50) r
    LEFT JOIN public.profiles pr ON pr.id = r.id;
  IF v_conv.cut_ts IS NOT NULL THEN
    SELECT min(coalesce(c.updated_at, c.created_at)) INTO v_oldest
      FROM public.conversations c
     WHERE c.workspace_id = p_workspace_id
       AND coalesce(c.updated_at, c.created_at, '-infinity'::timestamptz) >= v_conv.cut_ts;
  END IF;

  v_conv_lim := public.billing_effective_limit(p_workspace_id, 'max_conversations', v_plan);
  SELECT coalesce(u.conversations_count, 0) INTO v_conv_used
    FROM public.workspace_usage_counters u WHERE u.workspace_id = p_workspace_id AND u.period = v_period;
  v_conv_used := coalesce(v_conv_used, 0);
  v_store_lim := public.billing_storage_limit_mb(p_workspace_id, v_plan);
  -- Storage in use: the current month's counter, else the newest earlier one
  -- (usageResolvers.ts readStorageBytes).
  SELECT u.storage_bytes INTO v_bytes
    FROM public.workspace_usage_counters u
   WHERE u.workspace_id = p_workspace_id AND u.period <= v_period
   ORDER BY u.period DESC LIMIT 1;
  v_bytes := coalesce(v_bytes, 0);

  v_any := coalesce(v_kb.locked, 0) > 0 OR coalesce(v_contact.locked, 0) > 0
        OR coalesce(v_member.locked, 0) > 0 OR coalesce(v_conv.locked, 0) > 0;

  RETURN jsonb_build_object(
    'plan_id', v_plan,
    'locks_enabled', public.billing_locks_enabled(),
    'has_locks', v_any,
    'kb_article', jsonb_build_object('limit', v_kb.lim, 'total', v_kb.total, 'locked', coalesce(v_kb.locked, 0),
                                     'items', v_kb_items),
    'contact', jsonb_build_object('limit', v_contact.lim, 'total', v_contact.total, 'locked', coalesce(v_contact.locked, 0)),
    -- limit: max_agents (the owner's seat included); total: the seats held.
    'member', jsonb_build_object('limit', v_seats,
                                 'total', public.billing_countable_count(p_workspace_id, 'member') + 1,
                                 'locked', coalesce(v_member.locked, 0), 'items', v_members),
    'conversation', jsonb_build_object('retention_days', v_conv.lim, 'total', v_conv.total,
                                       'locked', coalesce(v_conv.locked, 0), 'cutoff', v_conv.cut_ts,
                                       'oldest_kept', v_oldest),
    'conversation_quota', jsonb_build_object('limit', v_conv_lim, 'used_this_month', v_conv_used,
                                             'full', v_conv_lim IS NOT NULL AND v_conv_used >= v_conv_lim),
    -- Storage in MB (271). limit_gb/used_gb are 265's fields, kept for a
    -- server that still runs code from before 271.
    'storage', jsonb_build_object('limit_mb', v_store_lim,
                                  'used_mb', round(v_bytes::numeric / 1048576, 2),
                                  'uploads_blocked', v_store_lim IS NOT NULL AND v_bytes >= v_store_lim * 1048576,
                                  'limit_gb', CASE WHEN v_store_lim IS NOT NULL THEN round(v_store_lim::numeric / 1024, 3) END,
                                  'used_gb', round(v_bytes::numeric / 1073741824, 2)),
    'locked_data_retention_days', v_retention,
    -- Deletion needs both notices, the first 30 days ahead: never sooner
    -- than this, and only while the switch is on (members are never deleted).
    'first_deletion_not_before',
      CASE WHEN v_retention IS NOT NULL
                AND (coalesce(v_kb.locked, 0) > 0 OR coalesce(v_contact.locked, 0) > 0 OR coalesce(v_conv.locked, 0) > 0)
           THEN now() + make_interval(days => greatest(v_retention, 30)) END
  );
END;
$$;


-- ─── 6. Access: the backend (service_role) only ──────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_storage_limit_mb(uuid, uuid)',
    'public.billing_lock_report(uuid, uuid)'
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
