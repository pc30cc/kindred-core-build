/**
 * Moving a conversation by hand — the Inbox's assignee change, transfer,
 * take and give back (owner decisions of 2026-10-21, DECISIONS §3–§4;
 * findings R-03, R-06, R-10, R-20, R-21):
 *
 *   who      supervisors (owner, admin, team lead; a platform admin) move
 *            anyone's conversation; everyone else in the Inbox takes an
 *            unassigned one, or hands on or gives back their own — never a
 *            colleague's (any role could move anyone's before);
 *   to whom  the caller themselves, or a member who receives chats: the
 *            owner or a team role (shared/chatRoles.ts), never staff, never a
 *            suspended member, a non-member or a seat the plan paused (a
 *            suspended member could be given chats before);
 *   race     the change applies only while the conversation is still with
 *            whoever the caller saw (409 `assignment_changed`), so two
 *            moves at once can never both land silently;
 *   told     the timeline (assigned / unassigned), the new operator's phone,
 *            the thread (the visitor's "X joined" or transfer line; an
 *            unassign stays in the Inbox), the AI (a thread it held is a
 *            person's now: human takeover, R-06), and a conversation that
 *            nobody has any more is routed again in every mode (R-20).
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { isRoutableChatRole } from '../../shared/chatRoles.js';
import { isSeatLocked } from '../lib/workspaceAuth.js';
import { supervisesInbox } from '../lib/inboxAccess.js';
import { recordAuditAndEvent } from './conversationEvents.js';
import { buildMessageEnvelope, publishConversationEvent, publishOperatorEvent } from './realtime/publish.js';
import { notifyAssignment } from './push/index.js';
import { markHumanTakeover } from './ai-agent/handoffState.js';

export interface AssignmentActor {
  userId: string;
  isAdmin: boolean;
  role: string | null;
}

/**
 * Whether `actor` may move a conversation held by `from` to `to` (null =
 * nobody). Supervisors: always. Everyone else: their own conversation (to
 * anyone, or back to nobody), or an unassigned one to themselves.
 */
export function mayReassign(actor: AssignmentActor, from: string | null, to: string | null): boolean {
  if (supervisesInbox(actor)) return true;
  if (from === actor.userId) return true;
  return from === null && to === actor.userId;
}

export type TargetCheck =
  | { ok: true }
  | { ok: false; status: 400 | 500; body: Record<string, unknown> };

/**
 * Whether a conversation may be given to `target` by hand: a member of the
 * workspace, not suspended, seat not paused, and — unless the caller takes
 * it themselves (their own Inbox role already let them in) — a member who
 * receives chats. Read fresh, not from routing's 30 s cache: a ban applies
 * at once.
 */
export async function checkAssignmentTarget(
  config: ServerConfig,
  workspaceId: string,
  actorId: string,
  target: string,
): Promise<TargetCheck> {
  const { data, error } = await getServiceClient(config)
    .from('workspace_members')
    .select('role, suspended_at')
    .eq('workspace_id', workspaceId)
    .eq('user_id', target)
    .maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: 'Authorization check failed' } };
  const member = data as { role?: string | null; suspended_at?: string | null } | null;
  if (!member) return { ok: false, status: 400, body: { error: 'invalid_target', reason: 'not_a_member' } };
  if (member.suspended_at) return { ok: false, status: 400, body: { error: 'invalid_target', reason: 'suspended' } };
  if (target !== actorId && !isRoutableChatRole(member.role)) {
    return { ok: false, status: 400, body: { error: 'invalid_target', reason: 'not_a_chat_operator' } };
  }
  // A member whose seat the plan paused cannot open the chat (every call
  // answers seat_locked): never hand it to them.
  if (await isSeatLocked(config, workspaceId, target)) {
    return { ok: false, status: 400, body: { error: 'assignee_seat_locked', reason: 'seat_locked', upgrade_required: true } };
  }
  return { ok: true };
}

