/**
 * AI Agent — "AI Reply Now" orchestration (Human Guidance UX).
 *
 * An authenticated operator can, from the inbox composer, privately steer the
 * assistant and then ask it to answer the visitor immediately.
 *
 * Hard rules (do not relax):
 *   - the answer is produced by the REAL Core AI Agent pipeline
 *     (maybeRunAiAssistantAfterVisitorMessage), never by a shortcut that
 *     "renders the guidance text". Latest visitor message, conversation
 *     history, working memory, retrieval/KB grounding, action authorization,
 *     freshness/supersession, delivery and accounting are all unchanged;
 *   - the run is always anchored to the LATEST eligible visitor message, so
 *     the reply answers what the visitor actually asked;
 *   - guidance is persisted BEFORE the run starts, so the pipeline picks it
 *     up through its normal loadActiveGuidance() path and `next_turn`
 *     guidance is consumed only after a delivered reply;
 *   - a human who already owns the public conversation is never talked over;
 *   - duplicate clicks are collapsed by an idempotency key.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { maybeRunAiAssistantAfterVisitorMessage, type MaybeRunResult } from './engine.js';
import {
  claimReplyNow, completeReplyNowClaim, failReplyNowClaim, readReplyNowClaim,
  type ClaimScope,
} from './replyNowClaims.js';
import {
  createGuidance, resolveGuidanceRequest,
  type GuidanceKind, type GuidanceRecord, type GuidanceScope,
} from './guidance.js';

const VISITOR_SENDER_TYPES = ['contact', 'visitor', 'user'];

export type ReplyNowBlockedReason =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'human_active'
  | 'handoff_in_progress'
  | 'not_ai_managed'
  | 'no_visitor_message'
  | 'reply_now_in_progress'
  | 'guidance_create_failed';

export interface ReplyNowSuccess {
  ok: true;
  guidance: GuidanceRecord | null;
  visitorMessageId: string;
  run: MaybeRunResult;
  /** True when this call reused an in-flight/just-finished identical request. */
  deduplicated: boolean;
}

export interface ReplyNowBlocked {
  ok: false;
  reason: ReplyNowBlockedReason;
  detail?: string;
}

export type ReplyNowResult = ReplyNowSuccess | ReplyNowBlocked;

export interface ReplyNowInput {
  workspaceId: string;
  conversationId: string;
  operatorId: string;
  operatorName?: string | null;
  /** Optional private guidance to persist before the turn runs. */
  body?: string | null;
  kind?: GuidanceKind;
  scope?: GuidanceScope;
  /** Optional pending AI guidance request this answers. */
  requestId?: string | null;
  /** Client-supplied token collapsing duplicate clicks. */
  idempotencyKey?: string | null;
}

interface LatestVisitorMessage {
  id: string;
  body: string;
}

/**
 * The message the AI must answer: the newest visitor-authored message in the
 * conversation. Returns null when the visitor has not said anything yet —
 * there is nothing to answer and the UI disables the action.
 */
export async function findLatestVisitorMessage(
  config: ServerConfig,
  conversationId: string,
): Promise<LatestVisitorMessage | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversation_messages')
    .select('id,body,sender_type,created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', VISITOR_SENDER_TYPES)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = (data || [])[0] as any;
  if (!row?.id) return null;
  const body = String(row.body || '').trim();
  if (!body) return null;
  return { id: row.id, body };
}

/**
 * Canonical AI-ownership invariant for "AI Reply Now".
 *
 * AI Reply Now is a Human Guidance feature that is only valid while the AI
 * still owns the PUBLIC conversation. It is NOT a way to bypass a handoff
 * that already started: once the conversation is canonically human-owned
 * (needs_human / human_assigned / human_active / takeover / active handoff
 * request), the conversation must first return to AI through the existing
 * "return to AI" transition. Frontend visibility is never the authority.
 */
export function checkAiOwnership(
  metadata: Record<string, unknown> | null | undefined,
): { owned: true; reason: null } | { owned: false; reason: ReplyNowBlockedReason } {
  const meta = (metadata || {}) as Record<string, unknown>;
  const state = typeof meta.ai_state === 'string' ? meta.ai_state : null;

  if (state === 'human_active' || meta.human_takeover_at) {
    return { owned: false, reason: 'human_active' };
  }
  if (state === 'human_assigned') {
    return { owned: false, reason: 'human_active' };
  }
  if (state === 'needs_human') {
    return { owned: false, reason: 'handoff_in_progress' };
  }
  // An active (unresolved) handoff request, whatever the mirrored state is.
  if (meta.ai_handoff_requested === true) {
    return { owned: false, reason: 'handoff_in_progress' };
  }
  if (state === 'closed') {
    return { owned: false, reason: 'conversation_closed' };
  }
  // Only the canonical AI-owned state qualifies. Conversations that were
  // never AI-managed are not a Human Guidance surface.
  const aiOwned =
    state === 'ai_managed' ||
    meta.managed_by_ai === true ||
    meta.ai_managed_by_ai === true;
  if (!aiOwned) return { owned: false, reason: 'not_ai_managed' };
  return { owned: true, reason: null };
}

export interface ReplyNowEligibility {
  eligible: boolean;
  reason: ReplyNowBlockedReason | null;
  visitorMessage: LatestVisitorMessage | null;
}

/**
 * Pure-read pre-check. The authoritative guards still run inside the engine
 * (policy + freshness at three checkpoints); this only lets the API answer
 * with a precise reason instead of a generic "skipped".
 */
