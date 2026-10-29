-- 289d — Abuse limits for the mail anyone can make the platform send, and
-- the owners' offline-message mail without visitor text in its subject
-- (owner, 2026-10-29: every mail goes through whichever provider the Super
-- Admin picks, so these limits are the platform's, the same for every one).
--
-- 1. public.email_send_quota: one fixed-window counter per (scope, key),
--    taken through public.email_send_quota_take(). The backend counts with it
--    what a stranger or a member could otherwise repeat without end
--    (server/services/email/sendQuota.ts):
--      - a reset or verification link per account (one a minute, five an
--        hour), so a public form cannot mail-bomb a person;
--      - the test mails of the panel, per member and per workspace and day;
--      - invitations, per workspace and day and per inviter and hour;
--      - the owners' offline-message notices: the first capture of a
--        workspace's 15-minute window is mailed at once, the ones after it
--        are merged into one summary at the window's end, and a workspace
--        gets at most so many windows a day.
--    A counter holds a scope name, a key (an account, member or workspace
--    id) and a count: nothing anybody typed. A window that ended long ago is
--    deleted by the function itself, now and then.
-- 2. email_templates, slug offline_message_received (the owners' mail when a
--    visitor leaves a message while away): the subject the platform seeded,
--    "New offline message from {contact_name}", put what an anonymous
--    visitor typed in the Subject of a DKIM-signed platform mail. The seeded
--    subject becomes the plain "New offline message", and the seeded text
--    part is cleared, so the text part is made from the HTML, which shows the
--    visitor's words as text. The backend no longer gives the subject or the
--    text part anything a visitor typed (the HTML part gets it escaped), so
--    a subject or text the Super Admin wrote with {contact_name} shows it
--    empty. Only rows still exactly as seeded (239, with or without 283's
--    phone) are changed; a template the Super Admin rewrote stays as written.
-- 3. email_templates, new slug offline_messages_summary, both editions, fa,
--    en and tr: the summary of the window (how many more messages, and the
--    inbox link; no visitor text at all). Never overwrites an existing row.
--
-- Access: the table and the function are the backend's only (service_role):
-- RLS on with a service_role policy, nothing granted to anon or
-- authenticated; the function is SECURITY INVOKER with a pinned search_path.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations); by its migrator on RESPOK, on push. Both orders
-- are safe: without it the backend counts in its own memory (the same
-- limits, lost on a restart) and sends the summary from its built-in text;
-- with it and the older backend, the older backend's mails get the plain
-- subject and a text part made from their HTML. It drops nothing and empties
-- no table; the two template updates touch only seeded rows. Safe to run
-- twice. Dry run: wrap the file in BEGIN; … ROLLBACK; (it opens no
-- transaction of its own). Like 284 to 289b, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

-- ─── 1. The counters ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_send_quota (
  scope              text NOT NULL,
  quota_key          text NOT NULL,
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  window_ends_at     timestamptz NOT NULL,
  hits               integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, quota_key),
  CONSTRAINT email_send_quota_scope_check CHECK (length(scope) BETWEEN 1 AND 64),
  CONSTRAINT email_send_quota_key_check CHECK (length(quota_key) BETWEEN 1 AND 200),
  CONSTRAINT email_send_quota_hits_check CHECK (hits >= 0),
  CONSTRAINT email_send_quota_window_check CHECK (window_ends_at > window_started_at)
);

COMMENT ON TABLE public.email_send_quota IS
  'Fixed-window counters for the mail limits (reset and verification links per account, panel test mails, invitations, the owners'' offline-message notices). A scope, a key (an id) and a count, nothing typed by anybody. Taken through email_send_quota_take(). Server-only. Migration 289d.';

CREATE INDEX IF NOT EXISTS email_send_quota_ends_idx
  ON public.email_send_quota (window_ends_at);

