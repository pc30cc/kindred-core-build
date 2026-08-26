-- 027 — Auth migration follow-up: `profiles.phone`.
--
-- server/routes/account.ts's PATCH /api/account/me lets an operator set
-- their own phone number, and GET /api/account/me returns it. Before this
-- migration that value lived only on `auth.users.phone`, written via
-- `sb.auth.admin.updateUserById()` — a genuine Supabase-Auth dependency
-- this migration's own instructions require removing. Since `profiles` is
-- now the first-party identity root (026), the field needs a home there
-- instead. Purely additive: existing profiles get `phone = NULL`, matching
-- "no phone set" — no data loss, no behavior change for anyone who never
-- set one.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'phone'
  ) THEN
    RAISE EXCEPTION 'profiles.phone column missing after migration';
  END IF;
END
$verify$;
