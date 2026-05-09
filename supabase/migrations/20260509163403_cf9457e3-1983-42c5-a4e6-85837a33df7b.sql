
CREATE TABLE IF NOT EXISTS public.platform_ai_agent_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key boolean NOT NULL DEFAULT true,
  ai_agent_enabled boolean NOT NULL DEFAULT true,
  customer_ai_agent_visible boolean NOT NULL DEFAULT true,
  advanced_tools_enabled boolean NOT NULL DEFAULT false,
  regression_runner_enabled boolean NOT NULL DEFAULT false,
  source_health_visible_to_customers boolean NOT NULL DEFAULT false,
  test_harness_visible_to_customers boolean NOT NULL DEFAULT false,
  operator_assist_enabled boolean NOT NULL DEFAULT true,
  auto_answer_enabled boolean NOT NULL DEFAULT true,
  learning_enabled boolean NOT NULL DEFAULT true,
  files_enabled boolean NOT NULL DEFAULT true,
  websites_enabled boolean NOT NULL DEFAULT true,
  qna_enabled boolean NOT NULL DEFAULT true,
  kb_enabled boolean NOT NULL DEFAULT true,
  max_customer_visible_nav_items integer NOT NULL DEFAULT 6,
  disabled_message text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_ai_agent_settings_singleton_check') THEN
    ALTER TABLE public.platform_ai_agent_settings
      ADD CONSTRAINT platform_ai_agent_settings_singleton_check CHECK (singleton_key = true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_ai_agent_settings_singleton_unique') THEN
    ALTER TABLE public.platform_ai_agent_settings
      ADD CONSTRAINT platform_ai_agent_settings_singleton_unique UNIQUE (singleton_key);
  END IF;
END $$;

ALTER TABLE public.platform_ai_agent_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read platform ai-agent settings" ON public.platform_ai_agent_settings;
CREATE POLICY "Admins read platform ai-agent settings"
  ON public.platform_ai_agent_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins manage platform ai-agent settings" ON public.platform_ai_agent_settings;
CREATE POLICY "Admins manage platform ai-agent settings"
  ON public.platform_ai_agent_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.platform_ai_agent_settings (singleton_key)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM public.platform_ai_agent_settings);

NOTIFY pgrst, 'reload schema';
