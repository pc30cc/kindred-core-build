-- Create widget_platform_settings table (singleton row pattern)
CREATE TABLE IF NOT EXISTS public.widget_platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Pre-chat field policies: 'force_on' | 'force_off' | 'default_on' | 'default_off'
  prechat_name_policy text NOT NULL DEFAULT 'default_on',
  prechat_email_policy text NOT NULL DEFAULT 'default_on',
  prechat_phone_policy text NOT NULL DEFAULT 'default_off',
  
  -- Deployment defaults
  default_allow_subdomains boolean NOT NULL DEFAULT true,
  max_allowed_domains_per_workspace integer NOT NULL DEFAULT 10,
  enforce_domain_validation boolean NOT NULL DEFAULT true,
  default_debug_mode boolean NOT NULL DEFAULT false,
  
  -- Feature locks (force off for free plans, etc.)
  force_chat_enabled text NOT NULL DEFAULT 'allow', -- 'allow' | 'force_on' | 'force_off'
  force_kb_enabled text NOT NULL DEFAULT 'allow',
  force_visitor_tracking text NOT NULL DEFAULT 'allow',
  
  -- Limits
  max_message_length integer NOT NULL DEFAULT 5000,
  rate_limit_messages_per_minute integer NOT NULL DEFAULT 20,
  
  -- Notes for admin
  admin_notes text,
  
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  
  CONSTRAINT prechat_name_policy_check CHECK (prechat_name_policy IN ('force_on','force_off','default_on','default_off')),
  CONSTRAINT prechat_email_policy_check CHECK (prechat_email_policy IN ('force_on','force_off','default_on','default_off')),
  CONSTRAINT prechat_phone_policy_check CHECK (prechat_phone_policy IN ('force_on','force_off','default_on','default_off')),
  CONSTRAINT force_chat_check CHECK (force_chat_enabled IN ('allow','force_on','force_off')),
  CONSTRAINT force_kb_check CHECK (force_kb_enabled IN ('allow','force_on','force_off')),
  CONSTRAINT force_visitor_check CHECK (force_visitor_tracking IN ('allow','force_on','force_off'))
);

-- Singleton: only one row allowed
CREATE UNIQUE INDEX IF NOT EXISTS widget_platform_settings_singleton 
  ON public.widget_platform_settings ((true));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.widget_platform_settings_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_widget_platform_settings_touch ON public.widget_platform_settings;
CREATE TRIGGER trg_widget_platform_settings_touch
  BEFORE UPDATE ON public.widget_platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.widget_platform_settings_touch();

-- Enable RLS
ALTER TABLE public.widget_platform_settings ENABLE ROW LEVEL SECURITY;

-- Only super admins can manage
CREATE POLICY "Admins can manage widget platform settings"
ON public.widget_platform_settings
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Authenticated users can read (workspace panels need to know lock states)
CREATE POLICY "Authenticated can read widget platform settings"
ON public.widget_platform_settings
FOR SELECT
TO authenticated
USING (true);

-- Anon (widget runtime) can read for resolving pre-chat policy
CREATE POLICY "Anon can read widget platform settings"
ON public.widget_platform_settings
FOR SELECT
TO anon
USING (true);

-- Seed default singleton row
INSERT INTO public.widget_platform_settings (id)
VALUES (gen_random_uuid())
ON CONFLICT DO NOTHING;

-- Helper RPC for resolving effective policy for a workspace
CREATE OR REPLACE FUNCTION public.get_widget_platform_settings()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(s.*) FROM public.widget_platform_settings s LIMIT 1;
$$;