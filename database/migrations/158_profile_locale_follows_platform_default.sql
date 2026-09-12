-- ============================================================
-- 158 — PROFILE LOCALE FOLLOWS THE PLATFORM DEFAULT
--
-- `profiles.preferred_locale` defaulted to a hardcoded 'en', so every new
-- account was stamped English even on a Persian platform, and billing
-- notifications resolved to the English template. Dropping the default
-- lets `billing_v2_resolve_billing_recipient` fall back to
-- `platform_settings.default_locale`. Explicit user choices are untouched.
-- ============================================================

ALTER TABLE public.profiles ALTER COLUMN preferred_locale DROP DEFAULT;
