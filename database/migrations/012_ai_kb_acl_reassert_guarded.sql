-- ============================================================
-- Phase 6-S5-R7.4 §10 — guarded ACL re-assertion
-- ============================================================
--
-- Migration 011 HAS shipped (a byte-identical mirror is deployed to the hosted
-- Supabase project as supabase/migrations/20260803090000_ai_kb_slug_namespace_lock.sql),
-- so it is frozen under the forward-only policy and cannot be made
-- role-tolerant in place.
--
-- This forward-only migration re-asserts the SAME least-privileged ACL that
-- 010/011 intended, but every role-specific statement is guarded by a
-- `pg_roles` lookup so the chain also completes on a plain PostgreSQL cluster.
-- On hosted Supabase all three roles exist and the effective ACL is unchanged.
--
-- It changes NO function body and NO behaviour.
-- ============================================================

DO $acl$
DECLARE
  fn text;
  sigs text[] := ARRAY[
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.accept_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.publish_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.reject_ai_kb_generated_article(uuid, uuid, uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    -- Skip signatures that this deployment does not have (older self-host
    -- installs that stopped before 010 are re-asserted by their own file).
    CONTINUE WHEN to_regprocedure(fn) IS NULL;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END
$acl$;
