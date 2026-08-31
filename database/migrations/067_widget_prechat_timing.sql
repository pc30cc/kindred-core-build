-- 067_widget_prechat_timing.sql
-- Explicit "when does the pre-chat form appear?" control for workspace owners.
--   always        → ask before the conversation starts (even when the AI agent
--                   is the first responder)
--   after_handoff → only once a human is involved (AI handed off, or AI is
--                   off/unavailable). This is the historical behaviour and is
--                   therefore the default so nothing changes on upgrade.
--   never         → the form is never shown (identity stays anonymous unless
--                   the visitor is already known)

ALTER TABLE public.widget_prechat_settings
  ADD COLUMN IF NOT EXISTS prechat_timing text NOT NULL DEFAULT 'after_handoff';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'widget_prechat_timing_check'
  ) THEN
    ALTER TABLE public.widget_prechat_settings
      ADD CONSTRAINT widget_prechat_timing_check
      CHECK (prechat_timing IN ('always', 'after_handoff', 'never'));
  END IF;
END $$;
