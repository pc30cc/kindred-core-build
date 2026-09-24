-- 213_desktop_apps_service_role_only.sql
--
-- desktop_app_settings (207), desktop_app_campaigns (208) and
-- macos_app_settings (211) are read and written only by the Express backend
-- through service_role. Hosted Supabase's default privileges nevertheless
-- grant every new public table to anon and authenticated, so the Data API
-- could address them; RLS with no policy is all that keeps them empty and
-- read-only today. Those grants now go, so one policy added by mistake can
-- never expose Super Admin's desktop settings to the browser.
--
-- Forward-only and re-runnable: REVOKE / GRANT only. Self-host installs,
-- where the roles may not exist, are skipped per role.

DO $$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['desktop_app_settings', 'desktop_app_campaigns', 'macos_app_settings'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;
