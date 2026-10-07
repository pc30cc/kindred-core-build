-- 252 — the platform email settings stop holding placeholder sender identities.
--
-- Platform mail is sent as `from_name <from_email>` from the email provider
-- (Super Admin → Providers → Email; resolveFromAddress in
-- server/services/email/index.ts), falling back to the platform name in
-- platform_branding_localized. Nothing reads email_settings.sender_email or
-- email_settings_localized.sender_name (src/test/architecture/
-- emailProviderOwnership.test.ts keeps it that way); the columns stay for
-- rollback.
--
-- They still held values from the template the platform started on: the
-- platform rows of email_settings_localized said "My Platform" (en),
-- "پلتفرم من" (fa) and "Destekly" (tr), and email_settings.sender_email said
-- noreply@example.com, the invented address the send path refuses to use. To
-- anyone reading the table they looked like the names and address the
-- platform's mail goes out under, and they are not.
--
-- This clears exactly those placeholder values on the platform rows and drops
-- the column default that would write noreply@example.com into a new platform
-- row (PUT /api/admin/management/email-settings inserts one with
-- reply_to_email only). Workspace rows and any other value are left alone.
-- Re-runnable: a second run matches nothing.

UPDATE public.email_settings_localized
   SET sender_name = NULL,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND sender_name IN ('My Platform', 'پلتفرم من', 'Destekly');

UPDATE public.email_settings
   SET sender_email = NULL,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND sender_email = 'noreply@example.com';

ALTER TABLE public.email_settings ALTER COLUMN sender_email DROP DEFAULT;
