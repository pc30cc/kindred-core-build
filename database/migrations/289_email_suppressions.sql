-- 289 — Email suppressions: the addresses the platform no longer mails
-- (owner, 2026-10-29: email is provider-driven — our own relay today,
-- Resend, SendGrid or another provider tomorrow — and works the same through
-- every one of them).
--
-- A hosted provider keeps its own list of addresses that hard-bounced or
-- complained and stops mailing them; our own relay keeps none, so since the
-- switch to it (2026-10-29 15:11 UTC) nothing did. Mailing an address that
-- bounces, again and again, is what costs a new sending IP and domain their
-- reputation, and the password resets and verification codes share both.
-- The list is now the platform's own, the same for every provider:
--
-- 1. public.email_suppressions: one row per address (lower-case, the primary
--    key), why (hard_bounce, complaint, manual), a short detail, what wrote
--    it (a webhook, the relay's bounce report, a Super Admin), how many
--    events it has seen, when it was first and last seen, and when it ends
--    (NULL: never). server/services/email/suppressions.ts reads and writes
--    it; sendEmail and sendPlatformEmail check it before any provider is
--    called, and a row that has expired holds nothing back.
-- 2. public.email_suppression_record(): the write, as one statement, so two
--    reports for the same address at once count twice. A later, weaker
--    reason never replaces a stronger one (manual > complaint >
--    hard_bounce) and a suppression without an end is never given one,
--    while the row is in force; a row that has expired starts over from the
--    new event (its count and first_seen_at go on).
--
-- Both are the backend's only (service_role): RLS on with a service_role
-- policy, nothing granted to anon or authenticated; the function is
-- SECURITY INVOKER with a pinned search_path. The Super Admin's provider
-- changes are audited in the existing public.audit_logs
-- (action 'admin.email_provider.changed', the field names only, never a
-- value), so no table is added for that.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that
-- reads it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. The
-- code before it needs nothing from it, and the code after it sends mail
-- without it (a failed lookup suppresses nothing), so the order is safe
-- either way. It writes no data, changes no existing table and drops
-- nothing. Safe to run twice. Dry run: wrap the file in BEGIN; … ROLLBACK;
-- (it opens no transaction of its own). Like 284 to 288, it sets
-- lock_timeout 5s itself.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  address       text PRIMARY KEY,
  reason        text NOT NULL,
  detail        text,
  source        text NOT NULL,
  bounce_count  integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  CONSTRAINT email_suppressions_address_check
    CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 254 AND position('@' IN address) > 1),
  CONSTRAINT email_suppressions_reason_check CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  CONSTRAINT email_suppressions_source_check CHECK (length(source) BETWEEN 1 AND 64),
  CONSTRAINT email_suppressions_detail_check CHECK (detail IS NULL OR length(detail) <= 500),
  CONSTRAINT email_suppressions_bounce_count_check CHECK (bounce_count >= 1)
);

COMMENT ON TABLE public.email_suppressions IS
  'Addresses the platform does not mail (hard_bounce, complaint, manual), the same for every email provider; checked by sendEmail/sendPlatformEmail before a provider is called. A row with expires_at in the past holds nothing back. Written by email_suppression_record(). Server-only. Migration 289.';

CREATE INDEX IF NOT EXISTS email_suppressions_last_seen_idx
  ON public.email_suppressions (last_seen_at DESC);

DO $$
BEGIN
  ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.email_suppressions FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.email_suppressions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.email_suppressions FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.email_suppressions TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'email_suppressions' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.email_suppressions
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- Record one event for an address: a new row, or the existing one counted
-- on. Returns the row's bounce_count after the event.
CREATE OR REPLACE FUNCTION public.email_suppression_record(
  p_address text,
  p_reason text,
  p_detail text,
  p_source text,
  p_expires_at timestamptz
) RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  INSERT INTO public.email_suppressions AS s (address, reason, detail, source, expires_at)
  VALUES (lower(btrim(p_address)), p_reason, left(nullif(btrim(p_detail), ''), 500), left(btrim(p_source), 64), p_expires_at)
  ON CONFLICT (address) DO UPDATE SET
    bounce_count = s.bounce_count + 1,
    last_seen_at = now(),
    detail = COALESCE(EXCLUDED.detail, s.detail),
    source = EXCLUDED.source,
    reason = CASE
      WHEN s.expires_at IS NOT NULL AND s.expires_at <= now() THEN EXCLUDED.reason
      WHEN array_position(ARRAY['hard_bounce', 'complaint', 'manual'], EXCLUDED.reason)
           >= array_position(ARRAY['hard_bounce', 'complaint', 'manual'], s.reason) THEN EXCLUDED.reason
      ELSE s.reason
    END,
    expires_at = CASE
      WHEN s.expires_at IS NOT NULL AND s.expires_at <= now() THEN EXCLUDED.expires_at
      WHEN s.expires_at IS NULL OR EXCLUDED.expires_at IS NULL THEN NULL
      ELSE greatest(s.expires_at, EXCLUDED.expires_at)
    END
  RETURNING s.bounce_count;
$fn$;

COMMENT ON FUNCTION public.email_suppression_record(text, text, text, text, timestamptz) IS
  'Records one suppression event (hard_bounce, complaint, manual) for an address: inserts it, or counts it on without weakening a row in force. Server-only. Migration 289.';

DO $acl$
DECLARE
  f text := 'public.email_suppression_record(text, text, text, text, timestamptz)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $acl$;

RESET lock_timeout;
