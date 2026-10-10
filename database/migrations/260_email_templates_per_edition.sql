-- 260 — Email templates are kept per edition.
--
-- Every email the platform sends is a Super Admin template (Branding →
-- Email templates). One codebase runs two editions (shared/edition.ts):
-- Iran (WebYar) and International (RESPOK). Until now email_templates had one
-- platform row per (slug, locale), so in one database both editions read the
-- same text: a region_mode switch served RESPOK's customers WebYar's mails or
-- the other way round. Production keeps the two brands in separate databases,
-- so it never showed; the rule is now in the schema.
--
--   email_templates gains `edition` ('iran' | 'international'), filled from
--   public.platform_edition() (257) — the edition the database runs — and
--   defaulting to it, so code that does not name the edition keeps working.
--   Platform rows are unique per (edition, slug, locale).
--
-- Each edition gets the other's rows copied once where it has none, so a
-- region_mode switch never finds an edition without templates; the Super
-- Admin then edits that edition's own copy. Rows that already have an
-- edition are never moved.
--
-- New templates, seeded for both editions in fa/en/tr, never overwriting an
-- edited row:
--   verification_code   the e-mail one-time code (sign-up, order lookup);
--                       its text used to be compiled into the server
--   email_test          the "your email provider works" test mail
--
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. The edition column ────────────────────────────────────────────────
ALTER TABLE public.email_templates ADD COLUMN IF NOT EXISTS edition text;

UPDATE public.email_templates SET edition = public.platform_edition() WHERE edition IS NULL;

ALTER TABLE public.email_templates ALTER COLUMN edition SET DEFAULT public.platform_edition();
ALTER TABLE public.email_templates ALTER COLUMN edition SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_templates_edition_check') THEN
    ALTER TABLE public.email_templates
      ADD CONSTRAINT email_templates_edition_check CHECK (edition IN ('iran', 'international'));
  END IF;
END $$;

COMMENT ON COLUMN public.email_templates.edition IS
  'The edition this template belongs to (shared/edition.ts). The server sends only the running edition''s templates; Super Admin edits only those.';

-- ─── 2. One platform row per (edition, slug, locale) ──────────────────────
DO $$
DECLARE
  v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.email_templates
     WHERE workspace_id IS NULL
     GROUP BY edition, slug, locale
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION '260: % duplicated platform email templates (edition, slug, locale); resolve them first', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_templates_platform_edition_slug_locale
  ON public.email_templates (edition, slug, locale) WHERE workspace_id IS NULL;

-- ─── 3. Each edition has every template ───────────────────────────────────
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
SELECT NULL, t.slug, t.locale, t.subject, t.html_body, t.text_body, t.is_active,
       CASE t.edition WHEN 'iran' THEN 'international' ELSE 'iran' END
  FROM public.email_templates t
 WHERE t.workspace_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.email_templates o
      WHERE o.workspace_id IS NULL
        AND o.slug = t.slug
        AND o.locale = t.locale
        AND o.edition = CASE t.edition WHEN 'iran' THEN 'international' ELSE 'iran' END
   );

-- ─── 4. New templates ─────────────────────────────────────────────────────
-- A layout like the existing templates': header with {brand}, body, footer.
CREATE OR REPLACE FUNCTION pg_temp._email_260_layout(p_locale text, p_title text, p_body text)
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

CREATE OR REPLACE FUNCTION pg_temp._email_260_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_body text, p_text text
) RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_edition text;
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_260_layout(p_locale, p_title, p_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_260_seed('verification_code', 'fa',
  'کد تأیید شما: {code} — {brand}', 'کد تأیید شما',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">کد تأیید شما:</p>'
  || '<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:6px;color:#1e293b;direction:ltr;text-align:center;">{code}</p>'
  || '<p style="margin:0;color:#94a3b8;font-size:13px;">این کد تا {minutes} دقیقه‌ی دیگر معتبر است. اگر شما درخواست نداده‌اید، این ایمیل را نادیده بگیرید.</p>',
  'کد تأیید: {code}' || chr(10) || 'این کد تا {minutes} دقیقه‌ی دیگر معتبر است.');
SELECT pg_temp._email_260_seed('verification_code', 'en',
  'Your verification code: {code} — {brand}', 'Your verification code',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your verification code:</p>'
  || '<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:6px;color:#1e293b;text-align:center;">{code}</p>'
  || '<p style="margin:0;color:#94a3b8;font-size:13px;">This code expires in {minutes} minutes. If you did not ask for it, you can ignore this email.</p>',
  'Verification code: {code}' || chr(10) || 'This code expires in {minutes} minutes.');
SELECT pg_temp._email_260_seed('verification_code', 'tr',
  'Doğrulama kodunuz: {code} — {brand}', 'Doğrulama kodunuz',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Doğrulama kodunuz:</p>'
  || '<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:6px;color:#1e293b;text-align:center;">{code}</p>'
  || '<p style="margin:0;color:#94a3b8;font-size:13px;">Bu kod {minutes} dakika geçerlidir. Bu kodu siz istemediyseniz bu e-postayı yok sayabilirsiniz.</p>',
  'Doğrulama kodu: {code}' || chr(10) || 'Bu kod {minutes} dakika geçerlidir.');

SELECT pg_temp._email_260_seed('email_test', 'fa',
  'ایمیل آزمایشی — {brand}', 'ارسال ایمیل درست کار می‌کند',
  '<p style="margin:0;color:#475569;font-size:15px;line-height:24px;">این یک ایمیل آزمایشی است. سرویس ارسال ایمیل به‌درستی تنظیم شده است.</p>',
  'این یک ایمیل آزمایشی است. سرویس ارسال ایمیل به‌درستی تنظیم شده است.');
SELECT pg_temp._email_260_seed('email_test', 'en',
  'Test email — {brand}', 'Email delivery works',
  '<p style="margin:0;color:#475569;font-size:15px;line-height:24px;">This is a test email. The email provider is configured correctly.</p>',
  'This is a test email. The email provider is configured correctly.');
SELECT pg_temp._email_260_seed('email_test', 'tr',
  'Test e-postası — {brand}', 'E-posta gönderimi çalışıyor',
  '<p style="margin:0;color:#475569;font-size:15px;line-height:24px;">Bu bir test e-postasıdır. E-posta sağlayıcısı doğru yapılandırılmış.</p>',
  'Bu bir test e-postasıdır. E-posta sağlayıcısı doğru yapılandırılmış.');
