-- 291 — The content of every email the platform sends, rewritten for the new
-- email layout (owner, 2026-10-30: new, well-made templates for both brands
-- that stay out of spam, a template for every email, and no email without
-- one).
--
-- From this release the email core wraps every platform mail in one layout
-- when it sends it (server/services/email/layout.ts): the brand band with
-- the logo, the card, and under it the footer with the brand's links, the
-- legal line and, for a notification, its unsubscribe line. A template row
-- now holds only its content, in the vocabulary that layout styles: a hidden
-- preview line (div.preheader), one h1, p, p.note, a button (p.action with
-- one link), the one-time code (div.code), a summary (table.details with th
-- and td rows), a quoted message (blockquote), callouts (div.warning,
-- div.notice) and a chat transcript (div.transcript, whose rows the sender
-- builds). A row that is still a whole document (it has <html) is sent as it
-- is, so a design a Super Admin wrote in full keeps working.
--
-- 1. The 28 slugs the code sends get a new subject, HTML and text part in
--    fa, en and tr: email_verify, password_reset, verification_code,
--    invite_otp, invite_member, email_test, visitor_conversation_transcript,
--    offline_message_received, offline_messages_summary, the five operator_*
--    notices and the 14 billing_* mails. The words are the same in both
--    editions; {brand} names the edition's brand. Each prints only the keys
--    its sender fills, plus the core's {brand}, {year} and {support_email}
--    (invite_member's {expiry} and localized {role}, and email_test's
--    {provider}, {slot} and {sent_at}, are filled from this release on); the
--    operator_* rows keep their {{double}} placeholders. Every row has a
--    hand-written text part but offline_message_received, whose text part is
--    still made from its HTML: the visitor's words reach a mail only through
--    the HTML part, escaped (289d).
-- 2. A row is replaced only while it is exactly as the chain seeded it: its
--    md5(subject || html_body || coalesce(text_body, '')) must be the value
--    measured by applying every migration up to 289g on an empty database
--    (both editions seed the same text, so there is one value per slug and
--    language). A row a Super Admin changed is kept as written and named in a
--    NOTICE, and so is a sent row that is switched off (it is replaced, and
--    stays off). On 2026-10-30 all 276 platform rows of both brands'
--    databases matched the fresh chain. A missing row of a sent slug is added
--    for its edition and language, never over an existing one.
-- 3. The slugs nothing sends any more (magic_link, welcome, new_conversation,
--    task_assigned, account_expiry, system_alert, invoice_*, payment_*,
--    subscription_*, wallet_autopay_insufficient) are not touched; the
--    Branding tab lists them as no longer sent.
--
-- Checked by src/test/integration/emailTemplatesRedesign291.pg.test.ts (the
-- whole chain): every sent slug has its six rows, each content only and
-- printing no key its sender does not fill; an edited row is kept and named;
-- a second run changes nothing.
--
-- Rollout: on WebYar by hand, AFTER the backend that wraps content rows is
-- live (CLAUDE.md, Migrations; as 283 and 286 were): that backend sends the
-- old whole-document rows unchanged, while an older backend would send a
-- content row as a bare fragment, so this order never sends a mail without
-- its layout. On RESPOK by its migrator on push; its backend is deployed in
-- the same round, so for the minutes between the two a mail may go out bare
-- but complete. It deletes nothing and changes no table's shape. Safe to run
-- twice: a replaced row is no longer as seeded, and a second run neither
-- changes nor names it. Dry run: wrap the file in BEGIN; … ROLLBACK; (it
-- opens no transaction of its own) and read its NOTICEs. Like 284 to 289d,
-- it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

-- ─── 1. The new content, and the hash of each row as the chain seeded it ──

-- A table of this session only; one left by a failed run before is replaced.
DO $drop$
BEGIN
  IF to_regclass('pg_temp._email_291') IS NOT NULL THEN
    DROP TABLE pg_temp._email_291;
  END IF;
END
$drop$;
CREATE TEMP TABLE _email_291 (
  slug        text NOT NULL,
  locale      text NOT NULL,
  -- md5(subject || html_body || coalesce(text_body, '')) of the row as the
  -- chain up to 289g seeds it, the same in both editions.
  seeded_md5  text NOT NULL,
  subject     text NOT NULL,
  html_body   text NOT NULL,
  text_body   text,
  PRIMARY KEY (slug, locale)
);

