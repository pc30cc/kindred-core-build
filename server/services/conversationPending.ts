/**
 * "Awaiting customer reply" (status = 'pending') lifecycle.
 *
 * Operators park a thread in `pending` when the ball is in the customer's
 * court. The moment the customer writes again the thread MUST return to
 * `open` so it re-enters the active queue — otherwise the tab silently
 * swallows live conversations.
 *
 * This helper is the single place that performs that transition.
 *
 * Guarantees:
 *  • ELIGIBILITY — the caller passes the persisted message; the shared guard
 *    (`isInboundCustomerMessageEligibleForResume`) decides. Agent, AI, bot,
 *    system, automation, internal-note, echo and menu-navigation rows can
 *    never resume a thread, on any channel.
 *  • ORDER — callers invoke this AFTER the message row is committed, so a
 *    failed insert can never leave a thread un-parked without a reply.
 *  • ATOMICITY — the update is a compare-and-set on `status = 'pending'`.
 *    Two simultaneous customer messages serialize on the row lock and only
 *    the winner sees a matched row, so exactly one transition and exactly one
 *    `status_changed` timeline event are produced.
 *  • REALTIME — the winner publishes a `conversation_updated` envelope so the
 *    Inbox moves the thread out of the Pending bucket without a page refresh.
 *  • It never throws: message delivery is always more important than the
 *    bookkeeping.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { recordConversationEvent } from './conversationEvents.js';
import { publishOperatorEvent } from './realtime/publish.js';
import {
  isInboundCustomerMessageEligibleForResume,
  type ResumeCandidate,
} from './conversationResumeEligibility.js';

export type ResumeResult = {
  resumed: boolean;
  /** 'customer_replied' when it happened, otherwise why it did not. */
  reason: string;
};

export async function resumeConversationIfPending(
  config: ServerConfig,
  params: {
    workspaceId: string;
    conversationId: string;
    source?: string;
    /** The message that was just persisted. Required for eligibility. */
    message: ResumeCandidate;
    /** Id of that message, recorded on the timeline event for traceability. */
    messageId?: string | null;
  },
): Promise<ResumeResult> {
  const { workspaceId, conversationId, source } = params;
  if (!workspaceId || !conversationId) return { resumed: false, reason: 'missing_ids' };

  const eligibility = isInboundCustomerMessageEligibleForResume(params.message);
  if (!eligibility.eligible) return { resumed: false, reason: eligibility.reason };

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('conversations')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .select('id, status, updated_at')
      .maybeSingle();
    // No row matched → the thread was not pending (or another concurrent
    // customer message already resumed it). Either way: no second event.
    if (error || !data) return { resumed: false, reason: 'not_pending' };

    void recordConversationEvent(config, {
      workspaceId,
      conversationId,
      eventType: 'status_changed',
      actorType: 'visitor',
      actorId: null,
      payload: {
        from: 'pending',
        to: 'open',
        reason: 'customer_replied',
        source: source || 'widget',
        message_id: params.messageId ?? null,
      },
    });

    // Inbox buckets + Needs Reply counters must move immediately.
    void publishOperatorEvent(config, {
      kind: 'conversation_updated',
      conversation_id: conversationId,
      workspace_id: workspaceId,
      actor_id: null,
      changes: { status: { from: 'pending', to: 'open' } },
      reason: 'customer_replied',
      updated_at: (data as any).updated_at,
    } as any);

    return { resumed: true, reason: 'customer_replied' };
  } catch {
    return { resumed: false, reason: 'error' };
  }
}