/**
 * Moves the conversation to `to` only while it is still with `from` (the
 * holder the caller saw). Returns the updated row, or `conflict` with the
 * holder now when somebody else moved it first. `extra`: other columns the
 * same write changes (the PATCH's status, priority, tags).
 */
export async function compareAndAssign(
  config: ServerConfig,
  a: {
    workspaceId: string;
    conversationId: string;
    from: string | null;
    to: string | null;
    extra?: Record<string, unknown>;
    columns?: string;
  },
): Promise<{ row: Record<string, unknown> } | { conflict: true; assignedTo: string | null } | { error: string }> {
  const sb = getServiceClient(config);
  let q = sb
    .from('conversations')
    .update({ ...(a.extra || {}), assigned_to: a.to, updated_at: new Date().toISOString() })
    .eq('id', a.conversationId)
    .eq('workspace_id', a.workspaceId);
  q = a.from ? q.eq('assigned_to', a.from) : q.is('assigned_to', null);
  const { data, error } = await q
    .select(a.columns || 'id, workspace_id, status, priority, assigned_to, tags, updated_at')
    .maybeSingle();
  if (error) return { error: error.message };
  if (data) return { row: data as unknown as Record<string, unknown> };
  const { data: now } = await sb
    .from('conversations')
    .select('assigned_to')
    .eq('id', a.conversationId)
    .eq('workspace_id', a.workspaceId)
    .maybeSingle();
  return { conflict: true, assignedTo: (now as { assigned_to?: string | null } | null)?.assigned_to ?? null };
}

/**
 * Everything a hand-made assignee change tells, after it landed (the PATCH,
 * a transfer to an operator, a take): the timeline and the audit log
 * (`method`: manual, or as given), the new operator's phone, the AI (a thread
 * it held is the new operator's now — R-06: it stayed hidden in the AI's
 * queue while the AI kept answering), the thread's notice, and — handed
 * back to nobody — routing again
 * (rerouteConversation: the next operator in auto or round robin, the queue
 * in manual; whoever let it go is not offered it again). The notice and the
 * routing run in the background, in that order, so the thread reads "X
 * unassigned", then "Y joined". Never throws.
 */
export async function announceManualAssignment(
  config: ServerConfig,
  a: {
    workspaceId: string;
    conversationId: string;
    actorId: string;
    from: string | null;
    to: string | null;
    /** The conversation's ai_state before the change. */
    aiState?: string | null;
    method?: string;
    source?: string;
    ipAddress?: string | null;
    stamp?: string | null;
  },
): Promise<void> {
  const method = a.method || 'manual';
  void recordAuditAndEvent(config, {
    workspaceId: a.workspaceId,
    conversationId: a.conversationId,
    actorType: 'agent',
    actorId: a.actorId,
    ipAddress: a.ipAddress ?? null,
    eventType: a.to ? 'assigned' : 'unassigned',
    auditAction: a.to ? 'conversation.assigned' : 'conversation.unassigned',
    oldValue: { assigned_to: a.from },
    newValue: { assigned_to: a.to },
    payload: { from: a.from, to: a.to, method, ...(a.source ? { source: a.source } : {}) },
  });

  if (a.to) {
    // The operator it was handed to hears about it on their phone.
    void notifyAssignment(config, {
      workspaceId: a.workspaceId,
      conversationId: a.conversationId,
      assigneeId: a.to,
      actorId: a.actorId,
      stamp: String(a.stamp ?? Date.now()),
    });
    if (a.aiState === 'ai_managed') {
      void markHumanTakeover(config, {
        workspaceId: a.workspaceId,
        conversationId: a.conversationId,
        operatorId: a.to,
        reason: 'assignment',
        previousAiState: a.aiState,
      }).catch(() => undefined);
    }
  }
  void (async () => {
    await postAssignmentNotice(config, a);
    if (!a.to) {
      try {
        const { rerouteConversation } = await import('./chatRouting.js');
        await rerouteConversation(config, {
          workspaceId: a.workspaceId,
          conversationId: a.conversationId,
          skipUserId: a.from,
        });
      } catch (e) {
        console.warn('[conversation assignment] routing after unassign failed:', e instanceof Error ? e.message : e);
      }
    }
  })();
}

