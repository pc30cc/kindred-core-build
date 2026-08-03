-- ============================================================
-- Phase 6-S5-R7.5.1 §1 — SINGLE SOURCE OF TRUTH for the internal RPC surface.
--
-- Every verification script `\ir`s this file. The signatures below are the
-- EXACT `regprocedure` identities produced by the current migration chain
-- (007 → 012); a stale or invented signature makes `to_regprocedure` return
-- NULL, and this file then RAISEs instead of silently skipping the check.
--
-- Drift protection, enforced here and mirrored by
-- `src/test/ci/verificationIntegrity.test.ts`:
--   • every listed signature MUST exist (no skip path of any kind)
--   • the listed signature MUST be the ONLY overload of that function name,
--     so a legacy overload cannot survive un-audited next to the new one.
-- ============================================================

DROP TABLE IF EXISTS ci_internal_rpc;
CREATE TEMP TABLE ci_internal_rpc (sig text PRIMARY KEY, proname text NOT NULL, kind text NOT NULL);

INSERT INTO ci_internal_rpc (sig, proname, kind) VALUES
  ('public.enqueue_entitlement_fanout(text, text, uuid)',
   'enqueue_entitlement_fanout', 'fanout'),
  ('public.claim_entitlement_fanout_jobs(text, integer, integer)',
   'claim_entitlement_fanout_jobs', 'fanout'),
  ('public.advance_entitlement_fanout(uuid, uuid, text, bigint, uuid, integer, integer, integer, integer, integer)',
   'advance_entitlement_fanout', 'fanout'),
  ('public.complete_entitlement_fanout(uuid, uuid, text, bigint, uuid, integer, integer, integer, integer)',
   'complete_entitlement_fanout', 'fanout'),
  ('public.fail_entitlement_fanout(uuid, uuid, text, bigint, text, integer, integer)',
   'fail_entitlement_fanout', 'fanout'),
  ('public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
   '_ai_kb_apply_generated', 'ai_kb'),
  ('public.accept_ai_kb_generated_article(uuid, uuid, uuid, text, text)',
   'accept_ai_kb_generated_article', 'ai_kb'),
  ('public.publish_ai_kb_generated_article(uuid, uuid, uuid, text, text)',
   'publish_ai_kb_generated_article', 'ai_kb'),
  ('public.reject_ai_kb_generated_article(uuid, uuid, uuid)',
   'reject_ai_kb_generated_article', 'ai_kb');

DO $sig$
DECLARE
  missing  text;
  extra    text;
  expected integer;
BEGIN
  SELECT count(*) INTO expected FROM ci_internal_rpc;
  IF expected <> 9 THEN
    RAISE EXCEPTION 'internal RPC inventory is incomplete: % entries', expected;
  END IF;

  -- 1. Every declared signature must resolve. No skipping.
  SELECT string_agg(sig, ', ') INTO missing
  FROM ci_internal_rpc
  WHERE to_regprocedure(sig) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'internal RPC signature(s) not found — migration chain incomplete or verifier is stale: %',
      missing;
  END IF;

  -- 2. No un-audited overload may share a verified function name.
  SELECT string_agg(format('%s (found %s)', r.proname, found.sigs), '; ')
    INTO extra
  FROM ci_internal_rpc r
  CROSS JOIN LATERAL (
    SELECT count(*) AS n, string_agg(p.oid::regprocedure::text, ' | ') AS sigs
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = r.proname
  ) AS found
  WHERE found.n <> 1;

  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected overload(s) of an internal RPC: %', extra;
  END IF;

  RAISE NOTICE 'internal RPC inventory verified: % exact signatures, no overloads', expected;
END
$sig$;