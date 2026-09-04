-- 127_billing_config_purge_protection.sql
-- The super-admin "purge data" action wipes every table that is not classified
-- as identity or settings. The unified billing configuration tables added in
-- 126 were never classified, so a data purge silently deleted the payment
-- gateway registry, currencies, tax rates, coupons and usage items.
--
-- This migration reclassifies them as SETTINGS (kept by a 'data' purge) and
-- restores the default rows for installations that already lost them.

create or replace function public.admin_reset_settings_tables()
returns text[]
language sql
immutable
as $$
  select array[
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
    'billing_tax_rates','billing_coupons','billing_usage_items'
  ]::text[]
$$;

INSERT INTO public.billing_currencies (code, display_name, symbol, minor_units, is_base, sort_order)
VALUES
  ('IRR', '{"fa":"ریال","en":"Iranian Rial","tr":"İran Riyali"}', 'ریال', 0, true, 1),
  ('USD', '{"fa":"دلار","en":"US Dollar","tr":"ABD Doları"}', '$', 2, false, 2),
  ('EUR', '{"fa":"یورو","en":"Euro","tr":"Euro"}', '€', 2, false, 3),
  ('TRY', '{"fa":"لیر","en":"Turkish Lira","tr":"Türk Lirası"}', '₺', 2, false, 4)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.billing_gateways (provider_name, display_name, currencies, is_test, sort_order)
VALUES
  ('manual',       '{"fa":"پرداخت دستی / کارت به کارت","en":"Manual / bank transfer","tr":"Manuel ödeme"}', '{IRR,USD,EUR,TRY}', false, 0),
  ('zarinpal',     '{"fa":"زرین‌پال","en":"ZarinPal","tr":"ZarinPal"}', '{IRR}', false, 1),
  ('zarinpal_test','{"fa":"زرین‌پال (تست)","en":"ZarinPal (test)","tr":"ZarinPal (test)"}', '{IRR}', true, 2),
  ('zibal',        '{"fa":"زیبال","en":"Zibal","tr":"Zibal"}', '{IRR}', false, 3),
  ('idpay',        '{"fa":"آیدی‌پی","en":"IDPay","tr":"IDPay"}', '{IRR}', false, 4),
  ('payping',      '{"fa":"پی‌پینگ","en":"PayPing","tr":"PayPing"}', '{IRR}', false, 5),
  ('nextpay',      '{"fa":"نکست‌پی","en":"NextPay","tr":"NextPay"}', '{IRR}', false, 6),
  ('sep_shaparak', '{"fa":"سامان (سپ)","en":"SEP Shaparak","tr":"SEP"}', '{IRR}', false, 7),
  ('stripe',       '{"fa":"استرایپ","en":"Stripe","tr":"Stripe"}', '{USD,EUR,TRY}', false, 8),
  ('paddle',       '{"fa":"پدل","en":"Paddle","tr":"Paddle"}', '{USD,EUR}', false, 9),
  ('paypal',       '{"fa":"پی‌پال","en":"PayPal","tr":"PayPal"}', '{USD,EUR}', false, 10),
  ('lemon_squeezy','{"fa":"لمون اسکوییزی","en":"Lemon Squeezy","tr":"Lemon Squeezy"}', '{USD,EUR}', false, 11),
  ('iyzico',       '{"fa":"آیزیکو","en":"iyzico","tr":"iyzico"}', '{TRY}', false, 12),
  ('paytr',        '{"fa":"پی‌تی‌آر","en":"PayTR","tr":"PayTR"}', '{TRY}', false, 13),
  ('sipay',        '{"fa":"سای‌پی","en":"Sipay","tr":"Sipay"}', '{TRY}', false, 14),
  ('paratika',     '{"fa":"پاراتیکا","en":"Paratika","tr":"Paratika"}', '{TRY}', false, 15),
  ('craftgate',    '{"fa":"کرفت‌گیت","en":"Craftgate","tr":"Craftgate"}', '{TRY}', false, 16)
ON CONFLICT (provider_name) DO NOTHING;

INSERT INTO public.billing_usage_items (key, display_name, unit, prices, sort_order)
VALUES
  ('ai_credit', '{"fa":"اعتبار هوش مصنوعی","en":"AI credit","tr":"Yapay zeka kredisi"}', 'credit', '{"IRR":1,"USD":0.00002}', 1),
  ('sms',       '{"fa":"پیامک","en":"SMS","tr":"SMS"}', 'message', '{"IRR":2000,"USD":0.05}', 2),
  ('storage',   '{"fa":"فضای ذخیره‌سازی","en":"Storage","tr":"Depolama"}', 'gb_month', '{"IRR":300000,"USD":0.5}', 3)
ON CONFLICT (key) DO NOTHING;
