/**
 * POST-SEND CONVERSATION ACTION (Split Send button — operator composer).
 *
 * One shared layer for every channel: the Inbox composer always sends through
 * POST /api/conversations/send-message (widget, Telegram, Bale, WhatsApp,
 * Instagram — outbound delivery is dispatched from that same route), so the
 * status transition that follows a reply belongs here and nowhere else.
 *
 * Rules:
 *  • Runs ONLY after the message row was actually inserted. A failed send never
 *    reaches this code, so a failed "Send & wait" leaves the status untouched.
 *  • Conditional (compare-and-set) update: a double-click or a retry cannot
 *    produce a second transition or a second timeline event.
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
  },
): Promise<{ changed: boolean; status?: string; reason?: string }> {
  const { action, workspaceId, conversationId, actorId } = input;
  if (action === 'none') return { changed: false };

  const targetStatus = action === 'resolve' ? 'resolved' : 'pending';
  // Only transition from states where the action is meaningful. This is the
  // idempotency guard: a replayed request finds the row already moved.
  const allowedFrom = action === 'resolve' ? ['open', 'pending'] : ['open'];
  const reason = action === 'resolve' ? 'resolved_after_reply' : 'waiting_for_customer';

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('conversations')
      .update({ status: targetStatus, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .in('status', allowedFrom)
      .select('id, status, updated_at')
      .maybeSingle();
    if (error || !data) return { changed: false };

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
      updated_at: data.updated_at,
    } as any);

    return { changed: true, status: targetStatus, reason };
  } catch {
    return { changed: false };
  }
}