/**
 * A notice inside the thread itself. Two genuinely different events share
 * it:
 *
 *   unassigned → assigned  is somebody JOINING. The visitor has been
 *     waiting and should be told who picked their conversation up, so this
 *     one is visitor-visible and uses the same `routing_agent_joined` kind
 *     that auto-routing emits.
 *
 *   assigned → someone else, or → nobody, is a staffing move. A transfer is
 *     news for the visitor too — the next operator arriving is who they will
 *     be talking to, and the widget renders it as a join naming `to_name`.
 *     Being unassigned is not: "nobody is handling you right now" helps no
 *     one, so it stays inbox-only (`internal`; the widget filters it out of
 *     /poll and /history, and it is not published to the visitor).
 */
async function postAssignmentNotice(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; actorId: string; from: string | null; to: string | null },
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const ids = [a.actorId, a.from, a.to].filter((v): v is string => !!v);
    const nameById = new Map<string, string>();
    if (ids.length) {
      const { data: people } = await sb
        .from('profiles')
        .select('id, full_name')
        .in('id', Array.from(new Set(ids)));
      for (const p of (people || []) as Array<{ id: string; full_name?: string | null }>) {
        if (p?.full_name) nameById.set(p.id, p.full_name);
      }
    }
    const actorName = nameById.get(a.actorId) || null;
    const fromName = a.from ? (nameById.get(a.from) || null) : null;
    const toName = a.to ? (nameById.get(a.to) || null) : null;
    const isJoin = !a.from && !!a.to;
    const body = isJoin
      ? `${toName || 'An operator'} joined the conversation.`
      : toName
        ? `${actorName || 'An operator'} transferred this conversation to ${toName}`
        : `${actorName || 'An operator'} unassigned this conversation`;
    const metadata = isJoin
      ? {
        kind: 'routing_agent_joined',
        agent_id: a.to,
        agent_name: toName,
        actor_id: a.actorId,
        actor_name: actorName,
      }
      : {
        kind: a.to ? 'conversation_transferred' : 'conversation_unassigned',
        internal: !a.to,
        actor_id: a.actorId,
        actor_name: actorName,
        from_id: a.from,
        from_name: fromName,
        to_id: a.to,
        to_name: toName,
      };
    const { data: noticeRow } = await sb.from('conversation_messages').insert({
      conversation_id: a.conversationId,
      sender_type: 'system',
      body,
      metadata,
    }).select('id, conversation_id, sender_type, body, created_at, metadata, seen_at').single();
    // A join and a transfer are visitor-facing: they reach the widget in real
    // time rather than waiting for a reload.
    if (noticeRow && a.to) {
      const row = noticeRow as { id: string; conversation_id: string; body: string; created_at: string | null; metadata?: Record<string, unknown> | null; seen_at?: string | null };
      void publishConversationEvent(
        config, a.workspaceId, a.conversationId,
        buildMessageEnvelope({
          id: row.id,
          conversation_id: row.conversation_id,
          sender_type: 'system',
          body: row.body,
          created_at: row.created_at,
          metadata: row.metadata ?? metadata,
          seen_at: row.seen_at ?? null,
        }),
      );
    }
  } catch (e) {
    console.warn('[conversation assignment] notice failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * The realtime `conversation_updated` an assignee change publishes on the
 * operators' channel (never the visitor's).
 */
export function publishAssigneeChange(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; actorId: string; from: string | null; to: string | null; updatedAt?: unknown; extra?: Record<string, unknown> },
): void {
  void publishOperatorEvent(config, {
    kind: 'conversation_updated',
    conversation_id: a.conversationId,
    workspace_id: a.workspaceId,
    actor_id: a.actorId,
    changes: { assigned_to: { from: a.from, to: a.to }, ...(a.extra || {}) },
    updated_at: a.updatedAt,
  }).catch(() => undefined);
}
