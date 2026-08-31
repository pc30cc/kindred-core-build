-- 069 — Distinguish "never authored" from "authored empty" for the widget
-- header texts.
--
-- brand_name / reply_time_text were seeded as '' which the widget now reads as
-- an authoritative "hide this line". Rows that were never edited must be NULL
-- so the workspace name and the locale default reply-time note show up (and
-- appear pre-filled in the Appearance tab).
--
-- No new table, so no GRANT block is required.

ALTER TABLE public.widget_settings ALTER COLUMN brand_name DROP DEFAULT;
ALTER TABLE public.widget_settings ALTER COLUMN reply_time_text DROP DEFAULT;
ALTER TABLE public.widget_settings ALTER COLUMN brand_name DROP NOT NULL;
ALTER TABLE public.widget_settings ALTER COLUMN reply_time_text DROP NOT NULL;

UPDATE public.widget_settings
   SET brand_name = NULL
 WHERE brand_name IS NOT NULL AND btrim(brand_name) = '';

UPDATE public.widget_settings
   SET reply_time_text = NULL
 WHERE reply_time_text IS NOT NULL AND btrim(reply_time_text) = '';
