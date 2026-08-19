-- 023 — Close 4 more anon-role RLS drift cases found by the general
-- migration-chain drift guard (src/test/integration/migrationChainAnonDriftGuard.test.ts)
-- added alongside 022. Same root cause as 022: the hosted chain tightened
-- these on 2026-04-15 / 2026-08-02, the self-host chain never received the
-- equivalent fix. Each one below is ported from its exact final hosted
-- definition (dependencies checked to exist in the self-host chain before
-- porting — none of these reference entitlement/plan helpers that were since
-- removed from the hosted definitions anyway).

-- ---------- app_runtime_config ----------
-- Hosted DROPPED anon SELECT entirely on 2026-04-15
-- (supabase/migrations/20260415082424_...sql) and never re-added it — this
-- table can hold operational secrets (e.g. captcha provider secretKey,
-- default email provider config; see server/routes/auth.ts,
-- server/services/email/index.ts), so on the self-host chain this was a
-- real anon-readable-secrets exposure, not just a cosmetic difference.
DROP POLICY IF EXISTS "Public can read runtime config" ON app_runtime_config;

-- ---------- translations ----------
-- Hosted: supabase/migrations/20260415082551_...sql — anon may only read
-- platform-level (workspace_id IS NULL) translation strings, not any
-- individual workspace's overrides.
DROP POLICY IF EXISTS "Public can read translations" ON translations;
DROP POLICY IF EXISTS "Public can read platform translations" ON translations;
CREATE POLICY "Public can read platform translations"
  ON translations FOR SELECT TO anon
  USING (workspace_id IS NULL);

-- ---------- workspace_branding ----------
-- Hosted: supabase/migrations/20260415082519_...sql — anon may only read
-- branding for a workspace whose widget is actually enabled, not every
-- workspace unconditionally.
DROP POLICY IF EXISTS "Public can read branding" ON workspace_branding;
DROP POLICY IF EXISTS "Public can read active workspace branding" ON workspace_branding;
CREATE POLICY "Public can read active workspace branding"
  ON workspace_branding FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM widget_settings ws
      WHERE ws.workspace_id = workspace_branding.workspace_id
      AND ws.enabled = true
    )
  );

-- ---------- knowledge_base_categories ----------
-- Hosted final definition: supabase/migrations/20260802200843_...sql (after
-- several iterations that added, then explicitly removed, an entitlement/plan
-- dependency — "Knowledge Base is a CORE product: remove every plan/
-- entitlement dependency from RLS", per that migration's own comment, so this
-- port intentionally uses the entitlement-free final form). Anon may only see
-- a category that actually has a published article in it.
DROP POLICY IF EXISTS "Public can read KB categories" ON knowledge_base_categories;
DROP POLICY IF EXISTS "Public can read non-empty KB categories" ON knowledge_base_categories;
CREATE POLICY "Public can read non-empty KB categories"
  ON knowledge_base_categories FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM knowledge_base_articles a
      WHERE a.category_id = knowledge_base_categories.id
      AND a.workspace_id = knowledge_base_categories.workspace_id
      AND a.status = 'published'::article_status
    )
  );

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'app_runtime_config' AND policyname = 'Public can read runtime config';
  IF n <> 0 THEN
    RAISE EXCEPTION '023: app_runtime_config is still anon-readable';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'translations' AND policyname = 'Public can read translations';
  IF n <> 0 THEN
    RAISE EXCEPTION '023: old wide-open translations policy still present';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'translations' AND policyname = 'Public can read platform translations';
  IF n <> 1 THEN
    RAISE EXCEPTION '023: translations scoped policy missing';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'workspace_branding' AND policyname = 'Public can read branding';
  IF n <> 0 THEN
    RAISE EXCEPTION '023: old wide-open workspace_branding policy still present';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'workspace_branding' AND policyname = 'Public can read active workspace branding';
  IF n <> 1 THEN
    RAISE EXCEPTION '023: workspace_branding scoped policy missing';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'knowledge_base_categories' AND policyname = 'Public can read KB categories';
  IF n <> 0 THEN
    RAISE EXCEPTION '023: old wide-open knowledge_base_categories policy still present';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'knowledge_base_categories' AND policyname = 'Public can read non-empty KB categories';
  IF n <> 1 THEN
    RAISE EXCEPTION '023: knowledge_base_categories scoped policy missing';
  END IF;

  RAISE NOTICE '023: anon policy parity hardening verified (app_runtime_config, translations, workspace_branding, knowledge_base_categories)';
END
$verify$;
