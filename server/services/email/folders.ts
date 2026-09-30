/**
 * EMAIL INBOX FOLDERS — `?folder=` on the thread list and on a thread, and
 * `GET /api/email-inbox/:ws/folders`.
 *
 * The same names for every mailbox, so apps draw one menu: the system folders
 * a mail client keeps (Inbox, Starred, Important, Sent, Drafts, All mail,
 * Spam, Trash) and a mailbox's own labels as `label:<id>`. Gmail has all of
 * them; a table-backed (Yahoo) mailbox, which the channel worker fills from
 * its inbox and from what is sent here, has Inbox, Starred and Sent — the
 * folder list says which, and a folder a mailbox does not have is
 * `unsupported_folder`.
 */

export const SYSTEM_FOLDERS = ['inbox', 'starred', 'important', 'sent', 'drafts', 'all', 'spam', 'trash'] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];
/** A system folder, or a mailbox label (`label:Label_123`). */
export type EmailFolder = SystemFolder | `label:${string}`;

/** Gmail label ids (`Label_123`, `CATEGORY_UPDATES`); nothing that could reach a URL path or query. */
const LABEL_FOLDER = /^label:[A-Za-z0-9_-]{1,100}$/;

/** `undefined` when absent (the inbox), `null` when the value is not a folder. */
export function parseFolder(value: unknown): EmailFolder | undefined | null {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return null;
  if ((SYSTEM_FOLDERS as readonly string[]).includes(value)) return value as SystemFolder;
  return LABEL_FOLDER.test(value) ? (value as EmailFolder) : null;
}

export function isLabelFolder(folder: EmailFolder): folder is `label:${string}` {
  return folder.startsWith('label:');
}

/** One entry of a mailbox's folder menu. Counts only, never mail. */
export interface MailFolderSummary {
  id: EmailFolder;
  kind: 'system' | 'label';
  /** A label's own name; null for system folders, which apps name in their own language. */
  name: string | null;
  /** Unread threads, where a mail client shows that (Inbox, Spam, labels); null otherwise or when unknown. */
  unread: number | null;
  /** Threads in the folder, where that is the number shown (Drafts); null otherwise. */
  total: number | null;
}

/** The folders a table-backed mailbox has. */
export const TABLE_FOLDERS: readonly SystemFolder[] = ['inbox', 'starred', 'sent'];
