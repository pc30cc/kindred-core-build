-- ============================================================
-- Phase 6-S5-R7.4 §10 — SELF-HOST ROLE BOOTSTRAP
-- ============================================================
--
-- Why this exists
-- ---------------
-- Migration 011 (and 010 before it) shipped to the hosted Supabase project,
-- so neither may be rewritten. Both — like the RLS policies in 001 — reference
-- the Supabase-managed roles `anon`, `authenticated` and `service_role`.
-- A plain PostgreSQL cluster has none of them, so the chain fails on the first
-- `GRANT ... TO service_role`.
--
-- This bootstrap creates those roles when (and only when) they are missing. It
-- is a no-op on hosted Supabase, where the roles already exist and are owned
-- by the platform.
--
-- Properties
-- ----------
--   * Idempotent — safe to re-run; never ALTERs an existing role.
--   * Least-privileged — NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
--     NOINHERIT for the customer-facing roles. No blanket schema grants: every
--     privilege still has to be handed out explicitly by a later migration.
--   * Ordered first — the `000_` prefix makes every filename-ordered runner
--     (see database/README.md) apply it before 001.
-- ============================================================

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  -- `service_role` is the trusted backend identity. It still gets no implicit
  -- privileges here; migrations grant exactly what it needs.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$bootstrap$;
