-- Platform support: any operator reaches the platform's own team.
-- Self-host mirror: database/migrations/242_platform_support.sql
--
-- An operator of ANY workspace opens Settings → Support in an app and talks to
-- the team that runs the platform. The team answers from an ordinary
-- workspace — the one Super Admin → Core settings → Support names — so every
-- message is a conversation in that workspace's inbox, with the operator as
-- its contact, and the team works it with the tools it already has.
--
--   platform_support_settings  the singleton switch: on/off, which workspace
--                              answers, whether tickets may be filed while
--                              nobody is available, and who else is mailed.
--   platform_support_threads   one row per support conversation, linking it
--                              to the operator who opened it: a live `chat`
--                              or an offline `ticket` with a subject and a
--                              number. Reads for the operator go through
--                              this table, never through the support
--                              workspace's membership.
--
-- Both tables are server-only (RLS on, no policies, no anon/authenticated
-- grants): the Express backend is their only reader and writer.

CREATE TABLE IF NOT EXISTS public.platform_support_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  tickets_enabled boolean NOT NULL DEFAULT true,
  notify_emails text[] NOT NULL DEFAULT '{}'::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

INSERT INTO public.platform_support_settings (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.platform_support_threads (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  support_workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('chat', 'ticket')),
  number bigint GENERATED ALWAYS AS IDENTITY,
  subject text CHECK (subject IS NULL OR char_length(subject) <= 200),
  user_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_support_threads_number_key UNIQUE (number)
);

CREATE INDEX IF NOT EXISTS idx_platform_support_threads_user
  ON public.platform_support_threads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_support_threads_support_workspace
  ON public.platform_support_threads (support_workspace_id);

ALTER TABLE public.platform_support_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_support_threads ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_support_settings', 'platform_support_threads'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

-- The two mails a ticket sends, editable afterwards in Super Admin →
-- Branding → Email templates. Values are interpolated by
-- server/services/email/index.ts; the sender escapes whatever a person typed.
CREATE OR REPLACE FUNCTION public._seed_platform_support_email(
  p_slug        TEXT,
  p_locale      TEXT,
  p_subject     TEXT,
  p_title       TEXT,
  p_intro       TEXT,
  p_quote_label TEXT,
  p_quote       TEXT,
  p_cta         TEXT,
  p_text        TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_rtl   BOOLEAN := (p_locale = 'fa');
  v_dir   TEXT := CASE WHEN v_rtl THEN 'rtl' ELSE 'ltr' END;
  v_align TEXT := CASE WHEN v_rtl THEN 'right' ELSE 'left' END;
  v_html  TEXT;
BEGIN
  v_html :=
    '<!DOCTYPE html><html lang="' || p_locale || '" dir="' || v_dir || '"><head><meta charset="utf-8">' ||
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' || p_title || '</title></head>' ||
    '<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;">' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;">' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;">' ||
    '<tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;">' ||
    '<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr>' ||
    '<tr><td style="padding:40px 40px 16px;text-align:' || v_align || ';">' ||
    '<h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">' || p_title || '</h2>' ||
    '<p style="margin:0;color:#475569;font-size:15px;line-height:24px;">' || p_intro || '</p></td></tr>' ||
    '<tr><td style="padding:8px 40px 0;text-align:' || v_align || ';">' ||
    '<p style="margin:0 0 8px;color:#64748b;font-size:13px;">' || p_quote_label || '</p>' ||
    '<div dir="auto" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;color:#1e293b;font-size:15px;line-height:24px;white-space:pre-wrap;">' ||
    p_quote || '</div></td></tr>' ||
    '<tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">' ||
    p_cta || '</a></td></tr>' ||
    '<tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">' ||
    '<p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr>' ||
    '</table></td></tr></table></body></html>';

  DELETE FROM public.email_templates
   WHERE workspace_id IS NULL AND slug = p_slug AND locale = p_locale;

  INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active)
  VALUES (NULL, p_slug, p_locale, p_subject, v_html, p_text, TRUE);
END;
$$;

