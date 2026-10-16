-- 272 — Plans: the storage limit in megabytes only; `storage_gb` is gone.
--
-- 271 added `storage_mb` next to `storage_gb` and kept the GB key (plans,
-- workspace overrides, the downgrade report's limit_gb/used_gb) for the
-- code that ran before it. Every reader since 271 (445e227) reads
-- `storage_mb` first and falls back to `storage_gb` × 1024 only where
-- `storage_mb` is absent or unreadable, and reads the report's limit_mb/
-- used_mb whenever they are there, so this file is safe for it as well as
-- for the code after it, which knows no GB at all.
--
-- 1. Plans: where `storage_mb` is not a number but `storage_gb` is, it gets
--    `storage_gb` × 1024 first (-1 stays unlimited), exactly what the
--    fallback read; then `storage_gb` leaves every plan. No plan's storage
--    limit changes.
-- 2. Workspace overrides keyed `storage_gb`: one without a `storage_mb`
--    row beside it becomes one (× 1024; negative or too large for an
--    integer = -1, unlimited, as that is what it allowed); then every
--    `storage_gb` row goes. Where both exist the `storage_mb` row already
--    won (271 copied it; the editor sets and removes them together).
-- 3. billing_storage_limit_mb reads `storage_mb` only (override, then plan).
-- 4. billing_lock_report: storage in MB only (no limit_gb/used_gb).
-- 5. app_review_seed_plan writes the App Review plan's 20 GB as
--    `storage_mb` 20480 (it wrote `storage_gb` 20 on top of Enterprise's
--    limits, so a reseed would have brought the GB key back).
--
-- Re-runnable: a second run finds nothing to change. Works on both
-- editions' databases. Dry run: wrap the file in BEGIN; … ROLLBACK; (it
-- opens no transaction of its own). Touches no archive schema or table.

-- ─── 1. Plans: storage_mb filled where only storage_gb named a number, then storage_gb removed
UPDATE public.billing_plans p
   SET limits = p.limits
                || jsonb_build_object('storage_mb',
                     CASE WHEN public.billing_jsonb_number(p.limits -> 'storage_gb') < 0 THEN -1
                          ELSE round(public.billing_jsonb_number(p.limits -> 'storage_gb') * 1024)::bigint END),
       updated_at = now()
 WHERE public.billing_jsonb_number(p.limits -> 'storage_gb') IS NOT NULL
   AND public.billing_jsonb_number(p.limits -> 'storage_mb') IS NULL;

UPDATE public.billing_plans p
   SET limits = p.limits - 'storage_gb',
       updated_at = now()
 WHERE jsonb_typeof(p.limits) = 'object'
   AND p.limits ? 'storage_gb';

-- ─── 2. Workspace overrides: storage_gb becomes storage_mb, then goes ──────
DO $$
DECLARE
  v_converted integer := 0;
  v_removed   integer := 0;
BEGIN
  IF to_regclass('public.workspace_limit_overrides') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value, admin_notes, created_at, updated_at)
  SELECT DISTINCT ON (o.workspace_id)
         o.workspace_id, 'storage_mb',
         CASE WHEN o.limit_value < 0 OR o.limit_value > 2097151 THEN -1 ELSE o.limit_value * 1024 END,
         o.admin_notes, now(), now()
    FROM public.workspace_limit_overrides o
   WHERE o.limit_key = 'storage_gb'
     AND NOT EXISTS (SELECT 1 FROM public.workspace_limit_overrides m
                      WHERE m.workspace_id = o.workspace_id AND m.limit_key = 'storage_mb')
   ORDER BY o.workspace_id, o.updated_at DESC
  ON CONFLICT (workspace_id, limit_key) DO NOTHING;
  GET DIAGNOSTICS v_converted = ROW_COUNT;

  DELETE FROM public.workspace_limit_overrides o
   WHERE o.limit_key = 'storage_gb'
     AND EXISTS (SELECT 1 FROM public.workspace_limit_overrides m
                  WHERE m.workspace_id = o.workspace_id AND m.limit_key = 'storage_mb');
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_converted > 0 OR v_removed > 0 THEN
    RAISE NOTICE '272: % storage_gb override(s) converted to storage_mb, % storage_gb override(s) removed', v_converted, v_removed;
  END IF;
