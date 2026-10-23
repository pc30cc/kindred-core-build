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
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { canSuperviseInbox, canUseInbox } from '../../shared/chatRoles.js';
import { authorizeWorkspaceAccess, isSeatLocked, type WorkspaceAuth } from './workspaceAuth.js';

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
 * Whether `userId` holds a seat in this workspace's Inbox: a member, not
 * suspended, seat not paused by the plan, in a role with an Inbox. A
 * platform admin passes every workspace door without one
 * (authorizeWorkspaceAccess answers `role: null` before it reads the
 * membership), so this is how their reply tells someone answering in a
 * workspace they work in (a seat: the reply claims the chat like any
 * member's) from a platform admin looking in from outside (no seat: it
 * claims nothing). Read only for that. False when it cannot be read.
 */
export async function holdsInboxSeat(config: ServerConfig, workspaceId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await getServiceClient(config)
      .from('workspace_members')
      .select('role, suspended_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();
    const member = data as { role?: string | null; suspended_at?: string | null } | null;
    if (error || !member || member.suspended_at || !canUseInbox(member.role ?? null)) return false;
    return !(await isSeatLocked(config, workspaceId, userId));
  } catch {
    return false;
  }
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
