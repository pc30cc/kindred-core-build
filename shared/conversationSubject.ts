/**
 * Conversation subjects the server writes when nobody typed one: the widget
 * and the AI store 'New conversation' (ai-agent/intro.ts), an offline
 * capture 'Offline message' (routes/widget.ts). They are English, so a
 * reader never sees them as a title: the dashboard shows its own localized
 * "untitled", and an email prints '—'. Pure: dashboard and server alike.
 */
export const PLACEHOLDER_SUBJECTS: ReadonlySet<string> = new Set([
  'new conversation',
  'new chat',
  'untitled conversation',
  'untitled',
  '[attachment]',
  'offline message',
]);

/** True for no subject at all, or one of PLACEHOLDER_SUBJECTS (any case, trimmed). */
export function isPlaceholderSubject(subject?: string | null): boolean {
  const s = (subject ?? '').trim().toLowerCase();
  return !s || PLACEHOLDER_SUBJECTS.has(s);
}
