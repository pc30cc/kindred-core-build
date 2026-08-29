/**
 * AI Agent — generation freshness / supersession guard.
 *
 * A single AI generation is bound to (conversation_id, trigger visitor
 * message_id). Between the moment the run starts and the moment the public
 * reply is written, three things can invalidate it:
 *
 *   1. the visitor sent a NEWER message (burst / topic switch)
 *   2. a human operator publicly replied or took the conversation over
 *   3. the conversation left AI management (handoff executed)
 *
 * Delivering an answer generated against a stale state is the single most
 * visible AI-support failure mode, so the engine checks freshness at three
 * points: BEFORE the provider call, AFTER the provider call, and
 * IMMEDIATELY BEFORE public delivery.
 *
 * Pure reads. Never throws — a failed freshness read is reported as
 * `fresh: true` with `checkFailed: true` so a transient DB blip can never
 * silently mute the assistant.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isHumanOperatorMessage } from './handoffState.js';

export type FreshnessCheckpoint = 'pre_generation' | 'post_generation' | 'pre_delivery';

export type StaleReason =
  | 'superseded_by_newer_visitor_message'
  | 'human_public_reply'
  | 'human_takeover'
  | 'handoff_in_progress'
  | 'conversation_closed';


export interface FreshnessVerdict {
  fresh: boolean;
  checkpoint: FreshnessCheckpoint;
  reason: StaleReason | null;
  /** id of the newest visitor message when it differs from the trigger. */
  supersededByMessageId: string | null;
  latestVisitorMessageId: string | null;
  humanTakeoverDetected: boolean;
  /** True when the underlying read failed; callers must fail OPEN. */
  checkFailed: boolean;
}

const VISITOR_SENDER_TYPES = ['contact', 'visitor', 'user'];

function ok(checkpoint: FreshnessCheckpoint, latest: string | null): FreshnessVerdict {
  return {
    fresh: true,
    checkpoint,
    reason: null,
    supersededByMessageId: null,
    latestVisitorMessageId: latest,
    humanTakeoverDetected: false,
    checkFailed: false,
  };
}

/**
 * Is the run triggered by `visitorMessageId` still the newest thing that
 * happened on this conversation?
 */
export async function checkGenerationFreshness(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    visitorMessageId: string;
    checkpoint: FreshnessCheckpoint;
    /** Messages created at/after this instant are the ones that matter. */
    startedAt?: string | null;
  },
): Promise<FreshnessVerdict> {
  const { workspaceId, conversationId, visitorMessageId, checkpoint } = args;
  if (!conversationId || !visitorMessageId) return ok(checkpoint, null);

  const sb = getServiceClient(config);
  try {
    // The trigger message anchors the timeline. Anything created strictly
    // after it that is a visitor message or a public human reply invalidates
    // this generation.
    const { data: trigger } = await sb
      .from('conversation_messages')
      .select('id,created_at')
      .eq('id', visitorMessageId)
      .maybeSingle();
    const anchor = (trigger as any)?.created_at || args.startedAt || null;
    if (!anchor) return ok(checkpoint, visitorMessageId);

    const { data: newer, error } = await sb
      .from('conversation_messages')
      .select('id,sender_type,sender_id,created_at,metadata')
      .eq('conversation_id', conversationId)
      .gt('created_at', anchor)
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) {
      return { ...ok(checkpoint, visitorMessageId), checkFailed: true };
    }

    let latestVisitor: string | null = visitorMessageId;
    let superseded: string | null = null;
    let humanReply = false;

    for (const m of newer || []) {
      if (m.id === visitorMessageId) continue;
      const st = String((m as any).sender_type || '').toLowerCase();
      if (VISITOR_SENDER_TYPES.includes(st)) {
        latestVisitor = m.id;
        superseded = superseded || m.id;
        continue;
      }
      if (isHumanOperatorMessage(m as any)) humanReply = true;
    }

    // A public human reply always wins over an in-flight AI generation.
    if (humanReply) {
      return {
        fresh: false,
        checkpoint,
        reason: 'human_public_reply',
        supersededByMessageId: superseded,
        latestVisitorMessageId: latestVisitor,
        humanTakeoverDetected: true,
        checkFailed: false,
      };
    }

    // Metadata-level takeover (operator pressed "Take over" without posting).
    const { data: conv } = await sb
      .from('conversations')
      .select('status,metadata')
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const meta = ((conv as any)?.metadata || {}) as Record<string, unknown>;
    const takeoverAt = meta.human_takeover_at as string | undefined;
    if (meta.ai_state === 'human_active' || (takeoverAt && takeoverAt > anchor)) {
      return {
        fresh: false,
        checkpoint,
        reason: 'human_takeover',
        supersededByMessageId: superseded,
        latestVisitorMessageId: latestVisitor,
        humanTakeoverDetected: true,
        checkFailed: false,
      };
    }

    // vNext blocker 2 — a handoff that was requested or already committed
    // (by this turn's action pipeline, another concurrent turn, a workflow,
    // or an operator) means the conversation no longer belongs to the AI.
    // Delivering a generated answer on top of it produces the classic
    // "I'm connecting you to a human" followed by the AI answering anyway.
    const handoffPending = meta.ai_state === 'needs_human'
      || meta.ai_state === 'human_assigned'
      || meta.ai_handoff_requested === true
      || (meta as any).ai_handoff_sent === true
      || (meta as any).routing_pending === true;
    if (handoffPending) {
      return {
        fresh: false,
        checkpoint,
        reason: 'handoff_in_progress',
        supersededByMessageId: superseded,
        latestVisitorMessageId: latestVisitor,
        humanTakeoverDetected: false,
        checkFailed: false,
      };
    }

    if (String((conv as any)?.status || '') === 'closed') {
      return {
        fresh: false,
        checkpoint,
        reason: 'conversation_closed',
        supersededByMessageId: superseded,
        latestVisitorMessageId: latestVisitor,
        humanTakeoverDetected: false,
        checkFailed: false,
      };
    }

    if (superseded) {
      return {
        fresh: false,
        checkpoint,
        reason: 'superseded_by_newer_visitor_message',
        supersededByMessageId: superseded,
        latestVisitorMessageId: latestVisitor,
        humanTakeoverDetected: false,
        checkFailed: false,
      };
    }

    return ok(checkpoint, latestVisitor);
  } catch {
    // Fail OPEN — never mute the assistant because of a diagnostics read.
    return { ...ok(checkpoint, visitorMessageId), checkFailed: true };
  }
}

/** Bounded, log-safe observability payload for ai_agent_runs.metadata. */
export function freshnessMeta(v: FreshnessVerdict): Record<string, unknown> {
  return {
    checkpoint: v.checkpoint,
    fresh: v.fresh,
    reason: v.reason,
    superseded_by_message_id: v.supersededByMessageId,
    human_takeover_detected_before_delivery: v.humanTakeoverDetected,
    check_failed: v.checkFailed,
  };
}
