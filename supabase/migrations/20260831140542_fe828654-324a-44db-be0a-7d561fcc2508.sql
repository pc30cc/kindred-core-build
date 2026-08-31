ALTER TABLE public.widget_prechat_settings
  ADD COLUMN IF NOT EXISTS prechat_timing text NOT NULL DEFAULT 'after_handoff';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_prechat_timing_check') THEN
    ALTER TABLE public.widget_prechat_settings
      ADD CONSTRAINT widget_prechat_timing_check
      CHECK (prechat_timing IN ('always','after_handoff','never'));
  END IF;
END $$;