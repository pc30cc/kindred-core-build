
CREATE TABLE IF NOT EXISTS public.call_center_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  public_key text UNIQUE,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  widget_position text NOT NULL DEFAULT 'bottom-right',
  widget_theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_name text,
  avatar_storage_path text,
  avatar_url text,
  voice_enabled boolean NOT NULL DEFAULT true,
  video_enabled boolean NOT NULL DEFAULT true,
  callback_enabled boolean NOT NULL DEFAULT true,
  pre_call_form_enabled boolean NOT NULL DEFAULT true,
  pre_call_form_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  business_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  offline_behavior text NOT NULL DEFAULT 'callback',
  recording_enabled boolean NOT NULL DEFAULT false,
  recording_consent_required boolean NOT NULL DEFAULT true,
  routing_mode text NOT NULL DEFAULT 'broadcast',
  default_department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_center_settings_workspace ON public.call_center_settings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_call_center_settings_publickey ON public.call_center_settings(public_key) WHERE public_key IS NOT NULL;

ALTER TABLE public.call_center_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_center_settings_member_read ON public.call_center_settings;
CREATE POLICY call_center_settings_member_read
  ON public.call_center_settings FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS call_center_settings_admin_write ON public.call_center_settings;
CREATE POLICY call_center_settings_admin_write
  ON public.call_center_settings FOR ALL
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TABLE IF NOT EXISTS public.platform_call_center_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  call_center_enabled boolean NOT NULL DEFAULT false,
  voice_calls_enabled boolean NOT NULL DEFAULT true,
  video_calls_enabled boolean NOT NULL DEFAULT true,
  callback_requests_enabled boolean NOT NULL DEFAULT true,
  call_recording_enabled boolean NOT NULL DEFAULT false,
  screen_share_enabled boolean NOT NULL DEFAULT false,
  call_transfer_enabled boolean NOT NULL DEFAULT false,
  departments_enabled boolean NOT NULL DEFAULT false,
  advanced_routing_enabled boolean NOT NULL DEFAULT false,
  max_concurrent_calls_per_workspace int NOT NULL DEFAULT 50,
  max_queue_size_per_workspace int NOT NULL DEFAULT 100,
  max_monthly_call_minutes_per_workspace int NOT NULL DEFAULT 100000,
  max_callback_requests_per_month int NOT NULL DEFAULT 10000,
  max_recording_storage_mb int NOT NULL DEFAULT 10000,
  disabled_message jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.platform_call_center_settings (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.platform_call_center_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pcc_read_anyone ON public.platform_call_center_settings;
CREATE POLICY pcc_read_anyone
  ON public.platform_call_center_settings FOR SELECT
  USING (true);

DROP POLICY IF EXISTS pcc_write_admin ON public.platform_call_center_settings;
CREATE POLICY pcc_write_admin
  ON public.platform_call_center_settings FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS call_type text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS page_url text,
  ADD COLUMN IF NOT EXISTS page_title text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS visitor_name text,
  ADD COLUMN IF NOT EXISTS visitor_email text,
  ADD COLUMN IF NOT EXISTS visitor_phone text,
  ADD COLUMN IF NOT EXISTS wait_seconds int NOT NULL DEFAULT 0;

ALTER TABLE public.call_queue_entries
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'chat';

CREATE INDEX IF NOT EXISTS idx_call_sessions_ws_entrysource_created
  ON public.call_sessions(workspace_id, entry_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_queue_ws_entrysource_state
  ON public.call_queue_entries(workspace_id, entry_source, state);

CREATE OR REPLACE FUNCTION public.cc_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_cc_settings_touch ON public.call_center_settings;
CREATE TRIGGER trg_cc_settings_touch BEFORE UPDATE ON public.call_center_settings
  FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

DROP TRIGGER IF EXISTS trg_pcc_touch ON public.platform_call_center_settings;
CREATE TRIGGER trg_pcc_touch BEFORE UPDATE ON public.platform_call_center_settings
  FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();
