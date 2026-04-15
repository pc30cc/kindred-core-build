
ALTER TABLE public.billing_plans
ADD COLUMN IF NOT EXISTS localized jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.billing_plans.localized IS 'Per-locale overrides: { "en": { "name": "...", "description": "..." }, "tr": { ... } }';
