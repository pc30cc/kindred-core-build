/**
 * A person's categorical slot (1-5) for themes (`data-avatar-tone`, Art's
 * src/themes/art/inbox.css), the same in every place a person appears: the
 * inbox, the email inbox, contacts, visitors. Keyed on the normalised email
 * address when one is known (the inbox and the email inbox know the same
 * person by different names), on the name otherwise.
 */
export function personTone(email?: string | null, name?: string | null): number {
  const key = (email || '').trim().toLowerCase() || (name || '').trim().toLowerCase() || '?';
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash) ^ key.charCodeAt(i);
  return ((hash >>> 0) % 5) + 1;
}
