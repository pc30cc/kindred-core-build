-- 062 — Workspace-configurable reply-time note for the widget header.
--
-- The Web Yar template renders a short "typically replies in…" line under the
-- workspace name in both the Home and Chat headers. Until now that string was
-- locale-default only; workspaces need to state their real reply time.
--
-- No new table, so no GRANT block is required: widget_settings already carries
-- its privileges and RLS policies.

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS reply_time_text text;

COMMENT ON COLUMN public.widget_settings.reply_time_text IS
  'Optional workspace-authored reply-time note shown under the brand name in the widget header. Empty/NULL falls back to the locale default.';
