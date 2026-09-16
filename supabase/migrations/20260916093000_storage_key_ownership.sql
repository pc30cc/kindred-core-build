-- 190 — storage keys become the only record of a WebYar-owned file, and the
-- database enforces that every key names its own owner.
--
-- A storage key (`workspace/<id>/...`, `users/<id>/...`, `platform/...`) is
-- identical on every storage vendor. A public URL is not — it names one
-- vendor's hostname. So a row that persists a URL is pinned to whichever
-- provider was primary when it was written, and promoting a new primary
-- would mean rewriting every such row. The platform therefore derives URLs
-- at read time from the key (server/services/storage/urlResolver.ts) and a
-- promotion rewrites nothing.
--
-- Two things are needed for that, and this migration does both.
--
-- 1. THE LAST MISSING KEY COLUMN. Every other upload already records its
--    key:
--
--      conversation_attachments.storage_path   email_attachments.storage_key
--      call_recordings.storage_path            privacy_jobs.artifact_storage_key
--      workspace_branding.logo_storage_key     call_center_settings.avatar_storage_path
--      profiles.avatar_storage_key             ai_agent_settings.metadata->ai_avatar_storage_key
--
--    Contact avatars (server/services/channels/telegram/mediaIngest.ts) kept
--    only `avatar_url`, with nothing to derive from. The widget launcher
--    image (`widget_settings.fab_image_url`) was worse still: the browser
--    uploaded the bytes and then PATCHed the provider URL the upload route
--    returned straight back into the settings row, so the row recorded a
--    vendor hostname and no key at all.
--
--    Both backfills are deliberately CONSERVATIVE and per-row
--    workspace-scoped: a key is recovered only when the stored URL contains
--    THIS row's OWN workspace id under a prefix this platform is known to
--    have written. A generic `workspace/<any-uuid>/` match is never
--    trusted — `contacts.avatar_url` historically also received
--    integrator-supplied URLs through the CRM import API (that writer is
--    gone: the workspace-facing contact schemas no longer accept the field
--    at all, so any such value is legacy historical data, not something new
--    that can appear), and a URL that merely mentions some workspace id
--    must never be adopted as this row's key.
--
--    Anything unprovable stays NULL — a NULL key means "we cannot prove
--    this is our object", and every read path already handles it by falling
--    back, read-only, to the stored URL.
--
--    Query strings and fragments are stripped: a CDN link may carry
--    `?v=2` or `#x`, and neither is part of the object key.
--
-- 2. OWNERSHIP CONSTRAINTS. A key is the authority for which tenant's
--    bucket namespace a row reads from, so a key naming another tenant is a
--    cross-tenant read primitive. These CHECKs make that unrepresentable in
--    the schema rather than only in the resolver.
--
--    contacts' constraint is VALIDATED: the backfill above only ever writes
--    a key built from the row's own workspace_id, so the table provably
--    satisfies it. The pre-existing key columns get NOT VALID constraints:
--    they contain rows written before the canonical roots existed (legacy
--    `avatars/<userId>/...` and `branding/<workspaceId>/...` shapes,
--    migrations 177/184), which the legacy-migration job rewrites over
--    time. NOT VALID still enforces the rule on every INSERT and UPDATE
--    from now on — it only declines to re-scan history — so new writes are
--    guarded immediately and the table can be VALIDATEd once the legacy
--    sweep finishes.
--
-- Deliberately NOT done here: clearing the now-derived `*_url` columns.
-- This migration is applied BEFORE the backend that reads keys (deployment
-- order 189 -> 190 -> backend -> frontend), so for the length of the deploy
-- the old code is still reading those columns. Dropping them is a separate,
-- later migration, once no running code reads a stored URL.

-- ─── 1. contacts.avatar_storage_key ────────────────────────────────

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS avatar_storage_key text;

