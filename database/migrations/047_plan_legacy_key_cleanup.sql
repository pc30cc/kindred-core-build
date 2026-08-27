-- 047_plan_legacy_key_cleanup.sql
-- Idempotent cleanup of legacy, non-enforced billing_plans JSON keys.
--
-- 1. Carries the legacy `contacts` limit into the canonical `max_contacts`
--    key so the contacts cap is actually enforced by requireLimit().
-- 2. Removes legacy keys that no code path reads (documented in
--    docs/PLAN_DATA_RECONCILIATION.md). Canonical keys are untouched.

BEGIN;

UPDATE public.billing_plans
SET limits = limits || jsonb_build_object('max_contacts', limits->'contacts')
WHERE limits ? 'contacts'
  AND jsonb_typeof(limits->'contacts') = 'number';

UPDATE public.billing_plans
SET
  limits = limits
    - 'contacts' - 'conversations' - 'conversations_monthly'
    - 'team_members' - 'agents'
    - 'ai_credits' - 'ai_requests_monthly' - 'ai_kb_monthly_credits'
    - 'ai_kb_max_articles' - 'ai_kb_max_chars' - 'kb_articles'
    - 'storage_mb' - 'file_storage_mb',
  entitlements = entitlements - 'advanced_analytics' - 'ai_enabled',
  updated_at = now()
WHERE
  limits ?| array['contacts','conversations','conversations_monthly','team_members','agents',
                  'ai_credits','ai_requests_monthly','ai_kb_monthly_credits','ai_kb_max_articles',
                  'ai_kb_max_chars','kb_articles','storage_mb','file_storage_mb']
  OR entitlements ?| array['advanced_analytics','ai_enabled'];

COMMIT;