DO $$
BEGIN
  ALTER TABLE public.email_send_quota ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.email_send_quota FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.email_send_quota FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.email_send_quota FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.email_send_quota TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'email_send_quota' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.email_send_quota
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- Counts one use of (scope, key) in its window and says whether it fits:
-- the window starts at the first use and lasts p_window_seconds; within it
-- the first p_max uses fit and the rest do not; after it the count starts
-- again. With p_take false nothing is counted: the answer is whether one
-- more use would fit now, and how many there were (0 once the window is
-- over). One statement per call, so two requests at once are counted one
-- after the other, never both as the first.
CREATE OR REPLACE FUNCTION public.email_send_quota_take(
  p_scope text,
  p_key text,
  p_window_seconds integer,
  p_max integer,
  p_take boolean DEFAULT true
) RETURNS TABLE (allowed boolean, used integer, started_at timestamptz, ends_at timestamptz)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 60), 1));
  v_max integer := greatest(coalesce(p_max, 0), 0);
  v_row public.email_send_quota%ROWTYPE;
BEGIN
  IF p_scope IS NULL OR length(p_scope) NOT BETWEEN 1 AND 64
     OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'email_send_quota: invalid scope or key' USING ERRCODE = '22023';
  END IF;

  IF NOT coalesce(p_take, true) THEN
    SELECT q.* INTO v_row FROM public.email_send_quota q WHERE q.scope = p_scope AND q.quota_key = p_key;
    IF NOT FOUND OR v_row.window_ends_at <= now() THEN
      RETURN QUERY SELECT v_max > 0, 0, now(), now() + v_window;
    ELSE
      RETURN QUERY SELECT v_row.hits < v_max, v_row.hits, v_row.window_started_at, v_row.window_ends_at;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.email_send_quota AS q (scope, quota_key, window_started_at, window_ends_at, hits, updated_at)
  VALUES (p_scope, p_key, now(), now() + v_window, 1, now())
  ON CONFLICT (scope, quota_key) DO UPDATE
     SET window_started_at = CASE WHEN q.window_ends_at <= now() THEN now() ELSE q.window_started_at END,
         window_ends_at    = CASE WHEN q.window_ends_at <= now() THEN now() + v_window ELSE q.window_ends_at END,
         hits              = CASE WHEN q.window_ends_at <= now() THEN 1 ELSE least(q.hits, 1000000) + 1 END,
         updated_at        = now()
  RETURNING q.* INTO v_row;

  -- Now and then, the windows that ended more than a day ago go.
  IF random() < 0.02 THEN
    DELETE FROM public.email_send_quota d
     WHERE d.ctid IN (
       SELECT o.ctid FROM public.email_send_quota o
        WHERE o.window_ends_at < now() - interval '1 day'
        LIMIT 200
     );
  END IF;

  RETURN QUERY SELECT v_row.hits <= v_max, v_row.hits, v_row.window_started_at, v_row.window_ends_at;
END;
$fn$;

COMMENT ON FUNCTION public.email_send_quota_take(text, text, integer, integer, boolean) IS
  'Counts one use of an email_send_quota counter (or, with p_take false, only reads it) and says whether it fits its fixed window. Server-only. Migration 289d.';

DO $acl$
DECLARE
  f text := 'public.email_send_quota_take(text, text, integer, integer, boolean)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $acl$;

-- ─── 2. No visitor text in the offline notice's subject ──────────────────

