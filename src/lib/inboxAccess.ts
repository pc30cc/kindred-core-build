/**
 * Who may do what in the Inbox, on the web — the panel's half of the role
 * rules in shared/chatRoles.ts (the server enforces the same lines).
 *
 *   - The Inbox itself: the owner, admins and the chat team (INBOX_ROLES).
 *     Other staff get 403 `inbox_not_allowed` from its routes, so the panel
 *     does not offer it to them at all.
 *   - "All conversations": supervisors (owner, admin, team lead), whoever
 *     else is online. It used to appear for the owner only, and only while a
 *     colleague was online, which is exactly when it is least needed.
 *   - Moving a conversation: supervisors move anyone's; everybody else takes
 *     an unassigned one or hands on their own.
 */
import { canSuperviseInbox, canUseInbox, isRoutableChatRole } from '../../shared/chatRoles';

export type InboxScope = 'mine' | 'all';

const SCOPE_KEY = 'inbox.scope';
/** Fired on `window` when this tab changes the scope (the alerts follow it). */
export const INBOX_SCOPE_EVENT = 'inbox-scope-changed';

/**
 * Whether this member may open the Inbox. While the role is still loading
 * (`undefined`) the answer is yes: the Inbox is the product's main surface and
 * the role arrives with the first paint, while the server refuses a staff
 * member's requests either way.
 */
export function inboxAllowed(role: string | null | undefined): boolean {
  if (role === undefined) return true;
  return canUseInbox(role);
}

/** Whether the "All conversations" switch is offered to this role. */
export function canSeeAllConversations(role: string | null | undefined): boolean {
  return canSuperviseInbox(role);
}

/** The scope this member last chose on this device ('mine' when unknown). */
export function readStoredInboxScope(): InboxScope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
}

export function writeStoredInboxScope(scope: InboxScope): void {
  try { window.localStorage.setItem(SCOPE_KEY, scope); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(INBOX_SCOPE_EVENT, { detail: { scope } })); } catch { /* noop */ }
}

/** The scope the Inbox actually asks for: 'all' only for a role allowed it. */
export function effectiveInboxScope(role: string | null | undefined, stored: InboxScope): InboxScope {
  return stored === 'all' && canSeeAllConversations(role) ? 'all' : 'mine';
}

/** What this member may do with a conversation's assignment. */
export interface AssignmentActions {
  /** Take it themselves. */
  take: boolean;
  /** Hand it to another operator or to a department. */
  transfer: boolean;
  /** Send it back to the queue (routing picks the next operator). */
  unassign: boolean;
}

/**
 * Supervisors move anyone's conversation. Everyone else in the Inbox takes an
 * unassigned one, or hands on or gives back their own — never a colleague's.
 * `assignedTo` is the assignee the panel shows.
 */
export function assignmentActions(
  role: string | null | undefined,
  viewerId: string | null | undefined,
  assignedTo: string | null | undefined,
): AssignmentActions {
  const mine = !!viewerId && assignedTo === viewerId;
  if (!viewerId || !canUseInbox(role)) return { take: false, transfer: false, unassign: false };
  if (canSuperviseInbox(role)) return { take: !mine, transfer: true, unassign: !!assignedTo };
  return { take: !assignedTo, transfer: mine, unassign: mine };
}

/**
 * A refused assignment change that means somebody else has the conversation
 * now — 409 from the claim, the transfer, the PATCH (`assignment_changed`)
 * or the take-over (`already_assigned`: routing or a colleague assigned it
 * first) — rather than a failure.
 */
export function isAssignmentConflict(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { status?: unknown }).status === 409;
}

/** A member a conversation may be handed to by hand (never staff, never a suspended or paused seat). */
export function isTransferTarget(member: {
  role: string;
  suspended_at?: string | null;
  seat_locked?: boolean | null;
}): boolean {
  return isRoutableChatRole(member.role) && !member.suspended_at && member.seat_locked !== true;
}
