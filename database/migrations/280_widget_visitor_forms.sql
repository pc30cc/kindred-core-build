-- 280 — The chat widget's visitor forms: a pre-chat field is required only
-- while it is asked, and the owner's "new offline message" mail shows the
-- visitor's phone.
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
-- 2. email_templates, slug offline_message_received (the mail to the
--    workspace's owners when a visitor leaves a message while away): the
--    platform rows get a Phone row under Email in the HTML and the phone
--    after the email in the text, as {contact_phone} (the server fills it
--    since this change; a visitor who left only a phone could not be called
--    back). Only rows whose details table still ends with the seeded Email
--    row and that have no {contact_phone} yet get the row added; a template
--    the Super Admin rewrote without it stays exactly as written.
--
-- Locks: ROW EXCLUSIVE on widget_prechat_settings (one row per workspace)
-- and email_templates for the UPDATEs, SHARE ROW EXCLUSIVE on
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

-- ─── 2. The visitor's phone in the owner's offline-message mail ───────────
UPDATE public.email_templates t
   SET html_body = replace(
         t.html_body,
         '{contact_email}</td></tr></table>',
         '{contact_email}</td></tr><tr><td style="padding:6px 0;color:#64748b;">'
           || CASE t.locale WHEN 'fa' THEN 'تلفن' WHEN 'tr' THEN 'Telefon' ELSE 'Phone' END
           || '</td><td style="padding:6px 0;" dir="ltr">{contact_phone}</td></tr></table>'),
       text_body = CASE
         WHEN t.text_body IS NOT NULL AND position('{contact_phone}' IN t.text_body) = 0
           THEN replace(t.text_body, '({contact_email})', '({contact_email} {contact_phone})')
         ELSE t.text_body
       END
 WHERE t.workspace_id IS NULL
   AND t.slug = 'offline_message_received'
   AND position('{contact_email}</td></tr></table>' IN t.html_body) > 0
   AND position('{contact_phone}' IN t.html_body) = 0;

RESET lock_timeout;