END $$;

-- ─── 3. The storage limit that blocks uploads, in MB ─────────────────────
-- storage_mb (override, then plan): a whole number >= 0, else NULL
-- (unlimited: -1; absent; unreadable).
CREATE OR REPLACE FUNCTION public.billing_storage_limit_mb(p_workspace_id uuid, p_plan_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.billing_effective_limit(p_workspace_id, 'storage_mb', p_plan_id)
$$;

-- ─── 4. The downgrade report: 271's, storage in MB only ──────────────────
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
    -- Storage in MB.
    'storage', jsonb_build_object('limit_mb', v_store_lim,
                                  'used_mb', round(v_bytes::numeric / 1048576, 2),
                                  'uploads_blocked', v_store_lim IS NOT NULL AND v_bytes >= v_store_lim * 1048576),
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

-- ─── 5. The App Review plan: storage in MB ───────────────────────────────
-- 249's function; only the storage key differs (20 GB = 20480 MB).
CREATE OR REPLACE FUNCTION public.app_review_seed_plan()
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ent  jsonb;
  v_lim  jsonb;
  v_plan uuid;
BEGIN
  -- Every key any plan carries, on, except the in-app promotions; and what
  -- the iOS app gates on, named outright.
  SELECT coalesce(jsonb_object_agg(k, NOT (k LIKE 'mobile_promo%')), '{}'::jsonb) INTO v_ent
    FROM (SELECT DISTINCT jsonb_object_keys(entitlements) AS k
            FROM public.billing_plans
           WHERE slug <> 'app-review' AND jsonb_typeof(entitlements) = 'object'
          UNION
          SELECT unnest(ARRAY['chat', 'chat_widget', 'contacts', 'visitor_tracking', 'web_analytics', 'analytics',
                              'email', 'email_inbox', 'gmail', 'yahoomail', 'whatsapp', 'telegram', 'instagram',
                              'omnichannel', 'voice', 'video', 'voice_video', 'call_center', 'call_queue',
                              'ai_assistant', 'advanced_ai_agent', 'ai_operator_assist', 'knowledge_base',
                              'inbox_ai_queue', 'inbox_needs_human', 'inbox_team_chat', 'contact_create',
                              'contact_edit', 'contact_tags', 'contact_notes', 'widget_attachments',
                              'widget_voice_notes'])) keys;
  SELECT (coalesce((SELECT limits FROM public.billing_plans WHERE slug = 'enterprise'), '{}'::jsonb) - 'storage_gb')
         || jsonb_build_object(
              'max_agents', -1, 'max_contacts', -1, 'max_visitors', -1,
              'max_conversations', -1, 'max_workspaces', -1, 'max_widget_domains', -1,
              'max_concurrent_calls', -1, 'max_call_minutes_per_month', -1,
              'data_retention_days', 400, 'storage_mb', 20480)
    INTO v_lim;

  INSERT INTO public.billing_plans (name, slug, description, sort_order, prices, default_currency,
                                    entitlements, limits, provider_price_ids, is_active, is_free,
                                    is_hidden, trial_days, localized)
  VALUES ('App Review', 'app-review',
          'Hidden. The workspace Apple''s App Review signs in to: every feature, no price.',
          99, '{"IRR":{"monthly":0,"yearly":0}}'::jsonb, 'IRR',
          v_ent, v_lim, '{}'::jsonb, true, false, true, 0, '{}'::jsonb)
  ON CONFLICT (slug) DO UPDATE
     SET entitlements = EXCLUDED.entitlements, limits = EXCLUDED.limits,
         is_active = true, is_hidden = true, updated_at = now()
  RETURNING id INTO v_plan;
  RETURN v_plan;
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_seed_plan() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_seed_plan() TO service_role;

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
