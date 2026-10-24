/**
 * The live preview's team stack, by the rule GET /config uses
 * (shared/widgetTeam.ts), so the dashboard shows the people a visitor will
 * see: the first four members to join among those who receive chats, under
 * the name visitors read (the widget's word for an operator in its language
 * without one, never an email), online by customer availability (manual
 * status and schedule, as the widget's green dots, not connection state).
 * The agent's face is a person's silhouette, never a letter.
 */
import type { WorkspaceMember } from '@/hooks/useWorkspaceMembers';
import type { OperatorPresence } from '@/hooks/useTeamPresence';
import { isWidgetTeamMember, widgetTeamMembers, widgetTeamName } from '../../../../shared/widgetTeam';

export interface PreviewTeamMember {
  /** The stack's name in the page's widget language. */
  name: string;
  /** Their own name (null without one): a preview in another language names them from it. */
  fullName: string | null;
  avatar: string | null;
  online: boolean;
}

/** Whether visitors see this member online (an older answer without customer availability: connected and available). */
function availableToVisitors(p: OperatorPresence | undefined): boolean {
  if (!p) return false;
  return p.customer_availability ? p.customer_availability === 'available' : p.state === 'online';
}

/** The preview's team for a widget speaking `locale`, as /config's `teamMembers` before its online-first order. */
export function previewTeam(
  members: readonly WorkspaceMember[] | null | undefined,
  presence: readonly OperatorPresence[] | null | undefined,
  locale: string,
): PreviewTeamMember[] {
  const byUser = new Map((presence || []).filter((p) => p?.user_id).map((p) => [p.user_id, p]));
  return widgetTeamMembers((members || []).filter(isWidgetTeamMember)).map((m) => ({
    name: widgetTeamName(m.full_name, locale),
    fullName: m.full_name || null,
    avatar: m.avatar_url,
    online: availableToVisitors(byUser.get(m.user_id)),
  }));
}