WITH seed(locale, old_subject, new_subject, old_text) AS (
  VALUES
    ('en', 'New offline message from {contact_name}', 'New offline message',
     'New offline message from {contact_name} ({contact_email}):' || chr(10) || chr(10) || '{message_body}'
       || chr(10) || chr(10) || 'Open this conversation in your inbox to reply.'),
    ('fa', 'پیام آفلاین جدید از {contact_name}', 'پیام آفلاین جدید',
     'پیام آفلاین جدید از {contact_name} ({contact_email}):' || chr(10) || chr(10) || '{message_body}'
       || chr(10) || chr(10) || 'برای پاسخ، این مکالمه را در صندوق ورودی باز کنید.'),
    ('tr', '{contact_name} kişisinden yeni çevrimdışı mesaj', 'Yeni çevrimdışı mesaj',
     '{contact_name} kişisinden yeni çevrimdışı mesaj ({contact_email}):' || chr(10) || chr(10) || '{message_body}'
       || chr(10) || chr(10) || 'Yanıtlamak için bu konuşmayı gelen kutusunda açın.')
)
UPDATE public.email_templates t
   SET subject = CASE WHEN t.subject = s.old_subject THEN s.new_subject ELSE t.subject END,
       -- 283 added " {contact_phone}" after the e-mail; either seeded form goes.
       text_body = CASE WHEN replace(coalesce(t.text_body, ''), ' {contact_phone})', ')') = s.old_text
                        THEN NULL ELSE t.text_body END
  FROM seed s
 WHERE t.workspace_id IS NULL
   AND t.slug = 'offline_message_received'
   AND t.locale = s.locale
   AND (t.subject = s.old_subject
        OR replace(coalesce(t.text_body, ''), ' {contact_phone})', ')') = s.old_text);

-- ─── 3. The window's summary ──────────────────────────────────────────────
-- The layout of 260's templates: header with {brand}, body, footer.
CREATE OR REPLACE FUNCTION pg_temp._email_289d_layout(p_locale text, p_title text, p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT '<!DOCTYPE html><html lang="' || p_locale || '" dir="' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || '">'
    || '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' || p_title || '</title></head>'
    || '<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Tahoma,sans-serif;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;">'
    || '<tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr>'
    || '<tr><td style="padding:40px;text-align:' || CASE WHEN p_locale = 'fa' THEN 'right' ELSE 'left' END || ';direction:' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || ';">'
    || '<h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">' || p_title || '</h2>'
    || p_body
    || '</td></tr>'
    || '<tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr>'
    || '</table></td></tr></table></body></html>'
$f$;

CREATE OR REPLACE FUNCTION pg_temp._email_289d_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_body text, p_text text
) RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_edition text;
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_289d_layout(p_locale, p_title, p_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_289d_seed('offline_messages_summary', 'fa',
  'پیام‌های آفلاین بیشتر: {count}', 'پیام‌های آفلاین بیشتر',
  '<p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:26px;">بعد از پیامی که خبرش را برایتان فرستادیم، در {minutes} دقیقه‌ی بعد {count} پیام دیگر هم رسید.</p>'
  || '<p style="margin:0;"><a href="{action_url}" style="display:inline-block;padding:10px 20px;background:#3B82F6;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;">باز کردن صندوق ورودی</a></p>',
  'بعد از پیامی که خبرش را برایتان فرستادیم، در {minutes} دقیقه‌ی بعد {count} پیام دیگر هم رسید.' || chr(10) || chr(10)
  || 'صندوق ورودی: {action_url}');
SELECT pg_temp._email_289d_seed('offline_messages_summary', 'en',
  'More offline messages: {count}', 'More offline messages',
  '<p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:24px;">After the message we told you about, {count} more arrived in the next {minutes} minutes.</p>'
  || '<p style="margin:0;"><a href="{action_url}" style="display:inline-block;padding:10px 20px;background:#3B82F6;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;">Open the inbox</a></p>',
  'After the message we told you about, {count} more arrived in the next {minutes} minutes.' || chr(10) || chr(10)
  || 'Inbox: {action_url}');
SELECT pg_temp._email_289d_seed('offline_messages_summary', 'tr',
  'Daha fazla çevrimdışı mesaj: {count}', 'Daha fazla çevrimdışı mesaj',
  '<p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:24px;">Size bildirdiğimiz mesajdan sonraki {minutes} dakika içinde {count} mesaj daha geldi.</p>'
  || '<p style="margin:0;"><a href="{action_url}" style="display:inline-block;padding:10px 20px;background:#3B82F6;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;">Gelen kutusunu aç</a></p>',
  'Size bildirdiğimiz mesajdan sonraki {minutes} dakika içinde {count} mesaj daha geldi.' || chr(10) || chr(10)
  || 'Gelen kutusu: {action_url}');

RESET lock_timeout;
