-- Plan Limits Backfill — align billing_plans.limits with the capability registry's
-- resolver-ready limit keys (max_conversations, max_visitors, storage_gb,
-- ai_credits_per_month). Additive only: existing keys are preserved
-- (jsonb concat order is `new || existing`, so existing values win on conflict).
-- Idempotent: re-running this migration is a no-op.

-- free plan: derive from existing conversations_monthly=50, storage_mb=100,
-- ai_requests_monthly=0. visitors has no prior key — use a conservative 1000.
UPDATE public.billing_plans
SET limits = jsonb_build_object(
      'max_conversations',     50,
      'max_visitors',          1000,
      'storage_gb',            1,
      'ai_credits_per_month',  0
    ) || COALESCE(limits, '{}'::jsonb)
WHERE slug = 'free';

-- pro plan: derive from conversations_monthly=1000, storage_mb=5000,
-- ai_requests_monthly=5000. visitors set to 50000 as a sane mid-tier default.
UPDATE public.billing_plans
SET limits = jsonb_build_object(
      'max_conversations',     1000,
      'max_visitors',          50000,
      'storage_gb',            5,
      'ai_credits_per_month',  5000
    ) || COALESCE(limits, '{}'::jsonb)
WHERE slug = 'pro';

-- enterprise plan: existing conversations_monthly=-1, storage_mb=50000 (~50GB),
-- ai_requests_monthly=-1. Mirror unlimited semantics with -1.
UPDATE public.billing_plans
SET limits = jsonb_build_object(
      'max_conversations',     -1,
      'max_visitors',          -1,
      'storage_gb',            50,
      'ai_credits_per_month',  -1
    ) || COALESCE(limits, '{}'::jsonb)
WHERE slug = 'enterprise';