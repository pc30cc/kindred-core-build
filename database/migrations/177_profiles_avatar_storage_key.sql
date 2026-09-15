-- 177 — Account avatar ownership: `profiles.avatar_storage_key`.
--
-- Storage ownership standardization (docs/STORAGE_ARCHITECTURE_AUDIT.md
-- §4/§9): the account avatar is a global, user-owned asset, not
-- workspace-owned — it must never depend on which workspace happens to be
-- the user's "primary" membership. New avatars are written under the
-- canonical `users/<userId>/avatar/<uuid>.<ext>` key
-- (server/services/storage/keys.ts's userAvatarKey()) via the owner-scoped
-- storage primitives (uploadForOwner/deleteForOwner), and the exact object
-- key is now recorded directly here instead of being re-derived by parsing
-- `avatar_url` — the same anti-pattern audit found for workspace icon and
-- call-center avatar.
--
-- Purely additive: existing rows get `avatar_storage_key = NULL`, meaning
-- "pre-migration avatar, key not yet recorded" — the account.ts route
-- falls back to the legacy avatar_url-marker parse for those specific rows
-- until they're replaced or backfilled. No data loss, no behavior change
-- for anyone who never re-uploads.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_storage_key TEXT;

COMMENT ON COLUMN public.profiles.avatar_storage_key IS
  'Canonical storage object key for avatar_url, e.g. users/<id>/avatar/<uuid>.<ext>. NULL for legacy pre-migration rows whose key must be recovered by parsing avatar_url.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'avatar_storage_key'
  ) THEN
    RAISE EXCEPTION 'profiles.avatar_storage_key column missing after migration';
  END IF;
END
$verify$;
