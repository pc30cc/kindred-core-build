/**
 * SHARED INBOUND CONVERSATION LIFECYCLE — one semantics for every channel.
 *
 * Before this module, the Web Widget and the channel ingest path disagreed
 * about what a new customer message does to a finished thread:
 *   • Widget  — silently flipped BOTH `resolved` and `closed` back to `open`
 *               (no timeline event, no realtime echo).
 *   • Channels — reused only `open`/`pending` and created a brand new
 *               conversation for `resolved` as well as `closed`.
 *
 * The canonical rule, applied everywhere now:
 *
 *   previous status │ new real customer message
 *   ────────────────┼───────────────────────────────────────────
 *   open            │ reuse the same conversation
 *   pending         │ reuse → resumed to `open` (customer_replied)
 *   resolved        │ reuse → reopened to `open`
 *                   │        (customer_replied_after_resolution)
 *   closed          │ NOT reused — a new conversation is created and the
 *                   │ archived one is left untouched
 *
 * `resolved` = handled for now, thread may continue.
 * `closed`   = archived/final, never resurrected.
 *
 * Both transitions are compare-and-set on the exact previous status, so two
 * simultaneous customer messages serialize on the row lock and produce exactly
 * one transition, one timeline event and one realtime envelope.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { recordConversationEvent } from './conversationEvents.js';
import { publishOperatorEvent } from './realtime/publish.js';
import { resumeConversationIfPending } from './conversationPending.js';
import {
  isInboundCustomerMessageEligibleForResume,
  type ResumeCandidate,
} from './conversationResumeEligibility.js';

/** Statuses a new inbound customer message may attach to. `closed` is absent on purpose. */
export const INBOUND_REUSABLE_STATUSES = ['open', 'pending', 'resolved'] as const;

export type InboundLifecycleDecision =
  | 'reuse'
  | 'resume_pending'
  | 'reopen_resolved'
  | 'create_new_after_closed';

export function decideInboundConversationLifecycle(
  status: string | null | undefined,
): InboundLifecycleDecision {
  switch (String(status ?? '')) {
    case 'pending':
      return 'resume_pending';
    case 'resolved':
      return 'reopen_resolved';
    case 'closed':
      return 'create_new_after_closed';
    default:
      return 'reuse';
  }
}

export type ReopenResult = { reopened: boolean; reason: string };

/**
 * resolved → open, driven exclusively by a genuine inbound customer message.
 * Same contract as `resumeConversationIfPending`: never throws, CAS-guarded,
 * emits one timeline event + one `conversation_updated` realtime envelope.
 */
export async function reopenConversationIfResolved(
  config: ServerConfig,
  params: {
    workspaceId: string;
    conversationId: string;
    /** widget | telegram | bale | whatsapp | instagram */
    source?: string;
    message: ResumeCandidate;
    messageId?: string | null;
  },
): Promise<ReopenResult> {
  const { workspaceId, conversationId, source } = params;
  if (!workspaceId || !conversationId) return { reopened: false, reason: 'missing_ids' };

  const eligibility = isInboundCustomerMessageEligibleForResume(params.message);
  if (!eligibility.eligible) return { reopened: false, reason: eligibility.reason };

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('conversations')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'resolved')
      .select('id, status, updated_at')
      .maybeSingle();
    // No match → not resolved anymore (already reopened by a concurrent
    // message, or never resolved). Exactly one winner emits the event.
    if (error || !data) return { reopened: false, reason: 'not_resolved' };

    void recordConversationEvent(config, {
      workspaceId,
      conversationId,
      eventType: 'reopened',
      actorType: 'visitor',
      actorId: null,
      payload: {
        from: 'resolved',
        to: 'open',
        reason: 'customer_replied_after_resolution',
        source: source || 'widget',
        message_id: params.messageId ?? null,
      },
    });

    void publishOperatorEvent(config, {
      kind: 'conversation_updated',
      conversation_id: conversationId,
      workspace_id: workspaceId,
      actor_id: null,
      changes: { status: { from: 'resolved', to: 'open' } },
      reason: 'customer_replied_after_resolution',
      updated_at: (data as any).updated_at,
    } as any);

    return { reopened: true, reason: 'customer_replied_after_resolution' };
  } catch {
    return { reopened: false, reason: 'error' };
  }
}

/**
 * Single call site for every ingest path, executed AFTER the inbound message
 * row is committed. Both helpers are CAS-guarded on mutually exclusive
 * statuses, so at most one of them can transition the thread.
 */
export async function applyInboundConversationLifecycle(
  config: ServerConfig,
  params: {
    workspaceId: string;
    conversationId: string;
    source?: string;
    message: ResumeCandidate;
    messageId?: string | null;
  },
): Promise<{ transition: 'resumed_pending' | 'reopened_resolved' | 'none'; reason: string }> {
  const resumed = await resumeConversationIfPending(config, params);
  if (resumed.resumed) return { transition: 'resumed_pending', reason: resumed.reason };

  const reopened = await reopenConversationIfResolved(config, params);
  if (reopened.reopened) return { transition: 'reopened_resolved', reason: reopened.reason };

  return { transition: 'none', reason: reopened.reason };
}