INSERT INTO pg_temp._email_291 (slug, locale, seeded_md5, subject, html_body, text_body) VALUES
  -- email_verify (fa)
  ('email_verify', 'fa', 'ed33313dd76bb631970ccd6036836827',
     'تأیید نشانی ایمیل — {brand}',
     '<div class="preheader">یک قدم مانده تا حساب شما در {brand} فعال شود. این لینک تا {expiry_time} معتبر است.</div>'
     || '<h1>ایمیل خود را تأیید کنید</h1>'
     || '<p>سلام {name}،</p>'
     || '<p>از ثبت‌نام شما در {brand} خوشحالیم. برای فعال شدن حساب، تأیید کنید که {email} نشانی ایمیل شماست.</p>'
     || '<p class="action"><a href="{action_url}">تأیید ایمیل</a></p>'
     || '<p class="note">این لینک تا {expiry_time} معتبر است. اگر شما در {brand} ثبت‌نام نکرده‌اید، این ایمیل را نادیده بگیرید؛ بدون تأیید، هیچ حسابی فعال نمی‌شود.</p>'
     || '<p class="note">اگر دکمه کار نکرد، این نشانی را در مرورگر باز کنید:<br><a href="{action_url}">{action_url}</a></p>',
     'سلام {name}،'
     || chr(10) || chr(10) || 'از ثبت‌نام شما در {brand} خوشحالیم. برای فعال شدن حساب، تأیید کنید که {email} نشانی ایمیل شماست. این لینک را در مرورگر باز کنید:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'این لینک تا {expiry_time} معتبر است. اگر شما در {brand} ثبت‌نام نکرده‌اید، این ایمیل را نادیده بگیرید؛ بدون تأیید، هیچ حسابی فعال نمی‌شود.'),
  -- email_verify (en)
  ('email_verify', 'en', 'ea42f9379622adeee77e5d704abd4f7b',
     'Confirm your email address — {brand}',
     '<div class="preheader">One step left to activate your {brand} account. The link works for {expiry_time}.</div>'
     || '<h1>Confirm your email</h1>'
     || '<p>Hi {name},</p>'
     || '<p>Thanks for signing up for {brand}. To activate your account, confirm that {email} is your email address.</p>'
     || '<p class="action"><a href="{action_url}">Confirm email</a></p>'
     || '<p class="note">The link works for {expiry_time}. If you didn’t sign up for {brand}, you can ignore this email; no account is activated without it.</p>'
     || '<p class="note">If the button doesn’t work, open this address in your browser:<br><a href="{action_url}">{action_url}</a></p>',
     'Hi {name},'
     || chr(10) || chr(10) || 'Thanks for signing up for {brand}. To activate your account, confirm that {email} is your email address by opening this link:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'The link works for {expiry_time}. If you didn’t sign up for {brand}, you can ignore this email; no account is activated without it.'),
  -- email_verify (tr)
  ('email_verify', 'tr', '42556c2bd487d3a0895a932041977749',
     'E-posta adresinizi doğrulayın — {brand}',
     '<div class="preheader">{brand} hesabınızı etkinleştirmeye bir adım kaldı. Bağlantı {expiry_time} geçerli.</div>'
     || '<h1>E-postanızı doğrulayın</h1>'
     || '<p>Merhaba {name},</p>'
     || '<p>{brand} hesabı açtığınız için teşekkür ederiz. Hesabınızı etkinleştirmek için {email} adresinin size ait olduğunu doğrulayın.</p>'
     || '<p class="action"><a href="{action_url}">E-postayı doğrula</a></p>'
     || '<p class="note">Bağlantı {expiry_time} geçerlidir. {brand} hesabı açmadıysanız bu e-postayı yok sayabilirsiniz; doğrulama olmadan hiçbir hesap etkinleşmez.</p>'
     || '<p class="note">Düğme çalışmazsa bu adresi tarayıcınızda açın:<br><a href="{action_url}">{action_url}</a></p>',
     'Merhaba {name},'
     || chr(10) || chr(10) || '{brand} hesabı açtığınız için teşekkür ederiz. Hesabınızı etkinleştirmek için {email} adresinin size ait olduğunu bu bağlantıyı açarak doğrulayın:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'Bağlantı {expiry_time} geçerlidir. {brand} hesabı açmadıysanız bu e-postayı yok sayabilirsiniz; doğrulama olmadan hiçbir hesap etkinleşmez.'),
  -- password_reset (fa)
  ('password_reset', 'fa', '2619d8618d86244a6e48c87e5126f77c',
     'بازنشانی رمز عبور — {brand}',
     '<div class="preheader">برای انتخاب رمز تازه تا {expiry_time} فرصت دارید.</div>'
     || '<h1>بازنشانی رمز عبور</h1>'
     || '<p>سلام {name}،</p>'
     || '<p>درخواستی برای بازنشانی رمز عبور حساب {email} در {brand} به ما رسید. برای انتخاب رمز تازه، روی دکمهٔ زیر بزنید.</p>'
     || '<p class="action"><a href="{action_url}">انتخاب رمز تازه</a></p>'
     || '<p class="note">این لینک تا {expiry_time} معتبر است. اگر شما این درخواست را نداده‌اید، کاری لازم نیست؛ رمز فعلی شما تغییر نمی‌کند.</p>'
     || '<p class="note">اگر دکمه کار نکرد، این نشانی را در مرورگر باز کنید:<br><a href="{action_url}">{action_url}</a></p>',
     'سلام {name}،'
     || chr(10) || chr(10) || 'درخواستی برای بازنشانی رمز عبور حساب {email} در {brand} به ما رسید. برای انتخاب رمز تازه، این لینک را در مرورگر باز کنید:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'این لینک تا {expiry_time} معتبر است. اگر شما این درخواست را نداده‌اید، کاری لازم نیست؛ رمز فعلی شما تغییر نمی‌کند.'),
  -- password_reset (en)
  ('password_reset', 'en', 'd64cc3a2f74d24128e212e11f869ea80',
     'Reset your password — {brand}',
     '<div class="preheader">You have {expiry_time} to choose a new password.</div>'
     || '<h1>Reset your password</h1>'
     || '<p>Hi {name},</p>'
     || '<p>We received a request to reset the password for {email} on {brand}. Choose a new one with the button below.</p>'
     || '<p class="action"><a href="{action_url}">Choose a new password</a></p>'
     || '<p class="note">The link works for {expiry_time}. If you didn’t ask for this, you don’t need to do anything; your current password stays the same.</p>'
     || '<p class="note">If the button doesn’t work, open this address in your browser:<br><a href="{action_url}">{action_url}</a></p>',
     'Hi {name},'
     || chr(10) || chr(10) || 'We received a request to reset the password for {email} on {brand}. To choose a new one, open this link:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'The link works for {expiry_time}. If you didn’t ask for this, you don’t need to do anything; your current password stays the same.'),
  -- password_reset (tr)
  ('password_reset', 'tr', 'c175bade8108ba87dfd22368c1f84357',
     'Şifrenizi sıfırlayın — {brand}',
     '<div class="preheader">Yeni bir şifre seçmek için {expiry_time} süreniz var.</div>'
     || '<h1>Şifrenizi sıfırlayın</h1>'
     || '<p>Merhaba {name},</p>'
     || '<p>{brand} üzerindeki {email} hesabının şifresini sıfırlama isteği aldık. Yeni şifrenizi aşağıdaki düğmeyle seçebilirsiniz.</p>'
     || '<p class="action"><a href="{action_url}">Yeni şifre seç</a></p>'
     || '<p class="note">Bağlantı {expiry_time} geçerlidir. Bu isteği siz yapmadıysanız bir şey yapmanız gerekmez; mevcut şifreniz değişmez.</p>'
     || '<p class="note">Düğme çalışmazsa bu adresi tarayıcınızda açın:<br><a href="{action_url}">{action_url}</a></p>',
     'Merhaba {name},'
     || chr(10) || chr(10) || '{brand} üzerindeki {email} hesabının şifresini sıfırlama isteği aldık. Yeni şifrenizi seçmek için bu bağlantıyı açın:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'Bağlantı {expiry_time} geçerlidir. Bu isteği siz yapmadıysanız bir şey yapmanız gerekmez; mevcut şifreniz değişmez.'),
  -- verification_code (fa)
  ('verification_code', 'fa', '676baade1cfae556842af4ae1d45b0e7',
     '{code} — کد تأیید {brand}',
     '<div class="preheader">این کد تا {minutes} دقیقه معتبر است؛ آن را به کسی ندهید.</div>'
     || '<h1>کد تأیید شما</h1>'
     || '<p>برای ادامه، این کد را در صفحه‌ای که باز است وارد کنید:</p>'
     || '<div class="code">{code}</div>'
     || '<p class="note">این کد تا {minutes} دقیقهٔ دیگر معتبر است. آن را به هیچ‌کس ندهید. اگر شما درخواست نداده‌اید، این ایمیل را نادیده بگیرید.</p>',
     'کد تأیید شما: {code}'
     || chr(10) || chr(10) || 'برای ادامه، این کد را در صفحه‌ای که باز است وارد کنید. این کد تا {minutes} دقیقهٔ دیگر معتبر است؛ آن را به هیچ‌کس ندهید. اگر شما درخواست نداده‌اید، این ایمیل را نادیده بگیرید.'),
  -- verification_code (en)
  ('verification_code', 'en', '0dddd91751e138738e4aa143a0903e44',
     '{code} is your {brand} verification code',
     '<div class="preheader">It expires in {minutes} minutes. Don’t share it with anyone.</div>'
     || '<h1>Your verification code</h1>'
     || '<p>To continue, enter this code on the page you have open:</p>'
     || '<div class="code">{code}</div>'
     || '<p class="note">The code expires in {minutes} minutes. Don’t share it with anyone. If you didn’t ask for it, you can ignore this email.</p>',
     'Your verification code: {code}'
     || chr(10) || chr(10) || 'To continue, enter this code on the page you have open. It expires in {minutes} minutes; don’t share it with anyone. If you didn’t ask for it, you can ignore this email.'),
  -- verification_code (tr)
  ('verification_code', 'tr', 'f2d53f778a55a73fd60c19a7e8498d3b',
     '{code} — {brand} doğrulama kodunuz',
     '<div class="preheader">Kod {minutes} dakika geçerli. Kimseyle paylaşmayın.</div>'
     || '<h1>Doğrulama kodunuz</h1>'
     || '<p>Devam etmek için bu kodu açık olan sayfaya girin:</p>'
     || '<div class="code">{code}</div>'
     || '<p class="note">Kod {minutes} dakika geçerlidir. Kimseyle paylaşmayın. Bu kodu siz istemediyseniz bu e-postayı yok sayabilirsiniz.</p>',
     'Doğrulama kodunuz: {code}'
     || chr(10) || chr(10) || 'Devam etmek için bu kodu açık olan sayfaya girin. Kod {minutes} dakika geçerlidir; kimseyle paylaşmayın. Bu kodu siz istemediyseniz bu e-postayı yok sayabilirsiniz.'),
  -- invite_otp (fa)
  ('invite_otp', 'fa', 'dd6a129170e9aa4c15874ae774239546',
     '{code} — کد تأیید دعوت {brand}',
     '<div class="preheader">برای پذیرفتن دعوت، این کد را تا {expiry_minutes} دقیقهٔ دیگر وارد کنید.</div>'
     || '<h1>کد تأیید دعوت</h1>'
     || '<p>برای پذیرفتن دعوت و پیوستن به تیم، این کد را در صفحه‌ای که باز است وارد کنید:</p>'
     || '<div class="code">{code}</div>'
     || '<p class="note">این کد تا {expiry_minutes} دقیقهٔ دیگر معتبر است. آن را به هیچ‌کس ندهید. اگر منتظر دعوتی نبوده‌اید، این ایمیل را نادیده بگیرید.</p>',
     'کد تأیید دعوت: {code}'
     || chr(10) || chr(10) || 'برای پذیرفتن دعوت و پیوستن به تیم، این کد را در صفحه‌ای که باز است وارد کنید. این کد تا {expiry_minutes} دقیقهٔ دیگر معتبر است؛ آن را به هیچ‌کس ندهید. اگر منتظر دعوتی نبوده‌اید، این ایمیل را نادیده بگیرید.'),
  -- invite_otp (en)
  ('invite_otp', 'en', '196d90c23fd87440050f4e3f6d3099ea',
     '{code} is your {brand} invitation code',
     '<div class="preheader">Enter it within {expiry_minutes} minutes to accept the invitation.</div>'
     || '<h1>Your invitation code</h1>'
     || '<p>To accept the invitation and join the team, enter this code on the page you have open:</p>'
     || '<div class="code">{code}</div>'
     || '<p class="note">The code expires in {expiry_minutes} minutes. Don’t share it with anyone. If you weren’t expecting an invitation, you can ignore this email.</p>',
     'Your invitation code: {code}'
     || chr(10) || chr(10) || 'To accept the invitation and join the team, enter this code on the page you have open. It expires in {expiry_minutes} minutes; don’t share it with anyone. If you weren’t expecting an invitation, you can ignore this email.'),
  -- invite_otp (tr)
  ('invite_otp', 'tr', 'e2ca4514f0dc268646a281b826052a6b',
     '{code} — {brand} davet kodunuz',
     '<div class="preheader">Daveti kabul etmek için kodu {expiry_minutes} dakika içinde girin.</div>'
     || '<h1>Davet kodunuz</h1>'
     || '<p>Daveti kabul edip ekibe katılmak için bu kodu açık olan sayfaya girin:</p>'
     || '<div class="code">{code}</div>'
     || '<p class="note">Kod {expiry_minutes} dakika geçerlidir. Kimseyle paylaşmayın. Bir davet beklemiyorsanız bu e-postayı yok sayabilirsiniz.</p>',
     'Davet kodunuz: {code}'
     || chr(10) || chr(10) || 'Daveti kabul edip ekibe katılmak için bu kodu açık olan sayfaya girin. Kod {expiry_minutes} dakika geçerlidir; kimseyle paylaşmayın. Bir davet beklemiyorsanız bu e-postayı yok sayabilirsiniz.'),
  -- invite_member (fa)
  ('invite_member', 'fa', 'c9a8f8c3d4aca4c92d94ce66470b784e',
     'دعوت به {workspace} — {brand}',
     '<div class="preheader">{inviter} شما را با نقش {role} به تیم دعوت کرده است. این دعوت تا {expiry} معتبر است.</div>'
     || '<h1>به {workspace} بپیوندید</h1>'
     || '<p>سلام {name}،</p>'
     || '<p><strong>{inviter}</strong> شما را دعوت کرده است تا با نقش {role} به فضای کاری <strong>{workspace}</strong> در {brand} بپیوندید.</p>'
     || '<p class="action"><a href="{action_url}">پذیرش دعوت</a></p>'
     || '<p class="note">این دعوت تا {expiry} معتبر است. اگر انتظار این دعوت را نداشتید، می‌توانید این ایمیل را نادیده بگیرید.</p>'
     || '<p class="note">اگر دکمه کار نکرد، این نشانی را در مرورگر باز کنید:<br><a href="{action_url}">{action_url}</a></p>',
     'سلام {name}،'
     || chr(10) || chr(10) || '{inviter} شما را دعوت کرده است تا با نقش {role} به فضای کاری «{workspace}» در {brand} بپیوندید. برای پذیرش دعوت، این لینک را باز کنید:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'این دعوت تا {expiry} معتبر است. اگر انتظار این دعوت را نداشتید، می‌توانید این ایمیل را نادیده بگیرید.'),
  -- invite_member (en)
  ('invite_member', 'en', 'f0427dfbd95f8afb5af0b4ef54de4534',
     'You’re invited to {workspace} — {brand}',
     '<div class="preheader">{inviter} invited you to join the team as {role}. The invitation is valid until {expiry}.</div>'
     || '<h1>Join {workspace}</h1>'
     || '<p>Hi {name},</p>'
     || '<p><strong>{inviter}</strong> invited you to join the <strong>{workspace}</strong> workspace on {brand} as {role}.</p>'
     || '<p class="action"><a href="{action_url}">Accept invitation</a></p>'
     || '<p class="note">The invitation is valid until {expiry}. If you weren’t expecting it, you can ignore this email.</p>'
     || '<p class="note">If the button doesn’t work, open this address in your browser:<br><a href="{action_url}">{action_url}</a></p>',
     'Hi {name},'
     || chr(10) || chr(10) || '{inviter} invited you to join the {workspace} workspace on {brand} as {role}. To accept, open this link:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'The invitation is valid until {expiry}. If you weren’t expecting it, you can ignore this email.'),
  -- invite_member (tr)
  ('invite_member', 'tr', '140fdf6c7bc54f235769699332b55930',
     '{workspace} çalışma alanına davet edildiniz — {brand}',
     '<div class="preheader">{inviter} sizi ekibe {role} rolüyle davet etti. Davet {expiry} tarihine kadar geçerli.</div>'
     || '<h1>{workspace} ekibine katılın</h1>'
     || '<p>Merhaba {name},</p>'
     || '<p><strong>{inviter}</strong>, sizi {brand} üzerindeki <strong>{workspace}</strong> çalışma alanına {role} rolüyle davet etti.</p>'
     || '<p class="action"><a href="{action_url}">Daveti kabul et</a></p>'
     || '<p class="note">Bu davet {expiry} tarihine kadar geçerlidir. Bir davet beklemiyorsanız bu e-postayı yok sayabilirsiniz.</p>'
     || '<p class="note">Düğme çalışmazsa bu adresi tarayıcınızda açın:<br><a href="{action_url}">{action_url}</a></p>',
     'Merhaba {name},'
     || chr(10) || chr(10) || '{inviter}, sizi {brand} üzerindeki "{workspace}" çalışma alanına {role} rolüyle davet etti. Kabul etmek için bu bağlantıyı açın:' || chr(10) || '{action_url}'
     || chr(10) || chr(10) || 'Bu davet {expiry} tarihine kadar geçerlidir. Bir davet beklemiyorsanız bu e-postayı yok sayabilirsiniz.'),
  -- email_test (fa)
  ('email_test', 'fa', '7ed00a09feb18d5cc79c837c889b1b3a',
     'ایمیل آزمایشی — {brand}',
     '<div class="preheader">ارائه‌دهندهٔ ایمیل این پیام را رساند؛ کار دیگری لازم نیست.</div>'
     || '<h1>ارسال ایمیل درست کار می‌کند</h1>'
     || '<p>این ایمیل آزمایشی از سوپر ادمین ← ارائه‌دهندگان ← ایمیل فرستاده شد.</p>'
     || '<table class="details"><tr><th>سرویس</th><td>{slot}</td></tr><tr><th>ارائه‌دهنده</th><td dir="ltr">{provider}</td></tr><tr><th>زمان ارسال</th><td>{sent_at}</td></tr></table>'
     || '<p>اگر این ایمیل را می‌خوانید، ارائه‌دهنده آن را رسانده است و کار دیگری لازم نیست.</p>',
     'این ایمیل آزمایشی از سوپر ادمین ← ارائه‌دهندگان ← ایمیل، با {slot} ({provider}) در {sent_at} فرستاده شد.'
     || chr(10) || chr(10) || 'اگر این ایمیل را می‌خوانید، ارائه‌دهنده آن را رسانده است و کار دیگری لازم نیست.'),
  -- email_test (en)
  ('email_test', 'en', '06c7f9abe2166646e6bf2310695d3907',
     'Test email — {brand}',
     '<div class="preheader">Your email provider delivered this message. Nothing else needs to be done.</div>'
     || '<h1>Email delivery works</h1>'
     || '<p>This test email was sent from Super Admin → Providers → Email.</p>'
     || '<table class="details"><tr><th>Sent through</th><td>{slot}</td></tr><tr><th>Provider</th><td>{provider}</td></tr><tr><th>Sent at</th><td>{sent_at}</td></tr></table>'
     || '<p>If you can read it, the provider delivered it. Nothing else needs to be done.</p>',
     'This test email was sent from Super Admin → Providers → Email through {slot} ({provider}) at {sent_at}.'
     || chr(10) || chr(10) || 'If you can read it, the provider delivered it. Nothing else needs to be done.'),
  -- email_test (tr)
  ('email_test', 'tr', 'e5d5057bd9ba2190a1f653752650d24e',
     'Test e-postası — {brand}',
     '<div class="preheader">E-posta sağlayıcınız bu iletiyi teslim etti. Başka bir şey yapmanız gerekmiyor.</div>'
     || '<h1>E-posta gönderimi çalışıyor</h1>'
     || '<p>Bu test e-postası Süper Yönetici → Sağlayıcılar → E-posta bölümünden gönderildi.</p>'
     || '<table class="details"><tr><th>Gönderim</th><td>{slot}</td></tr><tr><th>Sağlayıcı</th><td>{provider}</td></tr><tr><th>Gönderilme zamanı</th><td>{sent_at}</td></tr></table>'
     || '<p>Okuyabiliyorsanız sağlayıcı teslim etti. Başka bir şey yapmanız gerekmiyor.</p>',
     'Bu test e-postası Süper Yönetici → Sağlayıcılar → E-posta bölümünden {slot} ({provider}) ile {sent_at} tarihinde gönderildi.'
     || chr(10) || chr(10) || 'Okuyabiliyorsanız sağlayıcı teslim etti. Başka bir şey yapmanız gerekmiyor.'),
  -- visitor_conversation_transcript (fa)
  ('visitor_conversation_transcript', 'fa', '173fb661897c7e16fcdfcb150ad2a399',
     'متن گفتگوی شما با {workspace_name}',
     '<div class="preheader">متن گفتگوی {date} شما با {workspace}، برای نگه‌داشتن یا مرور دوباره.</div>'
     || '<h1>متن گفتگوی شما</h1>'
     || '<p>این متن گفتگوی شما با <strong>{workspace}</strong> در {date} است، همان‌طور که از پنجرهٔ گفتگو خواستید.</p>'
     || '<div class="transcript">{transcript}</div>'
     || '<p class="note">پاسخ به این ایمیل به {workspace} نمی‌رسد؛ برای ادامهٔ گفتگو از پنجرهٔ گفتگو در وب‌سایت آن استفاده کنید.</p>',
     'این متن گفتگوی شما با {workspace_name} در {date} است، همان‌طور که از پنجرهٔ گفتگو خواستید.'
     || chr(10) || chr(10) || '{transcript_text}'
     || chr(10) || chr(10) || 'پاسخ به این ایمیل به {workspace_name} نمی‌رسد؛ برای ادامهٔ گفتگو از پنجرهٔ گفتگو در وب‌سایت آن استفاده کنید.'),
  -- visitor_conversation_transcript (en)
  ('visitor_conversation_transcript', 'en', '48fe9d6ae88c9a85ac48fcb9f98fbece',
     'Your conversation with {workspace_name}',
     '<div class="preheader">The transcript of your conversation with {workspace} on {date}, to keep or read again.</div>'
     || '<h1>Your conversation</h1>'
     || '<p>Here is your conversation with <strong>{workspace}</strong> on {date}, as you asked from the chat window.</p>'
     || '<div class="transcript">{transcript}</div>'
     || '<p class="note">Replies to this email don’t reach {workspace}. To continue the conversation, use the chat on their website.</p>',
     'Here is your conversation with {workspace_name} on {date}, as you asked from the chat window.'
     || chr(10) || chr(10) || '{transcript_text}'
     || chr(10) || chr(10) || 'Replies to this email don’t reach {workspace_name}. To continue the conversation, use the chat on their website.'),
  -- visitor_conversation_transcript (tr)
  ('visitor_conversation_transcript', 'tr', 'c2f9bf6775817a47af37246ca2e3c6dd',
     '{workspace_name} ile sohbetiniz',
     '<div class="preheader">{workspace} ile {date} tarihli sohbetinizin dökümü; saklamak ya da yeniden okumak için.</div>'
     || '<h1>Sohbetiniz</h1>'
     || '<p>Sohbet penceresinden istediğiniz üzere, <strong>{workspace}</strong> ile {date} tarihli sohbetiniz aşağıda.</p>'
     || '<div class="transcript">{transcript}</div>'
     || '<p class="note">Bu e-postaya verdiğiniz yanıt {workspace} ekibine ulaşmaz. Sohbete devam etmek için web sitesindeki sohbet penceresini kullanın.</p>',
     'Sohbet penceresinden istediğiniz üzere, {workspace_name} ile {date} tarihli sohbetiniz:'
     || chr(10) || chr(10) || '{transcript_text}'
     || chr(10) || chr(10) || 'Bu e-postaya verdiğiniz yanıt {workspace_name} ekibine ulaşmaz. Sohbete devam etmek için web sitesindeki sohbet penceresini kullanın.'),
  -- offline_message_received (fa)
  ('offline_message_received', 'fa', '0e672e1c5e9da40252ee53df5cbc4356',
     'پیام آفلاین جدید',
     '<div class="preheader">یک بازدیدکننده پیام گذاشت؛ نام، راه تماس و متن پیام در این ایمیل است.</div>'
     || '<h1>پیام آفلاین جدید</h1>'
     || '<p>وقتی تیم شما آنلاین نبود، یک بازدیدکننده در وب‌سایت شما پیام گذاشت.</p>'
     || '<table class="details"><tr><th>نام</th><td>{contact_name}</td></tr><tr><th>ایمیل</th><td>{contact_email}</td></tr><tr><th>تلفن</th><td dir="ltr">{contact_phone}</td></tr></table>'
     || '<blockquote>{message_body}</blockquote>'
     || '<p class="action"><a href="{action_url}">پاسخ در صندوق ورودی</a></p>'
     || '<p class="note">پاسخ دادن به این ایمیل به بازدیدکننده نمی‌رسد؛ از صندوق ورودی پاسخ دهید.</p>',
     NULL),
  -- offline_message_received (en)
  ('offline_message_received', 'en', '48ee36b04f38fd1a0d2c0f383c060337',
     'New offline message',
     '<div class="preheader">A visitor left a message. Their name, contact details and message are inside.</div>'
     || '<h1>New offline message</h1>'
     || '<p>A visitor left a message on your website while your team was offline.</p>'
     || '<table class="details"><tr><th>Name</th><td>{contact_name}</td></tr><tr><th>Email</th><td>{contact_email}</td></tr><tr><th>Phone</th><td dir="ltr">{contact_phone}</td></tr></table>'
     || '<blockquote>{message_body}</blockquote>'
     || '<p class="action"><a href="{action_url}">Reply in the inbox</a></p>'
     || '<p class="note">Replying to this email doesn’t reach the visitor; answer from the inbox.</p>',
     NULL),
  -- offline_message_received (tr)
  ('offline_message_received', 'tr', 'cb722f94df214e73614765dcc0fe38d0',
     'Yeni çevrimdışı mesaj',
     '<div class="preheader">Bir ziyaretçi mesaj bıraktı. Adı, iletişim bilgileri ve mesajı içeride.</div>'
     || '<h1>Yeni çevrimdışı mesaj</h1>'
     || '<p>Ekibiniz çevrimdışıyken bir ziyaretçi web sitenizde mesaj bıraktı.</p>'
     || '<table class="details"><tr><th>Ad</th><td>{contact_name}</td></tr><tr><th>E-posta</th><td>{contact_email}</td></tr><tr><th>Telefon</th><td dir="ltr">{contact_phone}</td></tr></table>'
     || '<blockquote>{message_body}</blockquote>'
     || '<p class="action"><a href="{action_url}">Gelen kutusunda yanıtla</a></p>'
     || '<p class="note">Bu e-postayı yanıtlamak ziyaretçiye ulaşmaz; gelen kutusundan yanıt verin.</p>',
     NULL),
  -- offline_messages_summary (fa)
  ('offline_messages_summary', 'fa', '7e6343df04e0e66a6cbb0642042c9a21',
     'پیام‌های آفلاین بیشتر: {count}',
     '<div class="preheader">در {minutes} دقیقهٔ بعد، {count} پیام دیگر هم رسید. همه در صندوق ورودی است.</div>'
     || '<h1>پیام‌های آفلاین بیشتر</h1>'
     || '<p>بعد از پیامی که خبرش را برایتان فرستادیم، در {minutes} دقیقهٔ بعد <strong>{count}</strong> پیام آفلاین دیگر هم رسید.</p>'
     || '<p>برای اینکه صندوق ایمیل شما شلوغ نشود، این پیام‌ها را یک‌جا خبر می‌دهیم. متن آن‌ها را در صندوق ورودی ببینید.</p>'
     || '<p class="action"><a href="{action_url}">باز کردن صندوق ورودی</a></p>',
     'بعد از پیامی که خبرش را برایتان فرستادیم، در {minutes} دقیقهٔ بعد {count} پیام آفلاین دیگر هم رسید.'
     || chr(10) || chr(10) || 'برای اینکه صندوق ایمیل شما شلوغ نشود، این پیام‌ها را یک‌جا خبر می‌دهیم. متن آن‌ها را در صندوق ورودی ببینید:' || chr(10) || '{action_url}'),
  -- offline_messages_summary (en)
  ('offline_messages_summary', 'en', 'a97ade2c8ebe45dcf31cbd8d5db9f229',
     'More offline messages: {count}',
     '<div class="preheader">{count} more arrived in the next {minutes} minutes. They’re all in your inbox.</div>'
     || '<h1>More offline messages</h1>'
     || '<p>After the message we told you about, <strong>{count}</strong> more offline messages arrived in the next {minutes} minutes.</p>'
     || '<p>To keep your mailbox quiet, we tell you about them in one email. Read them in the inbox.</p>'
     || '<p class="action"><a href="{action_url}">Open the inbox</a></p>',
     'After the message we told you about, {count} more offline messages arrived in the next {minutes} minutes.'
     || chr(10) || chr(10) || 'To keep your mailbox quiet, we tell you about them in one email. Read them in the inbox:' || chr(10) || '{action_url}'),
  -- offline_messages_summary (tr)
  ('offline_messages_summary', 'tr', '5267ad66e87da10a7c8f2fe3a0e688d5',
     'Daha fazla çevrimdışı mesaj: {count}',
     '<div class="preheader">Sonraki {minutes} dakikada {count} mesaj daha geldi. Hepsi gelen kutunuzda.</div>'
     || '<h1>Daha fazla çevrimdışı mesaj</h1>'
     || '<p>Size bildirdiğimiz mesajdan sonraki {minutes} dakika içinde <strong>{count}</strong> çevrimdışı mesaj daha geldi.</p>'
     || '<p>Posta kutunuz kalabalıklaşmasın diye bunları tek bir e-postada bildiriyoruz. Mesajları gelen kutusunda okuyabilirsiniz.</p>'
     || '<p class="action"><a href="{action_url}">Gelen kutusunu aç</a></p>',
     'Size bildirdiğimiz mesajdan sonraki {minutes} dakika içinde {count} çevrimdışı mesaj daha geldi.'
     || chr(10) || chr(10) || 'Posta kutunuz kalabalıklaşmasın diye bunları tek bir e-postada bildiriyoruz. Mesajları gelen kutusunda okuyabilirsiniz:' || chr(10) || '{action_url}'),
  -- operator_unread_digest (fa)
  ('operator_unread_digest', 'fa', '62faf40d9daed7de327c9558c35bc9cb',
     '{{count}} گفتگو در {{workspace}} منتظر پاسخ است',
     '<div class="preheader">این گفتگوها بیش از {{minutes}} دقیقه است که پاسخی نگرفته‌اند.</div>'
     || '<h1>گفتگوهای منتظر پاسخ</h1>'
     || '<p>سلام {{name}}،</p>'
     || '<p>در <strong>{{workspace}}</strong> مشتریانی منتظر پاسخ شما هستند.</p>'
     || '<table class="details"><tr><th>گفتگوهای منتظر</th><td>{{count}}</td></tr><tr><th>مدت انتظار</th><td>بیش از {{minutes}} دقیقه</td></tr><tr><th>موضوع‌ها</th><td>{{list}}</td></tr></table>'
     || '<p class="action"><a href="{{action_url}}">باز کردن صندوق ورودی</a></p>',
     'سلام {{name}}،'
     || chr(10) || chr(10) || 'در {{workspace}} مشتریانی منتظر پاسخ شما هستند.'
     || chr(10) || chr(10) || 'گفتگوهای منتظر: {{count}}' || chr(10) || 'مدت انتظار: بیش از {{minutes}} دقیقه' || chr(10) || 'موضوع‌ها: {{list}}'
     || chr(10) || chr(10) || 'صندوق ورودی: {{action_url}}'),
  -- operator_unread_digest (en)
  ('operator_unread_digest', 'en', 'a3d4cd0cce5a3dc04dd4201977c006a6',
     'Conversations waiting in {{workspace}}: {{count}}',
     '<div class="preheader">They have had no answer for more than {{minutes}} minutes.</div>'
     || '<h1>Conversations waiting for you</h1>'
     || '<p>Hi {{name}},</p>'
     || '<p>Customers in <strong>{{workspace}}</strong> are waiting for an answer.</p>'
     || '<table class="details"><tr><th>Waiting conversations</th><td>{{count}}</td></tr><tr><th>Waiting for more than</th><td>{{minutes}} minutes</td></tr><tr><th>Subjects</th><td>{{list}}</td></tr></table>'
     || '<p class="action"><a href="{{action_url}}">Open the inbox</a></p>',
     'Hi {{name}},'
     || chr(10) || chr(10) || 'Customers in {{workspace}} are waiting for an answer.'
     || chr(10) || chr(10) || 'Waiting conversations: {{count}}' || chr(10) || 'Waiting for more than: {{minutes}} minutes' || chr(10) || 'Subjects: {{list}}'
     || chr(10) || chr(10) || 'Inbox: {{action_url}}'),
  -- operator_unread_digest (tr)
  ('operator_unread_digest', 'tr', 'dbea81dc778c207c96fd013754fad4ee',
     '{{workspace}}: {{count}} konuşma yanıt bekliyor',
     '<div class="preheader">{{minutes}} dakikadan uzun süredir yanıt almadılar.</div>'
     || '<h1>Yanıt bekleyen konuşmalar</h1>'
     || '<p>Merhaba {{name}},</p>'
     || '<p><strong>{{workspace}}</strong> alanında yanıt bekleyen müşteriler var.</p>'
     || '<table class="details"><tr><th>Bekleyen konuşmalar</th><td>{{count}}</td></tr><tr><th>Bekleme süresi</th><td>{{minutes}} dakikadan fazla</td></tr><tr><th>Konular</th><td>{{list}}</td></tr></table>'
     || '<p class="action"><a href="{{action_url}}">Gelen kutusunu aç</a></p>',
     'Merhaba {{name}},'
     || chr(10) || chr(10) || '{{workspace}} alanında yanıt bekleyen müşteriler var.'
     || chr(10) || chr(10) || 'Bekleyen konuşmalar: {{count}}' || chr(10) || 'Bekleme süresi: {{minutes}} dakikadan fazla' || chr(10) || 'Konular: {{list}}'
     || chr(10) || chr(10) || 'Gelen kutusu: {{action_url}}'),
  -- operator_conversation_transcript (fa)
  ('operator_conversation_transcript', 'fa', '499b83829e261d7353a082f7c3bd4e3c',
     'متن گفتگو — {{subject}}',
     '<div class="preheader">گفتگو با {{contact}} در {{workspace}} بسته شد؛ متن آن برای سابقهٔ شما.</div>'
     || '<h1>متن گفتگو</h1>'
     || '<p>سلام {{name}}،</p>'
     || '<p>این متن گفتگو با <strong>{{contact}}</strong> در {{workspace}} است که به‌تازگی بسته شد.</p>'
     || '<div class="transcript">{{transcript}}</div>'
     || '<p class="action"><a href="{{action_url}}">باز کردن گفتگو</a></p>',
     'سلام {{name}}،'
     || chr(10) || chr(10) || 'این متن گفتگو با {{contact}} در {{workspace}} است که به‌تازگی بسته شد.'
     || chr(10) || chr(10) || '{{transcript}}'
     || chr(10) || chr(10) || 'باز کردن گفتگو: {{action_url}}'),
  -- operator_conversation_transcript (en)
  ('operator_conversation_transcript', 'en', 'e5aef388f40bb4e8f8a4aca59791b8bc',
     'Transcript — {{subject}}',
     '<div class="preheader">Your conversation with {{contact}} in {{workspace}} is closed. Here is the transcript for your records.</div>'
     || '<h1>Conversation transcript</h1>'
     || '<p>Hi {{name}},</p>'
     || '<p>Here is the transcript of the conversation with <strong>{{contact}}</strong> in {{workspace}}, which has just been closed.</p>'
     || '<div class="transcript">{{transcript}}</div>'
     || '<p class="action"><a href="{{action_url}}">Open the conversation</a></p>',
     'Hi {{name}},'
     || chr(10) || chr(10) || 'Here is the transcript of the conversation with {{contact}} in {{workspace}}, which has just been closed.'
     || chr(10) || chr(10) || '{{transcript}}'
     || chr(10) || chr(10) || 'Open the conversation: {{action_url}}'),
  -- operator_conversation_transcript (tr)
  ('operator_conversation_transcript', 'tr', '42cda442af49e80683e4c8993b14977c',
     'Konuşma dökümü — {{subject}}',
     '<div class="preheader">{{workspace}} alanında {{contact}} ile konuşma kapandı. Kayıtlarınız için dökümü.</div>'
     || '<h1>Konuşma dökümü</h1>'
     || '<p>Merhaba {{name}},</p>'
     || '<p>{{workspace}} alanında <strong>{{contact}}</strong> ile yapılan ve az önce kapatılan konuşmanın dökümü aşağıda.</p>'
     || '<div class="transcript">{{transcript}}</div>'
     || '<p class="action"><a href="{{action_url}}">Konuşmayı aç</a></p>',
     'Merhaba {{name}},'
     || chr(10) || chr(10) || '{{workspace}} alanında {{contact}} ile yapılan ve az önce kapatılan konuşmanın dökümü:'
     || chr(10) || chr(10) || '{{transcript}}'
     || chr(10) || chr(10) || 'Konuşmayı aç: {{action_url}}'),
  -- operator_invoice_paid (fa)
  ('operator_invoice_paid', 'fa', '8b4c5cf583a366c1ea7bc9fdc9c34f32',
     'پرداخت دریافت شد — {{amount}}',
     '<div class="preheader">رسید آن در صفحهٔ صورتحساب {{workspace}} است.</div>'
     || '<h1>پرداخت دریافت شد</h1>'
     || '<p>سلام {{name}}،</p>'
     || '<p>مبلغ <strong>{{amount}}</strong> برای {{workspace}} <span dir="ltr">{{invoice_label}}</span> دریافت شد.</p>'
     || '<p class="action"><a href="{{action_url}}">مشاهدهٔ صورتحساب</a></p>',
     'سلام {{name}}،'
     || chr(10) || chr(10) || 'مبلغ {{amount}} برای {{workspace}}{{invoice_label}} دریافت شد.'
     || chr(10) || chr(10) || 'صورتحساب: {{action_url}}'),
  -- operator_invoice_paid (en)
  ('operator_invoice_paid', 'en', '72697d856f5117b363e4672b3de9188c',
     'Payment received — {{amount}}',
     '<div class="preheader">The receipt is on the billing page of {{workspace}}.</div>'
     || '<h1>Payment received</h1>'
     || '<p>Hi {{name}},</p>'
     || '<p><strong>{{amount}}</strong> was received for {{workspace}}{{invoice_label}}.</p>'
     || '<p class="action"><a href="{{action_url}}">View billing</a></p>',
     'Hi {{name}},'
     || chr(10) || chr(10) || '{{amount}} was received for {{workspace}}{{invoice_label}}.'
     || chr(10) || chr(10) || 'Billing: {{action_url}}'),
  -- operator_invoice_paid (tr)
  ('operator_invoice_paid', 'tr', 'ad5673cf2dd87cda51c250178a83022c',
     'Ödeme alındı — {{amount}}',
     '<div class="preheader">Makbuzu {{workspace}} faturalandırma sayfasında.</div>'
     || '<h1>Ödeme alındı</h1>'
     || '<p>Merhaba {{name}},</p>'
     || '<p>{{workspace}} için <strong>{{amount}}</strong> tutarında ödeme alındı{{invoice_label}}.</p>'
     || '<p class="action"><a href="{{action_url}}">Faturalandırmayı görüntüle</a></p>',
     'Merhaba {{name}},'
     || chr(10) || chr(10) || '{{workspace}} için {{amount}} tutarında ödeme alındı{{invoice_label}}.'
     || chr(10) || chr(10) || 'Faturalandırma: {{action_url}}'),
  -- operator_weekly_summary (fa)
  ('operator_weekly_summary', 'fa', 'f14de6a1d214245b2f9db00b1b033fa5',
     'هفتهٔ گذشته در {{workspace}}',
     '<div class="preheader">گفتگوهای تازه {{conversations}} · حل‌شده {{resolved}} · پیام‌ها {{messages}}</div>'
     || '<h1>خلاصهٔ هفته</h1>'
     || '<p>سلام {{name}}،</p>'
     || '<p>این خلاصهٔ هفتهٔ گذشته در <strong>{{workspace}}</strong> است:</p>'
     || '<table class="details"><tr><th>گفتگوهای تازه</th><td>{{conversations}}</td></tr><tr><th>حل‌شده</th><td>{{resolved}}</td></tr><tr><th>پیام‌ها</th><td>{{messages}}</td></tr></table>'
     || '<p class="action"><a href="{{action_url}}">باز کردن صندوق ورودی</a></p>',
     'سلام {{name}}،'
     || chr(10) || chr(10) || 'این خلاصهٔ هفتهٔ گذشته در {{workspace}} است:' || chr(10) || 'گفتگوهای تازه: {{conversations}}' || chr(10) || 'حل‌شده: {{resolved}}' || chr(10) || 'پیام‌ها: {{messages}}'
     || chr(10) || chr(10) || 'صندوق ورودی: {{action_url}}'),
  -- operator_weekly_summary (en)
  ('operator_weekly_summary', 'en', '19a6e822a02c8e7da4c2386dfbac37ef',
     'Your week in {{workspace}}',
     '<div class="preheader">New conversations {{conversations}} · Resolved {{resolved}} · Messages {{messages}}</div>'
     || '<h1>Your week</h1>'
     || '<p>Hi {{name}},</p>'
     || '<p>Here is last week in <strong>{{workspace}}</strong>:</p>'
     || '<table class="details"><tr><th>New conversations</th><td>{{conversations}}</td></tr><tr><th>Resolved</th><td>{{resolved}}</td></tr><tr><th>Messages</th><td>{{messages}}</td></tr></table>'
     || '<p class="action"><a href="{{action_url}}">Open the inbox</a></p>',
     'Hi {{name}},'
     || chr(10) || chr(10) || 'Here is last week in {{workspace}}:' || chr(10) || 'New conversations: {{conversations}}' || chr(10) || 'Resolved: {{resolved}}' || chr(10) || 'Messages: {{messages}}'
     || chr(10) || chr(10) || 'Inbox: {{action_url}}'),
  -- operator_weekly_summary (tr)
  ('operator_weekly_summary', 'tr', 'e252c1c59aea5699774f06502018b198',
     '{{workspace}} alanında geçen hafta',
     '<div class="preheader">Yeni konuşmalar {{conversations}} · Çözülen {{resolved}} · Mesajlar {{messages}}</div>'
     || '<h1>Haftanızın özeti</h1>'
     || '<p>Merhaba {{name}},</p>'
     || '<p><strong>{{workspace}}</strong> alanında geçen hafta:</p>'
     || '<table class="details"><tr><th>Yeni konuşmalar</th><td>{{conversations}}</td></tr><tr><th>Çözülen</th><td>{{resolved}}</td></tr><tr><th>Mesajlar</th><td>{{messages}}</td></tr></table>'
     || '<p class="action"><a href="{{action_url}}">Gelen kutusunu aç</a></p>',
     'Merhaba {{name}},'
     || chr(10) || chr(10) || '{{workspace}} alanında geçen hafta:' || chr(10) || 'Yeni konuşmalar: {{conversations}}' || chr(10) || 'Çözülen: {{resolved}}' || chr(10) || 'Mesajlar: {{messages}}'
     || chr(10) || chr(10) || 'Gelen kutusu: {{action_url}}'),
  -- operator_product_update (fa)
  ('operator_product_update', 'fa', '28b23deea0b94e53e2e5bf090316ca90',
     '{{title}}',
     '<div class="preheader">خبری تازه از تیم {{brand}}.</div>'
     || '<h1>{{title}}</h1>'
     || '<p>سلام {{name}}،</p>'
     || '<p>{{body}}</p>'
     || '<p>تیم {{brand}}</p>',
     '{{title}}'
     || chr(10) || chr(10) || 'سلام {{name}}،'
     || chr(10) || chr(10) || '{{body}}'
     || chr(10) || chr(10) || 'تیم {{brand}}'),
  -- operator_product_update (en)
  ('operator_product_update', 'en', '197f28cb7d058678b033b54f41be29d8',
     '{{title}}',
     '<div class="preheader">News from the {{brand}} team.</div>'
     || '<h1>{{title}}</h1>'
     || '<p>Hi {{name}},</p>'
     || '<p>{{body}}</p>'
     || '<p>The {{brand}} team</p>',
     '{{title}}'
     || chr(10) || chr(10) || 'Hi {{name}},'
     || chr(10) || chr(10) || '{{body}}'
     || chr(10) || chr(10) || 'The {{brand}} team'),
  -- operator_product_update (tr)
  ('operator_product_update', 'tr', 'a17c1670e5c975b0be47c0a4787bcb82',
     '{{title}}',
     '<div class="preheader">{{brand}} ekibinden bir haber.</div>'
     || '<h1>{{title}}</h1>'
     || '<p>Merhaba {{name}},</p>'
     || '<p>{{body}}</p>'
     || '<p>{{brand}} ekibi</p>',
     '{{title}}'
     || chr(10) || chr(10) || 'Merhaba {{name}},'
     || chr(10) || chr(10) || '{{body}}'
     || chr(10) || chr(10) || '{{brand}} ekibi'),
  -- billing_renewal_reminder (fa)
  ('billing_renewal_reminder', 'fa', '45d5397b4a4a9bea1b87a0642bb424fb',
     '{days_left} روز تا پایان پلن {plan_name} — {brand}',
     '<div class="preheader">برای اینکه {workspace} بدون وقفه کار کند، پیش از {period_end} تمدید کنید.</div>'
     || '<h1>پلن شما به‌زودی تمام می‌شود</h1>'
     || '<p>پلن {plan_name} فضای کاری {workspace} در {period_end} تمام می‌شود؛ {days_left} روز دیگر.</p>'
     || '<table class="details"><tr><th>پلن فعلی</th><td>{plan_name}</td></tr><tr><th>پایان دوره</th><td>{period_end}</td></tr><tr><th>تمدید با</th><td>{new_plan_name}</td></tr><tr><th>مبلغ تمدید</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr></table>'
     || '<p>اگر پلن تا آن روز تمدید نشود، فضای کاری به پلن رایگان منتقل می‌شود.</p>'
     || '<p class="action"><a href="{billing_url}">تمدید پلن</a></p>',
     'پلن {plan_name} فضای کاری {workspace} در {period_end} تمام می‌شود؛ {days_left} روز دیگر.'
     || chr(10) || chr(10) || 'تمدید با: {new_plan_name}' || chr(10) || 'مبلغ تمدید: {amount}' || chr(10) || 'موجودی حساب: {balance}'
     || chr(10) || chr(10) || 'اگر پلن تا آن روز تمدید نشود، فضای کاری به پلن رایگان منتقل می‌شود.'
     || chr(10) || chr(10) || 'تمدید پلن: {billing_url}'),
  -- billing_renewal_reminder (en)
  ('billing_renewal_reminder', 'en', 'b4e3f053bbc33a8761c6a072ca2e78e5',
     'Your {plan_name} plan ends on {period_end} — {brand}',
     '<div class="preheader">Renew before {period_end} to keep {workspace} running without a break.</div>'
     || '<h1>Your plan ends soon</h1>'
     || '<p>The {plan_name} plan of {workspace} ends on {period_end}.</p>'
     || '<table class="details"><tr><th>Current plan</th><td>{plan_name}</td></tr><tr><th>Period ends</th><td>{period_end}</td></tr><tr><th>Days left</th><td>{days_left}</td></tr><tr><th>Renews as</th><td>{new_plan_name}</td></tr><tr><th>Renewal amount</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr></table>'
     || '<p>If the plan isn’t renewed by then, the workspace moves to the Free plan.</p>'
     || '<p class="action"><a href="{billing_url}">Renew plan</a></p>',
     'The {plan_name} plan of {workspace} ends on {period_end}.'
     || chr(10) || chr(10) || 'Days left: {days_left}' || chr(10) || 'Renews as: {new_plan_name}' || chr(10) || 'Renewal amount: {amount}' || chr(10) || 'Account balance: {balance}'
     || chr(10) || chr(10) || 'If the plan isn’t renewed by then, the workspace moves to the Free plan.'
     || chr(10) || chr(10) || 'Renew plan: {billing_url}'),
  -- billing_renewal_reminder (tr)
  ('billing_renewal_reminder', 'tr', '88cfc89161b7c73485cccd007d3693f7',
     '{plan_name} planınız {days_left} gün içinde sona eriyor — {brand}',
     '<div class="preheader">{workspace} kesintisiz çalışsın diye {period_end} tarihinden önce yenileyin.</div>'
     || '<h1>Planınız yakında sona eriyor</h1>'
     || '<p>{workspace} çalışma alanının {plan_name} planı {period_end} tarihinde, {days_left} gün sonra sona eriyor.</p>'
     || '<table class="details"><tr><th>Mevcut plan</th><td>{plan_name}</td></tr><tr><th>Dönem sonu</th><td>{period_end}</td></tr><tr><th>Yenilenecek plan</th><td>{new_plan_name}</td></tr><tr><th>Yenileme tutarı</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr></table>'
     || '<p>O tarihe kadar yenilenmezse çalışma alanı Ücretsiz plana geçer.</p>'
     || '<p class="action"><a href="{billing_url}">Planı yenile</a></p>',
     '{workspace} çalışma alanının {plan_name} planı {period_end} tarihinde, {days_left} gün sonra sona eriyor.'
     || chr(10) || chr(10) || 'Yenilenecek plan: {new_plan_name}' || chr(10) || 'Yenileme tutarı: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}'
     || chr(10) || chr(10) || 'O tarihe kadar yenilenmezse çalışma alanı Ücretsiz plana geçer.'
     || chr(10) || chr(10) || 'Planı yenile: {billing_url}'),
  -- billing_renewed (fa)
  ('billing_renewed', 'fa', '6868740313a4539dee5827bc5a5bc9f5',
     'پلن {plan_name} تمدید شد — {brand}',
     '<div class="preheader">دورهٔ تازهٔ {workspace} از {period_start} تا {period_end} است.</div>'
     || '<h1>پلن شما تمدید شد</h1>'
     || '<p>پلن {plan_name} فضای کاری {workspace} تمدید شد.</p>'
     || '<table class="details"><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>دوره</th><td>{period_start} تا {period_end}</td></tr><tr><th>مبلغ</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">مشاهدهٔ صورتحساب</a></p>',
     'پلن {plan_name} فضای کاری {workspace} تمدید شد.'
     || chr(10) || chr(10) || 'دوره: {period_start} تا {period_end}' || chr(10) || 'مبلغ: {amount}' || chr(10) || 'موجودی حساب: {balance}'
     || chr(10) || chr(10) || 'صورتحساب: {billing_url}'),
  -- billing_renewed (en)
  ('billing_renewed', 'en', 'f05b977e99169468c552d77ac69d2ee9',
     'Your {plan_name} plan was renewed — {brand}',
     '<div class="preheader">The new period of {workspace} runs from {period_start} to {period_end}.</div>'
     || '<h1>Your plan is renewed</h1>'
     || '<p>The {plan_name} plan of {workspace} is renewed.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Period</th><td>{period_start} – {period_end}</td></tr><tr><th>Amount</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">View billing</a></p>',
     'The {plan_name} plan of {workspace} is renewed.'
     || chr(10) || chr(10) || 'Period: {period_start} – {period_end}' || chr(10) || 'Amount: {amount}' || chr(10) || 'Account balance: {balance}'
     || chr(10) || chr(10) || 'Billing: {billing_url}'),
  -- billing_renewed (tr)
  ('billing_renewed', 'tr', '88d31b1b628f276bcd4862e1f8d110b0',
     '{plan_name} planınız yenilendi — {brand}',
     '<div class="preheader">{workspace} için yeni dönem: {period_start} – {period_end}.</div>'
     || '<h1>Planınız yenilendi</h1>'
     || '<p>{workspace} çalışma alanının {plan_name} planı yenilendi.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Dönem</th><td>{period_start} – {period_end}</td></tr><tr><th>Tutar</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">Faturalandırmayı görüntüle</a></p>',
     '{workspace} çalışma alanının {plan_name} planı yenilendi.'
     || chr(10) || chr(10) || 'Dönem: {period_start} – {period_end}' || chr(10) || 'Tutar: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}'
     || chr(10) || chr(10) || 'Faturalandırma: {billing_url}'),
  -- billing_plan_changed (fa)
  ('billing_plan_changed', 'fa', 'f4d5925f845136ddf2b89dc1543f59f6',
     'پلن شما به {plan_name} تغییر کرد — {brand}',
     '<div class="preheader">تغییری که برنامه‌ریزی کرده بودید با شروع دورهٔ تازه انجام شد.</div>'
     || '<h1>پلن شما تغییر کرد</h1>'
     || '<p>پلن فضای کاری {workspace} از {old_plan_name} به {plan_name} تغییر کرد.</p>'
     || '<table class="details"><tr><th>پلن تازه</th><td>{plan_name}</td></tr><tr><th>پلن قبلی</th><td>{old_plan_name}</td></tr><tr><th>دوره</th><td>{period_start} تا {period_end}</td></tr><tr><th>مبلغ</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">مشاهدهٔ صورتحساب</a></p>',
     'پلن فضای کاری {workspace} از {old_plan_name} به {plan_name} تغییر کرد.'
     || chr(10) || chr(10) || 'دوره: {period_start} تا {period_end}' || chr(10) || 'مبلغ: {amount}' || chr(10) || 'موجودی حساب: {balance}'
     || chr(10) || chr(10) || 'صورتحساب: {billing_url}'),
  -- billing_plan_changed (en)
  ('billing_plan_changed', 'en', 'd9ded0fd96b1d137737b8fe25ea44c8b',
     'Your plan changed to {plan_name} — {brand}',
     '<div class="preheader">The change you scheduled took effect with the new period.</div>'
     || '<h1>Your plan has changed</h1>'
     || '<p>{workspace} moved from the {old_plan_name} plan to {plan_name}.</p>'
     || '<table class="details"><tr><th>New plan</th><td>{plan_name}</td></tr><tr><th>Previous plan</th><td>{old_plan_name}</td></tr><tr><th>Period</th><td>{period_start} – {period_end}</td></tr><tr><th>Amount</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">View billing</a></p>',
     '{workspace} moved from the {old_plan_name} plan to {plan_name}.'
     || chr(10) || chr(10) || 'Period: {period_start} – {period_end}' || chr(10) || 'Amount: {amount}' || chr(10) || 'Account balance: {balance}'
     || chr(10) || chr(10) || 'Billing: {billing_url}'),
  -- billing_plan_changed (tr)
  ('billing_plan_changed', 'tr', '4e39a74e254df1cfa4a4b673c011ca77',
     'Planınız {plan_name} olarak değişti — {brand}',
     '<div class="preheader">Planladığınız değişiklik yeni dönemle birlikte uygulandı.</div>'
     || '<h1>Planınız değişti</h1>'
     || '<p>{workspace} çalışma alanı {old_plan_name} planından {plan_name} planına geçti.</p>'
     || '<table class="details"><tr><th>Yeni plan</th><td>{plan_name}</td></tr><tr><th>Önceki plan</th><td>{old_plan_name}</td></tr><tr><th>Dönem</th><td>{period_start} – {period_end}</td></tr><tr><th>Tutar</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">Faturalandırmayı görüntüle</a></p>',
     '{workspace} çalışma alanı {old_plan_name} planından {plan_name} planına geçti.'
     || chr(10) || chr(10) || 'Dönem: {period_start} – {period_end}' || chr(10) || 'Tutar: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}'
     || chr(10) || chr(10) || 'Faturalandırma: {billing_url}'),
  -- billing_card_renewed (fa)
  ('billing_card_renewed', 'fa', 'ca595ab8697be34af15eb9dee961e078',
     'پلن {plan_name} با کارت شما تمدید شد — {brand}',
     '<div class="preheader">فاکتور پرداخت با کارت را جداگانه دریافت می‌کنید.</div>'
     || '<h1>تمدید با کارت انجام شد</h1>'
     || '<p>پلن {plan_name} فضای کاری {workspace} با کارت ذخیره‌شدهٔ شما تمدید شد.</p>'
     || '<table class="details"><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>دوره</th><td>{period_start} تا {period_end}</td></tr><tr><th>کارت</th><td dir="ltr">{card}</td></tr><tr><th>مبلغ</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr></table>'
     || '<p>فاکتور این پرداخت جداگانه برایتان ایمیل می‌شود.</p>'
     || '<p class="action"><a href="{billing_url}">مشاهدهٔ صورتحساب</a></p>',
     'پلن {plan_name} فضای کاری {workspace} با کارت ذخیره‌شدهٔ شما تمدید شد.'
     || chr(10) || chr(10) || 'دوره: {period_start} تا {period_end}' || chr(10) || 'کارت: {card}' || chr(10) || 'مبلغ: {amount}' || chr(10) || 'موجودی حساب: {balance}'
     || chr(10) || chr(10) || 'فاکتور این پرداخت جداگانه برایتان ایمیل می‌شود.'
     || chr(10) || chr(10) || 'صورتحساب: {billing_url}'),
  -- billing_card_renewed (en)
  ('billing_card_renewed', 'en', 'bea33fed72f1764fe693d1edf3846c6e',
     'Your {plan_name} plan was renewed with your card — {brand}',
     '<div class="preheader">The invoice for the card payment comes in a separate email.</div>'
     || '<h1>Renewed with your card</h1>'
     || '<p>The {plan_name} plan of {workspace} was renewed with your saved card.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Period</th><td>{period_start} – {period_end}</td></tr><tr><th>Card</th><td>{card}</td></tr><tr><th>Amount</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr></table>'
     || '<p>The invoice for this payment is emailed to you separately.</p>'
     || '<p class="action"><a href="{billing_url}">View billing</a></p>',
     'The {plan_name} plan of {workspace} was renewed with your saved card.'
     || chr(10) || chr(10) || 'Period: {period_start} – {period_end}' || chr(10) || 'Card: {card}' || chr(10) || 'Amount: {amount}' || chr(10) || 'Account balance: {balance}'
     || chr(10) || chr(10) || 'The invoice for this payment is emailed to you separately.'
     || chr(10) || chr(10) || 'Billing: {billing_url}'),
  -- billing_card_renewed (tr)
  ('billing_card_renewed', 'tr', 'a298f2442ab68e00b1829454fa15b958',
     '{plan_name} planınız kartınızla yenilendi — {brand}',
     '<div class="preheader">Kart ödemesinin faturası ayrı bir e-postayla gelir.</div>'
     || '<h1>Kartınızla yenilendi</h1>'
     || '<p>{workspace} çalışma alanının {plan_name} planı kayıtlı kartınızla yenilendi.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Dönem</th><td>{period_start} – {period_end}</td></tr><tr><th>Kart</th><td>{card}</td></tr><tr><th>Tutar</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr></table>'
     || '<p>Bu ödemenin faturası size ayrıca e-postayla gönderilir.</p>'
     || '<p class="action"><a href="{billing_url}">Faturalandırmayı görüntüle</a></p>',
     '{workspace} çalışma alanının {plan_name} planı kayıtlı kartınızla yenilendi.'
     || chr(10) || chr(10) || 'Dönem: {period_start} – {period_end}' || chr(10) || 'Kart: {card}' || chr(10) || 'Tutar: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}'
     || chr(10) || chr(10) || 'Bu ödemenin faturası size ayrıca e-postayla gönderilir.'
     || chr(10) || chr(10) || 'Faturalandırma: {billing_url}'),
  -- billing_plan_activated (fa)
  ('billing_plan_activated', 'fa', '719dc68955f7389bc43cbb9a7be46ddc',
     'پلن {plan_name} فعال شد — {brand}',
     '<div class="preheader">همهٔ امکانات این پلن از همین حالا تا {period_end} در دسترس است.</div>'
     || '<h1>پلن شما فعال شد</h1>'
     || '<p>پلن {plan_name} برای فضای کاری {workspace} فعال شد. سپاس از اعتمادتان.</p>'
     || '<table class="details"><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>معتبر تا</th><td>{period_end}</td></tr><tr><th>مبلغ</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">مشاهدهٔ صورتحساب</a></p>',
     'پلن {plan_name} برای فضای کاری {workspace} فعال شد. سپاس از اعتمادتان.'
     || chr(10) || chr(10) || 'معتبر تا: {period_end}' || chr(10) || 'مبلغ: {amount}' || chr(10) || 'موجودی حساب: {balance}'
     || chr(10) || chr(10) || 'صورتحساب: {billing_url}'),
  -- billing_plan_activated (en)
  ('billing_plan_activated', 'en', '753d1f27c424bc0b4fe0095aa7078a44',
     'Your {plan_name} plan is active — {brand}',
     '<div class="preheader">Everything in the plan is yours to use now, until {period_end}.</div>'
     || '<h1>Your plan is active</h1>'
     || '<p>The {plan_name} plan is now active for {workspace}. Thank you for your trust.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Valid until</th><td>{period_end}</td></tr><tr><th>Amount</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">View billing</a></p>',
     'The {plan_name} plan is now active for {workspace}. Thank you for your trust.'
     || chr(10) || chr(10) || 'Valid until: {period_end}' || chr(10) || 'Amount: {amount}' || chr(10) || 'Account balance: {balance}'
     || chr(10) || chr(10) || 'Billing: {billing_url}'),
  -- billing_plan_activated (tr)
  ('billing_plan_activated', 'tr', 'fd0ca42f0ab1b8cfc00625c05278aa48',
     '{plan_name} planınız etkin — {brand}',
     '<div class="preheader">Planın tüm özellikleri {period_end} tarihine kadar kullanımınızda.</div>'
     || '<h1>Planınız etkin</h1>'
     || '<p>{plan_name} planı {workspace} çalışma alanı için etkinleştirildi. Güveniniz için teşekkür ederiz.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Geçerlilik sonu</th><td>{period_end}</td></tr><tr><th>Tutar</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">Faturalandırmayı görüntüle</a></p>',
     '{plan_name} planı {workspace} çalışma alanı için etkinleştirildi. Güveniniz için teşekkür ederiz.'
     || chr(10) || chr(10) || 'Geçerlilik sonu: {period_end}' || chr(10) || 'Tutar: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}'
     || chr(10) || chr(10) || 'Faturalandırma: {billing_url}'),
  -- billing_expired (fa)
  ('billing_expired', 'fa', '25cefd40060f933eacdebbfcdd4d936c',
     'پلن {plan_name} به پایان رسید — {brand}',
     '<div class="preheader">فضای کاری {workspace} اکنون روی پلن رایگان کار می‌کند.</div>'
     || '<h1>پلن شما به پایان رسید</h1>'
     || '<p>پلن {plan_name} فضای کاری {workspace} به پایان رسید و فضای کاری به پلن رایگان منتقل شد.</p>'
     || '<table class="details"><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>تاریخ پایان</th><td>{expired_at}</td></tr></table>'
     || '<p>داده‌های شما حفظ می‌شوند. با خرید دوبارهٔ پلن، همهٔ امکانات دوباره در دسترس قرار می‌گیرد.</p>'
     || '<p class="action"><a href="{billing_url}">انتخاب پلن</a></p>',
     'پلن {plan_name} فضای کاری {workspace} در {expired_at} به پایان رسید و فضای کاری به پلن رایگان منتقل شد.'
     || chr(10) || chr(10) || 'داده‌های شما حفظ می‌شوند. با خرید دوبارهٔ پلن، همهٔ امکانات دوباره در دسترس قرار می‌گیرد.'
     || chr(10) || chr(10) || 'انتخاب پلن: {billing_url}'),
  -- billing_expired (en)
  ('billing_expired', 'en', '46a3c4ea62c7e171ae292e928d471337',
     'Your {plan_name} plan has ended — {brand}',
     '<div class="preheader">{workspace} is now on the Free plan.</div>'
     || '<h1>Your plan has ended</h1>'
     || '<p>The {plan_name} plan of {workspace} has ended, and the workspace moved to the Free plan.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Ended on</th><td>{expired_at}</td></tr></table>'
     || '<p>Your data is kept. Choose a plan again to use every feature.</p>'
     || '<p class="action"><a href="{billing_url}">Choose a plan</a></p>',
     'The {plan_name} plan of {workspace} ended on {expired_at}, and the workspace moved to the Free plan.'
     || chr(10) || chr(10) || 'Your data is kept. Choose a plan again to use every feature.'
     || chr(10) || chr(10) || 'Choose a plan: {billing_url}'),
  -- billing_expired (tr)
  ('billing_expired', 'tr', 'd8405fbaecf6e6625c21985f8ec389f2',
     '{plan_name} planınız sona erdi — {brand}',
     '<div class="preheader">{workspace} artık Ücretsiz planda.</div>'
     || '<h1>Planınız sona erdi</h1>'
     || '<p>{workspace} çalışma alanının {plan_name} planı sona erdi ve çalışma alanı Ücretsiz plana geçti.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Bitiş tarihi</th><td>{expired_at}</td></tr></table>'
     || '<p>Verileriniz saklanıyor. Tüm özellikleri yeniden kullanmak için bir plan seçin.</p>'
     || '<p class="action"><a href="{billing_url}">Plan seç</a></p>',
     '{workspace} çalışma alanının {plan_name} planı {expired_at} tarihinde sona erdi ve çalışma alanı Ücretsiz plana geçti.'
     || chr(10) || chr(10) || 'Verileriniz saklanıyor. Tüm özellikleri yeniden kullanmak için bir plan seçin.'
     || chr(10) || chr(10) || 'Plan seç: {billing_url}'),
  -- billing_change_scheduled (fa)
  ('billing_change_scheduled', 'fa', 'ee8d54f12de9a7cde219eac7632f8ef7',
     'تغییر پلن ثبت شد — {brand}',
     '<div class="preheader">از {effective_at}، پلن {new_plan_name} جای {plan_name} را می‌گیرد.</div>'
     || '<h1>تغییر پلن ثبت شد</h1>'
     || '<p>پلن فضای کاری {workspace} از {effective_at} تغییر می‌کند.</p>'
     || '<table class="details"><tr><th>پلن فعلی</th><td>{plan_name}</td></tr><tr><th>پلن تازه</th><td>{new_plan_name}</td></tr><tr><th>از تاریخ</th><td>{effective_at}</td></tr></table>'
     || '<p>تغییر با تمدید دوره اعمال می‌شود: از موجودی، با پرداخت آنلاین یا با تمدید خودکار. اگر دوره تمدید نشود، فضای کاری به پلن رایگان منتقل می‌شود. تا آن روز می‌توانید این تغییر را لغو کنید.</p>'
     || '<p class="action"><a href="{billing_url}">مدیریت پلن</a></p>',
     'پلن فضای کاری {workspace} از {effective_at} تغییر می‌کند.'
     || chr(10) || chr(10) || 'پلن فعلی: {plan_name}' || chr(10) || 'پلن تازه: {new_plan_name}'
     || chr(10) || chr(10) || 'تغییر با تمدید دوره اعمال می‌شود: از موجودی، با پرداخت آنلاین یا با تمدید خودکار. اگر دوره تمدید نشود، فضای کاری به پلن رایگان منتقل می‌شود. تا آن روز می‌توانید این تغییر را لغو کنید.'
     || chr(10) || chr(10) || 'مدیریت پلن: {billing_url}'),
  -- billing_change_scheduled (en)
  ('billing_change_scheduled', 'en', '29615bcf6a0fbf344bceed7304cad088',
     'Plan change scheduled — {brand}',
     '<div class="preheader">{new_plan_name} replaces {plan_name} from {effective_at}.</div>'
     || '<h1>Your plan change is scheduled</h1>'
     || '<p>The plan of {workspace} changes on {effective_at}.</p>'
     || '<table class="details"><tr><th>Current plan</th><td>{plan_name}</td></tr><tr><th>New plan</th><td>{new_plan_name}</td></tr><tr><th>From</th><td>{effective_at}</td></tr></table>'
     || '<p>The change takes effect when the period is renewed: from your balance, online, or by auto-renew. If the period isn’t renewed, the workspace moves to the Free plan. You can cancel the change until then.</p>'
     || '<p class="action"><a href="{billing_url}">Manage plan</a></p>',
     'The plan of {workspace} changes on {effective_at}.'
     || chr(10) || chr(10) || 'Current plan: {plan_name}' || chr(10) || 'New plan: {new_plan_name}'
     || chr(10) || chr(10) || 'The change takes effect when the period is renewed: from your balance, online, or by auto-renew. If the period isn’t renewed, the workspace moves to the Free plan. You can cancel the change until then.'
     || chr(10) || chr(10) || 'Manage plan: {billing_url}'),
  -- billing_change_scheduled (tr)
  ('billing_change_scheduled', 'tr', '7bad6dc4258b6a249f1d702e629c3b96',
     'Plan değişikliği planlandı — {brand}',
     '<div class="preheader">{effective_at} tarihinden itibaren {plan_name} yerine {new_plan_name} geçerli olacak.</div>'
     || '<h1>Plan değişikliğiniz planlandı</h1>'
     || '<p>{workspace} çalışma alanının planı {effective_at} tarihinde değişiyor.</p>'
     || '<table class="details"><tr><th>Mevcut plan</th><td>{plan_name}</td></tr><tr><th>Yeni plan</th><td>{new_plan_name}</td></tr><tr><th>Başlangıç</th><td>{effective_at}</td></tr></table>'
     || '<p>Değişiklik dönem yenilendiğinde uygulanır: bakiyeden, çevrimiçi ödemeyle veya otomatik yenilemeyle. Dönem yenilenmezse çalışma alanı Ücretsiz plana geçer. O zamana kadar bu değişikliği iptal edebilirsiniz.</p>'
     || '<p class="action"><a href="{billing_url}">Planı yönet</a></p>',
     '{workspace} çalışma alanının planı {effective_at} tarihinde değişiyor.'
     || chr(10) || chr(10) || 'Mevcut plan: {plan_name}' || chr(10) || 'Yeni plan: {new_plan_name}'
     || chr(10) || chr(10) || 'Değişiklik dönem yenilendiğinde uygulanır: bakiyeden, çevrimiçi ödemeyle veya otomatik yenilemeyle. Dönem yenilenmezse çalışma alanı Ücretsiz plana geçer. O zamana kadar bu değişikliği iptal edebilirsiniz.'
     || chr(10) || chr(10) || 'Planı yönet: {billing_url}'),
  -- billing_payment_receipt (fa)
  ('billing_payment_receipt', 'fa', '7b8131ddb9d999bc541529a89829cc38',
     'رسید پرداخت {receipt_number} — {brand}',
     '<div class="preheader">پرداخت {amount} برای {workspace} انجام شد.</div>'
     || '<h1>رسید پرداخت</h1>'
     || '<p>پرداخت شما برای فضای کاری {workspace} انجام شد. سپاس از اعتمادتان.</p>'
     || '<table class="details"><tr><th>شمارهٔ رسید</th><td dir="ltr">{receipt_number}</td></tr><tr><th>مبلغ</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{receipt_url}">مشاهدهٔ رسید</a></p>',
     'پرداخت شما برای فضای کاری {workspace} انجام شد. سپاس از اعتمادتان.'
     || chr(10) || chr(10) || 'شمارهٔ رسید: {receipt_number}' || chr(10) || 'مبلغ: {amount}' || chr(10) || 'موجودی حساب: {balance}'
     || chr(10) || chr(10) || 'مشاهدهٔ رسید: {receipt_url}'),
  -- billing_payment_receipt (en)
  ('billing_payment_receipt', 'en', '2ea2ff54b7b8c4a5cb409dfeeb5be708',
     'Payment receipt {receipt_number} — {brand}',
     '<div class="preheader">Your payment of {amount} for {workspace} went through.</div>'
     || '<h1>Payment receipt</h1>'
     || '<p>We received your payment for {workspace}. Thank you.</p>'
     || '<table class="details"><tr><th>Receipt number</th><td>{receipt_number}</td></tr><tr><th>Amount</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{receipt_url}">View receipt</a></p>',
     'We received your payment for {workspace}. Thank you.'
     || chr(10) || chr(10) || 'Receipt number: {receipt_number}' || chr(10) || 'Amount: {amount}' || chr(10) || 'Account balance: {balance}'
     || chr(10) || chr(10) || 'View receipt: {receipt_url}'),
  -- billing_payment_receipt (tr)
  ('billing_payment_receipt', 'tr', 'ba1c0bd46b150ba1d10f51d90f2a2f38',
     'Ödeme makbuzu {receipt_number} — {brand}',
     '<div class="preheader">{workspace} için {amount} tutarındaki ödemeniz alındı.</div>'
     || '<h1>Ödeme makbuzu</h1>'
     || '<p>{workspace} için ödemeniz alındı. Teşekkür ederiz.</p>'
     || '<table class="details"><tr><th>Makbuz numarası</th><td>{receipt_number}</td></tr><tr><th>Tutar</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr></table>'
     || '<p class="action"><a href="{receipt_url}">Makbuzu görüntüle</a></p>',
     '{workspace} için ödemeniz alındı. Teşekkür ederiz.'
     || chr(10) || chr(10) || 'Makbuz numarası: {receipt_number}' || chr(10) || 'Tutar: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}'
     || chr(10) || chr(10) || 'Makbuzu görüntüle: {receipt_url}'),
  -- billing_trial_ending (fa)
  ('billing_trial_ending', 'fa', '9ae01cada871e31afa9286e1a7833b03',
     'دورهٔ آزمایشی {days_left} روز دیگر تمام می‌شود — {brand}',
     '<div class="preheader">برای ادامهٔ استفاده از همهٔ امکانات، پیش از {trial_end} یک پلن انتخاب کنید.</div>'
     || '<h1>دورهٔ آزمایشی رو به پایان است</h1>'
     || '<p>دورهٔ آزمایشی فضای کاری {workspace} در {trial_end} تمام می‌شود.</p>'
     || '<table class="details"><tr><th>پایان دورهٔ آزمایشی</th><td>{trial_end}</td></tr><tr><th>روزهای باقی‌مانده</th><td>{days_left}</td></tr></table>'
     || '<p>بعد از آن، فضای کاری با پلن رایگان ادامه می‌دهد. برای استفاده از همهٔ امکانات، یک پلن انتخاب کنید.</p>'
     || '<p class="action"><a href="{billing_url}">انتخاب پلن</a></p>',
     'دورهٔ آزمایشی فضای کاری {workspace} در {trial_end} تمام می‌شود؛ {days_left} روز دیگر.'
     || chr(10) || chr(10) || 'بعد از آن، فضای کاری با پلن رایگان ادامه می‌دهد. برای استفاده از همهٔ امکانات، یک پلن انتخاب کنید:' || chr(10) || '{billing_url}'),
  -- billing_trial_ending (en)
  ('billing_trial_ending', 'en', '63a5cb68773751f56d4c41540c4e2806',
     'Your trial ends on {trial_end} — {brand}',
     '<div class="preheader">Choose a plan before {trial_end} to keep every feature.</div>'
     || '<h1>Your trial is ending</h1>'
     || '<p>The trial of {workspace} ends on {trial_end}.</p>'
     || '<table class="details"><tr><th>Trial ends</th><td>{trial_end}</td></tr><tr><th>Days left</th><td>{days_left}</td></tr></table>'
     || '<p>After that, the workspace continues on the Free plan. Choose a plan to keep every feature.</p>'
     || '<p class="action"><a href="{billing_url}">Choose a plan</a></p>',
     'The trial of {workspace} ends on {trial_end}. Days left: {days_left}.'
     || chr(10) || chr(10) || 'After that, the workspace continues on the Free plan. Choose a plan to keep every feature:' || chr(10) || '{billing_url}'),
  -- billing_trial_ending (tr)
  ('billing_trial_ending', 'tr', 'ea8fa5df0431ce4ef8b2894d7a90d0ce',
     'Deneme süreniz {days_left} gün içinde bitiyor — {brand}',
     '<div class="preheader">Tüm özellikleri kullanmaya devam etmek için {trial_end} tarihinden önce bir plan seçin.</div>'
     || '<h1>Deneme süreniz bitiyor</h1>'
     || '<p>{workspace} çalışma alanının deneme süresi {trial_end} tarihinde bitiyor.</p>'
     || '<table class="details"><tr><th>Deneme sonu</th><td>{trial_end}</td></tr><tr><th>Kalan gün</th><td>{days_left}</td></tr></table>'
     || '<p>Sonrasında çalışma alanı Ücretsiz planla devam eder. Tüm özellikleri kullanmaya devam etmek için bir plan seçin.</p>'
     || '<p class="action"><a href="{billing_url}">Plan seç</a></p>',
     '{workspace} çalışma alanının deneme süresi {trial_end} tarihinde, {days_left} gün sonra bitiyor.'
     || chr(10) || chr(10) || 'Sonrasında çalışma alanı Ücretsiz planla devam eder. Tüm özellikleri kullanmaya devam etmek için bir plan seçin:' || chr(10) || '{billing_url}'),
  -- billing_trial_ended (fa)
  ('billing_trial_ended', 'fa', 'fe56e562c3411da98849036b9089fa69',
     'دورهٔ آزمایشی به پایان رسید — {brand}',
     '<div class="preheader">هر وقت بخواهید می‌توانید پلن بخرید؛ داده‌های {workspace} سر جایش است.</div>'
     || '<h1>دورهٔ آزمایشی به پایان رسید</h1>'
     || '<p>دورهٔ آزمایشی فضای کاری {workspace} به پایان رسید و اکنون پلن رایگان فعال است.</p>'
     || '<p>برای استفاده از همهٔ امکانات، یک پلن انتخاب کنید.</p>'
     || '<p class="action"><a href="{billing_url}">انتخاب پلن</a></p>',
     'دورهٔ آزمایشی فضای کاری {workspace} به پایان رسید و اکنون پلن رایگان فعال است.'
     || chr(10) || chr(10) || 'برای استفاده از همهٔ امکانات، یک پلن انتخاب کنید:' || chr(10) || '{billing_url}'),
  -- billing_trial_ended (en)
  ('billing_trial_ended', 'en', '129476d0101a343f7c1f1b6dfea0ee5f',
     'Your trial has ended — {brand}',
     '<div class="preheader">You can choose a plan at any time; everything in {workspace} is still there.</div>'
     || '<h1>Your trial has ended</h1>'
     || '<p>The trial of {workspace} has ended, and the Free plan is now active.</p>'
     || '<p>Choose a plan to use every feature.</p>'
     || '<p class="action"><a href="{billing_url}">Choose a plan</a></p>',
     'The trial of {workspace} has ended, and the Free plan is now active.'
     || chr(10) || chr(10) || 'Choose a plan to use every feature:' || chr(10) || '{billing_url}'),
  -- billing_trial_ended (tr)
  ('billing_trial_ended', 'tr', '52046e2df3bba733fe5a15b5b7cd890e',
     'Deneme süreniz sona erdi — {brand}',
     '<div class="preheader">İstediğiniz zaman bir plan seçebilirsiniz; {workspace} içindeki her şey yerinde.</div>'
     || '<h1>Deneme süreniz sona erdi</h1>'
     || '<p>{workspace} çalışma alanının deneme süresi sona erdi ve artık Ücretsiz plan etkin.</p>'
     || '<p>Tüm özellikleri kullanmak için bir plan seçin.</p>'
     || '<p class="action"><a href="{billing_url}">Plan seç</a></p>',
     '{workspace} çalışma alanının deneme süresi sona erdi ve artık Ücretsiz plan etkin.'
     || chr(10) || chr(10) || 'Tüm özellikleri kullanmak için bir plan seçin:' || chr(10) || '{billing_url}'),
  -- billing_card_payment_failed (fa)
  ('billing_card_payment_failed', 'fa', '15e5809fbbc52e8e60782389370e3190',
     'پرداخت تمدید با کارت انجام نشد — {brand}',
     '<div class="preheader">برای اینکه پلن {plan_name} قطع نشود، پیش از {due_at} کارت را به‌روز کنید.</div>'
     || '<h1>پرداخت با کارت انجام نشد</h1>'
     || '<div class="warning">مبلغ تمدید پلن {plan_name} فضای کاری {workspace} از کارت شما برداشت نشد: {failure_reason}.</div>'
     || '<p>تا {due_at} فرصت دارید کارت را به‌روز کنید و بپردازید، یا پلن را از موجودی حساب تمدید کنید. در غیر این صورت، فضای کاری در همان روز به پلن رایگان منتقل می‌شود.</p>'
     || '<table class="details"><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>مبلغ</th><td>{amount}</td></tr><tr><th>کارت</th><td dir="ltr">{card}</td></tr><tr><th>مهلت پرداخت</th><td>{due_at}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">به‌روزرسانی کارت و پرداخت</a></p>',
     'مبلغ تمدید پلن {plan_name} فضای کاری {workspace} از کارت شما برداشت نشد: {failure_reason}.'
     || chr(10) || chr(10) || 'مبلغ: {amount}' || chr(10) || 'کارت: {card}' || chr(10) || 'مهلت پرداخت: {due_at}'
     || chr(10) || chr(10) || 'تا {due_at} فرصت دارید کارت را به‌روز کنید و بپردازید، یا پلن را از موجودی حساب تمدید کنید. در غیر این صورت، فضای کاری در همان روز به پلن رایگان منتقل می‌شود.'
     || chr(10) || chr(10) || 'به‌روزرسانی کارت و پرداخت: {billing_url}'),
  -- billing_card_payment_failed (en)
  ('billing_card_payment_failed', 'en', '473fbe86b051a4ffc04795d57ecdbd97',
     'Your card payment didn’t go through — {brand}',
     '<div class="preheader">Update your card before {due_at} to keep the {plan_name} plan.</div>'
     || '<h1>Card payment failed</h1>'
     || '<div class="warning">We couldn’t charge your card for the renewal of the {plan_name} plan of {workspace}: {failure_reason}.</div>'
     || '<p>You have until {due_at} to update your card and pay, or to renew from your balance. Otherwise the workspace moves to the Free plan on that day.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Amount</th><td>{amount}</td></tr><tr><th>Card</th><td>{card}</td></tr><tr><th>Pay by</th><td>{due_at}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">Update card and pay</a></p>',
     'We couldn’t charge your card for the renewal of the {plan_name} plan of {workspace}: {failure_reason}.'
     || chr(10) || chr(10) || 'Amount: {amount}' || chr(10) || 'Card: {card}' || chr(10) || 'Pay by: {due_at}'
     || chr(10) || chr(10) || 'You have until {due_at} to update your card and pay, or to renew from your balance. Otherwise the workspace moves to the Free plan on that day.'
     || chr(10) || chr(10) || 'Update card and pay: {billing_url}'),
  -- billing_card_payment_failed (tr)
  ('billing_card_payment_failed', 'tr', '698c928c8df59567583df7903cc9ab5c',
     'Kart ödemeniz gerçekleşmedi — {brand}',
     '<div class="preheader">{plan_name} planınızı korumak için kartınızı {due_at} tarihinden önce güncelleyin.</div>'
     || '<h1>Kart ödemesi başarısız oldu</h1>'
     || '<div class="warning">{workspace} çalışma alanının {plan_name} planını yenileme ödemesi kartınızdan alınamadı: {failure_reason}.</div>'
     || '<p>Kartınızı güncelleyip ödemek ya da planı bakiyenizden yenilemek için {due_at} tarihine kadar vaktiniz var. Aksi halde çalışma alanı o gün Ücretsiz plana geçer.</p>'
     || '<table class="details"><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Tutar</th><td>{amount}</td></tr><tr><th>Kart</th><td>{card}</td></tr><tr><th>Son ödeme tarihi</th><td>{due_at}</td></tr></table>'
     || '<p class="action"><a href="{billing_url}">Kartı güncelle ve öde</a></p>',
     '{workspace} çalışma alanının {plan_name} planını yenileme ödemesi kartınızdan alınamadı: {failure_reason}.'
     || chr(10) || chr(10) || 'Tutar: {amount}' || chr(10) || 'Kart: {card}' || chr(10) || 'Son ödeme tarihi: {due_at}'
     || chr(10) || chr(10) || 'Kartınızı güncelleyip ödemek ya da planı bakiyenizden yenilemek için {due_at} tarihine kadar vaktiniz var. Aksi halde çalışma alanı o gün Ücretsiz plana geçer.'
     || chr(10) || chr(10) || 'Kartı güncelle ve öde: {billing_url}'),
  -- billing_card_removed (fa)
  ('billing_card_removed', 'fa', 'ed05dbfbea2af7c6cefc8a3051c24dfd',
     'کارت ذخیره‌شده حذف شد — {brand}',
     '<div class="preheader">از این کارت دیگر برداشتی انجام نمی‌شود؛ دورهٔ پرداخت‌شده تا {period_end} ادامه دارد.</div>'
     || '<h1>کارت ذخیره‌شده حذف شد</h1>'
     || '<p>کارت شما دیگر برای تمدید خودکار پلن {plan_name} فضای کاری {workspace} ذخیره نیست و از آن برداشتی انجام نمی‌شود.</p>'
     || '<table class="details"><tr><th>کارت</th><td dir="ltr">{card}</td></tr><tr><th>دلیل</th><td>{reason}</td></tr><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>پرداخت‌شده تا</th><td>{period_end}</td></tr></table>'
     || '<p>برای ادامهٔ پلن پس از این تاریخ، آن را از موجودی حساب تمدید کنید یا در صفحهٔ صورتحساب آنلاین بپردازید. هر وقت بخواهید می‌توانید دوباره کارت اضافه کنید.</p>'
     || '<p class="action"><a href="{billing_url}">مشاهدهٔ صورتحساب</a></p>',
     'کارت شما دیگر برای تمدید خودکار پلن {plan_name} فضای کاری {workspace} ذخیره نیست و از آن برداشتی انجام نمی‌شود.'
     || chr(10) || chr(10) || 'کارت: {card}' || chr(10) || 'دلیل: {reason}' || chr(10) || 'پرداخت‌شده تا: {period_end}'
     || chr(10) || chr(10) || 'برای ادامهٔ پلن پس از این تاریخ، آن را از موجودی حساب تمدید کنید یا در صفحهٔ صورتحساب آنلاین بپردازید. هر وقت بخواهید می‌توانید دوباره کارت اضافه کنید.'
     || chr(10) || chr(10) || 'صورتحساب: {billing_url}'),
  -- billing_card_removed (en)
  ('billing_card_removed', 'en', '4e8433c9ea3f8bb192a2cb552d678e7f',
     'Your saved card was removed — {brand}',
     '<div class="preheader">It won’t be charged again. Your paid period lasts until {period_end}.</div>'
     || '<h1>Saved card removed</h1>'
     || '<p>Your card is no longer saved for the automatic renewal of the {plan_name} plan of {workspace}, and it won’t be charged again.</p>'
     || '<table class="details"><tr><th>Card</th><td>{card}</td></tr><tr><th>Reason</th><td>{reason}</td></tr><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Paid until</th><td>{period_end}</td></tr></table>'
     || '<p>To keep the plan after that date, renew it from your balance or pay online on the billing page. You can add a card again at any time.</p>'
     || '<p class="action"><a href="{billing_url}">View billing</a></p>',
     'Your card is no longer saved for the automatic renewal of the {plan_name} plan of {workspace}, and it won’t be charged again.'
     || chr(10) || chr(10) || 'Card: {card}' || chr(10) || 'Reason: {reason}' || chr(10) || 'Paid until: {period_end}'
     || chr(10) || chr(10) || 'To keep the plan after that date, renew it from your balance or pay online on the billing page. You can add a card again at any time.'
     || chr(10) || chr(10) || 'Billing: {billing_url}'),
  -- billing_card_removed (tr)
  ('billing_card_removed', 'tr', '4cf8bf57b0274dbfcaf1c7c9b415598b',
     'Kayıtlı kartınız kaldırıldı — {brand}',
     '<div class="preheader">Karttan artık ödeme alınmayacak. Ödenmiş döneminiz {period_end} tarihine kadar sürer.</div>'
     || '<h1>Kayıtlı kart kaldırıldı</h1>'
     || '<p>Kartınız artık {workspace} çalışma alanının {plan_name} planının otomatik yenilemesi için kayıtlı değil ve bu karttan yeniden ödeme alınmayacak.</p>'
     || '<table class="details"><tr><th>Kart</th><td>{card}</td></tr><tr><th>Neden</th><td>{reason}</td></tr><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Ödenmiş dönem sonu</th><td>{period_end}</td></tr></table>'
     || '<p>Planı bu tarihten sonra da kullanmak için bakiyenizden yenileyin veya faturalandırma sayfasından çevrimiçi ödeme yapın. İstediğiniz zaman yeniden kart ekleyebilirsiniz.</p>'
     || '<p class="action"><a href="{billing_url}">Faturalandırmayı görüntüle</a></p>',
     'Kartınız artık {workspace} çalışma alanının {plan_name} planının otomatik yenilemesi için kayıtlı değil ve bu karttan yeniden ödeme alınmayacak.'
     || chr(10) || chr(10) || 'Kart: {card}' || chr(10) || 'Neden: {reason}' || chr(10) || 'Ödenmiş dönem sonu: {period_end}'
     || chr(10) || chr(10) || 'Planı bu tarihten sonra da kullanmak için bakiyenizden yenileyin veya faturalandırma sayfasından çevrimiçi ödeme yapın. İstediğiniz zaman yeniden kart ekleyebilirsiniz.'
     || chr(10) || chr(10) || 'Faturalandırma: {billing_url}'),
  -- billing_locked_data_deletion (fa)
  ('billing_locked_data_deletion', 'fa', '24eb23c95649b8ee43f94a87e5b0c402',
     'داده‌های قفل‌شده {days_left} روز دیگر حذف می‌شوند — {brand}',
     '<div class="preheader">برای نگه داشتن آن‌ها پلن را ارتقا دهید یا پیش از {deletion_date} از آن‌ها خروجی بگیرید.</div>'
     || '<h1>داده‌های قفل‌شده حذف می‌شوند</h1>'
     || '<div class="warning">بخشی از داده‌های فضای کاری {workspace} که از سقف پلن {plan_name} بیشتر است، قفل شده و در {deletion_date}، {days_left} روز دیگر، برای همیشه حذف می‌شود.</div>'
     || '<table class="details"><tr><th>داده‌های قفل‌شده</th><td>{locked_summary}</td></tr><tr><th>پلن</th><td>{plan_name}</td></tr><tr><th>تاریخ حذف</th><td>{deletion_date}</td></tr></table>'
     || '<p>برای نگه داشتن این داده‌ها، پلن را ارتقا دهید یا پیش از این تاریخ از آن‌ها خروجی بگیرید.</p>'
     || '<p class="action"><a href="{billing_url}">ارتقای پلن</a></p>'
     || '<p class="note"><a href="{export_url}">دریافت خروجی داده‌های قفل‌شده</a></p>',
     'بخشی از داده‌های فضای کاری {workspace} که از سقف پلن {plan_name} بیشتر است، قفل شده و در {deletion_date}، {days_left} روز دیگر، برای همیشه حذف می‌شود.'
     || chr(10) || chr(10) || 'داده‌های قفل‌شده: {locked_summary}'
     || chr(10) || chr(10) || 'برای نگه داشتن این داده‌ها، پلن را ارتقا دهید یا پیش از این تاریخ از آن‌ها خروجی بگیرید.'
     || chr(10) || chr(10) || 'ارتقای پلن: {billing_url}' || chr(10) || 'دریافت خروجی: {export_url}'),
  -- billing_locked_data_deletion (en)
  ('billing_locked_data_deletion', 'en', '32c8fe4067edef6d0feba3872d67a38e',
     'Locked data will be deleted on {deletion_date} — {brand}',
     '<div class="preheader">Upgrade to keep it, or export it before {deletion_date}.</div>'
     || '<h1>Locked data will be deleted</h1>'
     || '<div class="warning">Data in {workspace} over the limits of the {plan_name} plan is locked, and on {deletion_date} it will be deleted for good.</div>'
     || '<table class="details"><tr><th>Locked data</th><td>{locked_summary}</td></tr><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Deletion date</th><td>{deletion_date}</td></tr><tr><th>Days left</th><td>{days_left}</td></tr></table>'
     || '<p>To keep this data, upgrade the plan or export it before that date.</p>'
     || '<p class="action"><a href="{billing_url}">Upgrade plan</a></p>'
     || '<p class="note"><a href="{export_url}">Export locked data</a></p>',
     'Data in {workspace} over the limits of the {plan_name} plan is locked, and on {deletion_date} it will be deleted for good. Days left: {days_left}.'
     || chr(10) || chr(10) || 'Locked data: {locked_summary}'
     || chr(10) || chr(10) || 'To keep this data, upgrade the plan or export it before that date.'
     || chr(10) || chr(10) || 'Upgrade plan: {billing_url}' || chr(10) || 'Export locked data: {export_url}'),
  -- billing_locked_data_deletion (tr)
  ('billing_locked_data_deletion', 'tr', 'f43aef169cca57ce1aaaccc929c95e8c',
     'Kilitli veriler {days_left} gün içinde silinecek — {brand}',
     '<div class="preheader">Saklamak için planınızı yükseltin ya da {deletion_date} tarihinden önce dışa aktarın.</div>'
     || '<h1>Kilitli veriler silinecek</h1>'
     || '<div class="warning">{workspace} çalışma alanında {plan_name} planının sınırlarını aşan veriler kilitlendi ve {deletion_date} tarihinde, {days_left} gün sonra kalıcı olarak silinecek.</div>'
     || '<table class="details"><tr><th>Kilitli veriler</th><td>{locked_summary}</td></tr><tr><th>Plan</th><td>{plan_name}</td></tr><tr><th>Silinme tarihi</th><td>{deletion_date}</td></tr></table>'
     || '<p>Bu verileri saklamak için planınızı yükseltin ya da o tarihten önce dışa aktarın.</p>'
     || '<p class="action"><a href="{billing_url}">Planı yükselt</a></p>'
     || '<p class="note"><a href="{export_url}">Kilitli verileri dışa aktar</a></p>',
     '{workspace} çalışma alanında {plan_name} planının sınırlarını aşan veriler kilitlendi ve {deletion_date} tarihinde, {days_left} gün sonra kalıcı olarak silinecek.'
     || chr(10) || chr(10) || 'Kilitli veriler: {locked_summary}'
     || chr(10) || chr(10) || 'Bu verileri saklamak için planınızı yükseltin ya da o tarihten önce dışa aktarın.'
     || chr(10) || chr(10) || 'Planı yükselt: {billing_url}' || chr(10) || 'Dışa aktar: {export_url}'),
  -- billing_ai_pack_purchased (fa)
  ('billing_ai_pack_purchased', 'fa', '5c9815c4827b8ab36329382bfeb626bd',
     'اعتبار هوش مصنوعی اضافه شد: {credit} — {brand}',
     '<div class="preheader">این اعتبار با پایان پلن از بین نمی‌رود.</div>'
     || '<h1>اعتبار هوش مصنوعی اضافه شد</h1>'
     || '<p>بستهٔ اعتبار هوش مصنوعی که خریدید به فضای کاری {workspace} اضافه شد.</p>'
     || '<table class="details"><tr><th>بسته</th><td>{pack_name}</td></tr><tr><th>اعتبار اضافه‌شده</th><td>{credit}</td></tr><tr><th>مبلغ پرداخت‌شده</th><td>{amount}</td></tr><tr><th>موجودی حساب</th><td>{balance}</td></tr><tr><th>اعتبار هوش مصنوعی اکنون</th><td>{ai_balance}</td></tr></table>'
     || '<p>این اعتبار با پایان پلن از بین نمی‌رود.</p>'
     || '<p class="action"><a href="{billing_url}">مشاهدهٔ صورتحساب</a></p>',
     'بستهٔ اعتبار هوش مصنوعی که خریدید به فضای کاری {workspace} اضافه شد. این اعتبار با پایان پلن از بین نمی‌رود.'
     || chr(10) || chr(10) || 'بسته: {pack_name}' || chr(10) || 'اعتبار اضافه‌شده: {credit}' || chr(10) || 'مبلغ پرداخت‌شده: {amount}' || chr(10) || 'موجودی حساب: {balance}' || chr(10) || 'اعتبار هوش مصنوعی اکنون: {ai_balance}'
     || chr(10) || chr(10) || 'صورتحساب: {billing_url}'),
  -- billing_ai_pack_purchased (en)
  ('billing_ai_pack_purchased', 'en', '31993c6b59d1a2dea264d763db6bec86',
     'AI credit added: {credit} — {brand}',
     '<div class="preheader">This credit doesn’t expire with your plan.</div>'
     || '<h1>AI credit added</h1>'
     || '<p>The AI credit pack you bought was added to {workspace}.</p>'
     || '<table class="details"><tr><th>Pack</th><td>{pack_name}</td></tr><tr><th>Credit added</th><td>{credit}</td></tr><tr><th>Paid</th><td>{amount}</td></tr><tr><th>Account balance</th><td>{balance}</td></tr><tr><th>AI credit now</th><td>{ai_balance}</td></tr></table>'
     || '<p>This credit doesn’t expire with your plan.</p>'
     || '<p class="action"><a href="{billing_url}">View billing</a></p>',
     'The AI credit pack you bought was added to {workspace}. This credit doesn’t expire with your plan.'
     || chr(10) || chr(10) || 'Pack: {pack_name}' || chr(10) || 'Credit added: {credit}' || chr(10) || 'Paid: {amount}' || chr(10) || 'Account balance: {balance}' || chr(10) || 'AI credit now: {ai_balance}'
     || chr(10) || chr(10) || 'Billing: {billing_url}'),
  -- billing_ai_pack_purchased (tr)
  ('billing_ai_pack_purchased', 'tr', '1594e0f60fba6be2102ead864c1c8730',
     'Yapay zekâ kredisi eklendi: {credit} — {brand}',
     '<div class="preheader">Bu kredi planınızla birlikte sona ermez.</div>'
     || '<h1>Yapay zekâ kredisi eklendi</h1>'
     || '<p>Satın aldığınız yapay zekâ kredi paketi {workspace} çalışma alanına eklendi.</p>'
     || '<table class="details"><tr><th>Paket</th><td>{pack_name}</td></tr><tr><th>Eklenen kredi</th><td>{credit}</td></tr><tr><th>Ödenen</th><td>{amount}</td></tr><tr><th>Hesap bakiyesi</th><td>{balance}</td></tr><tr><th>Güncel yapay zekâ kredisi</th><td>{ai_balance}</td></tr></table>'
     || '<p>Bu kredi planınızla birlikte sona ermez.</p>'
     || '<p class="action"><a href="{billing_url}">Faturalandırmayı görüntüle</a></p>',
     'Satın aldığınız yapay zekâ kredi paketi {workspace} çalışma alanına eklendi. Bu kredi planınızla birlikte sona ermez.'
     || chr(10) || chr(10) || 'Paket: {pack_name}' || chr(10) || 'Eklenen kredi: {credit}' || chr(10) || 'Ödenen: {amount}' || chr(10) || 'Hesap bakiyesi: {balance}' || chr(10) || 'Güncel yapay zekâ kredisi: {ai_balance}'
     || chr(10) || chr(10) || 'Faturalandırma: {billing_url}');

-- ─── 2. Replace what is still as seeded, add what is missing, name the rest ─

DO $m291$
DECLARE
  v_kept text;
  v_off text;
  v_replaced integer;
  v_added integer;
BEGIN
  -- Rows a Super Admin changed: neither the seeded text nor the new one.
  SELECT string_agg(format('%s/%s/%s', t.edition, t.slug, t.locale), ', ' ORDER BY t.slug, t.locale, t.edition)
    INTO v_kept
    FROM public.email_templates t
    JOIN pg_temp._email_291 n ON n.slug = t.slug AND n.locale = t.locale
   WHERE t.workspace_id IS NULL
     AND md5(t.subject || t.html_body || coalesce(t.text_body, '')) IS DISTINCT FROM n.seeded_md5
     AND md5(t.subject || t.html_body || coalesce(t.text_body, '')) IS DISTINCT FROM md5(n.subject || n.html_body || coalesce(n.text_body, ''));

  -- Sent rows switched off: replaced like the others, but left off.
  SELECT string_agg(format('%s/%s/%s', t.edition, t.slug, t.locale), ', ' ORDER BY t.slug, t.locale, t.edition)
    INTO v_off
    FROM public.email_templates t
    JOIN pg_temp._email_291 n ON n.slug = t.slug AND n.locale = t.locale
   WHERE t.workspace_id IS NULL AND t.is_active IS NOT TRUE;

  UPDATE public.email_templates t
     SET subject = n.subject,
         html_body = n.html_body,
         text_body = n.text_body
    FROM pg_temp._email_291 n
   WHERE t.workspace_id IS NULL
     AND t.slug = n.slug
     AND t.locale = n.locale
     AND md5(t.subject || t.html_body || coalesce(t.text_body, '')) = n.seeded_md5;
  GET DIAGNOSTICS v_replaced = ROW_COUNT;

  INSERT INTO public.email_templates (workspace_id, edition, slug, locale, subject, html_body, text_body, is_active)
  SELECT NULL, e.edition, n.slug, n.locale, n.subject, n.html_body, n.text_body, true
    FROM pg_temp._email_291 n
   CROSS JOIN (VALUES ('iran'), ('international')) AS e(edition)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.email_templates t
      WHERE t.workspace_id IS NULL AND t.edition = e.edition AND t.slug = n.slug AND t.locale = n.locale
   );
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RAISE NOTICE '291: % rows replaced, % added', v_replaced, v_added;
  IF v_kept IS NOT NULL THEN
    RAISE NOTICE '291: kept as the Super Admin wrote them (not replaced): %', v_kept;
  END IF;
  IF v_off IS NOT NULL THEN
    RAISE NOTICE '291: switched off (left off): %', v_off;
  END IF;
END
$m291$;

-- ─── 3. Proof ─────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_missing integer;
  v_documents integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM pg_temp._email_291 n
   CROSS JOIN (VALUES ('iran'), ('international')) AS e(edition)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.email_templates t
      WHERE t.workspace_id IS NULL AND t.edition = e.edition AND t.slug = n.slug AND t.locale = n.locale
   );
  IF v_missing > 0 THEN
    RAISE EXCEPTION '291: % sent templates have no row', v_missing;
  END IF;
  -- The new content is content: the layout is the email core's.
  SELECT count(*) INTO v_documents FROM pg_temp._email_291 WHERE html_body ~* '<html|<body|<head';
  IF v_documents > 0 OR (SELECT count(*) FROM pg_temp._email_291) <> 84 THEN
    RAISE EXCEPTION '291: the new content is not the 84 content rows it should be';
  END IF;
END
$verify$;

DROP TABLE pg_temp._email_291;

RESET lock_timeout;
