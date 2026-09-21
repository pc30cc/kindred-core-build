-- Which door a device's `push_token` goes through.
--
-- Hosted mirror of the second half of
-- database/migrations/204_mobile_push_voip_and_transport.sql. The first half
-- — `voip_token` and friends — is already in this chain as
-- 20260918120000_mobile_push_voip_token.sql; it was the SELF-HOST chain that
-- never received it.
--
-- `push_token` used to mean one thing, an FCM registration token, because
-- there was one client and one transport. The SwiftUI operator app has no
-- Firebase in it: it registers the raw APNs token iOS hands it, and the
-- server talks to Apple directly — which it already does for the CallKit
-- ring, with the same key. Two kinds of address in one column with no way to
-- tell them apart would mean handing an APNs token to Google and waiting for
-- a 404.
--
-- `fcm` by default, because every row that exists today is one.

ALTER TABLE public.mobile_push_devices
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'fcm';

ALTER TABLE public.mobile_push_devices
  DROP CONSTRAINT IF EXISTS mobile_push_devices_transport_check;
ALTER TABLE public.mobile_push_devices
  ADD CONSTRAINT mobile_push_devices_transport_check
  CHECK (transport IN ('fcm', 'apns'));

COMMENT ON COLUMN public.mobile_push_devices.transport IS
  'Which service push_token addresses: fcm (Capacitor build) or apns (native SwiftUI app, sent to Apple directly).';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'mobile_push_devices'
       AND column_name = 'transport'
  ) THEN
    RAISE EXCEPTION 'mobile_push_devices.transport was not created';
  END IF;

  -- The VoIP half has to be here already, or the registration path still
  -- fails on every call — which is exactly the state this project's
  -- production database is in until 20260918120000 is applied to it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'mobile_push_devices'
       AND column_name = 'voip_token'
  ) THEN
    RAISE EXCEPTION
      'mobile_push_devices.voip_token is missing: apply 20260918120000_mobile_push_voip_token.sql first';
  END IF;

  RAISE NOTICE 'device rows can name their transport';
END
$verify$;
