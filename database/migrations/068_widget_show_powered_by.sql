-- 068 — Workspace-level "Powered by" visibility switch.
--
-- The footer stays platform-owned (wording/brand/link) and plan-gated
-- (`widget_powered_by`). This adds an OPTIONAL workspace switch that only
-- becomes editable when the plan grants `widget_powered_by_toggle`.
-- Default is ON so every workspace keeps showing the credit until its owner
-- (on an allowed plan) explicitly turns it off.
--
-- No new tables => no GRANT changes required.

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS show_powered_by boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.widget_settings.show_powered_by IS
  'Workspace preference for the widget powered-by footer. Editable only when the plan grants widget_powered_by_toggle; forced true otherwise.';
