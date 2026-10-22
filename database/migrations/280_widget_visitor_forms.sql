-- 280 — The chat widget's visitor forms: a pre-chat field is required only
-- while it is asked.
--
-- 1. widget_prechat_settings: until now the workspace panel turned only
--    `ask_<field>` off and left `require_<field>` on (the column defaults
--    require name and email), so a visitor was refused for a field the form
--    never drew and could not start a chat at all. Rows stored that way get
--    `require_<field> = false`, and a BEFORE INSERT OR UPDATE trigger keeps
--    it so for every writer (an older backend during the rollout included):
--    `require_<field>` is stored as `require_<field> AND ask_<field>`. The
--    server applies the same rule when it serves the form
--    (shared/prechatPolicy.ts).
--
-- (The visitor's phone in the owners' "new offline message" mail is 283: it
-- adds a placeholder only the new backend fills, so it is applied after
-- that backend is deployed.)
--
-- Locks: ROW EXCLUSIVE on widget_prechat_settings (one row per workspace)
-- for the UPDATE, SHARE ROW EXCLUSIVE on
-- widget_prechat_settings for an instant to (re)create the trigger. The file
-- sets lock_timeout 5s itself and resets it (RESPOK's migrator runs without
-- PGOPTIONS); a statement stopped by it is simply run again. Re-runnable: a
-- second run updates nothing and replaces the function and trigger with the
-- same ones. Dry run: the file inside BEGIN … ROLLBACK. Drops nothing;
-- touches no archive schema or table.

SET lock_timeout = '5s';

-- ─── 1. A field is required only while it is asked ────────────────────────
UPDATE public.widget_prechat_settings
   SET require_name  = require_name  AND ask_name,
       require_email = require_email AND ask_email,
       require_phone = require_phone AND ask_phone
 WHERE (require_name AND NOT ask_name)
    OR (require_email AND NOT ask_email)
    OR (require_phone AND NOT ask_phone);

CREATE OR REPLACE FUNCTION public.widget_prechat_settings_require_asked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.require_name  := NEW.require_name  AND NEW.ask_name;
  NEW.require_email := NEW.require_email AND NEW.ask_email;
  NEW.require_phone := NEW.require_phone AND NEW.ask_phone;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.widget_prechat_settings_require_asked() IS
  'Stores require_<field> only while ask_<field> is on: a pre-chat field the form does not draw never blocks a visitor (migration 280).';

DROP TRIGGER IF EXISTS trg_widget_prechat_settings_require_asked ON public.widget_prechat_settings;
CREATE TRIGGER trg_widget_prechat_settings_require_asked
  BEFORE INSERT OR UPDATE ON public.widget_prechat_settings
  FOR EACH ROW EXECUTE FUNCTION public.widget_prechat_settings_require_asked();

RESET lock_timeout;
