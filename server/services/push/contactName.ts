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

export interface NamedContact {
  name?: string | null;
  email?: string | null;
  visitor_code?: string | null;
}

/** `Str.unknownVisitor` in the apps. */
const VISITOR: Record<'en' | 'fa' | 'tr', string> = {
  en: 'Visitor',
  fa: 'بازدیدکننده',
  tr: 'Ziyaretçi',
};

/**
 * The contact's own name, or null: older anonymous contacts still carry the
 * literal 'Visitor' (widget/anonymousContact.ts ANON_CONTACT_NAME), which
 * the dashboard treats as no name; read as a name it put English on a
 * Persian lock screen.
 */
function realName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed && trimmed.toLowerCase() !== 'visitor' ? (name as string) : null;
}

function language(locale: string | null | undefined): 'en' | 'fa' | 'tr' {
  const base = String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

export function contactDisplayName(contact: NamedContact | null | undefined, locale: string | null | undefined): string {
  const name = realName(contact?.name);
  if (name) return name;
  const email = contact?.email;
  if (email) {
    const at = email.indexOf('@');
    return at > 0 ? email.slice(0, at) : email;
  }
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
  const name = realName(contact?.name);
  if (name) return name;
  const email = contact?.email;
  if (email) {
    const at = email.indexOf('@');
    return at > 0 ? email.slice(0, at) : email;
  }
  return null;
}
