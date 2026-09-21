-- ============================================================
-- 204 — THE TWO THINGS A DEVICE ROW COULD NOT SAY
--
-- 1. WHERE TO RING IT.
--
-- `20260918120000_mobile_push_voip_token.sql` added `voip_token` and
-- `voip_token_updated_at` to the hosted chain and was never mirrored here. A
-- self-hosted install therefore has a `mobile_push_devices` without them —
-- and `server/services/push/devices.ts` writes both on EVERY registration,
-- so `POST /api/push/devices` has been failing outright on self-host since
-- the day VoIP was added. Not "calls do not ring": no device registers at
-- all, so no notification of any kind has ever reached a self-hosted
-- operator's phone.
--
-- 2. WHICH DOOR TO SEND THROUGH.
--
-- `push_token` used to mean one thing — an FCM registration token — because
-- there was one client, the Capacitor build, and one transport. The SwiftUI
-- operator app has no Firebase in it: it registers the raw APNs token iOS
-- hands it, and the server talks to Apple directly, which it already does for
-- the CallKit ring. Two kinds of address in one column with no way to tell
-- them apart would mean handing an APNs token to Google and waiting for a
-- 404, so the row says which it is.
--
-- `fcm` by default, because every row that exists today is one.
-- ============================================================

-- ---------- 1. the VoIP address ----------
--
-- Nullable on purpose: Android has no VoIP token, and an iOS install that has
-- never been granted microphone access never registers one.
ALTER TABLE public.mobile_push_devices
  ADD COLUMN IF NOT EXISTS voip_token text,
  ADD COLUMN IF NOT EXISTS voip_token_updated_at timestamptz;

-- One device per VoIP token, for the same reason `push_token` is unique: a
-- token that reappears under another user must be re-owned, never duplicated,
-- or one operator's phone would ring for another operator's calls.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_push_devices_voip_token
  ON public.mobile_push_devices (voip_token)
  WHERE voip_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_voip_active
  ON public.mobile_push_devices (user_id)
  WHERE enabled AND voip_token IS NOT NULL;

-- A device that can ring but cannot show a banner is a valid device: the ring
-- address comes from PushKit and the notification address needs the
-- operator's permission, so requiring both would mean declining notifications
-- silently costs you incoming calls.
ALTER TABLE public.mobile_push_devices
  ALTER COLUMN push_token DROP NOT NULL;

-- Postgres treats NULLs as distinct in a unique index, so rows with no
-- notification token coexist happily; re-stating it as partial makes that
-- intent explicit rather than incidental.
DROP INDEX IF EXISTS public.uq_mobile_push_devices_token;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_push_devices_token
  ON public.mobile_push_devices (push_token)
  WHERE push_token IS NOT NULL;

-- At least one address, or the row is just noise.
ALTER TABLE public.mobile_push_devices
  DROP CONSTRAINT IF EXISTS mobile_push_devices_has_address;
ALTER TABLE public.mobile_push_devices
  ADD CONSTRAINT mobile_push_devices_has_address
  CHECK (push_token IS NOT NULL OR voip_token IS NOT NULL);

-- ---------- 2. which transport `push_token` belongs to ----------
ALTER TABLE public.mobile_push_devices
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'fcm';

ALTER TABLE public.mobile_push_devices
  DROP CONSTRAINT IF EXISTS mobile_push_devices_transport_check;
ALTER TABLE public.mobile_push_devices
  ADD CONSTRAINT mobile_push_devices_transport_check
  CHECK (transport IN ('fcm', 'apns'));

COMMENT ON COLUMN public.mobile_push_devices.transport IS
  'Which service push_token addresses: fcm (Capacitor build) or apns (native SwiftUI app, sent to Apple directly).';

-- ---------- proof ----------
DO $verify$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c, ', ' ORDER BY c) INTO missing
    FROM unnest(ARRAY['voip_token', 'voip_token_updated_at', 'transport']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mobile_push_devices'
        AND column_name = c
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '204: mobile_push_devices is still missing %', missing;
  END IF;

  -- The registration path writes every one of these on every call. A column
  -- that exists but refuses the write is the same outage with a better error
  -- message, so the insert is actually attempted and rolled back.
  BEGIN
    INSERT INTO public.mobile_push_devices
      (user_id, platform, push_token, transport, device_id, voip_token, voip_token_updated_at)
    VALUES
      ('00000000-0000-4000-8000-000000000204', 'ios', 'verify-204-token',
       'apns', 'verify-204-device', 'ABCDEF0123456789', now());
    DELETE FROM public.mobile_push_devices WHERE device_id = 'verify-204-device';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION '204: a device row the server would write is still rejected: %', SQLERRM;
  END;

  RAISE NOTICE '204: device rows can carry a VoIP address and name their transport';
END
$verify$;
