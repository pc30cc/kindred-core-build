-- ============================================================
-- THE NOTIFICATION EMAILS THAT WERE ONLY EVER SWITCHES
--
-- Settings → Notifications carried six email switches with nothing behind
-- them. They are being built, and this is what they need:
--
--   1. A PLATFORM ROW, so the operator sees only what the platform offers.
--      Super Admin decides which types exist at all, which email provider
--      carries them, and when the two scheduled ones go out.
--   2. A QUEUE, because these are produced by tickers and by events in the
--      middle of other requests, and neither should be sending mail inline.
--      The dedupe key is the load-bearing part: a digest must not go twice
--      because two instances ran the same minute.
--   3. THE OPERATOR'S OWN SWITCHES, in a table of their own. They were
--      columns on `user_notification_prefs`, which now carries a surface —
--      and an email is not sent to a browser or to a phone, it is sent to a
--      person. One row per operator, and no surface in sight.
--   4. TEMPLATES, in all three languages, so the copy is editable in
--      Branding → Email templates like every other email this product sends.
-- ============================================================

-- ---------- 1. what the platform offers ----------
CREATE TABLE IF NOT EXISTS public.notification_email_settings (
  -- Singleton. The CHECK is what makes it one: a second row cannot exist, so
  -- no reader has to decide which of two is current.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),

  -- The master. Off means no operator notification email is sent at all,
  -- whatever any operator has asked for.
  enabled boolean NOT NULL DEFAULT false,

  -- One per type in `services/notificationEmail/types.ts`. Columns rather
  -- than a JSON blob so that a type nobody has heard of cannot be switched
  -- on by a typo.
  unread_messages_enabled boolean NOT NULL DEFAULT false,
  transcripts_enabled boolean NOT NULL DEFAULT false,
  paid_invoices_enabled boolean NOT NULL DEFAULT false,
  weekly_summary_enabled boolean NOT NULL DEFAULT false,
  product_updates_enabled boolean NOT NULL DEFAULT false,

  -- Which provider carries these. NULL means the platform default in
  -- `app_runtime_config.default_email_provider`; a name here points at
  -- `app_runtime_config.notification_email_provider` instead, so a platform
  -- can keep its password resets on one provider and its digests on another
  -- without one's reputation dragging down the other.
  provider_override text,

  -- How long a conversation goes unanswered before the digest counts it, and
  -- how often the digest may go to one operator. Both in minutes, both with
  -- a floor: a "digest" every five minutes is not a digest.
  unread_after_minutes integer NOT NULL DEFAULT 15 CHECK (unread_after_minutes BETWEEN 5 AND 1440),
  digest_every_minutes integer NOT NULL DEFAULT 60 CHECK (digest_every_minutes BETWEEN 15 AND 1440),

  -- When the weekly summary goes out, in the operator's own timezone where
  -- they have one. 1 = Monday, matching ISO, because that is what everybody
  -- means by "the start of the week".
  weekly_summary_dow integer NOT NULL DEFAULT 1 CHECK (weekly_summary_dow BETWEEN 0 AND 6),
  weekly_summary_hour integer NOT NULL DEFAULT 8 CHECK (weekly_summary_hour BETWEEN 0 AND 23),

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Off by default, deliberately. Turning on a mail path that has never sent
-- anything should be somebody's decision, made in the admin console, not
-- something a migration does to a live platform at 3am.
INSERT INTO public.notification_email_settings (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- ---------- 2. the queue ----------
CREATE TABLE IF NOT EXISTS public.notification_email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- NULL for anything that is about the platform rather than one workspace.
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  -- Everything the template needs, already resolved. The dispatcher renders
  -- from this and never goes back to the tables a producer read: a digest
  -- describes the moment it was produced, not the moment it was sent.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The recipient's own language, decided when the job was made.
  locale text,

  -- Earliest it may be sent. Quiet hours move this forward rather than
  -- dropping the job, so a digest produced at 2am arrives at breakfast.
  scheduled_for timestamptz NOT NULL DEFAULT now(),

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  sent_at timestamptz,

  -- What stops the same mail going twice. A producer names the thing it is
  -- about — "this operator's digest for this hour", "this conversation's
  -- transcript" — and the index refuses the second one.
  dedupe_key text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_email_jobs_dedupe
  ON public.notification_email_jobs (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_notification_email_jobs_due
  ON public.notification_email_jobs (scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notification_email_jobs_user
  ON public.notification_email_jobs (user_id, type, created_at DESC);

-- Nobody but the service role reads or writes this: it holds message
-- previews and addresses, and every producer and the dispatcher run
-- server-side.
ALTER TABLE public.notification_email_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_email_settings ENABLE ROW LEVEL SECURITY;

-- ---------- 3. the operator's own switches ----------
--
-- Their own table rather than more columns on `user_notification_prefs`,
-- which carries a surface now — 'web' or 'mobile'. An email is not sent to
-- a browser or to a phone; it is sent to a person, once.
CREATE TABLE IF NOT EXISTS public.user_email_notification_prefs (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- On by default, every one of them, because the platform switch above is
  -- the one that decides whether a type exists at all. An operator who has
  -- never opened the page gets what the platform chose to offer.
  unread_messages boolean NOT NULL DEFAULT true,
  transcripts boolean NOT NULL DEFAULT true,
  paid_invoices boolean NOT NULL DEFAULT true,
  weekly_summary boolean NOT NULL DEFAULT true,
  product_updates boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_email_notification_prefs ENABLE ROW LEVEL SECURITY;

-- The old columns on `user_notification_prefs` are deliberately left where
-- they are. Dropping a column is irreversible, they cost nothing, and an
-- operator's answers from before this existed are the best seed there is:
-- carry them over, once, for anybody who had a row.
INSERT INTO public.user_email_notification_prefs (
  user_id, unread_messages, transcripts, paid_invoices, weekly_summary, product_updates
)
SELECT DISTINCT ON (user_id)
  user_id,
  COALESCE(email_unread_messages, true),
  COALESCE(email_transcripts, true),
  COALESCE(email_paid_invoices, true),
  COALESCE(email_weekly_summary, true),
  COALESCE(email_product_updates, true)
FROM public.user_notification_prefs
WHERE workspace_id IS NULL
ORDER BY user_id, updated_at DESC
ON CONFLICT (user_id) DO NOTHING;

-- ---------- 4. the copy, in three languages ----------
--
-- Seeded so the feature works the moment it is switched on, and editable in
-- Branding → Email templates like every other email. `{{brand}}` and
-- `{{year}}` are filled by `services/email/index.ts` for every template.
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active)
VALUES
  (NULL, 'operator_unread_digest', 'en',
   '{{count}} conversations are still waiting',
   '<p>Hello {{name}},</p><p>{{count}} conversation(s) in {{workspace}} have been waiting for an answer for more than {{minutes}} minutes.</p><p>{{list}}</p><p><a href="{{action_url}}">Open the inbox</a></p><p>— {{brand}}</p>',
   'Hello {{name}}, {{count}} conversation(s) in {{workspace}} have been waiting more than {{minutes}} minutes. Open the inbox: {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_unread_digest', 'fa',
   '{{count}} گفتگو هنوز منتظر پاسخ است',
   '<p>سلام {{name}}،</p><p>{{count}} گفتگو در {{workspace}} بیش از {{minutes}} دقیقه است که منتظر پاسخ مانده‌اند.</p><p>{{list}}</p><p><a href="{{action_url}}">باز کردن صندوق ورودی</a></p><p>— {{brand}}</p>',
   'سلام {{name}}، {{count}} گفتگو در {{workspace}} بیش از {{minutes}} دقیقه منتظر مانده است. صندوق ورودی: {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_unread_digest', 'tr',
   '{{count}} konuşma hâlâ yanıt bekliyor',
   '<p>Merhaba {{name}},</p><p>{{workspace}} alanındaki {{count}} konuşma {{minutes}} dakikadan uzun süredir yanıt bekliyor.</p><p>{{list}}</p><p><a href="{{action_url}}">Gelen kutusunu aç</a></p><p>— {{brand}}</p>',
   'Merhaba {{name}}, {{workspace}} alanında {{count}} konuşma {{minutes}} dakikadan uzun süredir bekliyor. Gelen kutusu: {{action_url}} — {{brand}}',
   true),

  (NULL, 'operator_conversation_transcript', 'en',
   'Transcript — {{subject}}',
   '<p>Hello {{name}},</p><p>Here is the transcript of the conversation with {{contact}} in {{workspace}}, resolved on {{resolved_at}}.</p><div>{{transcript}}</div><p><a href="{{action_url}}">Open the conversation</a></p><p>— {{brand}}</p>',
   'Transcript of the conversation with {{contact}} in {{workspace}}, resolved {{resolved_at}}. {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_conversation_transcript', 'fa',
   'متن گفتگو — {{subject}}',
   '<p>سلام {{name}}،</p><p>این متن گفتگو با {{contact}} در {{workspace}} است که در {{resolved_at}} بسته شد.</p><div>{{transcript}}</div><p><a href="{{action_url}}">باز کردن گفتگو</a></p><p>— {{brand}}</p>',
   'متن گفتگو با {{contact}} در {{workspace}}، بسته‌شده در {{resolved_at}}. {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_conversation_transcript', 'tr',
   'Konuşma dökümü — {{subject}}',
   '<p>Merhaba {{name}},</p><p>{{workspace}} alanında {{contact}} ile yapılan ve {{resolved_at}} tarihinde kapatılan konuşmanın dökümü.</p><div>{{transcript}}</div><p><a href="{{action_url}}">Konuşmayı aç</a></p><p>— {{brand}}</p>',
   '{{workspace}} alanında {{contact}} ile konuşmanın dökümü, {{resolved_at}} tarihinde kapatıldı. {{action_url}} — {{brand}}',
   true),

  (NULL, 'operator_invoice_paid', 'en',
   'Payment received — {{amount}}',
   '<p>Hello {{name}},</p><p>{{amount}} has been received for {{workspace}}{{invoice_label}}.</p><p><a href="{{action_url}}">Open billing</a></p><p>— {{brand}}</p>',
   '{{amount}} received for {{workspace}}{{invoice_label}}. {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_invoice_paid', 'fa',
   'پرداخت دریافت شد — {{amount}}',
   '<p>سلام {{name}}،</p><p>مبلغ {{amount}} برای {{workspace}}{{invoice_label}} دریافت شد.</p><p><a href="{{action_url}}">باز کردن صورتحساب‌ها</a></p><p>— {{brand}}</p>',
   'مبلغ {{amount}} برای {{workspace}}{{invoice_label}} دریافت شد. {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_invoice_paid', 'tr',
   'Ödeme alındı — {{amount}}',
   '<p>Merhaba {{name}},</p><p>{{workspace}} için {{amount}} tutarında ödeme alındı{{invoice_label}}.</p><p><a href="{{action_url}}">Faturaları aç</a></p><p>— {{brand}}</p>',
   '{{workspace}} için {{amount}} ödeme alındı{{invoice_label}}. {{action_url}} — {{brand}}',
   true),

  (NULL, 'operator_weekly_summary', 'en',
   'Your week in {{workspace}}',
   '<p>Hello {{name}},</p><p>Last week in {{workspace}}: {{conversations}} conversations, {{resolved}} resolved, {{messages}} messages answered.</p><p><a href="{{action_url}}">Open the inbox</a></p><p>— {{brand}}</p>',
   'Last week in {{workspace}}: {{conversations}} conversations, {{resolved}} resolved, {{messages}} messages. {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_weekly_summary', 'fa',
   'هفته‌ی شما در {{workspace}}',
   '<p>سلام {{name}}،</p><p>هفته‌ی گذشته در {{workspace}}: {{conversations}} گفتگو، {{resolved}} بسته‌شده، {{messages}} پیام پاسخ داده شد.</p><p><a href="{{action_url}}">باز کردن صندوق ورودی</a></p><p>— {{brand}}</p>',
   'هفته‌ی گذشته در {{workspace}}: {{conversations}} گفتگو، {{resolved}} بسته‌شده، {{messages}} پیام. {{action_url}} — {{brand}}',
   true),
  (NULL, 'operator_weekly_summary', 'tr',
   '{{workspace}} alanındaki haftanız',
   '<p>Merhaba {{name}},</p><p>Geçen hafta {{workspace}} alanında: {{conversations}} konuşma, {{resolved}} çözüldü, {{messages}} mesaj yanıtlandı.</p><p><a href="{{action_url}}">Gelen kutusunu aç</a></p><p>— {{brand}}</p>',
   'Geçen hafta {{workspace}}: {{conversations}} konuşma, {{resolved}} çözüldü, {{messages}} mesaj. {{action_url}} — {{brand}}',
   true),

  (NULL, 'operator_product_update', 'en',
   '{{title}}',
   '<p>Hello {{name}},</p><div>{{body}}</div><p>— {{brand}}</p>',
   '{{title}} — {{body}} — {{brand}}',
   true),
  (NULL, 'operator_product_update', 'fa',
   '{{title}}',
   '<p>سلام {{name}}،</p><div>{{body}}</div><p>— {{brand}}</p>',
   '{{title}} — {{body}} — {{brand}}',
   true),
  (NULL, 'operator_product_update', 'tr',
   '{{title}}',
   '<p>Merhaba {{name}},</p><div>{{body}}</div><p>— {{brand}}</p>',
   '{{title}} — {{body}} — {{brand}}',
   true)
ON CONFLICT DO NOTHING;

-- ---------- proof ----------
DO $verify$
DECLARE
  settings_rows integer;
  seeded integer;
  has_prefs boolean;
  has_dedupe boolean;
BEGIN
  SELECT count(*) INTO settings_rows FROM public.notification_email_settings;

  SELECT count(*) INTO seeded
  FROM public.email_templates
  WHERE workspace_id IS NULL
    AND slug IN (
      'operator_unread_digest', 'operator_conversation_transcript',
      'operator_invoice_paid', 'operator_weekly_summary', 'operator_product_update'
    );

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_email_notification_prefs'
  ) INTO has_prefs;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_notification_email_jobs_dedupe'
  ) INTO has_dedupe;

  IF settings_rows <> 1 THEN
    RAISE EXCEPTION 'operator notification emails: notification_email_settings must hold exactly one row, found %', settings_rows;
  END IF;
  IF seeded < 15 THEN
    RAISE EXCEPTION 'operator notification emails: expected 5 templates in 3 locales, found %', seeded;
  END IF;
  IF NOT has_prefs THEN
    RAISE EXCEPTION 'operator notification emails: user_email_notification_prefs is missing';
  END IF;
  IF NOT has_dedupe THEN
    RAISE EXCEPTION 'operator notification emails: the queue has no dedupe index, so a digest can go twice';
  END IF;

  RAISE NOTICE 'ok: notification emails have a platform switch, a queue, preferences and copy';
END
$verify$;
