-- ─── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.call_type AS ENUM ('audio', 'video', 'screenshare', 'meeting');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_context_type AS ENUM ('conversation', 'internal', 'verification');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_state AS ENUM (
    'pending', 'ringing', 'connecting', 'active', 'ended', 'failed', 'cancelled', 'missed'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_participant_type AS ENUM ('visitor', 'operator', 'admin', 'internal');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_recording_state AS ENUM (
    'disabled', 'pending', 'recording', 'finalizing', 'available', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── call_sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                     -- 'livekit' | 'jitsi' | 'janus' | …
  provider_room_id TEXT,                      -- opaque, set after provider createRoom()
  call_type public.call_type NOT NULL,
  context_type public.call_context_type NOT NULL,
  context_id UUID,                            -- conversation_id / null for internal
  state public.call_state NOT NULL DEFAULT 'pending',
  initiated_by UUID,                          -- user_id (operator) or null (visitor)
  initiated_by_type public.call_participant_type NOT NULL DEFAULT 'operator',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  recording_enabled BOOLEAN NOT NULL DEFAULT false,
  recording_state public.call_recording_state NOT NULL DEFAULT 'disabled',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_workspace
  ON public.call_sessions (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_context
  ON public.call_sessions (context_type, context_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_state_active
  ON public.call_sessions (workspace_id, state)
  WHERE state IN ('pending','ringing','connecting','active');

-- ─── call_participants ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id UUID NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  participant_type public.call_participant_type NOT NULL,
  participant_id UUID,                        -- user_id / visitor_session_id / null
  provider_participant_id TEXT,               -- opaque (LiveKit identity, Jitsi jid, …)
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  media_state JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { audio:true, video:false, screen:false }
  device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_participants_session
  ON public.call_participants (call_session_id);

-- ─── call_events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id UUID NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                   -- e.g. 'invited','accepted','rejected','joined','left','mute','recording_start'
  actor_type public.call_participant_type,
  actor_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_events_session
  ON public.call_events (call_session_id, created_at DESC);

-- ─── call_recordings ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id UUID NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  recording_type TEXT NOT NULL DEFAULT 'composite',  -- 'composite' | 'individual' | 'audio_only'
  storage_provider TEXT NOT NULL,                    -- 'supabase' | 's3' | 'r2' | …
  storage_path TEXT NOT NULL,
  duration_seconds INTEGER,
  size_bytes BIGINT,
  retention_policy TEXT NOT NULL DEFAULT 'default',  -- e.g. '30d', 'legal_hold'
  retention_expires_at TIMESTAMPTZ,
  legal_hold BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_session
  ON public.call_recordings (call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_retention
  ON public.call_recordings (retention_expires_at)
  WHERE legal_hold = false AND retention_expires_at IS NOT NULL;

-- ─── updated_at trigger for call_sessions ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_call_sessions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_call_sessions_updated_at ON public.call_sessions;
CREATE TRIGGER trg_call_sessions_updated_at
BEFORE UPDATE ON public.call_sessions
FOR EACH ROW EXECUTE FUNCTION public.touch_call_sessions_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.call_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_recordings   ENABLE ROW LEVEL SECURITY;

-- Helper: is the caller a member of this workspace?
-- Reuse existing pattern from other tables: workspace_members table already has its own RLS.
-- We use a security-definer function to avoid recursive policy lookups.
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = _workspace_id AND user_id = _user_id
  );
$$;

-- call_sessions: workspace members read; admins read; mutations server-side only
CREATE POLICY "call_sessions_select_members"
  ON public.call_sessions FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );

-- call_participants
CREATE POLICY "call_participants_select_members"
  ON public.call_participants FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_sessions cs
      WHERE cs.id = call_session_id
        AND (public.is_workspace_member(cs.workspace_id, auth.uid())
             OR public.has_role(auth.uid(), 'admin'::app_role))
    )
  );

-- call_events
CREATE POLICY "call_events_select_members"
  ON public.call_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_sessions cs
      WHERE cs.id = call_session_id
        AND (public.is_workspace_member(cs.workspace_id, auth.uid())
             OR public.has_role(auth.uid(), 'admin'::app_role))
    )
  );

-- call_recordings
CREATE POLICY "call_recordings_select_members"
  ON public.call_recordings FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_sessions cs
      WHERE cs.id = call_session_id
        AND (public.is_workspace_member(cs.workspace_id, auth.uid())
             OR public.has_role(auth.uid(), 'admin'::app_role))
    )
  );

-- No INSERT/UPDATE/DELETE policies for authenticated → all writes flow through
-- the backend service role (signaling routes), which bypasses RLS.

-- ─── Seed control plane defaults ──────────────────────────────────────────
INSERT INTO public.app_runtime_config (key, value)
VALUES
  ('call_control_plane', jsonb_build_object(
    'enabled', false,
    'primary_provider', 'livekit',
    'secondary_provider', 'jitsi',
    'fallback_policy', 'lenient',
    'max_participants', 8,
    'default_audio_bitrate_kbps', 32,
    'default_video_bitrate_kbps', 1200,
    'default_video_profile', 'h264_baseline_720p',
    'recording_default_enabled', false,
    'recording_default_type', 'composite',
    'retention_default_days', 30,
    'verification_required_for_visitor_calls', true
  )),
  ('call_rtc_endpoints', jsonb_build_object(
    'rtc_url', null,
    'ws_url', null,
    'recording_url', null,
    'turn', jsonb_build_object(
      'urls', '[]'::jsonb,
      'username', null,
      'credential', null,
      'credential_type', 'password',
      'static_secret_present', false
    ),
    'ice_policy', 'all',
    'region', null
  ))
ON CONFLICT (key) DO NOTHING;