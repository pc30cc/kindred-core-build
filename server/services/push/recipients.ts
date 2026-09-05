/**
 * RECIPIENT RESOLUTION — server-side, workspace-isolated, preference-aware.
 *
 * Everything here answers ONE question: which operators are allowed to be
 * told about this event, right now? It reuses the existing membership model
 * (`workspace_members`, including `suspended_at`) and the existing
 * `user_notification_prefs` row — push adds policy, it does not add a second
 * authorization system.
 *
 * Hard rules:
 *  • Only members of THE conversation's workspace are ever considered.
 *  • Suspended members are excluded.
 *  • The actor who caused the event is never notified about their own action.
 *  • Preferences are enforced HERE, before dispatch — never in the client UI.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type PushEventType = 'new_message' | 'internal_note' | 'mention';

export interface RecipientContext {
  workspaceId: string;
  conversationId: string;
  assignedTo: string | null;
  eventType: PushEventType;
  /** Operator who authored the note/mention; never notified. */
  actorId?: string | null;
  mentionedUserIds?: string[];
}

export interface Recipient {
  userId: string;
  /** false → privacy mode: no message preview in the notification. */
  preview: boolean;
  sound: boolean;
}

interface PrefsRow {
  user_id: string;
  disable_all: boolean | null;
  play_sound: boolean | null;
  push_scope: string | null;
  push_preview: boolean | null;
  push_internal_notes: boolean | null;
}

const DEFAULT_PREFS = {
  disable_all: false,
  play_sound: true,
  push_scope: 'all',
  push_preview: true,
  push_internal_notes: true,
};

export async function resolveRecipients(
  config: ServerConfig,
  ctx: RecipientContext,
): Promise<Recipient[]> {
  const sb = getServiceClient(config);

  const { data: members, error } = await sb
    .from('workspace_members')
    .select('user_id, suspended_at')
    .eq('workspace_id', ctx.workspaceId);
  if (error) {
    console.error('[push] member lookup failed', { code: error.code, message: error.message });
    return [];
  }

  const mentioned = new Set(ctx.mentionedUserIds ?? []);
  const eligible = (members ?? [])
    .filter((m: any) => !m.suspended_at)
    .map((m: any) => String(m.user_id))
    .filter((id) => id !== ctx.actorId);

  if (!eligible.length) return [];

  const { data: prefRows } = await sb
    .from('user_notification_prefs')
    .select('user_id, disable_all, play_sound, push_scope, push_preview, push_internal_notes')
    .in('user_id', eligible)
    .is('workspace_id', null);

  const prefsByUser = new Map<string, PrefsRow>();
  for (const row of (prefRows ?? []) as PrefsRow[]) prefsByUser.set(row.user_id, row);

  const out: Recipient[] = [];
  for (const userId of eligible) {
    const p = { ...DEFAULT_PREFS, ...cleanPrefs(prefsByUser.get(userId)) };
    if (p.disable_all) continue;
    if (p.push_scope === 'none') continue;

    const isMentioned = mentioned.has(userId);
    const isAssignee = ctx.assignedTo === userId;

    if (ctx.eventType === 'mention' && !isMentioned) continue;
    if (ctx.eventType === 'internal_note') {
      if (!p.push_internal_notes && !isMentioned) continue;
      if (!isAssignee && !isMentioned && p.push_scope !== 'all') continue;
    }
    if (ctx.eventType === 'new_message') {
      if (p.push_scope === 'mentions' && !isMentioned) continue;
      // "only assigned to me": an unassigned thread still reaches everyone
      // whose scope is 'all', so a new customer never goes unanswered.
      if (p.push_scope === 'assigned' && !isAssignee && !isMentioned) continue;
      // An assigned thread is that operator's (plus anyone mentioned).
      if (ctx.assignedTo && !isAssignee && !isMentioned) continue;
    }

    out.push({ userId, preview: p.push_preview !== false, sound: p.play_sound !== false });
  }
  return out;
}

function cleanPrefs(row: PrefsRow | undefined): Partial<typeof DEFAULT_PREFS> {
  if (!row) return {};
  const out: Record<string, unknown> = {};
  if (row.disable_all != null) out.disable_all = row.disable_all;
  if (row.play_sound != null) out.play_sound = row.play_sound;
  if (row.push_scope != null) out.push_scope = row.push_scope;
  if (row.push_preview != null) out.push_preview = row.push_preview;
  if (row.push_internal_notes != null) out.push_internal_notes = row.push_internal_notes;
  return out as Partial<typeof DEFAULT_PREFS>;
}

/**
 * Server-authoritative unread badge: conversations in the operator's
 * workspaces that still hold an unseen inbound customer message. Counting
 * CONVERSATIONS (not messages) is what makes the badge match the inbox list
 * the operator actually sees, and is what lets it reconcile on read/resolve
 * from any device instead of drifting from local increments.
 */
export async function unreadBadgeCount(
  config: ServerConfig,
  userId: string,
  workspaceId?: string | null,
): Promise<number> {
  const sb = getServiceClient(config);
  let workspaceIds: string[] = [];
  if (workspaceId) {
    const { data: member } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .is('suspended_at', null)
      .maybeSingle();
    if (!member) return 0;
    workspaceIds = [workspaceId];
  } else {
    const { data: rows } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .is('suspended_at', null);
    workspaceIds = (rows ?? []).map((r: any) => String(r.workspace_id));
  }
  if (!workspaceIds.length) return 0;

  const { data: convs } = await sb
    .from('conversations')
    .select('id')
    .in('workspace_id', workspaceIds)
    .in('status', ['open', 'pending'])
    .limit(500);
  const ids = (convs ?? []).map((c: any) => String(c.id));
  if (!ids.length) return 0;

  const { data: msgs } = await sb
    .from('conversation_messages')
    .select('conversation_id')
    .in('conversation_id', ids)
    .eq('sender_type', 'contact')
    .is('seen_at', null)
    .limit(2000);

  return new Set((msgs ?? []).map((m: any) => String(m.conversation_id))).size;
}
