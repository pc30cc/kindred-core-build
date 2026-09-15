-- 20260915090500 — profiles.avatar_storage_key user-scope guard.
--
-- Storage ownership standardization follow-up to 177 (which added the
-- column, always NULL until a user re-uploads). Now that the column is in
-- active use, close the same gap conversation_attachments/email_attachments
-- closed for workspace-owned objects: a database-level guarantee that the
-- recorded key is actually scoped to the profile's own user id, not any
-- other user's or a workspace's. Allows both the canonical
-- users/<id>/avatar/... shape (server/services/storage/keys.ts's
-- userAvatarKey()) and the pre-migration avatars/<id>/... legacy shape
-- (server/services/storage/index.ts's LEGACY_USER_AVATAR_PATTERN) that
-- account.ts's cleanupPreviousAvatar() still deletes for rows that predate
-- 177. NULL is always allowed — it means "no key recorded yet", not
-- "invalid".

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_avatar_storage_key_scope_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_avatar_storage_key_scope_check
    CHECK (
      avatar_storage_key IS NULL
      OR avatar_storage_key LIKE 'users/' || id::text || '/avatar/%'
      OR avatar_storage_key LIKE 'avatars/' || id::text || '/%'
    );

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_avatar_storage_key_scope_check') THEN
    RAISE EXCEPTION 'profiles_avatar_storage_key_scope_check constraint missing after migration';
  END IF;
END
$verify$;
