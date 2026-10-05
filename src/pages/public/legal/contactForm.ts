import { CONTACT_PAGE, LEGAL_CONTACT_EMAIL } from './legalDocuments';

export type ContactFields = { name: string; email: string; subject: string; message: string };

/** The first thing wrong with the form, in the site's own rules, or null. */
export function contactFormError(fields: ContactFields): string | null {
  const { errors } = CONTACT_PAGE.form;
  if (fields.name.trim().length < 2) return errors.name;
  if (!/^\S+@\S+\.\S+$/.test(fields.email.trim())) return errors.email;
  if (fields.subject.trim().length < 2) return errors.subject;
  if (fields.message.trim().length < 5) return errors.message;
  return null;
}

/** The message as a `mailto:` link, signed with who wrote it. */
export function contactMailto(fields: ContactFields): string {
  const signature = CONTACT_PAGE.form.signature
    .replace('{name}', fields.name.trim())
    .replace('{email}', fields.email.trim());
  const body = `${fields.message.trim()}\n\n${signature}`;
  return `mailto:${LEGAL_CONTACT_EMAIL}?subject=${encodeURIComponent(fields.subject.trim())}&body=${encodeURIComponent(body)}`;
}
