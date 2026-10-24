/**
 * The widget's team: who GET /config sends as `teamMembers` (the home view's
 * team stack). One rule for the server
 * (server/services/widget/configSnapshot.ts) and the dashboard (the live
 * preview, src/pages/app/WidgetPage.tsx), so the preview shows the people a
 * visitor will see:
 *
 *   - only the members who receive chats (isWidgetTeamMember: the owner or
 *     a team member, shared/chatRoles.ts, not suspended, "Receive chats
 *     automatically" on, a seat the plan has not paused), the same people
 *     the widget's online/offline counts; staff never answer a visitor;
 *   - the first four of them in the order they joined
 *     (`workspace_members.created_at`, then the user id), whatever order the
 *     database returns its rows in;
 *   - each under their own name; without one (or with nothing in it that
 *     shows) the widget's word for an operator in the widget's language
 *     (runtime.js's own `operator`: «اپراتور», "Operatör", "Operator"),
 *     never English on a Persian or Turkish widget; the widget's config is
 *     public, so never an email, nor any part of one;
 *   - online first (customer availability: manual status and schedule, as
 *     the visitor's green dots), in that order otherwise.
 *
 * A member without a photo, and the agent's face on the launcher, wear the
 * person silhouette (shared/avatarGlyphs.ts), never a letter (owner,
 * 2026-10-24); launcherInitial here only tells whether a name has anything
 * that shows.
 */
import { launcherInitial } from './launcherStyles.js';
import { visitorDisplayName } from './systemMessages.js';
import { isRoutableChatRole } from './chatRoles.js';

/** How many members the widget shows. */
export const WIDGET_TEAM_SIZE = 4;

/** A member's name in the team stack when their profile has none, by the widget's language (English for any other). */
export const WIDGET_TEAM_NAME_FALLBACK: Readonly<Record<string, string>> = { en: 'Operator', fa: 'اپراتور', tr: 'Operatör' };

/** A `workspace_members` row as both readers get it. */
export interface WidgetTeamMemberRow {
  user_id: string | null;
  created_at?: string | null;
}

/** What isWidgetTeamMember reads of a member (a reader without a field passes it as not set). */
export interface WidgetTeamCandidate {
  role?: string | null;
  suspended_at?: string | null;
  receives_chats?: boolean | null;
  seat_locked?: boolean | null;
}

/**
 * Whether a member is one of the people who answer the widget's chats
 * (server/services/widget/customerAvailability.ts chatReceivingMemberIds,
 * which reads the seat lock itself): a role routing gives chats, not
 * suspended, "Receive chats automatically" on, the seat not paused.
 */
export function isWidgetTeamMember(row: WidgetTeamCandidate): boolean {
  return isRoutableChatRole(row.role) && !row.suspended_at && row.receives_chats !== false && row.seat_locked !== true;
}

/**
 * The team's members: the first WIDGET_TEAM_SIZE to join, in that order (an
 * unreadable `created_at` last, a tie by user id). Pure.
 */
export function widgetTeamMembers<T extends WidgetTeamMemberRow>(rows: readonly T[]): T[] {
  const joined = (row: T) => {
    const at = Date.parse(String(row.created_at ?? ''));
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows
    .filter((row) => !!row.user_id)
    .map((row) => ({ row, at: joined(row), text: String(row.created_at ?? ''), id: String(row.user_id) }))
    // Same instant (or both unreadable: NaN): the stored text, then the id.
    .sort((a, b) => (a.at - b.at) || byText(a.text, b.text) || byText(a.id, b.id))
    .slice(0, WIDGET_TEAM_SIZE)
    .map(({ row }) => row);
}

/** A member's name in the team stack, in a widget speaking `locale` (fa, en, tr; a region tag reads as its language). */
export function widgetTeamName(fullName: string | null | undefined, locale: string | null | undefined): string {
  // A profile name that is an email address is no name here either (I-10).
  const own = visitorDisplayName(fullName);
  if (own && launcherInitial([own])) return own;
  const lang = String(locale || '').toLowerCase().split('-')[0];
  return Object.prototype.hasOwnProperty.call(WIDGET_TEAM_NAME_FALLBACK, lang)
    ? WIDGET_TEAM_NAME_FALLBACK[lang]
    : WIDGET_TEAM_NAME_FALLBACK.en;
}

/** Online members first, the team's order otherwise. */
export function onlineFirst<T extends { online: boolean }>(team: readonly T[]): T[] {
  return [...team].sort((a, b) => Number(b.online) - Number(a.online));
}
