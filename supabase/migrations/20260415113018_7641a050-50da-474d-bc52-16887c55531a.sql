-- Add public read policy for specific platform config keys (support widget)
CREATE POLICY "Public can read support widget config"
ON public.app_runtime_config
FOR SELECT
TO anon, authenticated
USING (key IN ('support_widget_workspace_id'));

-- Insert default support widget workspace ID
INSERT INTO public.app_runtime_config (key, value)
VALUES ('support_widget_workspace_id', '"ac96df94-d5b9-4f67-a6be-9245bbece0bb"'::jsonb)
ON CONFLICT (key) DO NOTHING;