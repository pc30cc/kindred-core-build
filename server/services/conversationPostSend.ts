/**
 * POST-SEND CONVERSATION ACTION (Split Send button — operator composer).
 *
 * One shared layer for every channel: the Inbox composer always sends through
 * POST /api/conversations/send-message (widget, Telegram, Bale, WhatsApp,
 * Instagram — outbound delivery is dispatched from that same route), so the
 * status transition that follows a reply belongs here and nowhere else.
 *
 * Rules:
 *  • Runs ONLY after the message row was actually inserted AND, for external
 *    channels, after the durable delivery intent was accepted. A failed send
 *    never reaches this code, so a failed "Send & wait" leaves the status
 *    untouched.
 *  • The decision is made INSIDE the database
 *    (`public.conversation_apply_post_send_action`, migration 070) under a row
 *    lock. A plain CAS on `status = open` is not race-safe: a customer message
 *    can land between the agent's insert and the transition while the row is
 *    still `open`, and parking that thread would hide an unanswered reply.
 *    The function therefore also refuses when an inbound customer message
 *    NEWER than the agent's message exists (`blocked_reason=customer_replied`).
 *  • Conditional + row-locked: a double-click or a retry cannot produce a
 *    second transition or a second timeline event.
 *  • `none` is the default — an agent reply NEVER implicitly parks a thread.
 *  • Machine-readable timeline reasons: `waiting_for_customer`, `resolved_after_reply`.
 *  • Never throws: bookkeeping must not fail an already-delivered message.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { recordAuditAndEvent } from './conversationEvents.js';
import { publishOperatorEvent } from './realtime/publish.js';

export type PostSendAction = 'none' | 'wait_for_customer' | 'resolve';

export const POST_SEND_ACTIONS: readonly PostSendAction[] = [
  'none',
  'wait_for_customer',
  'resolve',
] as const;

export async function applyPostSendAction(
  config: ServerConfig,
  input: {
    action: PostSendAction;
    workspaceId: string;
    conversationId: string;
    actorId: string;
    messageId?: string | null;
    ipAddress?: string | null;
    /**
     * External-channel delivery gate. When false the outbound intent could not
     * be made durable, so the reply is not "sent" and no transition happens.
     */
    deliveryAccepted?: boolean;
  },
): Promise<{ changed: boolean; status?: string; reason?: string; blocked?: string }> {
  const { action, workspaceId, conversationId, actorId } = input;
  if (action === 'none') return { changed: false };
  if (input.deliveryAccepted === false) return { changed: false, blocked: 'delivery_failed' };

  const targetStatus = action === 'resolve' ? 'resolved' : 'pending';
  // Only transition from states where the action is meaningful.
  const allowedFrom = action === 'resolve' ? ['open', 'pending'] : ['open'];
  const reason = action === 'resolve' ? 'resolved_after_reply' : 'waiting_for_customer';

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('conversation_apply_post_send_action', {
      p_workspace_id: workspaceId,
      p_conversation_id: conversationId,
      p_target_status: targetStatus,
      p_allowed_from: allowedFrom,
      p_after_message_id: input.messageId ?? null,
    });
    if (error) {
      console.warn('[conversationPostSend] rpc failed:', error.message);
      return { changed: false, blocked: 'rpc_error' };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.changed) {
      return { changed: false, blocked: row?.blocked_reason ?? 'no_change' };
    }

    // Timeline + audit. `resolved` keeps the existing resolved lifecycle event
    // type so the Inbox timeline renders it exactly as a manual resolve.
    void recordAuditAndEvent(config, {
      workspaceId,
      conversationId,
      actorType: 'agent',
      actorId,
      ipAddress: input.ipAddress ?? null,
      eventType: action === 'resolve' ? 'resolved' : 'status_changed',
      auditAction: 'conversation.status_changed',
      oldValue: { status: allowedFrom.join('|') },
      newValue: { status: targetStatus },
      payload: {
        to: targetStatus,
        reason,
        source: 'composer_send_action',
        message_id: input.messageId ?? null,
      },
    });

    void publishOperatorEvent(config, {
      kind: action === 'resolve' ? 'conversation_resolved' : 'conversation_updated',
      conversation_id: conversationId,
      workspace_id: workspaceId,
      actor_id: actorId,
      changes: { status: { from: null, to: targetStatus } },
      updated_at: row.changed_at,
    } as any);

    return { changed: true, status: targetStatus, reason };
  } catch {
    return { changed: false, blocked: 'exception' };
  }
}
