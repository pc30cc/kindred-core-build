-- 137_billing_provider_credentials.sql
--
-- ONE canonical, per-provider credential store for billing gateways.
--
-- Before this migration, a billing provider's connection settings could live
-- in up to three places, merged ambiguously at read time:
--   1. billing_gateways.config            (per provider_name, operational table)
--   2. provider_configs.config            (per workspace_id + provider_name)
--   3. app_runtime_config.default_billing_provider.config  (a SINGLE global
--      "current default" pointer that also carried a copy of the credentials)
--
-- (2) is workspace-scoped by design (a real customer override) and stays.
-- (1) and (3) both tried to be "the" global credential store, and the
-- Providers-screen write path (src/providers/sync.ts setGlobalDefaultProvider)
-- wrote the SAME value to both — a admin_billing_gateways being a distinct
-- write from admin_runtime_config meant they could drift out of sync if one
-- write succeeded and the other failed, and there was no rule for which one
-- won on conflict. billing_gateways is also the WRONG table for this: it is
-- the "Finance -> Gateways" operational registry (enabled/disabled, test
-- marker, currencies, display), not a credential store.
--
-- This migration:
--   1. Creates billing_provider_credentials(provider_name PK, config) as the
--      ONE authoritative global credential source.
--   2. Backfills it from billing_gateways.config (the only place that could
--      already hold a non-default provider's credentials).
--   3. Where app_runtime_config.default_billing_provider.config is non-empty,
--      that value wins for its own provider_name (Providers-entered value is
--      authoritative over Gateways, per product requirement) — it overwrites
--      whatever billing_gateways contributed for that same provider.
--   4. Trims app_runtime_config.default_billing_provider to {provider_name}
--      only: "The default gateway must identify the provider by name; it
--      must not become another credential store."
--
-- Nothing is deleted: billing_gateways.config is left in place (untouched)
-- as a read-only legacy fallback for any provider the application code has
-- not yet re-resolved through the new canonical table. Existing credentials
-- are never lost, only given one authoritative home going forward.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.billing_provider_credentials (
  provider_name TEXT PRIMARY KEY,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.billing_provider_credentials TO service_role;
ALTER TABLE public.billing_provider_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_provider_credentials_service_only ON public.billing_provider_credentials;
CREATE POLICY billing_provider_credentials_service_only ON public.billing_provider_credentials
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Step 2: backfill from billing_gateways.config (today's de facto multi-provider store).
INSERT INTO public.billing_provider_credentials (provider_name, config)
SELECT provider_name, config
  FROM public.billing_gateways
 WHERE config IS NOT NULL AND config <> '{}'::jsonb
ON CONFLICT (provider_name) DO NOTHING;

-- Step 3: the Providers-entered value for the CURRENT default provider is
-- authoritative over a same-named billing_gateways row.
DO $$
DECLARE
  v_name   TEXT;
  v_config JSONB;
BEGIN
  SELECT value ->> 'provider_name', value -> 'config'
    INTO v_name, v_config
    FROM public.app_runtime_config
   WHERE key = 'default_billing_provider';

  IF v_name IS NOT NULL AND v_config IS NOT NULL AND v_config <> '{}'::jsonb THEN
    INSERT INTO public.billing_provider_credentials (provider_name, config, updated_at)
    VALUES (v_name, v_config, now())
    ON CONFLICT (provider_name) DO UPDATE SET config = EXCLUDED.config, updated_at = now();
  END IF;
END $$;

-- Step 4: the default-provider pointer becomes name-only.
UPDATE public.app_runtime_config
   SET value = jsonb_build_object('provider_name', value ->> 'provider_name'),
       updated_at = now()
 WHERE key = 'default_billing_provider'
   AND value ? 'config';

-- Same historical shape guard for the legacy `billing_default_provider` key
-- (server/services/billing/index.ts still reads it as a fallback).
UPDATE public.app_runtime_config
   SET value = jsonb_build_object('provider', COALESCE(value ->> 'provider', value ->> 'provider_name')),
       updated_at = now()
 WHERE key = 'billing_default_provider'
   AND (value ? 'config' OR (SELECT count(*) FROM jsonb_object_keys(value)) > 1);

-- Keep the super-admin "purge data" protection list (127) current: the new
-- table is commercial configuration, not transactional data.
CREATE OR REPLACE FUNCTION public.admin_reset_settings_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array[
    'platform_settings','platform_branding','platform_branding_localized',
    'platform_call_center_settings','platform_ai_agent_settings','platform_domains',
    'platform_sms_provider_config','app_runtime_config','feature_flags',
    'billing_plans','role_permissions','translations','legal_policy_versions',
    'email_settings','email_settings_localized','email_templates',
    'ai_models','ai_rate_cards','ai_rate_card_components','ai_sell_policies',
    'ai_exchange_rates','provider_configs','verification_purpose_settings',
    'widget_platform_settings','widget_settings','widget_prechat_settings',
    'workspaces','workspace_settings','workspace_members','workspace_branding',
    'workspace_branding_localized','workspace_domains','workspace_domains_extended',
    'workspace_departments','workspace_department_members','workspace_subscriptions',
    'workspace_limit_overrides','workspace_module_overrides','workspace_provider_settings',
    'workspace_seat_entitlement_mode','workspace_channel_overrides',
    'workspace_plugin_installations','call_center_settings','call_center_departments',
    'call_center_department_agents','channel_integrations','plugin_platform_state',
    'plugin_secrets','ai_agent_settings','enforcement_rules','auto_action_definitions',
    'slo_definitions','alert_rules',
    -- unified billing configuration (not transactional data)
    'billing_currencies','billing_exchange_rates','billing_gateways',
    'billing_tax_rates','billing_coupons','billing_usage_items',
    'billing_provider_credentials'
  ]::text[]
$$;
