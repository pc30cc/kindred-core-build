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
