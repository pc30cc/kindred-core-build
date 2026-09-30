-- 243 — Platform support is a chat: tickets go, ratings and the Android switch come.
-- Hosted twin: supabase/migrations/20260930170000_platform_support_chat.sql
--
-- The operator's side is one chat now (docs/PLATFORM_SUPPORT.md): a message
-- goes to their open conversation or starts a new one, and nobody files a
-- ticket any more. This takes out everything tickets needed and adds what
-- the chat does:
--
--   platform_support_settings  loses tickets_enabled and notify_emails.
--   platform_support_threads   loses kind, number and subject; gains the
--                              operator's rating of a conversation that
--                              ended — 1 to 5 stars and an optional comment.
--   email_templates            loses the two ticket mails.
--   mobile_app_settings        gains android_app_show_support: Super Admin
--                              hides Settings → Online support in the
--                              Android app without a new build.

ALTER TABLE public.platform_support_settings
  DROP COLUMN IF EXISTS tickets_enabled,
  DROP COLUMN IF EXISTS notify_emails;

ALTER TABLE public.platform_support_threads
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS number,
  DROP COLUMN IF EXISTS subject,
  ADD COLUMN IF NOT EXISTS rating smallint
    CONSTRAINT platform_support_threads_rating_check CHECK (rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS rating_comment text
    CONSTRAINT platform_support_threads_rating_comment_check
    CHECK (rating_comment IS NULL OR char_length(rating_comment) <= 1000),
  ADD COLUMN IF NOT EXISTS rated_at timestamptz;

DELETE FROM public.email_templates
 WHERE slug IN ('platform_support_ticket_created', 'platform_support_ticket_reply');

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS android_app_show_support boolean NOT NULL DEFAULT true;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'platform_support_threads' AND column_name IN ('kind', 'number', 'subject'))
         OR (table_name = 'platform_support_settings' AND column_name IN ('tickets_enabled', 'notify_emails')))
  ) THEN
    RAISE EXCEPTION 'platform support ticket columns still present';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'platform_support_threads'
         AND column_name IN ('rating', 'rating_comment', 'rated_at')) <> 3 THEN
    RAISE EXCEPTION 'platform support rating columns missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_templates
              WHERE slug IN ('platform_support_ticket_created', 'platform_support_ticket_reply')) THEN
    RAISE EXCEPTION 'platform support ticket mails still present';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mobile_app_settings' AND column_name = 'android_app_show_support'
  ) THEN
    RAISE EXCEPTION 'mobile_app_settings.android_app_show_support missing';
  END IF;
END $verify$;
