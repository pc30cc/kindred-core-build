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
import { routeConversationToOperator } from '../chatRouting.js';

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

export type PlatformOffReason =
  | 'platform_ai_disabled'
  | 'customer_ai_hidden'
  | 'auto_answer_disabled';

/**
 * Pass E12-Hardening — Clear AI-management metadata when the platform-wide
 * AI Agent is disabled so the conversation falls back to the Main Inbox.
 *
 * Idempotent. Preserves unrelated metadata. Does NOT mark needs_human,
 * does NOT assign an operator, does NOT close the conversation.
 */
export async function clearAiManagementForPlatformOff(
  config: ServerConfig,
  args: {
    workspaceId: string;
    conversationId: string;
    reason: PlatformOffReason;
  },
): Promise<{ changed: boolean; previousAiState: string | null }> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', args.conversationId)
    .maybeSingle();
  const meta = (((data as any)?.metadata) || {}) as Record<string, unknown>;
  const previousAiState = (meta.ai_state as string) || null;

  // Build a new metadata object explicitly omitting `ai_state` so the
  // generated `conversations.ai_state` column becomes NULL and Main Inbox
  // surfaces this conversation again.
  const next: Record<string, unknown> = { ...meta };
  delete next.ai_state;
  next.managed_by_ai = false;
  next.ai_managed_by_ai = false;
  next.ai_handoff_requested = false;
  next.ai_handoff_reason = null;
  next.ai_platform_disabled_at = new Date().toISOString();
  next.ai_platform_disabled_reason = args.reason;

  const wasManaged =
    previousAiState === 'ai_managed' ||
    meta.managed_by_ai === true ||
    meta.ai_managed_by_ai === true ||
    meta.ai_handoff_requested === true;

  await sb
    .from('conversations')
    .update({ metadata: next, updated_at: new Date().toISOString() })
    .eq('id', args.conversationId);

  if (wasManaged) {
    try {
      await publishOperatorEvent(config, {
        kind: 'conversation_updated' as any,
        conversation_id: args.conversationId,
        workspace_id: args.workspaceId,
        actor_id: null,
        reason: 'platform_ai_disabled_main_inbox_restore',
      } as any);
    } catch { /* best-effort */ }
  }

  return { changed: wasManaged, previousAiState };
}

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

  // Owner asked for operator routing to wait until the visitor has actually
  // identified themselves (pre-chat) instead of connecting/queuing them the
  // instant AI hands off — the inline pre-chat card shouldn't be racing an
  // "operator joined" notice that already fired before they typed anything.
  // widgetIdentity.ts's POST /identity/prechat is the deferred trigger: once
  // the visitor submits, it looks up any conversation still flagged
  // routing_pending and calls routeConversationToOperator then.
  if (await shouldDeferRoutingForPrechat(config, args.workspaceId, args.conversationId)) {
    await patchMeta(config, args.conversationId, { routing_pending: true });
    return;
  }

  // Single choke point — every caller that transitions a conversation to
  // needs_human gets real routing (auto/round-robin/manual + owner
  // fallback), replacing what used to be no assignment at all. Never
  // blocks or fails the handoff itself.
  try {
    await routeConversationToOperator(config, {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
    });
  } catch { /* best-effort — routing failure must never break handoff */ }
}

/**
 * True when the workspace's pre-chat asks for at least one field and this
 * conversation's contact hasn't actually supplied any of them yet — i.e.
 * the visitor is still looking at (or about to see) the pre-chat card.
 * Fails open (false = route now) on any lookup error so a DB hiccup can
 * never strand a conversation unrouted.
 */
async function shouldDeferRoutingForPrechat(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { data: prechat } = await sb
      .from('widget_prechat_settings')
      .select('ask_name, ask_email, ask_phone')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const anyAsked = !!(prechat && ((prechat as any).ask_name || (prechat as any).ask_email || (prechat as any).ask_phone));
    if (!anyAsked) return false;

    const { data: conv } = await sb
      .from('conversations')
      .select('contact_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!(conv as any)?.contact_id) return true;

    const { data: contact } = await sb
      .from('contacts')
      .select('name, email, phone')
      .eq('id', (conv as any).contact_id)
      .maybeSingle();
    if (!contact) return true;
    // mergeVisitorIdentity() seeds an unidentified contact's name with the
    // literal placeholder 'Visitor' — a real pre-chat submission always
    // writes an actual field, so "still just the placeholder, no email/
    // phone either" means pre-chat genuinely hasn't happened yet.
    const hasReal = ((contact as any).name && (contact as any).name !== 'Visitor')
      || (contact as any).email || (contact as any).phone;
    return !hasReal;
  } catch {
    return false;
  }
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
