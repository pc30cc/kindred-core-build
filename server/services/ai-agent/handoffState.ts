/**
 * AI Agent — handoff & takeover state.
 *
 * Single source of truth for the lifecycle state of an AI-managed conversation.
 * Stored on `conversations.metadata` so we don't need a side table for v1.
 * A generated column `conversations.ai_state` mirrors metadata.ai_state for
 * fast inbox filtering (see migration 20260429063439).
 *
 *   ai_managed      — AI is currently handling (Automated inbox)
 *   needs_human     — AI bailed out / handoff requested, waiting for operator
 *   human_assigned  — assigned to an operator but no human reply yet
 *   human_active    — a human operator has replied; AI must back off
 *   closed          — conversation closed
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { publishOperatorEvent } from '../realtime/publish.js';

export type AiConversationState =
  | 'ai_managed'
  | 'needs_human'
  | 'human_assigned'
  | 'human_active'
  | 'closed';

export type TakeoverReason =
  | 'operator_replied'
  | 'manual_takeover'
  | 'assignment';

export type HandoffReason =
  | 'human_request'
  | 'no_kb_match'
  | 'low_confidence'
  | 'max_replies'
  | 'max_replies_reached'
  | 'rate_limited'
  | 'no_credits'
  | 'plan_limit_reached'
  | 'fallback'
  | 'manual';

/**
 * Read current AI/human state metadata from a conversation. Tolerant of
 * conversations that pre-date this feature (returns nulls).
 */
export async function readAiConversationMeta(
  config: ServerConfig,
  conversationId: string,
): Promise<{
  state: AiConversationState | null;
  managed_by_ai: boolean;
  human_takeover_at: string | null;
  human_takeover_by: string | null;
  handoff_requested: boolean;
  handoff_reason: string | null;
  metadata: Record<string, unknown>;
}> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  const meta = ((data as any)?.metadata || {}) as Record<string, unknown>;
  return {
    state: (meta.ai_state as AiConversationState) || null,
    managed_by_ai: meta.ai_managed_by_ai === true || meta.managed_by_ai === true,
    human_takeover_at: (meta.human_takeover_at as string) || null,
    human_takeover_by: (meta.human_takeover_by as string) || null,
    handoff_requested: meta.ai_handoff_requested === true,
    handoff_reason: (meta.ai_handoff_reason as string) || null,
    metadata: meta,
  };
}

async function patchMeta(
  config: ServerConfig,
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  const meta = ((data as any)?.metadata || {}) as Record<string, unknown>;
  const merged = { ...meta, ...patch };
  await sb
    .from('conversations')
    .update({ metadata: merged, updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

/** Mark a conversation as managed by AI (placed into the Automated inbox). */
export async function markAiManaged(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
): Promise<void> {
  await patchMeta(config, args.conversationId, {
    ai_state: 'ai_managed',
    managed_by_ai: true,
    ai_managed_by_ai: true,
    ai_handoff_requested: false,
    last_ai_reply_at: new Date().toISOString(),
  });
}

/** Mark a conversation as needing a human (handoff). AI stops auto-replying. */
export async function markNeedsHuman(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    reason: HandoffReason;
  },
): Promise<void> {
  await patchMeta(config, args.conversationId, {
    ai_state: 'needs_human',
    managed_by_ai: false,
    ai_managed_by_ai: false,
    ai_handoff_requested: true,
    ai_handoff_reason: args.reason,
    ai_handoff_at: new Date().toISOString(),
  });
  try {
    await publishOperatorEvent(config, {
      kind: 'ai_handoff_requested' as any,
      conversation_id: args.conversationId,
      workspace_id: args.workspaceId,
      actor_id: null,
      reason: args.reason,
    } as any);
  } catch { /* best-effort */ }
}

/**
 * Mark a conversation as human-active: an operator has replied OR taken over.
 * AI must not auto-reply afterwards (subject to mode/policy).
 */
export async function markHumanTakeover(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    operatorId: string | null;
    reason: TakeoverReason;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await patchMeta(config, args.conversationId, {
    ai_state: 'human_active',
    managed_by_ai: false,
    ai_managed_by_ai: false,
    human_takeover_at: now,
    human_takeover_by: args.operatorId,
    human_takeover_reason: args.reason,
    ai_handoff_requested: false,
    last_human_reply_at: now,
  });
  try {
    await publishOperatorEvent(config, {
      kind: 'ai_human_takeover' as any,
      conversation_id: args.conversationId,
      workspace_id: args.workspaceId,
      actor_id: args.operatorId,
      reason: args.reason,
    } as any);
  } catch { /* best-effort */ }
}

/**
 * Helper: detect whether a conversation_messages row was sent by a human
 * operator (as opposed to the visitor, the system, or the AI).
 *
 * We check both sender_type and metadata defensively because:
 *   - the legacy enum had `'agent'` for operators
 *   - some integrations may write `'operator'`/`'admin'`/`'user'` later
 *   - AI replies use sender_type='ai' OR metadata.source starting with 'ai_agent'
 */
export function isHumanOperatorMessage(message: {
  sender_type?: string | null;
  metadata?: Record<string, unknown> | null;
  sender_id?: string | null;
}): boolean {
  if (!message) return false;
  const st = (message.sender_type || '').toLowerCase();
  const meta = (message.metadata || {}) as Record<string, any>;
  const source = String(meta.source || '').toLowerCase();
  const actorType = String(meta.actor_type || '').toLowerCase();

  // Hard excludes — AI / visitor / system are never human operators.
  if (st === 'ai' || st === 'bot') return false;
  if (st === 'contact' || st === 'visitor') return false;
  if (st === 'system') return false;
  if (source.startsWith('ai_agent')) return false;
  if (actorType === 'ai' || actorType === 'bot') return false;

  // Positive signals.
  const HUMAN_SENDER_TYPES = new Set(['agent', 'operator', 'admin', 'user']);
  if (HUMAN_SENDER_TYPES.has(st)) return true;
  if (['agent', 'operator', 'admin', 'user'].includes(actorType)) return true;
  if (source === 'inbox' || source === 'operator' || source.startsWith('inbox_')) return true;

  // Fallback: if there's a sender_id and not excluded above, treat as human.
  // (The widget visitor flow sets sender_type='contact' which is excluded.)
  if (message.sender_id) return true;
  return false;
}

/** Same predicate but for AI-authored messages. */
export function isAiAgentMessage(message: {
  sender_type?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (!message) return false;
  const st = (message.sender_type || '').toLowerCase();
  const meta = (message.metadata || {}) as Record<string, any>;
  const source = String(meta.source || '').toLowerCase();
  if (st === 'ai') return true;
  if (source.startsWith('ai_agent')) return true;
  return false;
}
