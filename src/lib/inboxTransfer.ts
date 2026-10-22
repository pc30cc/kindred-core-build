/**
 * Who and where a conversation can be handed to, as the Inbox's transfer
 * picker lists them.
 *
 * The old "Assignee" list was every workspace member, in the order the
 * server returned them, with no sign of who was at their desk: suspended
 * members and staff who never answer chats (billing, SEO, viewers…)
 * included. Now:
 *   - operators: the owner and the chat team only (isTransferTarget: never
 *     staff, never a suspended member or a seat the plan paused), each with
 *     their presence and departments, the ones at their desk first;
 *   - departments: the enabled chat departments, each with how many of its
 *     operators are online — handing a chat to one lets routing pick the
 *     operator.
 */
import type { OperatorPresence } from '@/lib/availability-api';
import type { InboxDepartment } from '@/lib/workspace-departments-api';
import { isTransferTarget } from '@/lib/inboxAccess';

/** The three presence glyphs PresenceDot draws. */
export type OperatorDot = 'online' | 'idle' | 'offline';

/** An operator's teammate-facing presence: at the desk, away, or not there. */
export function operatorDot(p: Pick<OperatorPresence, 'state' | 'presence_state'> | null | undefined): OperatorDot {
  if (!p) return 'offline';
  if (p.presence_state === 'active') return 'online';
  if (p.presence_state === 'away') return 'idle';
  if (p.presence_state) return 'offline';
  // An older server without the teammate-facing state.
  return p.state === 'online' ? 'online' : 'offline';
}

const DOT_RANK: Record<OperatorDot, number> = { online: 0, idle: 1, offline: 2 };

export interface TransferMember {
  user_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
  avatar_url?: string | null;
  suspended_at?: string | null;
  seat_locked?: boolean;
  department_names?: string[];
}

export interface TransferCandidate {
  userId: string;
  name: string;
  avatarUrl: string | null;
  departments: string[];
  presence: OperatorDot;
  /** Away by their own choice ("Away from desk"), not idle: routing gives them nothing new. */
  manualAway: boolean;
  isViewer: boolean;
  isCurrent: boolean;
}

export function memberName(m: Pick<TransferMember, 'full_name' | 'email' | 'user_id'>): string {
  return m.full_name?.trim() || m.email?.trim() || m.user_id.slice(0, 8);
}

/** The operators a conversation may be handed to, at their desk first, then by name. */
export function transferCandidates(
  members: readonly TransferMember[],
  presence: readonly OperatorPresence[] | null | undefined,
  ctx: { viewerId?: string | null; assignedTo?: string | null; locale?: string },
): TransferCandidate[] {
  const byUser = new Map<string, OperatorPresence>();
  for (const p of presence ?? []) if (p?.user_id) byUser.set(p.user_id, p);
  const out = members.filter(isTransferTarget).map((m): TransferCandidate => ({
    userId: m.user_id,
    name: memberName(m),
    avatarUrl: m.avatar_url ?? null,
    departments: m.department_names ?? [],
    presence: operatorDot(byUser.get(m.user_id)),
    manualAway: byUser.get(m.user_id)?.presence_state === 'away' && byUser.get(m.user_id)?.reason === 'manual_away',
    isViewer: !!ctx.viewerId && m.user_id === ctx.viewerId,
    isCurrent: !!ctx.assignedTo && m.user_id === ctx.assignedTo,
  }));
  return out.sort((a, b) =>
    DOT_RANK[a.presence] - DOT_RANK[b.presence] || a.name.localeCompare(b.name, ctx.locale),
  );
}

export interface DepartmentTarget {
  id: string;
  name: string;
  /** Its operators who are at their desk or away (connected). */
  onlineCount: number;
  isCurrent: boolean;
}

/** The chat departments a conversation may be handed to. */
export function departmentTargets(
  directory: readonly InboxDepartment[] | null | undefined,
  members: readonly TransferMember[],
  presence: readonly OperatorPresence[] | null | undefined,
  currentDepartmentId?: string | null,
): DepartmentTarget[] {
  const targets = new Set(members.filter(isTransferTarget).map((m) => m.user_id));
  const byUser = new Map<string, OperatorPresence>();
  for (const p of presence ?? []) if (p?.user_id) byUser.set(p.user_id, p);
  return (directory ?? [])
    .filter((d) => d.enabled && d.chat_enabled)
    .map((d) => ({
      id: d.id,
      name: d.name,
      onlineCount: d.member_ids.filter((id) => targets.has(id) && operatorDot(byUser.get(id)) !== 'offline').length,
      isCurrent: !!currentDepartmentId && d.id === currentDepartmentId,
    }));
}

/** Case- and diacritic-insensitive match on what the picker shows. */
export function matchesTransferQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = normalize(query);
  if (!q) return true;
  return fields.some((f) => !!f && normalize(f).includes(q));
}

function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().trim();
}