COMMENT ON COLUMN public.contacts.avatar_storage_key IS
  'Canonical storage key of a WebYar-owned avatar object (workspace/<workspace_id>/...). The only persisted record of the file: the public URL is derived from it at read time for whichever provider is primary. NULL means the avatar is not ours (externally supplied avatar_url) or predates the key column.';

UPDATE public.contacts AS c
SET avatar_storage_key = substring(
      split_part(split_part(c.avatar_url, '#', 1), '?', 1)
      from '(workspace/' || c.workspace_id::text || '/avatars/telegram/.*)$'
    )
WHERE c.avatar_storage_key IS NULL
  AND c.workspace_id IS NOT NULL
  AND c.avatar_url IS NOT NULL
  AND split_part(split_part(c.avatar_url, '#', 1), '?', 1)
      LIKE '%workspace/' || c.workspace_id::text || '/avatars/telegram/%';

-- ─── 1b. widget_settings.fab_image_storage_key ─────────────────────
--
-- The launcher image was uploaded by the BROWSER through the generic
-- storage API, which then PATCHed the provider URL it got back into the
-- settings row — so the row recorded a vendor hostname and no key at all.
--
-- The key is nevertheless recoverable, because the browser only ever built
-- it one way. `src/pages/app/WidgetPage.tsx` constructed exactly:
--
--     workspace/${workspace.id}/widget/launcher-${Date.now()}.${ext}
--
-- for the whole life of that code path (verified against the file's full
-- history — no other launcher key shape was ever written by it), with
-- `ext` restricted to png/webp/jpg by the uploader's own type check. That
-- is a fixed, workspace-rooted shape: `launcher-<epoch millis>.<ext>`.
--
-- So the same conservative rule the contact backfill uses applies here. A
-- key is adopted only when the stored URL, after query string and fragment
-- are stripped, ENDS WITH that exact shape under THIS row's own workspace
-- id. Anything else — a URL naming another workspace, an arbitrary
-- external image, a path that merely starts like ours — stays NULL and
-- keeps using the deprecated read-only URL fallback until the operator
-- re-uploads through the new endpoint.
--
-- Why bother: without this, an existing WebYar-owned launcher image stays
-- pinned to the provider that was primary when it was uploaded, and a
-- promotion silently leaves it behind. Recovering the key is what lets the
-- very next read derive it from the NEW primary with no row rewritten.
--
-- The new upload endpoint writes the canonical
-- `workspace/<id>/widget/launcher/<uuid>-<name>` shape (note the slash, not
-- the dash). Both satisfy the ownership CHECK below, which requires only
-- `workspace/<workspace_id>/widget/`.

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS fab_image_storage_key text;

COMMENT ON COLUMN public.widget_settings.fab_image_storage_key IS
  'Canonical storage key of the widget launcher image (workspace/<workspace_id>/widget/...). The only persisted record of the file: its public URL is derived at read time for whichever storage provider is primary. Written solely by POST /api/widget-settings/:workspaceId/fab-image — never from the generic settings PATCH. NULL means the legacy fab_image_url could not be proven to name an object of this workspace.';

UPDATE public.widget_settings AS w
SET fab_image_storage_key = substring(
      split_part(split_part(w.fab_image_url, '#', 1), '?', 1)
      from '(workspace/' || w.workspace_id::text || '/widget/launcher-[0-9]+\.[A-Za-z0-9]+)$'
    )
WHERE w.fab_image_storage_key IS NULL
  AND w.workspace_id IS NOT NULL
  AND w.fab_image_url IS NOT NULL
  AND split_part(split_part(w.fab_image_url, '#', 1), '?', 1)
      LIKE '%workspace/' || w.workspace_id::text || '/widget/launcher-%';

-- ─── 2. Ownership constraints ──────────────────────────────────────

DO $contacts_ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.contacts'::regclass AND conname = 'contacts_avatar_storage_key_owned'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_avatar_storage_key_owned
      CHECK (
        avatar_storage_key IS NULL
        OR avatar_storage_key LIKE 'workspace/' || workspace_id::text || '/%'
      );
  END IF;
