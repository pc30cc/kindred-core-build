
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS maintenance_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maintenance_message text,
  ADD COLUMN IF NOT EXISTS locale_billing_providers jsonb NOT NULL DEFAULT '{}'::jsonb;
