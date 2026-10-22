/**
 * What a notification calls a customer: exactly what the operator's app calls
 * them in its inbox list.
 *
 * The Android and iOS apps both name a contact with `Format.contactName`:
 * their name; else the part of their email before the @; else "Visitor"
 * followed by their stable visitor code, so two anonymous visitors are still
 * told apart; else "Visitor" alone. This is that function, word for word, in
 * the recipient's language — so the name on the lock screen is the name the
 * operator then finds in the list, and a visitor who later gives their name
 * is called by it from their next message on.
 *
 * Notifications used to take the name the widget sent with the message,
 * which an anonymous visitor never has, and fall back to "Customer" — every
 * visitor was the same word.
 */

import { contactOwnName as sharedContactOwnName, type NamedContact } from '../../../shared/contactName.js';

export type { NamedContact };

/** `Str.unknownVisitor` in the apps. */
const VISITOR: Record<'en' | 'fa' | 'tr', string> = {
  en: 'Visitor',
  fa: 'بازدیدکننده',
  tr: 'Ziyaretçi',
};

function language(locale: string | null | undefined): 'en' | 'fa' | 'tr' {
  const base = String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/**
 * Their name, else their email's local part (the rule every operator surface
 * shares, shared/contactName.ts — the web Inbox included), else "Visitor"
 * and their code in the recipient's language. Older anonymous contacts still
 * carry the literal 'Visitor' as a name, which counts as none: read as a
 * name it put English on a Persian lock screen.
 */
export function contactDisplayName(contact: NamedContact | null | undefined, locale: string | null | undefined): string {
  const own = sharedContactOwnName(contact);
  if (own) return own;
  const visitor = VISITOR[language(locale)];
  const code = contact?.visitor_code;
  if (code) return `${visitor} ${code}`;
  return visitor;
}

/**
 * The part of a contact's name that is the same in every language — their
 * name, or their email's local part — or null for an anonymous visitor, whom
 * each phone names in its own language from the visitor code.
 */
export function contactOwnName(contact: NamedContact | null | undefined): string | null {
  return sharedContactOwnName(contact);
}
