/**
 * Who may open the Inbox and what they see there (owner decision of
 * 2026-10-21, DECISIONS §3; shared/chatRoles.ts draws the lines):
 *
 *   - the Inbox — its conversations, messages, notes, timeline and
 *     attachments — is for the owner, admins and the chat team
 *     (INBOX_ROLES); every other staff role gets 403 `inbox_not_allowed`
 *     from its routes (the panel hides it for them). Team chat is not the
 *     Inbox: its files (attachment rows with no conversation) stay open to
 *     the members they concern (server/routes/conversationAttachments.ts);
 *   - "All conversations" and moving anyone's conversation are for
 *     supervisors (owner, admin, team lead).
 *
 * A platform admin (the global bypass, no workspace role) keeps both, as
 * every workspace route lets them through.
 */
import { canSuperviseInbox, canUseInbox } from '../../shared/chatRoles.js';
import { authorizeWorkspaceAccess, type WorkspaceAuth } from './workspaceAuth.js';

export const INBOX_NOT_ALLOWED = { error: 'inbox_not_allowed' } as const;

/** Whether this caller may use the Inbox at all. */
export function mayUseInbox(auth: Pick<WorkspaceAuth, 'isAdmin' | 'role'>): boolean {
  return auth.isAdmin || canUseInbox(auth.role);
}

/** Whether this caller supervises the Inbox: every conversation, anyone's to move. */
export function supervisesInbox(auth: Pick<WorkspaceAuth, 'isAdmin' | 'role'>): boolean {
  return auth.isAdmin || canSuperviseInbox(auth.role);
}

/**
 * authorizeWorkspaceAccess, then the Inbox's own door: a member whose role
 * has no Inbox gets 403 `inbox_not_allowed`. Writes the response and returns
 * null when the caller must stop.
 */
export async function authorizeInboxAccess(
  req: Parameters<typeof authorizeWorkspaceAccess>[0],
  res: Parameters<typeof authorizeWorkspaceAccess>[1],
  workspaceId: unknown,
  opts: Parameters<typeof authorizeWorkspaceAccess>[3] = {},
): Promise<WorkspaceAuth | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, opts);
  if (!auth) return null;
  if (!mayUseInbox(auth)) {
    res.status(403).json(INBOX_NOT_ALLOWED);
    return null;
  }
  return auth;
}
