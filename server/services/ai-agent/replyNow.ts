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
  createGuidance, resolveGuidanceRequest,
  type GuidanceKind, type GuidanceRecord, type GuidanceScope,
} from './guidance.js';

const VISITOR_SENDER_TYPES = ['contact', 'visitor', 'user'];

export type ReplyNowBlockedReason =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'human_active'
  | 'no_visitor_message'
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
  if (meta.ai_state === 'human_active' || meta.human_takeover_at) {
    return { eligible: false, reason: 'human_active', visitorMessage: null };
  }
  const visitorMessage = await findLatestVisitorMessage(config, args.conversationId);
  if (!visitorMessage) return { eligible: false, reason: 'no_visitor_message', visitorMessage: null };
  return { eligible: true, reason: null, visitorMessage };
}

// ─── Idempotency ───────────────────────────────────────────────────────
// Duplicate clicks (double-tap, retried request, flaky network) must never
// produce two visitor-facing replies. Identical (conversation, key) pairs
// share a single in-flight promise; the resolved value is retained briefly so
// an immediate retry returns the SAME result instead of starting a new turn.
const IDEMPOTENCY_TTL_MS = 60_000;
const inFlight = new Map<string, { promise: Promise<ReplyNowResult>; at: number }>();

function pruneIdempotency(now: number): void {
  for (const [k, v] of inFlight) {
    if (now - v.at > IDEMPOTENCY_TTL_MS) inFlight.delete(k);
  }
}

/** Test-only helper: clears the idempotency cache between cases. */
export function __resetReplyNowIdempotency(): void {
  inFlight.clear();
}

export async function replyNowWithGuidance(
  config: ServerConfig,
  input: ReplyNowInput,
): Promise<ReplyNowResult> {
  const now = Date.now();
  pruneIdempotency(now);
  const key = input.idempotencyKey
    ? `${input.conversationId}:${input.idempotencyKey}`
    : null;
  if (key) {
    const existing = inFlight.get(key);
    if (existing) {
      const prior = await existing.promise;
      return prior.ok ? { ...prior, deduplicated: true } : prior;
    }
  }

  const promise = runReplyNow(config, input);
  if (key) {
    inFlight.set(key, { promise, at: now });
    void promise.finally(() => {
      const entry = inFlight.get(key);
      if (entry) inFlight.set(key, { ...entry, at: Date.now() });
    });
  }
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
