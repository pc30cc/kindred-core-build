-- ============================================================
-- Phase 6-S5-R7.5 §1 — hosted Supabase full-chain structural proof.
-- Runs after `supabase db reset` has applied every file in
-- supabase/migrations in real timestamp order.
-- ============================================================

DO $chain$
DECLARE
  applied integer;
  missing text;
BEGIN
  SELECT count(*) INTO applied FROM supabase_migrations.schema_migrations;
  IF applied = 0 THEN
    RAISE EXCEPTION 'no migrations recorded — db reset did not apply the chain';
  END IF;
  RAISE NOTICE 'migrations applied: %', applied;

  -- Supabase auth helpers must be real, not mocked.
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() unavailable — not a Supabase-compatible environment';
  END IF;
  IF to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.jwt() unavailable — not a Supabase-compatible environment';
  END IF;

  -- Core / KB / AI-KB / fan-out tables from across the whole chain.
  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'profiles', 'workspaces', 'workspace_members',
    'knowledge_base_articles', 'knowledge_base_categories', 'knowledge_base_change_events',
    'ai_kb_jobs', 'ai_kb_job_pages', 'ai_kb_generated_articles',
    'entitlement_fanout_jobs', 'billing_plans', 'workspace_subscriptions'
  ]) AS t
  WHERE to_regclass('public.' || t) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing tables after full chain: %', missing;
  END IF;

  -- Latest AI-KB RPC signatures (010 → 012 head).
  SELECT string_agg(f, ', ') INTO missing
  FROM unnest(ARRAY[
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.accept_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.publish_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.reject_ai_kb_generated_article(uuid, uuid, uuid)'
  ]) AS f
  WHERE to_regprocedure(f) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing AI-KB RPC signatures: %', missing;
  END IF;

  -- RLS must be on for the customer-facing tables.
  SELECT string_agg(c.relname, ', ') INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity
    AND c.relname IN ('profiles', 'workspaces', 'workspace_members',
                      'knowledge_base_articles', 'ai_kb_jobs', 'ai_kb_generated_articles',
                      'entitlement_fanout_jobs');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS disabled on: %', missing;
  END IF;

  RAISE NOTICE 'hosted full-chain structural verification passed';
END
$chain$;