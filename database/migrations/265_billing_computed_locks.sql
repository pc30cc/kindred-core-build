-- 265 — Simple billing, phase 4: computed locks over the plan's limits after
-- a downgrade, the downgrade report, the locked-data export jobs and the
-- retention-deletion clock (docs/billing/SIMPLE_BILLING.md, "Over the limit
-- after a downgrade: lock, never delete").
--
-- No lock is stored. A row is locked when its rank (created_at, id; oldest
-- first) is above the workspace's effective limit, or, for chats, when its
-- last activity is older than the plan's data_retention_days. Both are
-- computed here, at read time, by one set of functions every caller uses:
--
--   billing_locks_enabled()            the kill switch of the running edition
--                                      (billing_settings.locks_enabled, off
--                                      by default: nothing locks until the
--                                      Super Admin turns it on)
--   billing_effective_plan_id(ws)      the plan in force (planSelection.ts)
--   billing_effective_limit(ws, key)   override ?? plan (aliases); NULL =
--                                      unlimited, absent or unreadable. Only
--                                      explicit limits lock: never a
--                                      registry default.
--   billing_lock_cutoff(ws, kind)      limit, total, locked, and the last
--                                      unlocked row's (cut_ts, cut_id)
--   billing_locked_ids / billing_is_locked / billing_countable_count
--   billing_lock_report(ws, plan)      what a plan would lock (computed as if
--                                      the switch were on)
--   billing_release_locked_agent_chats(ws)   a locked agent's open chats go
--                                            back to the queue
--   billing_lock_clock_observe(ws)     the hourly job's deletion clock
--   billing_locked_delete(...)         deletes locked rows once both notices
--                                      were sent and the deadline passed
--
-- Kinds: kb_article (every article, any status), contact (not spam and not
-- an anonymous widget visitor), member (non-owner, not suspended; the owner
-- holds one of max_agents' seats; identified by user_id) and conversation
-- (last activity, coalesce(updated_at, created_at), before now() -
-- data_retention_days). Locks fail open: an unreadable plan or limit locks
-- nothing. The create-time quotas (requireLimit) are unchanged.
--
-- Also: the seat capacity reads the effective plan (an expired workspace gets
-- Free's seats, not 0) and counts suspended members no more; the AI KB
-- builder cannot rewrite a locked article; a customer's message moves its
-- chat's last activity; the deletion-notice email per edition in fa/en/tr.
--
-- Indexes: build them by hand on a live database BEFORE applying this file
-- (the migration runs with lock_timeout=5s inside one transaction, too short
-- to build them there); the IF NOT EXISTS below then finds them:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_ws_created_id_idx ON public.contacts (workspace_id, created_at, id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_base_articles_ws_created_id_idx ON public.knowledge_base_articles (workspace_id, created_at, id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_members_ws_created_user_idx ON public.workspace_members (workspace_id, created_at, user_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_ws_updated_idx ON public.conversations (workspace_id, updated_at);
--
-- Defines only: no row of any table is deleted or rewritten as this applies.
-- Server-only: every table and function is reachable by service_role alone.
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. Indexes (see the header: built CONCURRENTLY beforehand) ──────────
CREATE INDEX IF NOT EXISTS contacts_ws_created_id_idx
  ON public.contacts (workspace_id, created_at, id);
CREATE INDEX IF NOT EXISTS knowledge_base_articles_ws_created_id_idx
  ON public.knowledge_base_articles (workspace_id, created_at, id);
CREATE INDEX IF NOT EXISTS workspace_members_ws_created_user_idx
  ON public.workspace_members (workspace_id, created_at, user_id);
CREATE INDEX IF NOT EXISTS conversations_ws_updated_idx
  ON public.conversations (workspace_id, updated_at);

-- ─── 2. The kill switch, the deletion clock and the export jobs ──────────
ALTER TABLE public.billing_settings
  ADD COLUMN IF NOT EXISTS locks_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.billing_settings.locks_enabled IS
  'Billing locks (265) for this edition: rows over a plan''s limits are hidden, read-only and, after the plan''s locked_data_retention_days and the 30/7-day notices, deleted. Off: nothing is locked; the downgrade report still computes.';

-- When the hourly job first saw a kind over its limit, and which notices it
-- sent. A clock, not a lock: it holds no row ids, and an episode is removed
-- as soon as nothing of its kind is locked any more (upgrade, deletions, an
-- override). Count kinds: one open episode (deleted_at IS NULL) per kind,
-- keyed by the moment it started. Chats: one per monthly deletion batch,
-- keyed by the batch date, with the activity cutoff named in its notice.
CREATE TABLE IF NOT EXISTS public.billing_lock_clocks (
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  episode_key   text NOT NULL,
  since         timestamptz NOT NULL,
  cutoff_at     timestamptz,
  locked_count  integer NOT NULL DEFAULT 0,
  notice_30_at  timestamptz,
  notice_7_at   timestamptz,
  deleted_at    timestamptz,
  PRIMARY KEY (workspace_id, kind, episode_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_lock_clocks_kind_check') THEN
    ALTER TABLE public.billing_lock_clocks
      ADD CONSTRAINT billing_lock_clocks_kind_check CHECK (kind IN ('kb_article', 'contact', 'conversation'));
  END IF;
END $$;

-- The owner's export of what is locked (a ZIP the export worker builds).
CREATE TABLE IF NOT EXISTS public.billing_lock_exports (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by               uuid NOT NULL,
  status                     text NOT NULL DEFAULT 'pending',
  kinds                      text[] NOT NULL,
  counts                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_storage_provider  text,
  artifact_storage_key       text,
  artifact_size_bytes        bigint,
  download_token_hash        text,
  expires_at                 timestamptz,
  attempts                   integer NOT NULL DEFAULT 0,
  locked_at                  timestamptz,
  error                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_lock_exports_status_check') THEN
    ALTER TABLE public.billing_lock_exports
      ADD CONSTRAINT billing_lock_exports_status_check
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired'));
  END IF;
END $$;

-- One export at a time per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS billing_lock_exports_one_live
  ON public.billing_lock_exports (workspace_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS billing_lock_exports_workspace_idx
  ON public.billing_lock_exports (workspace_id, created_at DESC);

-- ─── 3. Plan, limit and the switch ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_locks_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT s.locks_enabled FROM public.billing_settings s WHERE s.edition = public.platform_edition()),
    false)
$$;

-- The plan a workspace is entitled to now: SQL twin of planSelection.ts
-- assignedPlanApplies and check_workspace_entitlement (251), else the active
-- Free plan. NULL when there is neither.
CREATE OR REPLACE FUNCTION public.billing_effective_plan_id(p_workspace_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT p.id
       FROM public.workspace_subscriptions s
       JOIN public.billing_plans p ON p.id = s.plan_id
      WHERE s.workspace_id = p_workspace_id
        AND (s.status = 'active'
          OR (s.status = 'past_due' AND s.free_fallback_at IS NULL)
          OR (s.status = 'trialing' AND (s.trial_end IS NULL OR s.trial_end > now()))
          OR (s.status IN ('canceled', 'cancelled') AND s.cancel_at_period_end IS TRUE
              AND s.current_period_end > now()))),
    (SELECT p.id FROM public.billing_plans p WHERE p.slug = 'free' AND p.is_active = true
      ORDER BY p.created_at NULLS LAST, p.id LIMIT 1))
$$;

-- A limit as written: the workspace's override, else the plan's value (the
-- legacy aliases after the key, as kbArticleQuota.ts reads them). NULL when
-- neither names a number. p_plan_id NULL means the plan in force.
CREATE OR REPLACE FUNCTION public.billing_limit_raw(p_workspace_id uuid, p_key text, p_plan_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan   uuid := coalesce(p_plan_id, public.billing_effective_plan_id(p_workspace_id));
  v_limits jsonb;
  v_key    text;
  v_value  numeric;
BEGIN
  SELECT coalesce(p.limits, '{}'::jsonb) INTO v_limits FROM public.billing_plans p WHERE p.id = v_plan;
  v_limits := coalesce(v_limits, '{}'::jsonb);
  FOREACH v_key IN ARRAY CASE WHEN p_key = 'max_kb_articles'
                              THEN ARRAY['max_kb_articles', 'ai_kb_max_articles', 'kb_articles']
                              ELSE ARRAY[p_key] END LOOP
    SELECT o.limit_value INTO v_value
      FROM public.workspace_limit_overrides o
     WHERE o.workspace_id = p_workspace_id AND o.limit_key = v_key
     ORDER BY o.updated_at DESC LIMIT 1;
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
    v_value := public.billing_jsonb_number(v_limits -> v_key);
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- The limit that locks: a whole number >= 0, else NULL (unlimited: -1, a
-- fraction, absent, unreadable). Registry defaults are never used here.
CREATE OR REPLACE FUNCTION public.billing_effective_limit(p_workspace_id uuid, p_key text, p_plan_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN v >= 0 AND v = trunc(v) AND v <= 9223372036854775807 THEN v::bigint END
    FROM (SELECT public.billing_limit_raw(p_workspace_id, p_key, p_plan_id) AS v) x
$$;

-- ─── 4. Countable rows and the cutoff ─────────────────────────────────────
-- The rows a count kind ranks, with their rank key. The same predicate the
-- quota counts (billing_countable_count), so the quota and the lock agree.
-- A NULL created_at ranks first ('-infinity'). Members are named by user_id
-- (the rank's tie-break too); the owner never ranks.
CREATE OR REPLACE FUNCTION public.billing_lock_rank_rows(p_workspace_id uuid, p_kind text)
RETURNS TABLE (id uuid, ts timestamptz)
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT a.id, coalesce(a.created_at, '-infinity'::timestamptz)
    FROM public.knowledge_base_articles a
   WHERE p_kind = 'kb_article' AND a.workspace_id = p_workspace_id
  UNION ALL
  SELECT c.id, coalesce(c.created_at, '-infinity'::timestamptz)
    FROM public.contacts c
   WHERE p_kind = 'contact' AND c.workspace_id = p_workspace_id
     AND NOT c.is_spam
     -- An anonymous widget visitor (no name, email or phone; 'Visitor' is
     -- the legacy placeholder name) is not a contact the plan counts.
     AND NOT (coalesce(c.metadata ->> 'anonymous', '') = 'true'
              AND nullif(btrim(c.email), '') IS NULL
              AND nullif(btrim(c.phone), '') IS NULL
              AND (nullif(btrim(c.name), '') IS NULL OR c.name = 'Visitor'))
  UNION ALL
  SELECT m.user_id, coalesce(m.created_at, '-infinity'::timestamptz)
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE p_kind = 'member' AND m.workspace_id = p_workspace_id
     AND m.user_id <> w.owner_id AND m.suspended_at IS NULL
$$;

-- What the plan counts for a kind (contacts: D1; members: non-owner, not
-- suspended; conversations: every chat).
CREATE OR REPLACE FUNCTION public.billing_countable_count(p_workspace_id uuid, p_kind text)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_kind = 'conversation' THEN
    RETURN (SELECT count(*) FROM public.conversations c WHERE c.workspace_id = p_workspace_id);
  ELSIF p_kind IN ('kb_article', 'contact', 'member') THEN
    RETURN (SELECT count(*) FROM public.billing_lock_rank_rows(p_workspace_id, p_kind));
  END IF;
  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_lock_kind_invalid';
END;
$$;

-- The limit of a kind for a plan (NULL = nothing locks):
-- kb_article max_kb_articles, contact max_contacts, member max_agents - 1
-- (the owner's seat), conversation data_retention_days (days).
CREATE OR REPLACE FUNCTION public.billing_lock_limit(p_workspace_id uuid, p_kind text, p_plan_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE p_kind
    WHEN 'kb_article'   THEN public.billing_effective_limit(p_workspace_id, 'max_kb_articles', p_plan_id)
    WHEN 'contact'      THEN public.billing_effective_limit(p_workspace_id, 'max_contacts', p_plan_id)
    -- (greatest() skips a NULL: unlimited must stay NULL, not 0.)
    WHEN 'member'       THEN (SELECT CASE WHEN m IS NOT NULL THEN greatest(m - 1, 0) END
                                FROM (SELECT public.billing_effective_limit(p_workspace_id, 'max_agents', p_plan_id) AS m) x)
    WHEN 'conversation' THEN public.billing_effective_limit(p_workspace_id, 'data_retention_days', p_plan_id)
  END
$$;

-- The cutoff as the plan would set it, whatever the switch says (the report
-- and billing_lock_cutoff use it). Nothing locks for a workspace that is not
-- active, on an install whose billing is unlimited, or without a limit.
-- Count kinds: rows after (cut_ts, cut_id) are locked; limit 0 locks every
-- row ('-infinity', the nil uuid). Conversation: activity before cut_ts.
CREATE OR REPLACE FUNCTION public.billing_lock_compute(p_workspace_id uuid, p_kind text, p_plan_id uuid DEFAULT NULL)
RETURNS TABLE (lim bigint, total bigint, locked bigint, cut_ts timestamptz, cut_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_lim   bigint;
  v_total bigint;
  v_ts    timestamptz;
  v_id    uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('kb_article', 'contact', 'member', 'conversation') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_lock_kind_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.status = 'active')
     OR EXISTS (SELECT 1 FROM public.workspace_seat_entitlement_mode m WHERE m.id AND m.mode = 'self_host_unlimited') THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 0::bigint, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;

  v_lim := public.billing_lock_limit(p_workspace_id, p_kind, p_plan_id);
  IF v_lim IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 0::bigint, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;

  IF p_kind = 'conversation' THEN
    v_ts := now() - make_interval(days => least(v_lim, 1000000)::integer);
    RETURN QUERY
      SELECT v_lim, count(*), count(*) FILTER (WHERE coalesce(c.updated_at, c.created_at, '-infinity'::timestamptz) < v_ts),
             v_ts, NULL::uuid
        FROM public.conversations c WHERE c.workspace_id = p_workspace_id;
    RETURN;
  END IF;

  SELECT count(*) INTO v_total FROM public.billing_lock_rank_rows(p_workspace_id, p_kind);
  IF v_total <= v_lim THEN
    RETURN QUERY SELECT v_lim, v_total, 0::bigint, NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;
  IF v_lim = 0 THEN
    v_ts := '-infinity';
    v_id := '00000000-0000-0000-0000-000000000000';
  ELSE
    SELECT r.ts, r.id INTO v_ts, v_id
      FROM public.billing_lock_rank_rows(p_workspace_id, p_kind) r
     ORDER BY r.ts, r.id
    OFFSET v_lim - 1 LIMIT 1;
  END IF;
  RETURN QUERY SELECT v_lim, v_total, v_total - v_lim, v_ts, v_id;
END;
$$;

-- The cutoff in force: nothing is locked while the edition's switch is off
-- (lim is still reported; total only when it was counted).
CREATE OR REPLACE FUNCTION public.billing_lock_cutoff(p_workspace_id uuid, p_kind text, p_plan_id uuid DEFAULT NULL)
RETURNS TABLE (lim bigint, total bigint, locked bigint, cut_ts timestamptz, cut_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('kb_article', 'contact', 'member', 'conversation') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_lock_kind_invalid';
  END IF;
  IF NOT public.billing_locks_enabled() THEN
    RETURN QUERY SELECT public.billing_lock_limit(p_workspace_id, p_kind, p_plan_id), NULL::bigint, 0::bigint,
                        NULL::timestamptz, NULL::uuid;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.billing_lock_compute(p_workspace_id, p_kind, p_plan_id);
END;
$$;

-- The rows past a cutoff, oldest first (chats: least recent activity
-- first), with their rank key (chats: their activity).
CREATE OR REPLACE FUNCTION public.billing_lock_rows_after(
  p_workspace_id uuid, p_kind text, p_cut_ts timestamptz, p_cut_id uuid, p_max integer
) RETURNS TABLE (id uuid, ts timestamptz)
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT x.id, x.ts FROM (
    SELECT r.id, r.ts
      FROM public.billing_lock_rank_rows(p_workspace_id, p_kind) r
     WHERE p_kind <> 'conversation' AND p_cut_ts IS NOT NULL AND (r.ts, r.id) > (p_cut_ts, p_cut_id)
    UNION ALL
    SELECT c.id, coalesce(c.updated_at, c.created_at, '-infinity'::timestamptz)
      FROM public.conversations c
     WHERE p_kind = 'conversation' AND p_cut_ts IS NOT NULL AND c.workspace_id = p_workspace_id
       AND coalesce(c.updated_at, c.created_at, '-infinity'::timestamptz) < p_cut_ts
  ) x
  ORDER BY x.ts, x.id
  LIMIT greatest(coalesce(p_max, 0), 0)
$$;

-- The locked rows of a kind, oldest first, at most p_max (members: user ids).
CREATE OR REPLACE FUNCTION public.billing_locked_ids(
  p_workspace_id uuid, p_kind text, p_plan_id uuid DEFAULT NULL, p_max integer DEFAULT 5000
) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM public.billing_lock_cutoff(p_workspace_id, p_kind, p_plan_id);
  IF coalesce(c.locked, 0) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT r.id FROM public.billing_lock_rows_after(p_workspace_id, p_kind, c.cut_ts, c.cut_id, p_max) r;
END;
$$;

-- Whether one row is locked now (members: by user id).
CREATE OR REPLACE FUNCTION public.billing_is_locked(p_workspace_id uuid, p_kind text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  IF p_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO c FROM public.billing_lock_cutoff(p_workspace_id, p_kind);
  IF coalesce(c.locked, 0) = 0 THEN
    RETURN false;
  END IF;
  IF p_kind = 'conversation' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.conversations x
       WHERE x.id = p_id AND x.workspace_id = p_workspace_id
         AND coalesce(x.updated_at, x.created_at, '-infinity'::timestamptz) < c.cut_ts);
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.billing_lock_rank_rows(p_workspace_id, p_kind) r
     WHERE r.id = p_id AND (r.ts, r.id) > (c.cut_ts, c.cut_id));
END;
$$;

-- ─── 5. The downgrade report ──────────────────────────────────────────────
-- What p_plan_id (NULL: the plan in force) locks for the workspace, computed
-- as if the switch were on; locks_enabled says whether it is. The server adds
-- modules, channels and the AI credit (server/services/billing/locks/report.ts).
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
  v_store_lim := public.billing_effective_limit(p_workspace_id, 'storage_gb', v_plan);
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
    'storage', jsonb_build_object('limit_gb', v_store_lim,
                                  'used_gb', round(v_bytes::numeric / 1073741824, 2),
                                  'uploads_blocked', v_store_lim IS NOT NULL AND v_bytes >= v_store_lim * 1073741824),
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

-- ─── 6. A locked agent's open chats go back to the queue ─────────────────
-- Returns the conversations released, for the server to publish and route.
-- An upgrade does not assign them back.
CREATE OR REPLACE FUNCTION public.billing_release_locked_agent_chats(p_workspace_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_locked uuid[];
BEGIN
  SELECT array_agg(x) INTO v_locked FROM public.billing_locked_ids(p_workspace_id, 'member', NULL, 100000) x;
  IF v_locked IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    UPDATE public.conversations c
       SET assigned_to = NULL
     WHERE c.workspace_id = p_workspace_id
       AND c.assigned_to = ANY (v_locked)
       AND c.status IN ('open', 'pending')
    RETURNING c.id;
END;
$$;

-- ─── 7. The deletion clock and the deletion ───────────────────────────────
-- The next monthly chat-deletion batch: the 1st of next month, 00:00 UTC.
CREATE OR REPLACE FUNCTION public.billing_lock_next_batch(p_at timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT (date_trunc('month', p_at AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
$$;

-- Called by the hourly job for each workspace it handles. Count kinds: an
-- episode opens the first time something is locked and is removed once
-- nothing is (so an upgrade, deletions or a raised override reset the
-- clock). Chats: from 30 days before a batch date D, an episode for D opens
-- when a chat's activity is before D - (data_retention_days +
-- locked_data_retention_days); its cutoff is fixed by its 30-day notice.
-- Returns the open episodes.
CREATE OR REPLACE FUNCTION public.billing_lock_clock_observe(p_workspace_id uuid)
RETURNS SETOF public.billing_lock_clocks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind      text;
  c           record;
  v_open      public.billing_lock_clocks;
  v_now       timestamptz := now();
  v_plan      uuid;
  v_retention bigint;
  v_keep      integer;
  v_batch     timestamptz;
  v_key       text;
  v_cutoff    timestamptz;
  v_count     bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_lock_clock:' || p_workspace_id::text, 0));

  FOREACH v_kind IN ARRAY ARRAY['kb_article', 'contact'] LOOP
    SELECT * INTO c FROM public.billing_lock_cutoff(p_workspace_id, v_kind);
    SELECT * INTO v_open FROM public.billing_lock_clocks k
     WHERE k.workspace_id = p_workspace_id AND k.kind = v_kind AND k.deleted_at IS NULL
     ORDER BY k.since DESC LIMIT 1;
    IF coalesce(c.locked, 0) > 0 THEN
      IF v_open.workspace_id IS NULL THEN
        INSERT INTO public.billing_lock_clocks (workspace_id, kind, episode_key, since, locked_count)
        VALUES (p_workspace_id, v_kind, to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                v_now, least(c.locked, 2147483647))
        ON CONFLICT (workspace_id, kind, episode_key) DO NOTHING;
      ELSE
        UPDATE public.billing_lock_clocks k SET locked_count = least(c.locked, 2147483647)
         WHERE k.workspace_id = p_workspace_id AND k.kind = v_kind AND k.episode_key = v_open.episode_key;
      END IF;
    ELSE
      DELETE FROM public.billing_lock_clocks k
       WHERE k.workspace_id = p_workspace_id AND k.kind = v_kind AND k.deleted_at IS NULL;
    END IF;
  END LOOP;

  -- Chats.
  SELECT * INTO c FROM public.billing_lock_cutoff(p_workspace_id, 'conversation');
  v_plan := public.billing_effective_plan_id(p_workspace_id);
  v_retention := c.lim;
  SELECT p.locked_data_retention_days INTO v_keep FROM public.billing_plans p WHERE p.id = v_plan;
  IF coalesce(c.locked, 0) = 0 OR v_retention IS NULL OR v_keep IS NULL THEN
    -- Nothing is locked, or nothing is ever deleted: no batch is pending.
    DELETE FROM public.billing_lock_clocks k
     WHERE k.workspace_id = p_workspace_id AND k.kind = 'conversation' AND k.deleted_at IS NULL;
  ELSE
    v_batch := public.billing_lock_next_batch(v_now);
    IF v_now >= v_batch - interval '30 days' THEN
      v_key := to_char(v_batch AT TIME ZONE 'UTC', 'YYYY-MM-DD');
      v_cutoff := v_batch - make_interval(days => least(v_retention + v_keep, 1000000)::integer);
      SELECT * INTO v_open FROM public.billing_lock_clocks k
       WHERE k.workspace_id = p_workspace_id AND k.kind = 'conversation' AND k.episode_key = v_key;
      -- Once noticed, the cutoff stays the one the notice named.
      IF v_open.notice_30_at IS NOT NULL THEN
        v_cutoff := least(v_open.cutoff_at, v_cutoff);
      END IF;
      SELECT count(*) INTO v_count FROM public.conversations x
       WHERE x.workspace_id = p_workspace_id
         AND coalesce(x.updated_at, x.created_at, '-infinity'::timestamptz) < v_cutoff;
      IF v_count > 0 THEN
        INSERT INTO public.billing_lock_clocks (workspace_id, kind, episode_key, since, cutoff_at, locked_count)
        VALUES (p_workspace_id, 'conversation', v_key, v_now, v_cutoff, least(v_count, 2147483647))
        ON CONFLICT (workspace_id, kind, episode_key) DO UPDATE
          SET cutoff_at = EXCLUDED.cutoff_at, locked_count = EXCLUDED.locked_count
          WHERE billing_lock_clocks.deleted_at IS NULL;
      ELSIF v_open.workspace_id IS NOT NULL AND v_open.deleted_at IS NULL THEN
        DELETE FROM public.billing_lock_clocks k
         WHERE k.workspace_id = p_workspace_id AND k.kind = 'conversation' AND k.episode_key = v_key;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM public.billing_lock_clocks k
                WHERE k.workspace_id = p_workspace_id AND k.deleted_at IS NULL
                ORDER BY k.kind, k.since;
END;
$$;

-- When an episode's rows may be deleted: both notices recorded, and the
-- latest of its deadline, 30 days after the 30-day notice and 7 days after
-- the 7-day notice (a late notice never shortens the notice period). NULL
-- while it may not (no notices, or the plan keeps locked data for ever).
CREATE OR REPLACE FUNCTION public.billing_lock_episode_deadline(p_clock public.billing_lock_clocks)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_keep integer;
  v_base timestamptz;
BEGIN
  IF p_clock.notice_30_at IS NULL OR p_clock.notice_7_at IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT p.locked_data_retention_days INTO v_keep
    FROM public.billing_plans p WHERE p.id = public.billing_effective_plan_id(p_clock.workspace_id);
  IF v_keep IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_clock.kind = 'conversation' THEN
    v_base := (p_clock.episode_key || 'T00:00:00Z')::timestamptz;
  ELSE
    v_base := p_clock.since + make_interval(days => v_keep);
  END IF;
  RETURN greatest(v_base, p_clock.notice_30_at + interval '30 days', p_clock.notice_7_at + interval '7 days');
END;
$$;

-- Deletes the given rows of an episode that are still locked now and were
-- already locked when its 30-day notice went out (count kinds: created
-- before it; chats: activity before the noticed cutoff and the current
-- one). Only after the deadline, under the account lock, while the switch is
-- on. Rows that do not qualify are skipped. Sets deleted_at once nothing of
-- the episode is left. Returns the number of rows deleted. Members are never
-- deleted; storage objects are removed by the caller first.
CREATE OR REPLACE FUNCTION public.billing_locked_delete(
  p_workspace_id uuid, p_kind text, p_episode_key text, p_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_clock     public.billing_lock_clocks;
  v_deadline  timestamptz;
  c           record;
  v_keep      integer;
  v_cutoff    timestamptz;
  v_targets   uuid[];
  v_batch     uuid[];
  v_deleted   integer := 0;
  v_n         integer;
  v_left      boolean;
  i           integer;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('kb_article', 'contact', 'conversation') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'billing_lock_kind_invalid';
  END IF;
  PERFORM public.billing_account_lock(p_workspace_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_lock_clock:' || p_workspace_id::text, 0));

  SELECT * INTO v_clock FROM public.billing_lock_clocks k
   WHERE k.workspace_id = p_workspace_id AND k.kind = p_kind AND k.episode_key = p_episode_key
   FOR UPDATE;
  IF v_clock.workspace_id IS NULL OR v_clock.deleted_at IS NOT NULL THEN
    RETURN 0;
  END IF;
  v_deadline := public.billing_lock_episode_deadline(v_clock);
  IF v_deadline IS NULL OR now() < v_deadline THEN
    RETURN 0;
  END IF;
  SELECT * INTO c FROM public.billing_lock_cutoff(p_workspace_id, p_kind);
  IF coalesce(c.locked, 0) = 0 THEN
    RETURN 0;
  END IF;

  IF p_kind = 'conversation' THEN
    SELECT p.locked_data_retention_days INTO v_keep
      FROM public.billing_plans p WHERE p.id = public.billing_effective_plan_id(p_workspace_id);
    v_cutoff := least(
      v_clock.cutoff_at,
      (p_episode_key || 'T00:00:00Z')::timestamptz - make_interval(days => least(c.lim + v_keep, 1000000)::integer),
      c.cut_ts);
    SELECT array_agg(x.id) INTO v_targets
      FROM public.conversations x
     WHERE x.workspace_id = p_workspace_id AND x.id = ANY (p_ids)
       AND coalesce(x.updated_at, x.created_at, '-infinity'::timestamptz) < v_cutoff;
  ELSE
    SELECT array_agg(r.id) INTO v_targets
      FROM public.billing_lock_rows_after(p_workspace_id, p_kind, c.cut_ts, c.cut_id, 2147483647) r
     WHERE r.id = ANY (p_ids) AND r.ts < v_clock.notice_30_at;
  END IF;

  IF v_targets IS NOT NULL THEN
    i := 1;
    WHILE i <= cardinality(v_targets) LOOP
      v_batch := v_targets[i : i + 499];
      IF p_kind = 'kb_article' THEN
        DELETE FROM public.knowledge_base_articles x WHERE x.workspace_id = p_workspace_id AND x.id = ANY (v_batch);
      ELSIF p_kind = 'contact' THEN
        DELETE FROM public.contacts x WHERE x.workspace_id = p_workspace_id AND x.id = ANY (v_batch);
      ELSE
        DELETE FROM public.conversations x WHERE x.workspace_id = p_workspace_id AND x.id = ANY (v_batch);
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_deleted := v_deleted + v_n;
      i := i + 500;
    END LOOP;
  END IF;

  -- Is anything of this episode left?
  IF p_kind = 'conversation' THEN
    v_left := EXISTS (SELECT 1 FROM public.conversations x
                       WHERE x.workspace_id = p_workspace_id
                         AND coalesce(x.updated_at, x.created_at, '-infinity'::timestamptz) < v_cutoff);
  ELSE
    SELECT * INTO c FROM public.billing_lock_cutoff(p_workspace_id, p_kind);
    v_left := coalesce(c.locked, 0) > 0 AND EXISTS (
      SELECT 1 FROM public.billing_lock_rows_after(p_workspace_id, p_kind, c.cut_ts, c.cut_id, 2147483647) r
       WHERE r.ts < v_clock.notice_30_at);
  END IF;
  IF NOT v_left THEN
    UPDATE public.billing_lock_clocks k SET deleted_at = now(), locked_count = 0
     WHERE k.workspace_id = p_workspace_id AND k.kind = p_kind AND k.episode_key = p_episode_key;
  END IF;
  RETURN v_deleted;
END;
$$;

-- ─── 8. Seat capacity: the plan in force, overrides, non-suspended seats ──
-- As 251, except: the limit is the effective plan's max_agents (an expired
-- or lapsed subscription gets Free's seats, not 0) with the workspace's
-- override, and suspended members hold no seat. The self-host modes are
-- unchanged. No plan at all, or a max_agents that is missing or not a whole
-- number, still fails closed (ENTITLEMENT_UNAVAILABLE).
CREATE OR REPLACE FUNCTION public.wi_resolve_seat_capacity(_workspace_id uuid)
 RETURNS TABLE(limit_value integer, used integer, source text, version integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _mode text;
  _config_version integer;
  _seat_limit integer;
  _plan_id uuid;
  _raw numeric;
BEGIN
  SELECT m.mode, m.config_version, m.seat_limit
    INTO _mode, _config_version, _seat_limit
  FROM public.workspace_seat_entitlement_mode m WHERE m.id = true;

  IF _mode IS NULL THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;

  SELECT count(*)::integer INTO used
  FROM public.workspace_members WHERE workspace_id = _workspace_id AND suspended_at IS NULL;

  IF _mode = 'self_host_unlimited' THEN
    limit_value := NULL;
    source := 'self_host_unlimited';
    version := _config_version;
    RETURN NEXT;
    RETURN;
  END IF;

  -- A fixed install-wide limit (SELF_HOST_SEAT_LIMIT) wins when configured.
  IF _seat_limit IS NOT NULL THEN
    IF _seat_limit < 0 THEN
      RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
    END IF;
    limit_value := _seat_limit;
    source := 'self_host_fixed_limit';
    version := _config_version;
    RETURN NEXT;
    RETURN;
  END IF;

  _plan_id := public.billing_effective_plan_id(_workspace_id);
  IF _plan_id IS NULL THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;
  _raw := public.billing_limit_raw(_workspace_id, 'max_agents', _plan_id);
  IF _raw IS NULL OR _raw <> trunc(_raw) OR _raw > 2147483647 THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;

  limit_value := CASE WHEN _raw < 0 THEN NULL ELSE _raw::integer END;
  source := 'plan_authoritative';
  version := _config_version;
  RETURN NEXT;
END;
$function$;

-- ─── 9. The AI KB builder cannot rewrite a locked article ────────────────
-- As 139, plus the lock check before the article is updated.
CREATE OR REPLACE FUNCTION public._ai_kb_apply_generated(
  _generated_id     uuid,
  _workspace_id     uuid,
  _reviewer         uuid,
  _content          text,
  _article_status   text,
  _generated_status text,
  _slug_seed        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g            record;
  v_article_id uuid;
  v_slug_out   text;
  v_locale_out text;
  v_status_out text;
  v_base       text;
  v_slug       text;
  v_clash      uuid;
  i            integer;
  attempt      integer;
BEGIN
  -- The row lock is taken FIRST and held for the whole transaction: state
  -- validation and the KB write can never straddle a concurrent mutation.
  SELECT * INTO g
  FROM public.ai_kb_generated_articles
  WHERE id = _generated_id AND workspace_id = _workspace_id
  FOR UPDATE;

  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF _generated_status = 'accepted' THEN
    IF g.status NOT IN ('pending', 'accepted') THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'invalid_state', 'current_status', g.status);
    END IF;
  ELSIF _generated_status = 'published' THEN
    IF g.status NOT IN ('pending', 'accepted', 'published') THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'invalid_state', 'current_status', g.status);
    END IF;
  ELSE
    RETURN jsonb_build_object(
      'ok', false, 'error', 'invalid_state', 'current_status', g.status);
  END IF;

  -- A locked article (over the plan's max_kb_articles, 265) is read-only.
  IF g.kb_article_id IS NOT NULL AND public.billing_is_locked(_workspace_id, 'kb_article', g.kb_article_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'kb_article_locked';
  END IF;

  IF g.kb_article_id IS NOT NULL THEN
    UPDATE public.knowledge_base_articles
    SET title = g.title,
        content = _content,
        excerpt = g.excerpt,
        locale = g.locale,
        status = _article_status::public.article_status
    WHERE id = g.kb_article_id AND workspace_id = _workspace_id
    RETURNING id, slug, locale, status
      INTO v_article_id, v_slug_out, v_locale_out, v_status_out;

    IF v_article_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'kb_article_workspace_mismatch');
    END IF;
  ELSE
    -- Slug contract: stored slug → server title slug → deterministic id slug.
    v_base := COALESCE(
      NULLIF(g.slug, ''),
      NULLIF(_slug_seed, ''),
      'article-' || LEFT(g.id::text, 8));

    -- Lock the (workspace, locale) SLUG NAMESPACE — the exact scope the slug
    -- must be unique within — so concurrent allocations for the same
    -- namespace are serialized regardless of their base (R7.3 fix from 011).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ai-kb-slug-ns:' || _workspace_id::text || ':' || g.locale, 0));

    attempt := 0;
    <<allocate>>
    LOOP
      attempt := attempt + 1;
      v_slug := v_base;
      v_clash := NULL;

      FOR i IN 0..49 LOOP
        SELECT id INTO v_clash
        FROM public.knowledge_base_articles
        WHERE workspace_id = _workspace_id AND locale = g.locale AND slug = v_slug
        LIMIT 1;
        EXIT WHEN v_clash IS NULL;
        v_slug := v_base || '-' || (i + 2)::text;
        v_clash := NULL;
      END LOOP;

      IF v_clash IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'slug_allocation_failed');
      END IF;

      -- Defence in depth: an out-of-band writer outside this advisory lock
      -- can still take the slug between the probe and the INSERT. Retry
      -- rather than aborting the caller's publish transaction.
      BEGIN
        INSERT INTO public.knowledge_base_articles
          (workspace_id, slug, locale, title, content, excerpt, status)
        VALUES
          (_workspace_id, v_slug, g.locale, g.title, _content, g.excerpt, _article_status::public.article_status)
        RETURNING id, slug, locale, status
          INTO v_article_id, v_slug_out, v_locale_out, v_status_out;
        EXIT allocate;
      EXCEPTION WHEN unique_violation THEN
        IF attempt >= 5 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'slug_allocation_failed');
        END IF;
        -- fall through and re-probe
      END;
    END LOOP;
  END IF;

  UPDATE public.ai_kb_generated_articles
  SET status = _generated_status::public.ai_kb_generated_status,
      kb_article_id = v_article_id,
      reviewed_by = _reviewer,
      reviewed_at = now()
  WHERE id = _generated_id AND workspace_id = _workspace_id;

  RETURN jsonb_build_object(
    'ok', true,
    'kb_article_id', v_article_id,
    'status', v_status_out,
    'slug', v_slug_out,
    'locale', v_locale_out
  );
END;
$$;

-- ─── 10. A customer's message is activity on its chat ────────────────────
-- A chat locks by last activity (updated_at), so a visitor coming back
-- reopens an old thread. The widget, the operator send path and the channel
-- ingest already touch updated_at; this covers every other writer of a
-- customer message. Only an older updated_at is moved (no second write
-- when the server's own touch came first).
CREATE OR REPLACE FUNCTION public.tg_conversation_messages_touch_conversation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.sender_type = 'contact' THEN
    UPDATE public.conversations c
       SET updated_at = coalesce(NEW.created_at, now())
     WHERE c.id = NEW.conversation_id
       AND (c.updated_at IS NULL OR c.updated_at < coalesce(NEW.created_at, now()) - interval '1 minute');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_messages_touch_conversation ON public.conversation_messages;
CREATE TRIGGER trg_conversation_messages_touch_conversation
  AFTER INSERT ON public.conversation_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_conversation_messages_touch_conversation();

-- ─── 11. Plans: locked-data retention ─────────────────────────────────────
COMMENT ON COLUMN public.billing_plans.locked_data_retention_days IS
  'Days data locked by this plan''s limits (KB articles, contacts, chats; never members) is kept before it is deleted, only while billing locks are enabled for the edition (billing_settings.locks_enabled), and only after notices 30 and 7 days before (billing_lock_clocks). NULL = never deleted.';

-- ─── 12. The deletion notice, per edition (Super Admin → Branding → Email templates) ─
-- Seeded for both editions in fa/en/tr; a row that exists (edited) is never
-- overwritten. The server fills the dates for the edition (the Persian
-- calendar and Tehran time in Iran), the summary and the links.
CREATE OR REPLACE FUNCTION pg_temp._email_265_layout(p_locale text, p_title text, p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT '<!DOCTYPE html><html lang="' || p_locale || '" dir="' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || '">'
    || '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' || p_title || '</title></head>'
    || '<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Tahoma,sans-serif;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;">'
    || '<tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr>'
    || '<tr><td style="padding:40px;text-align:' || CASE WHEN p_locale = 'fa' THEN 'right' ELSE 'left' END || ';direction:' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || ';">'
    || '<h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">' || p_title || '</h2>'
    || p_body
    || '</td></tr>'
    || '<tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr>'
    || '</table></td></tr></table></body></html>'
$f$;

CREATE OR REPLACE FUNCTION pg_temp._email_265_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_body text, p_text text
) RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_edition text;
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_265_layout(p_locale, p_title, p_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_265_seed('billing_locked_data_deletion', 'fa',
  'داده‌های قفل‌شده {days_left} روز دیگر حذف می‌شوند — {brand}', 'حذف داده‌های قفل‌شده',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">فضای کاری {workspace} بیش از سقف پلن {plan_name} داده دارد و این داده‌ها قفل شده‌اند: {locked_summary}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">این داده‌ها در تاریخ {deletion_date} ({days_left} روز دیگر) برای همیشه حذف می‌شوند. برای نگه داشتن آن‌ها پلن را ارتقا دهید، یا پیش از آن تاریخ از آن‌ها خروجی بگیرید.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">ارتقای پلن</a></p><p style="margin:16px 0 0;text-align:center;"><a href="{export_url}" style="color:#1E40AF;font-size:14px;">دریافت خروجی داده‌های قفل‌شده</a></p>',
  'داده‌های قفل‌شده‌ی فضای کاری {workspace} ({locked_summary}) در تاریخ {deletion_date} ({days_left} روز دیگر) حذف می‌شوند. ارتقای پلن: {billing_url} — دریافت خروجی: {export_url}');
SELECT pg_temp._email_265_seed('billing_locked_data_deletion', 'en',
  'Locked data will be deleted in {days_left} days — {brand}', 'Locked data will be deleted',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace {workspace} holds more than the {plan_name} plan allows, and the excess is locked: {locked_summary}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">It will be deleted permanently on {deletion_date} (in {days_left} days). Upgrade to keep it, or export it before then.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Upgrade</a></p><p style="margin:16px 0 0;text-align:center;"><a href="{export_url}" style="color:#1E40AF;font-size:14px;">Export locked data</a></p>',
  'The locked data of {workspace} ({locked_summary}) will be deleted on {deletion_date} (in {days_left} days). Upgrade: {billing_url} — Export: {export_url}');
SELECT pg_temp._email_265_seed('billing_locked_data_deletion', 'tr',
  'Kilitli veriler {days_left} gün içinde silinecek — {brand}', 'Kilitli veriler silinecek',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{workspace} çalışma alanınız {plan_name} planının izin verdiğinden fazla veri barındırıyor ve fazlası kilitlendi: {locked_summary}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Bu veriler {deletion_date} tarihinde ({days_left} gün sonra) kalıcı olarak silinecek. Saklamak için planınızı yükseltin ya da o tarihten önce dışa aktarın.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Planı yükselt</a></p><p style="margin:16px 0 0;text-align:center;"><a href="{export_url}" style="color:#1E40AF;font-size:14px;">Kilitli verileri dışa aktar</a></p>',
  '{workspace} çalışma alanının kilitli verileri ({locked_summary}) {deletion_date} tarihinde ({days_left} gün sonra) silinecek. Yükselt: {billing_url} — Dışa aktar: {export_url}');

-- ─── 13. Access: the backend (service_role) only ──────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_lock_clocks', 'billing_lock_exports'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = t AND policyname = 'service_role_only'
      ) THEN
        EXECUTE format(
          'CREATE POLICY service_role_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
          t
        );
      END IF;
    END IF;
  END LOOP;
END $$;

DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_locks_enabled()',
    'public.billing_effective_plan_id(uuid)',
    'public.billing_limit_raw(uuid, text, uuid)',
    'public.billing_effective_limit(uuid, text, uuid)',
    'public.billing_lock_rank_rows(uuid, text)',
    'public.billing_countable_count(uuid, text)',
    'public.billing_lock_limit(uuid, text, uuid)',
    'public.billing_lock_compute(uuid, text, uuid)',
    'public.billing_lock_cutoff(uuid, text, uuid)',
    'public.billing_lock_rows_after(uuid, text, timestamptz, uuid, integer)',
    'public.billing_locked_ids(uuid, text, uuid, integer)',
    'public.billing_is_locked(uuid, text, uuid)',
    'public.billing_lock_report(uuid, uuid)',
    'public.billing_release_locked_agent_chats(uuid)',
    'public.billing_lock_next_batch(timestamptz)',
    'public.billing_lock_clock_observe(uuid)',
    'public.billing_lock_episode_deadline(public.billing_lock_clocks)',
    'public.billing_locked_delete(uuid, text, text, uuid[])',
    'public.wi_resolve_seat_capacity(uuid)',
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.tg_conversation_messages_touch_conversation()'
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
