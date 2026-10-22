/**
 * Who handles website chats, by workspace role.
 *
 * Owner decision (2026-10-21): only the workspace owner and the team members
 * the owner invites from Team & Departments receive chats. Staff (everyone
 * invited from Staff access, `admin` included) never get a chat routed to
 * them. `admin` keeps a supervisor's Inbox (sees every conversation, can take
 * or transfer one by hand); the other staff roles have no Inbox at all.
 *
 * One module so routing, the widget's online/offline, the Inbox routes and
 * the dashboard all draw the same line. Role strings are the
 * `public.workspace_role` enum values.
 */

/** Team members invited from Team & Departments (legacy values included). */
export const CHAT_TEAM_ROLES = ['agent', 'team_lead', 'support_agent', 'sales_agent'] as const;

/** Roles chat routing may assign automatically (the owner can opt out per member). */
export const ROUTABLE_CHAT_ROLES = ['owner', ...CHAT_TEAM_ROLES] as const;

/** Staff roles, invited from Staff access. None of them is routed chats. */
export const STAFF_ROLES = [
  'admin',
  'marketing_manager',
  'seo_manager',
  'analyst',
  'developer',
  'billing',
  'viewer',
] as const;

/** Roles that may open the Inbox and answer chats. */
export const INBOX_ROLES = ['owner', 'admin', ...CHAT_TEAM_ROLES] as const;

/** Roles that may see every conversation and reassign other members' chats. */
export const SUPERVISOR_ROLES = ['owner', 'admin', 'team_lead'] as const;

function has(list: readonly string[], role: string | null | undefined): boolean {
  return !!role && list.includes(role);
}

export function isRoutableChatRole(role: string | null | undefined): boolean {
  return has(ROUTABLE_CHAT_ROLES, role);
}

export function isStaffRole(role: string | null | undefined): boolean {
  return has(STAFF_ROLES, role);
}

export function canUseInbox(role: string | null | undefined): boolean {
  return has(INBOX_ROLES, role);
}

export function canSuperviseInbox(role: string | null | undefined): boolean {
  return has(SUPERVISOR_ROLES, role);
}
