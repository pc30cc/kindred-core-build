ALTER TABLE public.platform_sms_provider_config
DROP CONSTRAINT IF EXISTS platform_sms_provider_config_name_chk;

ALTER TABLE public.platform_sms_provider_config
ADD CONSTRAINT platform_sms_provider_config_name_chk
CHECK (provider_name IN ('kavenegar', 'smsir', 'disabled'));