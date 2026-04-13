
-- Email delivery logs (append-only)
CREATE TABLE public.email_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE NOT NULL,
  template_slug text,
  recipient_email text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'pending',
  provider_name text,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  sent_at timestamptz
);

-- Create validation trigger for status values
CREATE OR REPLACE FUNCTION public.validate_email_log_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'sent', 'failed', 'bounced') THEN
    RAISE EXCEPTION 'Invalid email_logs status: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER check_email_log_status
  BEFORE INSERT OR UPDATE ON public.email_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_email_log_status();

-- Indexes for common queries
CREATE INDEX idx_email_logs_workspace_id ON public.email_logs(workspace_id);
CREATE INDEX idx_email_logs_created_at ON public.email_logs(created_at DESC);
CREATE INDEX idx_email_logs_status ON public.email_logs(status);

-- RLS
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins+ can view email logs"
  ON public.email_logs FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) = ANY(ARRAY['owner'::workspace_role, 'admin'::workspace_role]));

CREATE POLICY "Global admins can view all email logs"
  ON public.email_logs FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));
