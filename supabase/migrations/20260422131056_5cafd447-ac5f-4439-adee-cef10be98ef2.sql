-- Phase 8B — LiveKit production schema additions

-- 1. Seed default LiveKit config row (server-only secrets).
INSERT INTO public.app_runtime_config (key, value)
VALUES (
  'call_livekit_config',
  jsonb_build_object(
    'enabled', false,
    'api_key', null,
    'api_secret', null,
    'rtc_url', null,
    'ws_url', null,
    'egress_enabled', false,
    'egress_url', null,
    'region', null,
    'webhook_secret_present', false,
    'recording_storage', jsonb_build_object(
      'vendor', null,
      'bucket', null,
      'region', null,
      'access_key_present', false,
      'secret_key_present', false,
      'endpoint', null,
      'force_path_style', false
    )
  )
)
ON CONFLICT (key) DO NOTHING;

-- 2. Extend call_recordings with the LiveKit egress id used by webhook reconciliation.
ALTER TABLE public.call_recordings
  ADD COLUMN IF NOT EXISTS provider_recording_id text;

CREATE INDEX IF NOT EXISTS idx_call_recordings_provider_recording_id
  ON public.call_recordings (provider_recording_id)
  WHERE provider_recording_id IS NOT NULL;

-- 3. LiveKit webhook event audit table — service role only.
CREATE TABLE IF NOT EXISTS public.livekit_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  event_type text NOT NULL,
  room_name text,
  participant_identity text,
  egress_id text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_valid boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  process_error text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_webhook_events_event_id
  ON public.livekit_webhook_events (event_id);

CREATE INDEX IF NOT EXISTS idx_livekit_webhook_events_room
  ON public.livekit_webhook_events (room_name)
  WHERE room_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_livekit_webhook_events_received_at
  ON public.livekit_webhook_events (received_at DESC);

ALTER TABLE public.livekit_webhook_events ENABLE ROW LEVEL SECURITY;

-- Service-role-only access. No public/auth/admin client reads through PostgREST.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'livekit_webhook_events'
      AND policyname = 'No PostgREST access'
  ) THEN
    CREATE POLICY "No PostgREST access"
      ON public.livekit_webhook_events
      AS PERMISSIVE
      FOR ALL
      TO authenticated
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;