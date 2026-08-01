CREATE TABLE public.platform_sms_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  provider_name text NOT NULL DEFAULT 'disabled',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_sms_provider_config_singleton_chk CHECK (singleton = true),
  CONSTRAINT platform_sms_provider_config_singleton_uniq UNIQUE (singleton),
  CONSTRAINT platform_sms_provider_config_name_chk CHECK (provider_name IN ('kavenegar', 'disabled'))
);

GRANT ALL ON public.platform_sms_provider_config TO service_role;

ALTER TABLE public.platform_sms_provider_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only"
  ON public.platform_sms_provider_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER platform_sms_provider_config_updated_at
  BEFORE UPDATE ON public.platform_sms_provider_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();