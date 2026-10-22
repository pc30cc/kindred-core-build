/**
 * The widget's team: who GET /config sends as `teamMembers` (the home view's
 * team stack) and which letter the agent's face wears (`fab.initial`,
 * launcherStyles.ts). One rule for the server
 * (server/services/widget/configSnapshot.ts) and the dashboard (the
 * launcher picker and the live preview, src/pages/app/WidgetPage.tsx), so
 * the preview shows the people and the letter a visitor will see:
 *
 *   - the workspace's first four members in the order they joined
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
 * The agent face's letter is the first character that shows of the first
 * of those names (the stack's, so it is the face t1's header draws for the
 * same person), else the workspace's name (launcherInitial).
 */
import { launcherInitial } from './launcherStyles.js';
import { visitorDisplayName } from './systemMessages.js';

/** How many members the widget shows (and the agent face picks from). */
export const WIDGET_TEAM_SIZE = 4;

/** A member's name in the team stack when their profile has none, by the widget's language (English for any other). */
export const WIDGET_TEAM_NAME_FALLBACK: Readonly<Record<string, string>> = { en: 'Operator', fa: 'اپراتور', tr: 'Operatör' };

/** A `workspace_members` row as both readers get it. */
export interface WidgetTeamMemberRow {
  user_id: string | null;
  created_at?: string | null;
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

/**
 * The agent face's letter: the team (online first) by their stack names
 * (widgetTeamName), then the workspace's name; '' when none has a
 * character that shows.
 */
export function agentFaceInitial(
  team: ReadonlyArray<{ name: string; online: boolean }>,
  workspaceName: string | null | undefined,
): string {
  return launcherInitial([...onlineFirst(team).map((m) => m.name), workspaceName]);
}
