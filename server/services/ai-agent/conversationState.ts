/**
 * AI Agent — conversation state inspector.
 *
 * Pure read helpers used by the runtime policy to decide whether the AI
 * Agent is still allowed to auto-reply on a given conversation.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isHumanOperatorMessage, isAiAgentMessage } from './handoffState.js';

export interface ConversationState {
  exists: boolean;
  status: string | null;
  assignedTo: string | null;
  hasHumanAgentReplied: boolean;
  isAssignedToHuman: boolean;
  lastHumanReplyAt: string | null;
  lastVisitorMessageAt: string | null;
  aiRepliesCountInConversation: number;
  /** Visitor-authored messages in this conversation (incl. the current one). */
  visitorMessagesCountInConversation: number;
  aiRepliesInLastHour: number;
  pendingHandoffRequested: boolean;
  aiState: string | null;
  managedByAi: boolean;
  humanTakeoverAt: string | null;
  /** Raw conversation.metadata — read-only consumers (C2 runtime flags). */
  _metadata?: Record<string, unknown> | null;
}

export async function getConversationState(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
): Promise<ConversationState> {
  const sb = getServiceClient(config);
  const empty: ConversationState = {
    exists: false,
    status: null,
    assignedTo: null,
    hasHumanAgentReplied: false,
    isAssignedToHuman: false,
    lastHumanReplyAt: null,
    lastVisitorMessageAt: null,
    aiRepliesCountInConversation: 0,
    visitorMessagesCountInConversation: 0,
    aiRepliesInLastHour: 0,
    pendingHandoffRequested: false,
    aiState: null,
    managedByAi: false,
    humanTakeoverAt: null,
  };

  const { data: conv } = await sb
    .from('conversations')
    .select('id,status,assigned_to,workspace_id,metadata')
    .eq('id', conversationId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!conv) return empty;

  const { data: msgs } = await sb
    .from('conversation_messages')
    .select('id,sender_type,sender_id,created_at,metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(200);

  let hasHumanAgentReplied = false;
  let lastHumanReplyAt: string | null = null;
  let lastVisitorMessageAt: string | null = null;
  let aiRepliesCountInConversation = 0;
  let visitorMessagesCountInConversation = 0;
  let aiRepliesInLastHour = 0;
  const oneHourAgo = Date.now() - 3600_000;

  for (const m of msgs || []) {
    if (isHumanOperatorMessage(m as any)) {
      if (!hasHumanAgentReplied) hasHumanAgentReplied = true;
      if (!lastHumanReplyAt) lastHumanReplyAt = m.created_at;
    } else if (isAiAgentMessage(m as any)) {
      aiRepliesCountInConversation++;
      if (m.created_at && new Date(m.created_at).getTime() > oneHourAgo) {
        aiRepliesInLastHour++;
      }
    } else if (m.sender_type === 'contact') {
      visitorMessagesCountInConversation++;
      if (!lastVisitorMessageAt) lastVisitorMessageAt = m.created_at;
    }
  }

  const meta = (conv as any).metadata || {};
  const pendingHandoffRequested = !!meta.ai_handoff_requested;
  const aiState = (meta.ai_state as string) || null;
  const managedByAi = meta.managed_by_ai === true || meta.ai_managed_by_ai === true;
  const humanTakeoverAt = (meta.human_takeover_at as string) || null;

  // Belt-and-suspenders: if metadata says human took over, treat as human-replied
  // even if message scan didn't catch it (e.g. older message with custom sender_type).
  if (humanTakeoverAt && !hasHumanAgentReplied) {
    hasHumanAgentReplied = true;
    if (!lastHumanReplyAt) lastHumanReplyAt = humanTakeoverAt;
  }

  return {
    exists: true,
    status: conv.status || null,
    assignedTo: conv.assigned_to || null,
    hasHumanAgentReplied,
    isAssignedToHuman: !!conv.assigned_to,
    lastHumanReplyAt,
    lastVisitorMessageAt,
    aiRepliesCountInConversation,
    visitorMessagesCountInConversation,
    aiRepliesInLastHour,
    pendingHandoffRequested,
    aiState,
    managedByAi,
    humanTakeoverAt,
    _metadata: meta || null,
  };
}

/**
 * Mark the conversation as having a pending handoff so subsequent visitor
 * messages won't trigger another AI auto-reply.
 */
export async function markHandoffRequested(
  config: ServerConfig,
  conversationId: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const patch = {
    ai_handoff_requested: true,
    ai_handoff_at: new Date().toISOString(),
  };
  // Atomic server-side merge (migration 057) — the previous read-modify-write
  // discarded concurrent metadata writes (working memory, routing state).
  const { error } = await sb.rpc('patch_conversation_metadata', {
    p_conversation_id: conversationId,
    p_workspace_id: null,
    p_patch: patch,
  });
  if (!error) return;
  const { data: conv } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  const meta = { ...(((conv as any)?.metadata || {}) as Record<string, unknown>), ...patch };
  await sb.from('conversations').update({ metadata: meta }).eq('id', conversationId);
}

