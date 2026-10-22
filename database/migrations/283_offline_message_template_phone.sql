-- 283 — The visitor's phone in the owners' "new offline message" mail
-- (email_templates, slug offline_message_received: the mail to the
-- workspace's owners when a visitor leaves a message while away). Moved out
-- of 280 so it can be applied AFTER the backend that fills it.
--
-- The platform rows get a Phone row under Email in the HTML and the phone
-- after the email in the text, as {contact_phone} (a visitor who left only a
-- phone could not be called back). Only rows whose details table still ends
-- with the seeded Email row and that have no {contact_phone} yet get the row
-- added; a template the Super Admin rewrote without it stays exactly as
-- written.
--
-- DEPLOY ORDER: an older backend sends this mail without contact_phone, and
-- the mail renderer leaves an unknown placeholder as it is, so with this
-- file applied the old backend's mails would read "Phone: {contact_phone}".
-- On WebYar apply it only once the backend of this release is deployed
-- (docs/operations/CHAT_ROUTING.md, Rollout checklist, step 8), not with
-- 278-282b before the merge. RESPOK's migrator applies it on push, while
-- its backend deploys: a few minutes of the raw placeholder at worst, in an
-- internal mail.
--
-- Locks: ROW EXCLUSIVE on email_templates for the UPDATE (the platform's
-- six rows). The file sets lock_timeout 5s itself and resets it (RESPOK's
-- migrator runs without PGOPTIONS); a statement stopped by it is simply run
-- again. Re-runnable: a second run updates nothing. Dry run: the file inside
-- BEGIN … ROLLBACK. Drops nothing; touches no archive schema or table.

SET lock_timeout = '5s';

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
