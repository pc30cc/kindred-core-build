-- 257 — The native apps' settings are kept per edition.
--
-- One deployment runs one edition at a time (shared/edition.ts resolveEdition):
-- the Iranian edition (WebYar) while platform_settings.region_mode = 'iran',
-- the International edition (RESPOK) for every other value and for no row.
-- The Super Admin can switch region_mode, and each edition keeps its own app
-- settings across a switch: after one, Super Admin and the apps see that
-- edition's own values, never the other's. Until now each of these was one
-- platform-wide row (`<table>_singleton_idx`, a unique index on (true)), so a
-- switch served RESPOK's apps WebYar's feeds, bundle ids and texts, or the
-- other way round.
--
--   desktop_app_settings (207)    Super Admin → Windows app
--   macos_app_settings (211)      Super Admin → macOS app
--   mobile_app_settings (195)     Super Admin → Mobile app (iOS and Android,
--                                 the promotions included)
--   push_platform_settings (195)  Super Admin → Notifications (the mobile
--                                 apps' push policy)
--     gain `edition` ('iran' | 'international'): one row per edition, the
--     singleton index replaced by a unique index on (edition). An edition
--     with no row yet is served its own brand's defaults
--     (server/services/*: desktopAppDefaults, macosAppDefaults,
--     mobileAppDefaults, pushPlatformDefaults; shared/nativeAppBrands.ts),
--     and its row is created by the first save of its Super Admin page.
--   desktop_app_campaigns (208)   Super Admin → Windows app → Ads &
--                                 announcements (both desktop apps)
--     gains `edition` too: each edition lists, shows, edits and deletes only
--     its own.
--
-- The rows that exist belong to the edition the deployment runs now: 'iran'
-- iff platform_settings.region_mode = 'iran', otherwise (any other value, or
-- no platform_settings row) 'international' — the rule of resolveEdition,
-- read from the same singleton row (152) server/services/platformRegion.ts
-- reads. public.platform_edition() states it once, for that backfill and as
-- the column's default.
--
-- The default is for code that does not name the edition. The server before
-- this migration inserts a settings row only into an empty table and a
-- campaign at any time, both without `edition`; this migration is applied
-- before that code is replaced, and the default puts such a row in the
-- edition running at that moment, so the old code keeps working against this
-- schema (it reads the oldest row and updates it by id, and there is one).
-- The new code always names the edition.
--
-- app_review_status() and app_review_seed() (248, 249) read and wrote "the"
-- mobile_app_settings row. The demo account and its workspace are one per
-- database, whichever edition made them, so the status reports the latest
-- time any edition seeded them; the seed records the demo account in the
-- running edition's App Store record only, never in the other's. Both keep
-- their names, arguments and results.
--
-- Re-runnable: every step is guarded or a no-op the second time, and rows
-- that already have an edition are never moved.

-- ─── The edition, as resolveEdition decides it ────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_edition()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE WHEN (SELECT s.region_mode FROM public.platform_settings s LIMIT 1) = 'iran'
              THEN 'iran'
              ELSE 'international'
         END
$$;

COMMENT ON FUNCTION public.platform_edition() IS
  'The running edition: iran iff platform_settings.region_mode = ''iran'', else international (shared/edition.ts resolveEdition). Default of the per-edition app settings tables (257).';

-- Service role only, as every other function; the inserting role evaluates
-- the default, and only the backend (service_role) inserts these rows.
DO $acl$
DECLARE
  f text := 'public.platform_edition()';
  r text;
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END
$acl$;

-- ─── Windows app ──────────────────────────────────────────────────────────
ALTER TABLE public.desktop_app_settings ADD COLUMN IF NOT EXISTS edition text;
UPDATE public.desktop_app_settings SET edition = public.platform_edition() WHERE edition IS NULL;
ALTER TABLE public.desktop_app_settings
  ALTER COLUMN edition SET DEFAULT public.platform_edition(),
  ALTER COLUMN edition SET NOT NULL;
DROP INDEX IF EXISTS public.desktop_app_settings_singleton_idx;
CREATE UNIQUE INDEX IF NOT EXISTS desktop_app_settings_edition_idx
  ON public.desktop_app_settings (edition);

-- ─── macOS app ────────────────────────────────────────────────────────────
ALTER TABLE public.macos_app_settings ADD COLUMN IF NOT EXISTS edition text;
UPDATE public.macos_app_settings SET edition = public.platform_edition() WHERE edition IS NULL;
ALTER TABLE public.macos_app_settings
  ALTER COLUMN edition SET DEFAULT public.platform_edition(),
  ALTER COLUMN edition SET NOT NULL;
DROP INDEX IF EXISTS public.macos_app_settings_singleton_idx;
CREATE UNIQUE INDEX IF NOT EXISTS macos_app_settings_edition_idx
  ON public.macos_app_settings (edition);

-- ─── Mobile apps (iOS, Android) ───────────────────────────────────────────
ALTER TABLE public.mobile_app_settings ADD COLUMN IF NOT EXISTS edition text;
UPDATE public.mobile_app_settings SET edition = public.platform_edition() WHERE edition IS NULL;
ALTER TABLE public.mobile_app_settings
  ALTER COLUMN edition SET DEFAULT public.platform_edition(),
  ALTER COLUMN edition SET NOT NULL;
DROP INDEX IF EXISTS public.mobile_app_settings_singleton_idx;
CREATE UNIQUE INDEX IF NOT EXISTS mobile_app_settings_edition_idx
  ON public.mobile_app_settings (edition);

-- ─── Push policy of the mobile apps ───────────────────────────────────────
ALTER TABLE public.push_platform_settings ADD COLUMN IF NOT EXISTS edition text;
UPDATE public.push_platform_settings SET edition = public.platform_edition() WHERE edition IS NULL;
ALTER TABLE public.push_platform_settings
  ALTER COLUMN edition SET DEFAULT public.platform_edition(),
  ALTER COLUMN edition SET NOT NULL;
DROP INDEX IF EXISTS public.push_platform_settings_singleton_idx;
CREATE UNIQUE INDEX IF NOT EXISTS push_platform_settings_edition_idx
  ON public.push_platform_settings (edition);

-- ─── Desktop ads and announcements ────────────────────────────────────────
ALTER TABLE public.desktop_app_campaigns ADD COLUMN IF NOT EXISTS edition text;
UPDATE public.desktop_app_campaigns SET edition = public.platform_edition() WHERE edition IS NULL;
ALTER TABLE public.desktop_app_campaigns
  ALTER COLUMN edition SET DEFAULT public.platform_edition(),
  ALTER COLUMN edition SET NOT NULL;
-- The apps read "this edition's live campaigns, by priority".
CREATE INDEX IF NOT EXISTS desktop_app_campaigns_edition_idx
  ON public.desktop_app_campaigns (edition, active, priority DESC);

-- Guarded so the file can be applied twice: `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'desktop_app_settings', 'macos_app_settings', 'mobile_app_settings',
    'push_platform_settings', 'desktop_app_campaigns'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_edition_chk') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (edition IN (''iran'', ''international''))',
        t, t || '_edition_chk'
      );
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN public.desktop_app_settings.edition IS
  'The edition this row is for (iran = WebYar, international = RESPOK); one row per edition. Migration 257.';
COMMENT ON COLUMN public.macos_app_settings.edition IS
  'The edition this row is for (iran = WebYar, international = RESPOK); one row per edition. Migration 257.';
COMMENT ON COLUMN public.mobile_app_settings.edition IS
  'The edition this row is for (iran = WebYar, international = RESPOK); one row per edition. Migration 257.';
COMMENT ON COLUMN public.push_platform_settings.edition IS
  'The edition this row is for (iran = WebYar, international = RESPOK); one row per edition. Migration 257.';
COMMENT ON COLUMN public.desktop_app_campaigns.edition IS
  'The edition that shows this campaign (iran = WebYar, international = RESPOK). Migration 257.';

-- ─── App Review (248, 249): the running edition's App Store record ───────
CREATE OR REPLACE FUNCTION public.app_review_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user   public.profiles%ROWTYPE;
  v_status text;
  v_ws     public.workspaces%ROWTYPE;
  v_at     timestamptz;
BEGIN
  SELECT * INTO v_user FROM public.profiles WHERE email = 'apple@webyar.ai';
  IF v_user.id IS NOT NULL THEN
    SELECT status INTO v_status FROM public.user_credentials WHERE user_id = v_user.id;
  END IF;
  SELECT * INTO v_ws FROM public.workspaces WHERE slug = 'ws_appreview';
  -- One demo per database, whichever edition seeded it last.
  SELECT max(app_review_seeded_at) INTO v_at FROM public.mobile_app_settings;

  RETURN jsonb_build_object(
    'email', 'apple@webyar.ai',
    'exists', v_user.id IS NOT NULL,
    'user_id', v_user.id,
    'full_name', v_user.full_name,
    'enabled', v_user.id IS NOT NULL AND coalesce(v_status, 'active') = 'active',
    'workspace_id', v_ws.id,
    'workspace_name', v_ws.name,
    'seeded_at', v_at
  );
END;
$$;

-- Same name, arguments and result as 249's.
CREATE OR REPLACE FUNCTION public.app_review_seed(_password_hash text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_p   jsonb;
  v_ws  uuid;
  v_ids jsonb;
BEGIN
  v_p := public.app_review_seed_people(_password_hash);
  v_ws := public.app_review_seed_workspace(v_p, public.app_review_seed_plan());
  v_ids := jsonb_build_object('contacts', public.app_review_seed_contacts(v_ws));
  v_ids := v_ids || jsonb_build_object('visitors', public.app_review_seed_visitors(v_ws, v_ids->'contacts'));
  PERFORM public.app_review_seed_inbox(v_ws, v_p, v_ids);
  PERFORM public.app_review_seed_inbox_more(v_ws, v_p, v_ids);
  PERFORM public.app_review_seed_team(v_ws, v_p);
  PERFORM public.app_review_seed_traffic(v_ws);
  PERFORM public.app_review_seed_page_views(v_ws);

  -- The running edition's App Store record; the other edition's is its own.
  UPDATE public.mobile_app_settings
     SET app_review_seeded_at = now(), demo_account_username = 'apple@webyar.ai'
   WHERE edition = public.platform_edition();
  RETURN public.app_review_status();
END;
$$;

REVOKE ALL ON FUNCTION public.app_review_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_review_seed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_review_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.app_review_seed(text) TO service_role;
