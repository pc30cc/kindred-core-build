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
    let row: { changed?: boolean; new_status?: string; changed_at?: string; blocked_reason?: string } | null = null;

    const { data, error } = await sb.rpc('conversation_apply_post_send_action', {
      p_workspace_id: workspaceId,
      p_conversation_id: conversationId,
      p_target_status: targetStatus,
      p_allowed_from: allowedFrom,
      p_after_message_id: input.messageId ?? null,
    });

    if (error) {
      // The RPC is the race-safe path, but a stale PostgREST schema cache or a
      // deployment where migration 070 has not been applied yet must not break
      // the operator's "Send & wait" / "Send & resolve" action. Fall back to a
      // conditional UPDATE that keeps the same guards (allowed source status +
      // no newer inbound customer message).
      console.warn(
        '[conversationPostSend] rpc failed:',
        error.code ?? '',
        error.message,
        error.details ?? '',
      );
      row = await applyPostSendFallback(sb, {
        workspaceId,
        conversationId,
        targetStatus,
        allowedFrom,
        afterMessageId: input.messageId ?? null,
      });
    } else {
      row = Array.isArray(data) ? data[0] : data;
    }

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

/**
 * Non-RPC fallback for `conversation_apply_post_send_action`.
 * Keeps the same guards as the SQL function:
 *   • conversation must exist in the workspace and be in an allowed status
 *   • no inbound customer message newer than the agent's message
 * The final UPDATE is conditional on the still-allowed status, so a concurrent
 * change loses the race instead of overwriting it.
 */
async function applyPostSendFallback(
  sb: ReturnType<typeof getServiceClient>,
  input: {
    workspaceId: string;
    conversationId: string;
    targetStatus: string;
    allowedFrom: string[];
    afterMessageId: string | null;
  },
): Promise<{ changed: boolean; new_status?: string; changed_at?: string; blocked_reason?: string }> {
  const { data: conv, error: convErr } = await sb
    .from('conversations')
    .select('id, status')
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();

  if (convErr) return { changed: false, blocked_reason: 'rpc_error' };
  if (!conv) return { changed: false, blocked_reason: 'not_found' };
  if (!input.allowedFrom.includes(conv.status as string)) {
    return { changed: false, blocked_reason: 'status_conflict' };
  }

  if (input.afterMessageId) {
    const { data: anchor } = await sb
      .from('conversation_messages')
      .select('created_at')
      .eq('id', input.afterMessageId)
      .maybeSingle();
    if (anchor?.created_at) {
      const { data: newer } = await sb
        .from('conversation_messages')
        .select('id')
        .eq('conversation_id', input.conversationId)
        .eq('sender_type', 'contact')
        .gt('created_at', anchor.created_at)
        .limit(1);
      if (newer && newer.length > 0) {
        return { changed: false, blocked_reason: 'customer_replied' };
      }
    }
  }

  const changedAt = new Date().toISOString();
  const { data: updated, error: updErr } = await sb
    .from('conversations')
    .update({ status: input.targetStatus, updated_at: changedAt })
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId)
    .in('status', input.allowedFrom)
    .select('id')
    .maybeSingle();

  if (updErr) {
    console.warn('[conversationPostSend] fallback update failed:', updErr.message);
    return { changed: false, blocked_reason: 'rpc_error' };
  }
  if (!updated) return { changed: false, blocked_reason: 'status_conflict' };
  return { changed: true, new_status: input.targetStatus, changed_at: changedAt };
}
