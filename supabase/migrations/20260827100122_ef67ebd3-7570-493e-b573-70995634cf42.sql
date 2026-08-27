-- 1) Carry the legacy `contacts` limit into the canonical `max_contacts` key.
UPDATE public.billing_plans
SET limits = limits || jsonb_build_object('max_contacts', limits->'contacts')
WHERE limits ? 'contacts'
  AND jsonb_typeof(limits->'contacts') = 'number';

-- 2) Drop legacy, non-enforced keys from every plan.
UPDATE public.billing_plans
SET
  limits = limits
    - 'contacts' - 'conversations' - 'conversations_monthly'
    - 'team_members' - 'agents'
    - 'ai_credits' - 'ai_requests_monthly' - 'ai_kb_monthly_credits'
    - 'ai_kb_max_articles' - 'ai_kb_max_chars' - 'kb_articles'
    - 'storage_mb' - 'file_storage_mb',
  entitlements = entitlements - 'advanced_analytics' - 'ai_enabled',
  updated_at = now();