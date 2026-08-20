-- 036 — Canonicalize existing profiles.email values; strengthen the
-- uniqueness invariant to match the application's actual normalization.
--
-- 032 added `UNIQUE (lower(email))` — but application code normalizes with
-- `.trim().toLowerCase()` (server/routes/auth.ts signup/login,
-- server/services/auth/identity.ts's findIdentityByEmail), which is
-- `lower(btrim(email))`, not just `lower(email)`. The gap matters because
-- `findIdentityByEmail` does an EXACT match (`.eq('email', normalizedEmail)`
-- against the pre-trimmed input) — an index expression can make two
-- differently-whitespaced rows collide at INSERT time, but it cannot make a
-- lookup find a row whose STORED value still carries stray whitespace. A
-- legacy row is a real, not hypothetical, source of that drift: the
-- self-host chain's own `handle_new_user()` trigger
-- (001_core_tables.sql) — and the equivalent Supabase-chain trigger
-- (20260413202234_*.sql / 20260415075437_update_handle_new_user.sql) —
-- both insert `NEW.email` (from `auth.users.email`) into `profiles.email`
-- completely unnormalized: no trim, no case-fold. Any legacy account
-- created with leading/trailing whitespace in its GoTrue email would carry
-- that into `profiles.email` untouched and stay permanently unreachable by
-- exact-match login lookup, while a NEW first-party signup for the
-- visually-identical (but actually already-trimmed) address could still
-- succeed — two rows, one real mailbox, only one of them ever logs in.
--
-- Preflight: refuse to touch any row if canonicalizing to
-- lower(btrim(email)) would make two currently-distinct profiles collide —
-- this migration must never silently merge or delete real user data. If it
-- fails here, an operator must resolve the conflict manually (merge the
-- accounts or rename one) and re-run.

DO $preflight$
DECLARE
  dupe_count integer;
  dupe_sample text;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT lower(btrim(email)) AS norm_email
    FROM public.profiles
    WHERE email IS NOT NULL
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    SELECT string_agg(norm_email, ', ') INTO dupe_sample
    FROM (
      SELECT lower(btrim(email)) AS norm_email
      FROM public.profiles
      WHERE email IS NOT NULL
      GROUP BY lower(btrim(email))
      HAVING count(*) > 1
      ORDER BY norm_email
      LIMIT 20
    ) sample;

    RAISE EXCEPTION '036: refusing to canonicalize profiles.email — % group(s) of currently-distinct rows would collide once whitespace is stripped and must be resolved manually first (merge the duplicate accounts, or rename one email) before re-running this migration. Sample: %', dupe_count, dupe_sample;
  END IF;
END
$preflight$;

-- Canonicalize existing rows IN PLACE. A single statement over the whole
-- table: Postgres checks the (non-deferrable) unique index per row as it is
-- updated, but the preflight above already proved every row's final
-- canonical value is globally unique across the table, so no row can ever
-- collide with another regardless of update order.
UPDATE public.profiles
SET email = lower(btrim(email)), updated_at = now()
WHERE email IS NOT NULL
  AND email <> lower(btrim(email));

-- Strengthen the invariant itself to match: btrim, not just lower —
-- defense-in-depth against any future write path (a raw SQL console, a
-- different code path) storing a non-canonical value again. Same index
-- name as 032 (drop-then-recreate, not IF NOT EXISTS alone, since
-- CREATE INDEX IF NOT EXISTS matches by name only and would otherwise
-- leave the OLD lower(email)-only definition in place).
DROP INDEX IF EXISTS public.profiles_email_normalized_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_normalized_unique_idx
  ON public.profiles (lower(btrim(email)));

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  stale_count integer;
  index_def text;
BEGIN
  SELECT count(*) INTO stale_count
  FROM public.profiles
  WHERE email IS NOT NULL AND email <> lower(btrim(email));
  IF stale_count > 0 THEN
    RAISE EXCEPTION '036: % profiles.email row(s) still not canonicalized', stale_count;
  END IF;

  SELECT indexdef INTO index_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx';
  IF index_def IS NULL OR index_def NOT ILIKE '%btrim%' THEN
    RAISE EXCEPTION '036: profiles_email_normalized_unique_idx is not defined on lower(btrim(email))';
  END IF;

  RAISE NOTICE '036: profiles.email canonicalized to lower(btrim(email)); unique index strengthened to match';
END
$verify$;
