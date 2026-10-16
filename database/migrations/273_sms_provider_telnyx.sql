-- 273 — Platform SMS provider: Telnyx (Telnyx Verify) for the International edition.
--
-- `platform_sms_provider_config.provider_name` was limited to the two Iranian
-- vendors (Kavenegar, SMS.ir) and 'disabled'. The International edition
-- delivers its phone-verification codes through Telnyx Verify, so 'telnyx'
-- joins the allowed names. Its settings live in the existing `config` jsonb,
-- exactly like the other vendors' (apiKey, verifyProfileId, channel); no new
-- column is needed.
--
-- Only the CHECK constraint changes: it is dropped and re-added with the
-- wider list. Every row that satisfied the old list satisfies the new one,
-- and no row is touched. The table stays service-role only (RLS and grants
-- unchanged).
--
-- Re-runnable: a second run re-creates the same constraint. Works on both
-- editions' databases (the Iranian edition simply never stores 'telnyx').
-- Dry run: wrap the file in BEGIN; … ROLLBACK; (it opens no transaction of
-- its own). Touches no archive schema or table.

ALTER TABLE public.platform_sms_provider_config
  DROP CONSTRAINT IF EXISTS platform_sms_provider_config_name_chk;

ALTER TABLE public.platform_sms_provider_config
  ADD CONSTRAINT platform_sms_provider_config_name_chk
  CHECK (provider_name = ANY (ARRAY['kavenegar'::text, 'smsir'::text, 'telnyx'::text, 'disabled'::text]));
