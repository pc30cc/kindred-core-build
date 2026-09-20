-- 197: Retire the legacy platform-URL shadows on `platform_domains`.
--
-- `platform_domains.widget_base_url` and `.asset_base_url` are copies of URLs
-- the platform owns somewhere else. Migration 20260419082857 moved widget URLs
-- to `widget_platform_settings` and marked both columns DEPRECATED, kept only
-- so a rollback had somewhere to land. Nothing has read them since — but the
-- admin API still accepted writes to them, so they kept the domain the
-- platform used before it moved. A column no screen shows is a column nobody
-- corrects.
--
-- NULL, not a new URL. These are retired shadows: the right value is "unset",
-- which is also what a fresh install has. Writing today's domain in would just
-- re-create the same problem for whoever moves next.
--
-- TARGETED AND IDEMPOTENT. Only rows still carrying an exact known legacy
-- value are touched, so an operator who set their own URL here keeps it, and
-- running this twice is a no-op.
--
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- `workspace_branding.canonical_base_url`, `.panel_base_url` and
-- `.asset_base_url` carry the same stale shadows, and they are NOT cleaned up
-- here. `trg_protect_workspace_domains` (migration 20260415171446) is a BEFORE
-- UPDATE trigger that reassigns those columns back to their OLD values unless
-- `has_role(auth.uid(), 'admin')`. A migration has no `auth.uid()`, so the
-- trigger would not reject the write — it would silently undo it and report
-- success.
--
-- The only way to make the UPDATE stick from here is to disable that trigger,
-- and that is not a trade worth making: the trigger is a deliberate guard on
-- who may change a workspace's domains, while the values it is protecting have
-- no runtime reader left. Nothing reads `panel_base_url` or `asset_base_url`
-- at all, and the one consumer of `canonical_base_url` — the dashboard's
-- <link rel="canonical"> — now takes it from `platform_domains` through
-- GET /api/platform/origins. The stale rows are inert.
--
-- They are cleared from Super Admin instead, where the admin role the trigger
-- asks for is actually present. `src/test/architecture/platformUrlOwnership.test.ts`
-- pins the reasoning so nobody "fixes" this later by reaching for the trigger.
--
-- Also deliberately absent: platform and workspace branding TEXT, every
-- customer domain in `workspace_domains`, and the call centre ringback asset
-- URL. Those are the operator's to set in Super Admin, not a migration's to
-- overwrite.

DO $$
DECLARE
  legacy text[] := ARRAY[
    'https://destekly.tr',
    'https://destekly.tr/',
    'http://destekly.tr',
    'https://app.destekly.tr',
    'https://app.destekly.tr/',
    'http://app.destekly.tr',
    'https://www.destekly.tr',
    'https://www.destekly.tr/'
  ];
  col text;
BEGIN
  -- Guarded per column: a self-host database part-way through the chain, or
  -- one that rolled a column back, must not fail here.
  IF to_regclass('public.platform_domains') IS NOT NULL THEN
    FOREACH col IN ARRAY ARRAY['widget_base_url', 'asset_base_url'] LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'platform_domains'
          AND column_name = col
      ) THEN
        EXECUTE format(
          'UPDATE public.platform_domains SET %I = NULL WHERE %I = ANY($1)', col, col
        ) USING legacy;
      END IF;
    END LOOP;
  END IF;
END $$;

-- Say so in the schema itself, so the next person reading `\d+` does not have
-- to find the migration that retired these. Comments are metadata, not data:
-- no protection trigger is involved and nothing is overwritten.
DO $$
BEGIN
  IF to_regclass('public.workspace_branding') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.workspace_branding.canonical_base_url IS
      'DEPRECATED — platform identity. Read platform_domains.canonical_base_url via GET /api/platform/origins.'$c$;
    EXECUTE $c$COMMENT ON COLUMN public.workspace_branding.panel_base_url IS
      'DEPRECATED — platform identity. Read platform_domains.app_base_url via GET /api/platform/origins.'$c$;
    EXECUTE $c$COMMENT ON COLUMN public.workspace_branding.asset_base_url IS
      'DEPRECATED — managed centrally via widget_platform_settings.'$c$;
  END IF;
END $$;
