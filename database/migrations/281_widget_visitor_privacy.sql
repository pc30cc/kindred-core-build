-- 281 — Visitor privacy in the chat widget (P-01): consent before tracking,
-- no query strings in page history, a privacy notice in the visitor's forms,
-- and a retention period for visitor tracking data.
--
-- 1. widget_settings (Settings → Privacy requests → Visitor privacy):
--    - tracking_requires_consent: the widget tracks nothing (no visitor
--      session, page views, presence, Smart Engagement storage, AI page
--      journey) until the page gives the visitor's consent
--      (`__gs.push(['consent', true])`, docs/WIDGET_PUBLIC_API.md). Default
--      off. A browser sending Global Privacy Control is treated as asking for
--      consent whatever this says (server/services/widget/trackingPrivacy.ts).
--    - tracking_keep_query: a tracked page keeps its query string. Default
--      off: `?email=…` or `?token=…` no longer reaches page history.
--    - visitor_data_retention_days: how long the workspace keeps visitor
--      tracking data, 30 to 1095 days; NULL = the platform's default (3.).
-- 2. widget_prechat_settings (Widget → Pre-chat form): the privacy line the
--    pre-chat and leave-a-message forms show above their button in every
--    template: privacy_notice_enabled (default off), privacy_notice_text (at
--    most 300 characters; NULL = the widget's own sentence in the visitor's
--    language), privacy_policy_url (an https link, at most 500 characters;
--    NULL = no link) and privacy_consent_required (a checkbox the visitor
--    ticks before sending; the server refuses the form without it).
-- 3. data_retention_policies: the visitor tracking tables — visitor_sessions
--    (by last_seen_at), visitor_page_views (viewed_at), web_analytics_events,
--    widget_smart_events and widget_ai_nudges (created_at) — rolling, 395
--    days (13 months), ENABLED, `workspace_overridable` (a workspace's
--    visitor_data_retention_days replaces the 395 for its own rows). Seeded
--    with ON CONFLICT DO NOTHING: a policy the Super Admin tuned is never
--    overwritten. The server runs them every six hours
--    (server/services/privacy/visitorRetention.ts) through the retention
--    engine (server/services/retention/retentionService.ts); Super Admin →
--    Data retention shows, previews, tunes and disables them. Deleting a
--    session also deletes its page views and presence (ON DELETE CASCADE)
--    and unlinks its analytics events, calls and article votes (SET NULL);
--    conversations keep their messages.
-- 4. visitor_data_retention_count_expired(policy) and
--    visitor_data_retention_delete_batch(policy, batch): 169's count and
--    bounded delete for a workspace-overridable policy, workspace by
--    workspace with each one's window (its (workspace_id, time) index
--    serves each probe). Only an enabled, non-permanent, overridable policy
--    whose table has a workspace_id column; SECURITY DEFINER, search_path
--    pinned, executable by service_role only.
--
-- 5. widget_smart_events_ws_created_idx (workspace_id, created_at): what the
--    Smart Engagement policy's per-workspace count and delete read (the other
--    four tables have their (workspace_id, time) index already). On a live
--    database build it by hand FIRST, outside a transaction (a plain build
--    blocks writes to widget_smart_events for its whole run); this file then
--    finds it and builds nothing:
--      CREATE INDEX CONCURRENTLY IF NOT EXISTS widget_smart_events_ws_created_idx
--        ON public.widget_smart_events (workspace_id, created_at);
--    An interrupted CONCURRENTLY build leaves an invalid index of that name:
--    the file then stops and says so (drop it with DROP INDEX CONCURRENTLY
--    and build it again).
--
-- Locks: ACCESS EXCLUSIVE on widget_settings and widget_prechat_settings for
-- an instant each (new nullable / constant-default columns rewrite nothing;
-- their CHECK constraints are added NOT VALID, then validated with SHARE
-- UPDATE EXCLUSIVE, which blocks no reads or writes), ROW EXCLUSIVE on
-- data_retention_policies for the seed, SHARE on widget_smart_events while
-- its index builds (unless it was built beforehand as above). The file sets
-- lock_timeout 5s itself and resets it (RESPOK's migrator runs without
-- PGOPTIONS); a statement stopped by it is simply run again. Nothing is deleted when it runs: the
-- policies delete on their first run, and only rows older than 13 months
-- (or the workspace's own period). Re-runnable. Dry run: the file inside
-- BEGIN … ROLLBACK. Drops nothing; touches no archive schema or table.

SET lock_timeout = '5s';

-- ─── 1. Tracking: consent, query strings, retention ───────────────────────
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS tracking_requires_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_keep_query boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS visitor_data_retention_days integer;

DO $c$ BEGIN
  ALTER TABLE public.widget_settings
    ADD CONSTRAINT widget_settings_visitor_data_retention_days_check
    CHECK (visitor_data_retention_days IS NULL OR visitor_data_retention_days BETWEEN 30 AND 1095) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $c$;
ALTER TABLE public.widget_settings VALIDATE CONSTRAINT widget_settings_visitor_data_retention_days_check;

COMMENT ON COLUMN public.widget_settings.tracking_requires_consent IS
  'Track nothing until the page gives the visitor''s consent (__gs.push([''consent'', true])); GPC is treated the same way whatever this says. Migration 281.';
COMMENT ON COLUMN public.widget_settings.tracking_keep_query IS
  'Keep a tracked page''s query string (default off: the path only). Migration 281.';
COMMENT ON COLUMN public.widget_settings.visitor_data_retention_days IS
  'How long this workspace keeps visitor tracking data (30..1095 days); NULL = the platform default (data_retention_policies). Migration 281.';

-- ─── 2. The privacy line of the visitor's forms ───────────────────────────
ALTER TABLE public.widget_prechat_settings
  ADD COLUMN IF NOT EXISTS privacy_notice_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS privacy_notice_text text,
  ADD COLUMN IF NOT EXISTS privacy_policy_url text,
  ADD COLUMN IF NOT EXISTS privacy_consent_required boolean NOT NULL DEFAULT false;

DO $c$ BEGIN
  ALTER TABLE public.widget_prechat_settings
    ADD CONSTRAINT widget_prechat_settings_privacy_notice_text_check
    CHECK (privacy_notice_text IS NULL OR char_length(privacy_notice_text) <= 300) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $c$;
DO $c$ BEGIN
  ALTER TABLE public.widget_prechat_settings
    ADD CONSTRAINT widget_prechat_settings_privacy_policy_url_check
    CHECK (privacy_policy_url IS NULL OR (char_length(privacy_policy_url) <= 500 AND privacy_policy_url ~* '^https://[^[:space:]]+$')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $c$;
ALTER TABLE public.widget_prechat_settings VALIDATE CONSTRAINT widget_prechat_settings_privacy_notice_text_check;
ALTER TABLE public.widget_prechat_settings VALIDATE CONSTRAINT widget_prechat_settings_privacy_policy_url_check;

COMMENT ON COLUMN public.widget_prechat_settings.privacy_notice_enabled IS
  'Show a privacy line above the pre-chat and leave-a-message forms'' button. Migration 281.';
COMMENT ON COLUMN public.widget_prechat_settings.privacy_notice_text IS
  'The privacy line (at most 300 characters); NULL = the widget''s own sentence in the visitor''s language. Migration 281.';
COMMENT ON COLUMN public.widget_prechat_settings.privacy_policy_url IS
  'The privacy policy the line links to (https); NULL = no link. Migration 281.';
COMMENT ON COLUMN public.widget_prechat_settings.privacy_consent_required IS
  'The visitor ticks a consent checkbox before sending the form; the server refuses it otherwise. Migration 281.';

-- ─── 3. Retention of visitor tracking data ────────────────────────────────
INSERT INTO public.data_retention_policies
  (policy_key, table_name, timestamp_column, category, retention_mode, hot_retention_days, keep_last_n,
   workspace_overridable, enabled, batch_size, description)
VALUES
  ('visitor_sessions',     'visitor_sessions',     'last_seen_at', 'analytics', 'rolling', 395, NULL, true, true, 5000,
   'Visitor sessions (device, place, first pages) — 13 months after the last visit, or the workspace''s own period'),
  ('visitor_page_views',   'visitor_page_views',   'viewed_at',    'analytics', 'rolling', 395, NULL, true, true, 5000,
   'Visitor page history — 13 months, or the workspace''s own period'),
  ('web_analytics_events', 'web_analytics_events', 'created_at',   'analytics', 'rolling', 395, NULL, true, true, 5000,
   'Web analytics custom events — 13 months, or the workspace''s own period'),
  ('widget_smart_events',  'widget_smart_events',  'created_at',   'analytics', 'rolling', 395, NULL, true, true, 5000,
   'Smart Engagement events per visitor — 13 months, or the workspace''s own period'),
  ('widget_ai_nudges',     'widget_ai_nudges',     'created_at',   'analytics', 'rolling', 395, NULL, true, true, 5000,
   'AI proactive nudges per visitor — 13 months, or the workspace''s own period')
ON CONFLICT (policy_key) DO NOTHING;

-- ─── 3b. The Smart Engagement policy's index (see 5. in the header) ───────
DO $idx$ BEGIN
  IF to_regclass('public.widget_smart_events_ws_created_idx') IS NULL THEN
    CREATE INDEX widget_smart_events_ws_created_idx ON public.widget_smart_events (workspace_id, created_at);
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid = 'public.widget_smart_events_ws_created_idx'::regclass AND indisvalid
  ) THEN
    RAISE EXCEPTION '281: widget_smart_events_ws_created_idx is invalid (an interrupted CREATE INDEX CONCURRENTLY); DROP INDEX CONCURRENTLY public.widget_smart_events_ws_created_idx, build it again, then run this file';
  END IF;
END $idx$;

-- ─── 4. Count and delete, workspace by workspace ──────────────────────────
-- The policy row is the allow-list (as 169's functions): nothing here can be
-- aimed at a table no enabled, overridable, non-permanent policy names.
CREATE OR REPLACE FUNCTION public.visitor_data_retention_policy(_policy_key text)
RETURNS public.data_retention_policies
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.data_retention_policies%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.data_retention_policies WHERE policy_key = _policy_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_policy_not_found: %', _policy_key; END IF;
  IF p.retention_mode <> 'rolling' OR p.hot_retention_days IS NULL OR p.hot_retention_days <= 0 THEN
    RAISE EXCEPTION 'retention_policy_not_rolling: %', _policy_key;
  END IF;
  IF NOT p.workspace_overridable THEN
    RAISE EXCEPTION 'retention_policy_not_overridable: %', _policy_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.' || quote_ident(p.table_name))
       AND attname = 'workspace_id' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'retention_policy_no_workspace_column: %', _policy_key;
  END IF;
  RETURN p;
END;
$$;

CREATE OR REPLACE FUNCTION public.visitor_data_retention_count_expired(_policy_key text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.data_retention_policies%ROWTYPE;
  w record;
  n bigint;
  total bigint := 0;
BEGIN
  p := public.visitor_data_retention_policy(_policy_key);
  FOR w IN
    SELECT ws.id AS workspace_id, coalesce(s.visitor_data_retention_days, p.hot_retention_days) AS days
      FROM public.workspaces ws
      LEFT JOIN public.widget_settings s ON s.workspace_id = ws.id
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id = $1 AND %I < $2', p.table_name, p.timestamp_column)
      INTO n USING w.workspace_id, now() - make_interval(days => w.days);
    total := total + coalesce(n, 0);
  END LOOP;
  RETURN total;
END;
$$;

CREATE OR REPLACE FUNCTION public.visitor_data_retention_delete_batch(_policy_key text, _batch_size integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.data_retention_policies%ROWTYPE;
  w record;
  n integer;
  remaining integer := GREATEST(1, LEAST(coalesce(_batch_size, 5000), 50000));
  total integer := 0;
BEGIN
  p := public.visitor_data_retention_policy(_policy_key);
  IF NOT p.enabled THEN RAISE EXCEPTION 'retention_policy_disabled: %', _policy_key; END IF;
  FOR w IN
    SELECT ws.id AS workspace_id, coalesce(s.visitor_data_retention_days, p.hot_retention_days) AS days
      FROM public.workspaces ws
      LEFT JOIN public.widget_settings s ON s.workspace_id = ws.id
  LOOP
    -- Bounded: at most `remaining` rows, oldest first, in one statement.
    EXECUTE format(
      'WITH victims AS (
         SELECT ctid FROM public.%I WHERE workspace_id = $1 AND %I < $2 ORDER BY %I ASC LIMIT $3
       )
       DELETE FROM public.%I t USING victims v WHERE t.ctid = v.ctid',
      p.table_name, p.timestamp_column, p.timestamp_column, p.table_name
    ) USING w.workspace_id, now() - make_interval(days => w.days), remaining;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    remaining := remaining - n;
    EXIT WHEN remaining <= 0;
  END LOOP;
  RETURN total;
END;
$$;

COMMENT ON FUNCTION public.visitor_data_retention_delete_batch(text, integer) IS
  'Bounded delete for a workspace-overridable retention policy: each workspace''s rows older than its visitor_data_retention_days (else the policy''s hot_retention_days), at most _batch_size in all. Migration 281.';

DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.visitor_data_retention_policy(text)',
    'public.visitor_data_retention_count_expired(text)',
    'public.visitor_data_retention_delete_batch(text, integer)'
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

RESET lock_timeout;
