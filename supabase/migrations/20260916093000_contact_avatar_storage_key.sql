-- contacts.avatar_storage_key (hosted mirror of database/migrations/190): the last uploaded object whose only
-- record in the database was an absolute URL.
--
-- Every other upload the platform performs already stores its canonical
-- storage key next to (or instead of) the public URL:
--
--   conversation_attachments.storage_path      email_attachments.storage_key
--   call_recordings.storage_path               privacy_jobs.artifact_storage_key
--   workspace_branding.logo_storage_key        call_center_settings.avatar_storage_path
--   profiles.avatar_storage_key                ai_agent_settings.metadata->ai_avatar_storage_key
--
-- Contact avatars (server/services/channels/telegram/mediaIngest.ts) kept
-- only `avatar_url`. An absolute URL names one provider's hostname, so a row
-- holding nothing else is pinned to the storage provider that happened to be
-- primary when it was written — it cannot follow a promotion, and nothing can
-- rebuild it.
--
-- The key is deterministic (`workspace/<id>/avatars/telegram/<hint>.jpg`) and
-- present inside the stored URL, so existing rows are backfilled by slicing
-- the canonical root out of the URL path. A row whose URL is NOT one of our
-- objects (an external avatar from a channel) matches nothing and is left
-- NULL — correctly, because there is no key to record.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS avatar_storage_key text;

COMMENT ON COLUMN public.contacts.avatar_storage_key IS
  'Canonical storage key of the avatar object (workspace/<id>/...). The source of truth; avatar_url is a derived, refreshable cache.';

UPDATE public.contacts
SET avatar_storage_key = substring(avatar_url from 'workspace/[0-9a-fA-F-]{36}/.*$')
WHERE avatar_storage_key IS NULL
  AND avatar_url IS NOT NULL
  AND avatar_url ~ 'workspace/[0-9a-fA-F-]{36}/';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'avatar_storage_key'
  ) THEN
    RAISE EXCEPTION 'contact_avatar_storage_key: contacts.avatar_storage_key missing';
  END IF;
END
$verify$;
