-- AI usage tracking
CREATE TABLE public.ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider_name text NOT NULL,
  model text,
  prompt_tokens integer DEFAULT 0,
  completion_tokens integer DEFAULT 0,
  total_tokens integer DEFAULT 0,
  success boolean NOT NULL DEFAULT true,
  error_message text,
  latency_ms integer,
  endpoint text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ai_usage_workspace ON public.ai_usage_logs(workspace_id);
CREATE INDEX idx_ai_usage_created ON public.ai_usage_logs(created_at DESC);
CREATE INDEX idx_ai_usage_provider ON public.ai_usage_logs(provider_name);

ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins+ can view AI usage"
  ON public.ai_usage_logs FOR SELECT
  TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );

CREATE POLICY "Global admins can view all AI usage"
  ON public.ai_usage_logs FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Storage usage tracking
CREATE TABLE public.storage_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider_name text NOT NULL,
  operation text NOT NULL,
  file_key text,
  file_size bigint,
  content_type text,
  success boolean NOT NULL DEFAULT true,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_storage_usage_workspace ON public.storage_usage_logs(workspace_id);
CREATE INDEX idx_storage_usage_created ON public.storage_usage_logs(created_at DESC);

ALTER TABLE public.storage_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins+ can view storage usage"
  ON public.storage_usage_logs FOR SELECT
  TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );

CREATE POLICY "Global admins can view all storage usage"
  ON public.storage_usage_logs FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));