export async function checkReplyNowEligibility(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
): Promise<ReplyNowEligibility> {
  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('id,status,metadata')
    .eq('id', args.conversationId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle();
  if (!conv) return { eligible: false, reason: 'conversation_not_found', visitorMessage: null };
  if (String((conv as any).status || '') === 'closed') {
    return { eligible: false, reason: 'conversation_closed', visitorMessage: null };
  }
  const meta = (((conv as any).metadata || {}) as Record<string, unknown>);
  const ownership = checkAiOwnership(meta);
  if (!ownership.owned) {
    return { eligible: false, reason: ownership.reason, visitorMessage: null };
  }
  const visitorMessage = await findLatestVisitorMessage(config, args.conversationId);
  if (!visitorMessage) return { eligible: false, reason: 'no_visitor_message', visitorMessage: null };
  return { eligible: true, reason: null, visitorMessage };
}

// ─── Idempotency ───────────────────────────────────────────────────────
// Duplicate clicks (double-tap, retried request, flaky network, a retry that
// lands on another Core replica) must never produce two visitor-facing
// replies. The CORRECTNESS boundary is the durable claim table
// (public.ai_agent_reply_now_claims, migration 059); the in-process map below
// is only a fast local short-circuit for the same process.
const IDEMPOTENCY_TTL_MS = 60_000;
const inFlight = new Map<string, { promise: Promise<ReplyNowResult>; at: number }>();

/** How long a caller waits for a peer instance to finish an identical turn. */
const PEER_WAIT_MS = 15_000;
const PEER_POLL_MS = 250;

function pruneIdempotency(now: number): void {
  for (const [k, v] of inFlight) {
    if (now - v.at > IDEMPOTENCY_TTL_MS) inFlight.delete(k);
  }
}

/** Test-only helper: clears the local idempotency cache between cases. */
export function __resetReplyNowIdempotency(): void {
  inFlight.clear();
}

function asDeduplicated(result: ReplyNowResult): ReplyNowResult {
  return result.ok ? { ...result, deduplicated: true } : result;
}

export async function replyNowWithGuidance(
  config: ServerConfig,
  input: ReplyNowInput,
): Promise<ReplyNowResult> {
  const now = Date.now();
  pruneIdempotency(now);
  if (!input.idempotencyKey) return runReplyNow(config, input);

  const scope: ClaimScope = {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
  };
  const localKey = `${input.workspaceId}:${input.conversationId}:${input.idempotencyKey}`;

  const existing = inFlight.get(localKey);
  if (existing) return asDeduplicated(await existing.promise);

  const promise = (async (): Promise<ReplyNowResult> => {
    const claim = await claimReplyNow<ReplyNowResult>(config, scope);
    if (claim.state === 'duplicate_completed') {
      return claim.result ? asDeduplicated(claim.result) : { ok: false, reason: 'reply_now_in_progress' };
    }
    if (claim.state === 'duplicate_running') {
      // Another instance owns this exact turn — wait for its outcome instead
      // of generating a second visitor-facing reply.
      const deadline = Date.now() + PEER_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, PEER_POLL_MS));
        const peer = await readReplyNowClaim<ReplyNowResult>(config, scope);
        if (peer.status === 'completed' && peer.result) return asDeduplicated(peer.result);
        if (peer.status === 'failed') break;
      }
      return { ok: false, reason: 'reply_now_in_progress' };
    }

    try {
      const result = await runReplyNow(config, input);
      await completeReplyNowClaim(config, scope, result);
      return result;
    } catch (err) {
      await failReplyNowClaim(config, scope);
      throw err;
    }
  })();

  inFlight.set(localKey, { promise, at: now });
  void promise.catch(() => undefined).finally(() => {
    const entry = inFlight.get(localKey);
    if (entry) inFlight.set(localKey, { ...entry, at: Date.now() });
  });
  return promise;
}

async function runReplyNow(
  config: ServerConfig,
  input: ReplyNowInput,
): Promise<ReplyNowResult> {
  const eligibility = await checkReplyNowEligibility(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
  });
  if (!eligibility.eligible || !eligibility.visitorMessage) {
    return { ok: false, reason: eligibility.reason || 'conversation_not_found' };
  }

  // 1. Persist guidance FIRST so the pipeline reads it through its normal
  //    path and the consumption lifecycle stays owned by the delivery stage.
  let guidance: GuidanceRecord | null = null;
  const body = String(input.body || '').trim();
  if (body) {
    const created = await createGuidance(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      body,
      kind: input.kind || 'direction',
      scope: input.scope || 'next_turn',
      operatorId: input.operatorId,
      operatorName: input.operatorName || null,
      requestId: input.requestId || null,
      metadata: { origin: 'ai_reply_now' },
    });
    if (created.ok !== true) {
      return { ok: false, reason: 'guidance_create_failed', detail: created.error };
    }
    guidance = created.guidance;
    if (input.requestId) {
      await resolveGuidanceRequest(config, {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        guidanceId: created.guidance.id,
        resolvedBy: input.operatorId,
      }).catch(() => {});
    }
  }

  // 2. Run the real engine, anchored to the latest visitor message.
  const run = await maybeRunAiAssistantAfterVisitorMessage(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    visitorMessageId: eligibility.visitorMessage.id,
    question: eligibility.visitorMessage.body,
    operatorReplyNow: true,
    operatorId: input.operatorId,
  });

  return {
    ok: true,
    guidance,
    visitorMessageId: eligibility.visitorMessage.id,
    run,
    deduplicated: false,
  };
}
