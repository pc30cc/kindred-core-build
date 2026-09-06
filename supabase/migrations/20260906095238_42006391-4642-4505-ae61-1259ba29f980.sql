insert into public.billing_gateways (provider_name, display_name, is_active, is_test, currencies, countries, sort_order, config)
values ('internal_test',
        '{"fa":"درگاه تست داخلی (شبیه‌ساز)","en":"Internal test gateway (simulator)","tr":"Dahili test sağlayıcısı"}'::jsonb,
        false, true, array['IRR']::text[], array['IR']::text[], 17, '{}'::jsonb)
on conflict (provider_name) do nothing;