END
$contacts_ck$;

DO $profiles_ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_avatar_storage_key_owned'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_avatar_storage_key_owned
      CHECK (
        avatar_storage_key IS NULL
        OR avatar_storage_key LIKE 'users/' || id::text || '/%'
        OR avatar_storage_key LIKE 'avatars/' || id::text || '/%'
      ) NOT VALID;
  END IF;
END
$profiles_ck$;

DO $branding_ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workspace_branding'::regclass AND conname = 'workspace_branding_logo_storage_key_owned'
  ) THEN
    ALTER TABLE public.workspace_branding
      ADD CONSTRAINT workspace_branding_logo_storage_key_owned
      CHECK (
        logo_storage_key IS NULL
        OR logo_storage_key LIKE 'workspace/' || workspace_id::text || '/%'
        OR logo_storage_key LIKE 'branding/' || workspace_id::text || '/%'
      ) NOT VALID;
  END IF;
END
$branding_ck$;

DO $fab_ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.widget_settings'::regclass AND conname = 'widget_settings_fab_image_storage_key_owned'
  ) THEN
    ALTER TABLE public.widget_settings
      ADD CONSTRAINT widget_settings_fab_image_storage_key_owned
      CHECK (
        fab_image_storage_key IS NULL
        OR fab_image_storage_key LIKE 'workspace/' || workspace_id::text || '/widget/%'
      );
  END IF;
END
$fab_ck$;

DO $callcenter_ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.call_center_settings'::regclass AND conname = 'call_center_settings_avatar_storage_path_owned'
  ) THEN
    ALTER TABLE public.call_center_settings
      ADD CONSTRAINT call_center_settings_avatar_storage_path_owned
      CHECK (
        avatar_storage_path IS NULL
        OR avatar_storage_path LIKE 'workspace/' || workspace_id::text || '/%'
      ) NOT VALID;
  END IF;
END
$callcenter_ck$;

-- ─── 3. Verification ───────────────────────────────────────────────

DO $verify$
DECLARE
  bad_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'avatar_storage_key'
  ) THEN
    RAISE EXCEPTION 'storage_key_ownership: contacts.avatar_storage_key missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'widget_settings' AND column_name = 'fab_image_storage_key'
  ) THEN
    RAISE EXCEPTION 'storage_key_ownership: widget_settings.fab_image_storage_key missing';
  END IF;

  -- Neither backfill may ever have adopted another tenant's key.
  SELECT count(*) INTO bad_rows
  FROM public.contacts
  WHERE avatar_storage_key IS NOT NULL
    AND avatar_storage_key NOT LIKE 'workspace/' || workspace_id::text || '/%';
  IF bad_rows > 0 THEN
    RAISE EXCEPTION 'storage_key_ownership: % contact avatar key(s) are not workspace-scoped', bad_rows;
  END IF;

  SELECT count(*) INTO bad_rows
  FROM public.widget_settings
  WHERE fab_image_storage_key IS NOT NULL
    AND fab_image_storage_key NOT LIKE 'workspace/' || workspace_id::text || '/widget/%';
  IF bad_rows > 0 THEN
    RAISE EXCEPTION 'storage_key_ownership: % launcher image key(s) are not workspace-scoped', bad_rows;
  END IF;

  FOR bad_rows IN
    SELECT 1 FROM (VALUES
      ('contacts_avatar_storage_key_owned'),
      ('profiles_avatar_storage_key_owned'),
      ('workspace_branding_logo_storage_key_owned'),
      ('call_center_settings_avatar_storage_path_owned'),
      ('widget_settings_fab_image_storage_key_owned')
    ) AS expected(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = expected.name)
  LOOP
    RAISE EXCEPTION 'storage_key_ownership: an expected ownership constraint is missing';
  END LOOP;
END
$verify$;
