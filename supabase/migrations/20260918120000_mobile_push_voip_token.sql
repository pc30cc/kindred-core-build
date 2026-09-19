-- VoIP push tokens for CallKit.
--
-- A VoIP token is NOT the same address as the notification token: it comes
-- from PushKit rather than from UNUserNotificationCenter, it is only valid for
-- `apns-push-type: voip`, and Apple terminates an app that receives one
-- without reporting a call. Keeping it in its own column is what lets the
-- dispatcher pick the right transport per message: FCM for a new message,
-- APNs direct for a ringing call.
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

-- The ring path looks devices up by user and only wants the ones that can
-- actually ring.
CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_voip_active
  ON public.mobile_push_devices (user_id)
  WHERE enabled AND voip_token IS NOT NULL;

-- A device that can ring but cannot show a banner is a valid device.
--
-- The iOS app obtains its VoIP address from PushKit, which needs no Firebase
-- at all; the notification token needs the Firebase SDK and the operator's
-- permission. Requiring both would mean an operator who declined notification
-- permission also silently loses incoming calls, which is not a trade anyone
-- would knowingly make.
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
