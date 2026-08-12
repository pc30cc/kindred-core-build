/**
 * Display name for a contact in operator surfaces.
 *
 * Anonymous visitors get a placeholder contact row (name === 'Visitor')
 * created the moment a conversation starts — including AI-only threads.
 * Showing every one of them as just "Visitor" makes the inbox unreadable,
 * so we append the short stable code stored on the contact metadata
 * (falling back to the conversation id) → "Visitor #4F2A".
 */
export interface DisplayableContact {
  name?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
}

const PLACEHOLDER = 'visitor';

export function isAnonymousContact(contact?: DisplayableContact | null): boolean {
  if (!contact) return true;
  const n = (contact.name ?? '').trim().toLowerCase();
  return (!n || n === PLACEHOLDER) && !contact.email;
}

export function contactDisplayName(
  contact: DisplayableContact | null | undefined,
  fallbackId?: string | null,
  visitorLabel = 'Visitor',
): string {
  const name = (contact?.name ?? '').trim();
  if (name && name.toLowerCase() !== PLACEHOLDER) return name;
  if (contact?.email) return contact.email;
  const code =
    (contact?.metadata as any)?.anon_code
    || (fallbackId ? fallbackId.replace(/-/g, '').slice(0, 4).toUpperCase() : null);
  return code ? `${visitorLabel} #${code}` : visitorLabel;
}
