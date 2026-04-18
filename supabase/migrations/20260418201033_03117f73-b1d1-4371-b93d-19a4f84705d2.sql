-- Phase 5: Operator Presence + Availability UX
-- Adds availability/business-hours columns to widget_settings.
-- Safe defaults: live chat enabled, accept-messages mode, no business hours configured (always available).
-- Backwards compatible: existing widgets continue to behave exactly as before.

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS live_chat_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS offline_mode TEXT NOT NULL DEFAULT 'accept_messages',
  ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL DEFAULT '{"enabled": false, "timezone": "UTC", "schedule": []}'::jsonb,
  ADD COLUMN IF NOT EXISTS availability_labels JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Constrain offline_mode to known values (validation trigger, not CHECK, per project rules).
CREATE OR REPLACE FUNCTION public.widget_settings_validate_offline_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.offline_mode NOT IN ('accept_messages', 'contact_fallback') THEN
    RAISE EXCEPTION 'invalid offline_mode: %, expected accept_messages or contact_fallback', NEW.offline_mode;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS widget_settings_validate_offline_mode ON public.widget_settings;
CREATE TRIGGER widget_settings_validate_offline_mode
BEFORE INSERT OR UPDATE OF offline_mode ON public.widget_settings
FOR EACH ROW EXECUTE FUNCTION public.widget_settings_validate_offline_mode();

COMMENT ON COLUMN public.widget_settings.live_chat_enabled IS 'Phase 5: master toggle for live human chat. When false, widget shows unavailable state.';
COMMENT ON COLUMN public.widget_settings.offline_mode IS 'Phase 5: behavior when live operators are offline/unavailable. accept_messages = let user send anyway, contact_fallback = show contact form.';
COMMENT ON COLUMN public.widget_settings.business_hours IS 'Phase 5: { enabled, timezone, schedule:[{day:0..6, open:"HH:MM", close:"HH:MM"}] }. When enabled=false, widget never marks as closed by hours.';
COMMENT ON COLUMN public.widget_settings.availability_labels IS 'Phase 5: optional overrides for { online, away, offline, unavailable, offline_intro, fallback_intro }. Empty {} means use widget defaults.';