DO $seed$
BEGIN
  -- ── platform_support_ticket_created: to the support team ─────────────
  PERFORM public._seed_platform_support_email('platform_support_ticket_created', 'en',
    'New support ticket #{ticket_number} from {requester_name} — {brand}',
    'New support ticket',
    '{requester_name} ({requester_email}) of the workspace “{workspace_name}” filed ticket #{ticket_number}: {subject}',
    'Message', '{message}',
    'Open in the inbox',
    E'{requester_name} ({requester_email}) of the workspace “{workspace_name}” filed ticket #{ticket_number}: {subject}\n\n{message}\n\n{action_url}');
  PERFORM public._seed_platform_support_email('platform_support_ticket_created', 'fa',
    'تیکت پشتیبانی جدید #{ticket_number} از {requester_name} — {brand}',
    'تیکت پشتیبانی جدید',
    '{requester_name} ({requester_email}) از فضای کاری «{workspace_name}» تیکت #{ticket_number} را ثبت کرد: {subject}',
    'پیام', '{message}',
    'مشاهده در صندوق',
    E'{requester_name} ({requester_email}) از فضای کاری «{workspace_name}» تیکت #{ticket_number} را ثبت کرد: {subject}\n\n{message}\n\n{action_url}');
  PERFORM public._seed_platform_support_email('platform_support_ticket_created', 'tr',
    'Yeni destek talebi #{ticket_number}: {requester_name} — {brand}',
    'Yeni destek talebi',
    '“{workspace_name}” çalışma alanından {requester_name} ({requester_email}) #{ticket_number} numaralı talebi oluşturdu: {subject}',
    'Mesaj', '{message}',
    'Gelen kutusunda aç',
    E'“{workspace_name}” çalışma alanından {requester_name} ({requester_email}) #{ticket_number} numaralı talebi oluşturdu: {subject}\n\n{message}\n\n{action_url}');

  -- ── platform_support_ticket_reply: to the operator who filed it ──────
  PERFORM public._seed_platform_support_email('platform_support_ticket_reply', 'en',
    'Reply to your support ticket #{ticket_number} — {brand}',
    'Your ticket has a reply',
    '{agent_name} replied to your ticket #{ticket_number}: {subject}',
    'Reply', '{reply}',
    'Open support',
    E'{agent_name} replied to your ticket #{ticket_number}: {subject}\n\n{reply}\n\n{action_url}');
  PERFORM public._seed_platform_support_email('platform_support_ticket_reply', 'fa',
    'پاسخ به تیکت پشتیبانی #{ticket_number} — {brand}',
    'تیکت شما پاسخ داده شد',
    '{agent_name} به تیکت #{ticket_number} شما پاسخ داد: {subject}',
    'پاسخ', '{reply}',
    'مشاهدهٔ پشتیبانی',
    E'{agent_name} به تیکت #{ticket_number} شما پاسخ داد: {subject}\n\n{reply}\n\n{action_url}');
  PERFORM public._seed_platform_support_email('platform_support_ticket_reply', 'tr',
    'Destek talebinize yanıt #{ticket_number} — {brand}',
    'Talebiniz yanıtlandı',
    '{agent_name}, #{ticket_number} numaralı talebinizi yanıtladı: {subject}',
    'Yanıt', '{reply}',
    'Desteği aç',
    E'{agent_name}, #{ticket_number} numaralı talebinizi yanıtladı: {subject}\n\n{reply}\n\n{action_url}');
END $seed$;

DROP FUNCTION public._seed_platform_support_email(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

DO $verify$
BEGIN
  IF to_regclass('public.platform_support_settings') IS NULL
     OR to_regclass('public.platform_support_threads') IS NULL THEN
    RAISE EXCEPTION 'platform support tables missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_support_settings WHERE id) THEN
    RAISE EXCEPTION 'platform support settings row missing';
  END IF;
  IF (SELECT count(*) FROM public.email_templates
       WHERE workspace_id IS NULL
         AND slug IN ('platform_support_ticket_created', 'platform_support_ticket_reply')) <> 6 THEN
    RAISE EXCEPTION 'platform support email templates missing';
  END IF;
END $verify$;
