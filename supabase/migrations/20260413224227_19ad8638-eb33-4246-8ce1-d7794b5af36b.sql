-- Security events table for tracking all security-relevant activity
CREATE TABLE public.security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  ip_address text,
  user_id uuid,
  user_email text,
  workspace_id uuid,
  endpoint text,
  metadata jsonb DEFAULT '{}'::jsonb,
  resolved boolean DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_security_events_type ON public.security_events(event_type);
CREATE INDEX idx_security_events_ip ON public.security_events(ip_address);
CREATE INDEX idx_security_events_created ON public.security_events(created_at DESC);
CREATE INDEX idx_security_events_severity ON public.security_events(severity);
CREATE INDEX idx_security_events_user ON public.security_events(user_id);

ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view security events"
  ON public.security_events FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update security events"
  ON public.security_events FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Login attempt tracking for brute force protection
CREATE TABLE public.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address text NOT NULL,
  email text NOT NULL,
  success boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_login_attempts_ip_email ON public.login_attempts(ip_address, email);
CREATE INDEX idx_login_attempts_created ON public.login_attempts(created_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- IP blocklist for automatic and manual blocking
CREATE TABLE public.ip_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address text NOT NULL UNIQUE,
  reason text NOT NULL,
  blocked_by uuid,
  blocked_until timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ip_blocklist_ip ON public.ip_blocklist(ip_address);

ALTER TABLE public.ip_blocklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage IP blocklist"
  ON public.ip_blocklist FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Security stats function
CREATE OR REPLACE FUNCTION public.admin_security_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total_events_24h', (SELECT count(*) FROM security_events WHERE created_at > now() - interval '24 hours'),
    'failed_logins_24h', (SELECT count(*) FROM security_events WHERE event_type = 'login_failed' AND created_at > now() - interval '24 hours'),
    'rate_limited_24h', (SELECT count(*) FROM security_events WHERE event_type = 'rate_limited' AND created_at > now() - interval '24 hours'),
    'captcha_failed_24h', (SELECT count(*) FROM security_events WHERE event_type = 'captcha_failed' AND created_at > now() - interval '24 hours'),
    'blocked_ips', (SELECT count(*) FROM ip_blocklist WHERE blocked_until IS NULL OR blocked_until > now()),
    'brute_force_24h', (SELECT count(*) FROM security_events WHERE event_type = 'brute_force' AND created_at > now() - interval '24 hours'),
    'abuse_detected_24h', (SELECT count(*) FROM security_events WHERE event_type = 'abuse_detected' AND created_at > now() - interval '24 hours'),
    'critical_events_24h', (SELECT count(*) FROM security_events WHERE severity = 'critical' AND created_at > now() - interval '24 hours'),
    'unresolved_events', (SELECT count(*) FROM security_events WHERE resolved = false AND severity IN ('error', 'critical'))
  )
$$;

-- Check if IP is blocked
CREATE OR REPLACE FUNCTION public.is_ip_blocked(_ip text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM ip_blocklist
    WHERE ip_address = _ip
    AND (blocked_until IS NULL OR blocked_until > now())
  )
$$;

-- Count recent failed logins for brute force detection
CREATE OR REPLACE FUNCTION public.count_recent_login_failures(_ip text, _email text, _window_minutes integer DEFAULT 15)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer FROM login_attempts
  WHERE ip_address = _ip
  AND email = _email
  AND success = false
  AND created_at > now() - (_window_minutes || ' minutes')::interval
$$;