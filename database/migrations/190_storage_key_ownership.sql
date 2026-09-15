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
--    only `avatar_url`, with nothing to derive from.
--
--    The backfill is deliberately CONSERVATIVE and per-row workspace-scoped.
--    It recovers a key only when the stored URL contains this row's OWN
--    workspace id under the exact prefix the ingest writes
--    (`workspace/<workspace_id>/avatars/telegram/`). It does not trust a
--    generic `workspace/<any-uuid>/` match: `contacts.avatar_url` is also
--    written by the CRM import API with an integrator-supplied URL, and a
--    URL that merely mentions some workspace id must never be adopted as
--    THIS row's key. Anything unprovable stays NULL — a NULL key means
--    "not our object", which every read path already handles by falling
--    back to the externally supplied URL.
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

  -- The backfill must never have adopted another tenant's key.
  SELECT count(*) INTO bad_rows
  FROM public.contacts
  WHERE avatar_storage_key IS NOT NULL
    AND avatar_storage_key NOT LIKE 'workspace/' || workspace_id::text || '/%';
  IF bad_rows > 0 THEN
    RAISE EXCEPTION 'storage_key_ownership: % contact avatar key(s) are not workspace-scoped', bad_rows;
  END IF;

  FOR bad_rows IN
    SELECT 1 FROM (VALUES
      ('contacts_avatar_storage_key_owned'),
      ('profiles_avatar_storage_key_owned'),
      ('workspace_branding_logo_storage_key_owned'),
      ('call_center_settings_avatar_storage_path_owned')
    ) AS expected(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = expected.name)
  LOOP
    RAISE EXCEPTION 'storage_key_ownership: an expected ownership constraint is missing';
  END LOOP;
END
$verify$;
