-- 279 — widget_settings.offline_mode: the database accepts the values the
-- panel and the server write.
--
-- What it fixes: the validation trigger from the hosted chain
-- (supabase/migrations/20260418201033, replayed by 239) only accepts the
-- two values of the first availability design, 'accept_messages' and
-- 'contact_fallback'. Since the Availability tab was rebuilt, the panel and
-- PATCH /api/widget-settings/:id write 'capture_message',
-- 'show_offline_message' or 'hide_widget' (server/routes/widgetSettings.ts),
-- so choosing "Hide widget" or "Show offline message only" failed with
-- "invalid offline_mode" and nothing was saved. The column default is still
-- 'accept_messages', which the panel shows as no choice at all; the server
-- has always read both old values as 'capture_message'
-- (server/services/widget/availability.ts normalizeOfflineMode), which is
-- what every visitor got.
--
-- 1. The trigger function accepts the three current values. An old value
--    still written by anything is stored as 'capture_message' (its meaning)
--    instead of being refused; any other value is refused as before.
-- 2. Rows holding an old value are rewritten to 'capture_message' (what the
--    server already serves them, so no visitor sees a change).
-- 3. The column default becomes 'capture_message'.
--
-- Locks: the function swap takes none on the table; the UPDATE takes ROW
-- EXCLUSIVE (readers and other writers pass) and row locks on the rows it
-- rewrites (one row per workspace, only those still on an old value); the
-- default is metadata only (ACCESS EXCLUSIVE for an instant) and is set only
-- while it differs, so a second run takes no lock but the UPDATE's (which
-- then matches nothing). The trigger itself is created only where it is
-- missing, and the column comment takes SHARE UPDATE EXCLUSIVE (readers and
-- writers pass). updated_at is not touched: the visitors' behaviour is
-- unchanged.
-- The file sets lock_timeout 5s itself (RESPOK's migrator runs without
-- PGOPTIONS); a statement stopped by it is simply run again. Dry run: the
-- file inside BEGIN … ROLLBACK. Drops nothing; touches no archive schema or
-- table.

SET lock_timeout = '5s';

-- 1. The values the panel and the server write; old ones mean the form.
CREATE OR REPLACE FUNCTION public.widget_settings_validate_offline_mode() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.offline_mode IN ('accept_messages', 'contact_fallback') THEN
    NEW.offline_mode := 'capture_message';
  END IF;
  IF NEW.offline_mode NOT IN ('capture_message', 'show_offline_message', 'hide_widget') THEN
    RAISE EXCEPTION 'invalid offline_mode: %, expected capture_message, show_offline_message or hide_widget', NEW.offline_mode
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.widget_settings'::regclass
       AND tgname = 'widget_settings_validate_offline_mode'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER widget_settings_validate_offline_mode
      BEFORE INSERT OR UPDATE OF offline_mode ON public.widget_settings
      FOR EACH ROW EXECUTE FUNCTION public.widget_settings_validate_offline_mode();
  END IF;
END
$$;

-- 2. Stored old values: their meaning, which the server already serves.
UPDATE public.widget_settings
   SET offline_mode = 'capture_message'
 WHERE offline_mode IN ('accept_messages', 'contact_fallback');

-- 3. New rows start on the leave-a-message form, as the panel shows it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'widget_settings'
       AND column_name = 'offline_mode'
       AND column_default IS DISTINCT FROM '''capture_message''::text'
  ) THEN
    ALTER TABLE public.widget_settings ALTER COLUMN offline_mode SET DEFAULT 'capture_message';
  END IF;
END
$$;

COMMENT ON COLUMN public.widget_settings.offline_mode IS
  'What visitors see while the chat is offline (outside business hours, or no operator available): capture_message = a leave-a-message form (default), show_offline_message = the offline message only, hide_widget = no launcher on new page loads. 279: the old values accept_messages / contact_fallback are stored as capture_message.';
