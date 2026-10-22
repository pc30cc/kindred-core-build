/**
 * What every operator surface calls a contact by their own data (finding
 * I-07): their name; else the part of their email before the @; else nothing
 * (an anonymous visitor, whom each surface names in its own language with
 * the visitor code).
 *
 * The phone apps' lists (`Format.contactName` on Android and iOS) and the
 * push notifications (server/services/push/contactName.ts) always named an
 * email-only visitor by the email's local part, while the web Inbox called
 * the same visitor «بازدیدکننده از {شهر} · کد», so the name on the lock
 * screen («ali.r») was nowhere in the web list. One rule now, for the
 * server and the dashboard alike. Pure, no I/O.
 */

export interface NamedContact {
  name?: string | null;
  email?: string | null;
  visitor_code?: string | null;
}

/**
 * The contact's own name, or null: blank, or the literal 'Visitor' older
 * anonymous contacts still carry (widget/anonymousContact.ts
 * ANON_CONTACT_NAME), which is no name.
 */
export function realContactName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed && trimmed.toLowerCase() !== 'visitor' ? (name as string) : null;
}

/** The part of an email before the @ (the whole value when there is none before it). */
export function emailLocalPart(email: string | null | undefined): string | null {
  const value = (email ?? '').trim();
  if (!value) return null;
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}

/**
 * The part of a contact's name that is the same in every language — their
 * name, or their email's local part — or null for an anonymous visitor.
 */
export function contactOwnName(contact: NamedContact | null | undefined): string | null {
  return realContactName(contact?.name) ?? emailLocalPart(contact?.email);
}
