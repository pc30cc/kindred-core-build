-- 038 — Enforce that profiles.email is ITSELF stored canonically
-- (lower(btrim(email))), not just unique.
--
-- 036 canonicalized every existing row and built
-- profiles_email_normalized_unique_idx on lower(btrim(email)) — but an
-- expression unique index only constrains what two DIFFERENT rows may
-- both equal; it does nothing to stop a FUTURE single row from being
-- stored non-canonically (mixed case, stray whitespace) as long as no
-- other row currently collides with it. findIdentityByEmail's lookup
-- (server/services/auth/identity.ts) is an EXACT match against an
-- already-normalized input, so a non-canonical stored value would again be
-- unreachable by login the moment it existed — the exact failure mode 036
-- closed for legacy rows, reopened for any new write that skips
-- normalization.
--
-- A CHECK constraint closes this at the table level, independent of which
-- code path performs the write: every INSERT/UPDATE of profiles.email
-- must already be canonical, or the write is rejected outright (never
-- silently rewritten — this constraint enforces, it does not coerce).
-- Every current write path already produces a canonical value before
-- writing (server/routes/auth.ts's signup handler normalizes with
-- `.trim().toLowerCase()`; admin_change_user_email, 035, computes
-- `lower(btrim(_new_email))` itself), so this is a backstop against a
-- future path — a raw SQL console, a differently-written code path,
-- restored from an old backup — reintroducing the same drift 036 fixed,
-- not a change to how any current path already behaves.
--
-- Preflight: refuse to add the constraint (rather than have it fail with
-- a generic constraint-violation error) if 036 has not actually run yet on
-- this database — a clear, named diagnostic instead of an opaque ALTER
-- TABLE failure.
--
-- Applied identically to both migration chains.

DO $preflight$
DECLARE
  noncanonical_count integer;
BEGIN
  SELECT count(*) INTO noncanonical_count
  FROM public.profiles
  WHERE email IS NOT NULL AND email <> lower(btrim(email));

  IF noncanonical_count > 0 THEN
    RAISE EXCEPTION '038: refusing to add profiles_email_canonical_check — % row(s) are not yet canonical; run 036_profiles_email_canonicalize first', noncanonical_count;
  END IF;
END
$preflight$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_email_canonical_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_email_canonical_check
  CHECK (email IS NULL OR email = lower(btrim(email)));

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND r.relname = 'profiles'
      AND c.conname = 'profiles_email_canonical_check' AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION '038: profiles_email_canonical_check was not created';
  END IF;
  RAISE NOTICE '038: profiles.email is now constrained to its own canonical (lower(btrim)) form at the database level';
END
$verify$;
