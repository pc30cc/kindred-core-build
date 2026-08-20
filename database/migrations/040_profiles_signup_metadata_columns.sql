-- 040 — profiles signup-metadata columns (self-host chain ONLY — no hosted
-- mirror; the hosted chain has carried these since 2026-04-15,
-- supabase/migrations/20260415072517_8809d881-...sql).
--
-- Discovered while building the fresh self-host acceptance test for 039:
-- POST /api/auth/signup (server/routes/auth.ts) always INSERTs
-- company_name, website_domain, main_goal, ai_mode, signup_ip, and
-- signup_locale into profiles — columns the self-host chain's profiles
-- table never had. First-party signup was therefore completely broken on
-- a fresh self-host install (every signup attempt failed with a Postgres
-- "column does not exist" error, which the route's own generic error
-- handling then reported as a misleading 409 "account already exists").
-- This is a schema-parity gap in the exact same spirit as 039's
-- account/workspace tables, just one layer earlier in the same signup
-- flow — closing it here rather than as a separate pass, since 039's own
-- acceptance test cannot exercise signup at all without it.
--
-- All nullable, no defaults, matching the hosted chain's columns exactly.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS company_name TEXT,
  ADD COLUMN IF NOT EXISTS website_domain TEXT,
  ADD COLUMN IF NOT EXISTS main_goal TEXT,
  ADD COLUMN IF NOT EXISTS ai_mode TEXT,
  ADD COLUMN IF NOT EXISTS signup_ip TEXT,
  ADD COLUMN IF NOT EXISTS signup_locale TEXT;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(col, ', ') INTO missing
  FROM unnest(ARRAY['company_name','website_domain','main_goal','ai_mode','signup_ip','signup_locale']) AS col
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '040: profiles is still missing column(s): %', missing;
  END IF;
  RAISE NOTICE '040: profiles signup-metadata columns present';
END
$verify$;
