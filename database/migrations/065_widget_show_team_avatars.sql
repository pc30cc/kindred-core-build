-- 065 — Widget: opt-out toggle for online-operator avatars.
-- The avatars now render inside the Home "start chat" CTA (never in the
-- header). No new table, so no GRANT block is required: widget_settings
-- already carries its own grants/policies.

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS show_team_avatars boolean NOT NULL DEFAULT true;
